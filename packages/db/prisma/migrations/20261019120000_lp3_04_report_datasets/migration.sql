-- LP3-04 PR C — the retained report dataset (README "Inventory coverage and
-- report datasets"; Decisions 2026-10-15 (ninth), V5).
--
--  * `report_datasets`: one row per capture — the dataset's exact JSON text
--    (`content`; text, not jsonb: Prisma rounds a double to 16 significant
--    digits on a jsonb write, and the fingerprint must be recomputable from
--    what is stored), its fingerprint, and the set of subsidiaries it
--    references (a reader needs every one in their current access).
--  * `report_datasets_guard` (TA016): an insert names a FROZEN version of its
--    own organisation and year; its columns agree with its content — its
--    identity, organisation, version id, year, selection, context, schema,
--    fingerprint, capture time and referenced set, which the guard recomputes
--    from the content; and its content agrees with the version as stored —
--    its number and decision, its declared subsidiaries exactly the version's
--    rows, its resolved ones what the selection takes of them (a subsidiary
--    extract's one, else all), every subsidiary id spelled as the API spells a
--    uuid (contract follow-up (13), bindings; Codex's P2). Then the row is
--    retained: no update, and no delete but the organisation's own (as W10),
--    for every writer, the owner included; no TRUNCATE.
--  * Every function in `public` — this migration's two and every older one,
--    definer or invoker — searches pg_catalog first and pg_temp last
--    (section 5).
--  * RLS on, never FORCE, with no client policy and no client grant, the
--    service role included: the API is the dataset's only reader, and the
--    read rule (organisation, then a non-empty referenced set inside current
--    access) lives there once (V5). The runtime role inserts and reads.
--
-- A new table only; its foreign keys take SHARE ROW EXCLUSIVE on
-- `organisations` and `inventory_boundaries`, so a lock wait gives up after
-- 5 s rather than stall writes behind a long transaction. Then Prisma records
-- the migration as failed and rolls it back whole:
-- `prisma migrate resolve --rolled-back 20261019120000_lp3_04_report_datasets`
-- before deploying again, in a quieter window.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "report_datasets" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "boundary_id" UUID NOT NULL,
    "reporting_year" INTEGER NOT NULL,
    "selection" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "canonicalization" TEXT NOT NULL,
    "fingerprint_hex" CHAR(64) NOT NULL,
    "referenced_subsidiary_ids" UUID[],
    "captured_by" UUID NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "report_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_datasets_organisation_id_reporting_year_captured_at_idx" ON "report_datasets"("organisation_id", "reporting_year", "captured_at" DESC);

-- CreateIndex
CREATE INDEX "report_datasets_boundary_id_organisation_id_idx" ON "report_datasets"("boundary_id", "organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_datasets_id_organisation_id_key" ON "report_datasets"("id", "organisation_id");

-- AddForeignKey
ALTER TABLE "report_datasets" ADD CONSTRAINT "report_datasets_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report_datasets" ADD CONSTRAINT "report_datasets_boundary_id_organisation_id_fkey" FOREIGN KEY ("boundary_id", "organisation_id") REFERENCES "inventory_boundaries"("id", "organisation_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- What a row is, held for every writer. Prisma models none of these.
ALTER TABLE "report_datasets"
  ADD CONSTRAINT "report_datasets_selection_check"
    CHECK ("selection" IN ('inventory', 'extract')),
  -- An inventory has no filter; an extract at least one (V3: derived, never sent).
  ADD CONSTRAINT "report_datasets_selection_context_check"
    CHECK (("selection" = 'inventory') = (("context" OPERATOR(pg_catalog.-) 'year'::text) = '{}'::jsonb)),
  ADD CONSTRAINT "report_datasets_schema_check"
    CHECK ("schema_version" = 1 AND "canonicalization" = 'tonyai-report-dataset-v1'),
  ADD CONSTRAINT "report_datasets_fingerprint_check"
    CHECK ("fingerprint_hex" ~ '^[0-9a-f]{64}$'),
  -- Non-empty and without a null: an empty set references no one, so the
  -- dataset would be no one's to read (README: empty sets fail closed).
  ADD CONSTRAINT "report_datasets_referenced_check"
    CHECK ("referenced_subsidiary_ids" IS NOT NULL
           AND pg_catalog.cardinality("referenced_subsidiary_ids") > 0
           AND pg_catalog.array_position("referenced_subsidiary_ids", NULL) IS NULL);

-- ---------------------------------------------------------------------------
-- 2. The guard (TA016)
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER: it reads the version, the organisation and its
-- subsidiaries whoever inserts — and, like every function here, its path
-- names pg_catalog first and the session's temporary schema last (section 5). An insert is checked against what its
-- transaction sees — the capture's REPEATABLE READ snapshot, opened after its
-- freeze committed (W8), so the version reads frozen. The referenced set is
-- every `subsidiaryId` the content holds, at any depth, with the boundary's
-- declared and the resolved subsidiaries — the API computes it the same way,
-- from the same object — and every one must be its organisation's.
CREATE FUNCTION "public"."report_datasets_guard"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  doc jsonb;
  stored_version integer;
  stored_decision text;
  declared uuid[];
  content_declared uuid[];
  resolved uuid[];
  content_resolved uuid[];
  referenced uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "public"."organisations" o WHERE o."id" = OLD."organisation_id") THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA016',
        MESSAGE = format('report dataset %s is retained: it is deleted only with its organisation', OLD."id");
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA016',
      MESSAGE = format('report dataset %s is retained as captured: a correction is a new capture', OLD."id");
  END IF;
  SELECT b."version", b."decision" INTO stored_version, stored_decision
  FROM "public"."inventory_boundaries" b
  WHERE b."id" = NEW."boundary_id"
    AND b."organisation_id" = NEW."organisation_id"
    AND b."reporting_year" = NEW."reporting_year"
    AND b."frozen_at" IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA016',
      MESSAGE = format('report dataset %s captures a frozen inventory boundary version of its organisation and year only', NEW."id");
  END IF;
  -- The version's own declarations, as stored — frozen, they never change (TA014).
  SELECT pg_catalog.array_agg(bs."subsidiary_id" ORDER BY bs."subsidiary_id") INTO declared
  FROM "public"."inventory_boundary_subsidiaries" bs
  WHERE bs."boundary_id" = NEW."boundary_id";
  -- One member per key, at every depth: jsonb keeps the last of two, but the
  -- text is served as stored (`security-rls` round-2 P2). Read as json, which
  -- keeps both — portable to any supported PostgreSQL, unlike IS JSON's
  -- WITH UNIQUE KEYS (16+).
  IF EXISTS (
    WITH RECURSIVE v(val) AS (
      SELECT NEW."content"::json
      UNION ALL
      SELECT c.member
      FROM v, LATERAL (
        SELECT e.value FROM pg_catalog.json_each(CASE WHEN pg_catalog.json_typeof(v.val) = 'object' THEN v.val END) AS e
        UNION ALL
        SELECT a.value FROM pg_catalog.json_array_elements(CASE WHEN pg_catalog.json_typeof(v.val) = 'array' THEN v.val END) AS a(value)
      ) AS c(member)
    )
    SELECT 1 FROM v
    WHERE pg_catalog.json_typeof(v.val) = 'object'
      AND (SELECT pg_catalog.count(*) FROM pg_catalog.json_object_keys(v.val))
          <> (SELECT pg_catalog.count(DISTINCT k) FROM pg_catalog.json_object_keys(v.val) AS k)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA016',
      MESSAGE = format('report dataset %s: its content names a key twice in one object', NEW."id");
  END IF;
  doc := NEW."content"::jsonb;
  IF pg_catalog.jsonb_typeof(doc) IS DISTINCT FROM 'object'
     OR doc->>'datasetId' IS DISTINCT FROM NEW."id"::text
     OR doc->>'organisationId' IS DISTINCT FROM NEW."organisation_id"::text
     OR doc->'boundary'->>'id' IS DISTINCT FROM NEW."boundary_id"::text
     OR doc->'boundary'->>'organisationId' IS DISTINCT FROM NEW."organisation_id"::text
     OR doc->'boundary'->'reportingYear' IS DISTINCT FROM pg_catalog.to_jsonb(NEW."reporting_year")
     OR doc->'boundary'->'version' IS DISTINCT FROM pg_catalog.to_jsonb(stored_version)
     OR doc->'boundary'->>'decision' IS DISTINCT FROM stored_decision
     OR doc->'context'->'year' IS DISTINCT FROM pg_catalog.to_jsonb(NEW."reporting_year")
     OR doc->>'selection' IS DISTINCT FROM NEW."selection"
     OR doc->'context' IS DISTINCT FROM NEW."context"
     OR doc->'schemaVersion' IS DISTINCT FROM pg_catalog.to_jsonb(NEW."schema_version")
     OR doc->'fingerprint'->>'algorithm' IS DISTINCT FROM 'sha256'
     OR doc->'fingerprint'->>'canonicalization' IS DISTINCT FROM NEW."canonicalization"
     OR doc->'fingerprint'->>'hex' IS DISTINCT FROM NEW."fingerprint_hex"
     OR doc->>'capturedAt' IS DISTINCT FROM
        pg_catalog.to_char(NEW."captured_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA016',
      MESSAGE = format('report dataset %s: its columns and its content disagree', NEW."id");
  END IF;
  -- Declared and resolved, bound to the version itself (Codex's P2): the
  -- content declares exactly the subsidiaries the version stores — none
  -- substituted, omitted or named twice — and resolves what its selection
  -- does of them (V3): a subsidiary extract that one declared subsidiary,
  -- anything else every one. Each comparison fails closed on NULL.
  IF pg_catalog.jsonb_typeof(doc->'boundary'->'subsidiaryIds') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(doc->'resolvedSubsidiaryIds') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA016',
      MESSAGE = format('report dataset %s: its declared or resolved subsidiaries are not a list', NEW."id");
  END IF;
  -- Every `subsidiaryId` the content holds is a string — never an array, an
  -- object or null the referenced set would pass over (`security-rls`
  -- round-2 P2) — and every subsidiary id is spelled as the API spells a
  -- uuid, lower-case and hyphenated, in either list and at any depth, so a
  -- reader comparing text reads what the guard compared by value
  -- (`architect`'s round-2 P3).
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_path_query(doc, 'lax $.**.subsidiaryId') AS j
    WHERE pg_catalog.jsonb_typeof(j) IS DISTINCT FROM 'string'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA016',
      MESSAGE = format('report dataset %s: a subsidiaryId is not a string', NEW."id");
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(doc->'boundary'->'subsidiaryIds') AS j
    WHERE (j #>> '{}') IS DISTINCT FROM ((j #>> '{}')::uuid)::text
    UNION ALL
    SELECT 1 FROM pg_catalog.jsonb_array_elements(doc->'resolvedSubsidiaryIds') AS j
    WHERE (j #>> '{}') IS DISTINCT FROM ((j #>> '{}')::uuid)::text
    UNION ALL
    SELECT 1 FROM pg_catalog.jsonb_path_query(doc, 'lax $.**.subsidiaryId') AS j
    WHERE pg_catalog.jsonb_typeof(j) = 'string' AND (j #>> '{}') IS DISTINCT FROM ((j #>> '{}')::uuid)::text
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA016',
      MESSAGE = format('report dataset %s: a subsidiary id is not spelled as a uuid is', NEW."id");
  END IF;
  SELECT pg_catalog.array_agg(e::uuid ORDER BY e::uuid) INTO content_declared
  FROM pg_catalog.jsonb_array_elements_text(doc->'boundary'->'subsidiaryIds') AS e;
  SELECT pg_catalog.array_agg(e::uuid ORDER BY e::uuid) INTO content_resolved
  FROM pg_catalog.jsonb_array_elements_text(doc->'resolvedSubsidiaryIds') AS e;
  IF pg_catalog.jsonb_exists(doc->'context', 'subsidiaryId') THEN
    resolved := ARRAY[(doc->'context'->>'subsidiaryId')::uuid];
  ELSE
    resolved := declared;
  END IF;
  IF (declared IS NOT NULL
      AND content_declared IS NOT DISTINCT FROM declared
      AND resolved[1] = ANY (declared)
      AND content_resolved IS NOT DISTINCT FROM resolved) IS NOT TRUE THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA016',
      MESSAGE = format('report dataset %s: its declared or resolved subsidiaries are not its version''s', NEW."id");
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT s.id ORDER BY s.id) INTO referenced
  FROM (
    SELECT (j #>> '{}')::uuid AS id
    FROM pg_catalog.jsonb_path_query(doc, 'lax $.**.subsidiaryId') AS j
    WHERE pg_catalog.jsonb_typeof(j) = 'string'
    UNION ALL
    SELECT e::uuid FROM pg_catalog.jsonb_array_elements_text(doc->'boundary'->'subsidiaryIds') AS e
    UNION ALL
    SELECT e::uuid FROM pg_catalog.jsonb_array_elements_text(doc->'resolvedSubsidiaryIds') AS e
  ) s;
  -- The same set, and no id twice in the column (`referenced` is distinct);
  -- NULL on either side fails closed.
  IF (referenced IS NOT NULL
      AND pg_catalog.cardinality(referenced) = pg_catalog.cardinality(NEW."referenced_subsidiary_ids")
      AND referenced OPERATOR(pg_catalog.@>) NEW."referenced_subsidiary_ids"
      AND referenced OPERATOR(pg_catalog.<@) NEW."referenced_subsidiary_ids") IS NOT TRUE THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA016',
      MESSAGE = format('report dataset %s: its referenced subsidiaries are not the ones its content names', NEW."id");
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(referenced) AS r(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM "public"."subsidiaries" s
      WHERE s."id" = r.id AND s."organisation_id" = NEW."organisation_id"
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA016',
      MESSAGE = format('report dataset %s references a subsidiary outside its organisation', NEW."id");
  END IF;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION "public"."report_datasets_before_truncate"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'TA016',
    MESSAGE = format('%s holds retained report datasets: it cannot be truncated', TG_TABLE_NAME);
END
$fn$;

-- ALWAYS: they fire in replica mode too.
CREATE TRIGGER "report_datasets_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "report_datasets"
  FOR EACH ROW EXECUTE FUNCTION "public"."report_datasets_guard"();
ALTER TABLE "report_datasets" ENABLE ALWAYS TRIGGER "report_datasets_guard";
CREATE TRIGGER "report_datasets_before_truncate"
  BEFORE TRUNCATE ON "report_datasets"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."report_datasets_before_truncate"();
ALTER TABLE "report_datasets" ENABLE ALWAYS TRIGGER "report_datasets_before_truncate";

REVOKE ALL ON FUNCTION "public"."report_datasets_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."report_datasets_before_truncate"() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3. RLS and the client roles
-- ---------------------------------------------------------------------------
--
-- No client policy: an authenticated client reads no row, and holds no
-- privilege to try. The runtime role's policy keeps the table working should
-- its BYPASSRLS ever go (as `storage_intents_runtime_all`, LP1-03).
ALTER TABLE "report_datasets" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "report_datasets_runtime_all" ON "report_datasets"
  AS PERMISSIVE FOR ALL TO "tonyai_runtime"
  USING (true) WITH CHECK (true);

-- Supabase grants every new table to its client roles by default privilege;
-- the service role among them bypasses RLS. Taken back, all of it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping the report dataset client revokes';
    RETURN;
  END IF;
  REVOKE ALL ON "report_datasets" FROM anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION "public"."report_datasets_guard"() FROM anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION "public"."report_datasets_before_truncate"() FROM anon, authenticated, service_role;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. The runtime role (LP1-03) — `runtime-role.mjs` lists the same
-- ---------------------------------------------------------------------------
--
-- A capture inserts; the dataset routes read. Never UPDATE or DELETE.
GRANT SELECT, INSERT ON "report_datasets" TO "tonyai_runtime";

-- ---------------------------------------------------------------------------
-- 5. Every function in `public`: pg_temp searched LAST
-- ---------------------------------------------------------------------------
--
-- With `search_path = ''` PostgreSQL still searches the session's temporary
-- schema FIRST for type (and relation) names, and every login holds TEMP
-- (PUBLIC's default). A function then runs a caller's `CREATE DOMAIN
-- pg_temp.text … CHECK (pg_temp.f(VALUE))` the moment it casts to or
-- declares that type — as whoever it runs as. A SECURITY DEFINER runs as its
-- owner (`security-rls`'s P1 on this PR, reproduced as the runtime login:
-- `current_user=postgres`); and so does an INVOKER function a definer calls,
-- or a trigger an owner-run statement fires — the factor event recorders'
-- `factor_release_events_actor_role()` helper ran the factor loader's domain
-- as postgres (Codex's P1, reproduced from a fresh loader login), as would
-- any trigger an FK cascade (run as the table's owner) reaches. So safety is
-- not a function's own `prosecdef`: every function here — all are the
-- tables' owner's — names pg_catalog first and pg_temp last, which resolves
-- every unqualified type to the catalog's (functions and operators were never
-- looked up in pg_temp). The bodies are unchanged; `runtime-role.mjs` holds
-- every function in `public` to this path.
ALTER FUNCTION "public"."activity_records_committed_delete"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."activity_records_lifecycle_writer"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."activity_records_slot_kind"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."activity_records_snapshot_immutable"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_release_events_actor_role"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_release_events_before_insert"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_release_events_refuse"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_releases_before_delete"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_releases_before_insert"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_releases_before_update"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_releases_record_event"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_releases_sealed_at_commit"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_rows_before_delete"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_rows_before_insert"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_rows_before_update"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_rows_record_event"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."factor_tables_before_truncate"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."geography_code_writer"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."inventory_boundaries_frozen"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."inventory_boundary_before_truncate"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."inventory_boundary_rows_frozen"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."organisations_delete_owner_only"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."organisations_remove_access_before_delete"() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION "public"."subsidiaries_stay_in_organisation"() SET search_path = pg_catalog, pg_temp;
