-- LP4-02 B2's record-lifecycle follow-ups (Open questions, "LP4-02
-- follow-ups" (27), (29), (33); the owner's D1a–D4a, 2026-10-15; W12): what a
-- draft is priced from is the API's to write, and what a record says is
-- refused at the door when no API could have written it.
--
-- Before this, a direct database write could:
--   * (27) change a subsidiary's or a site's `geography_code` — the service
--     role through PostgREST (table privileges, no guard), with no audit row.
--     A draft saved again while the flip held was priced against the other
--     country's factor, and K11 recomputed it with the same geography at
--     submit and approve.
--   * (29) insert a NEW draft — the service role through PostgREST — whose
--     inputs are forged (value, unit, category, type, year, period, site,
--     `input`, `import_batch_id`, `created_by`), carrying the engine's honest
--     snapshot for them: K11 checks the figure against the inputs, not the
--     inputs' truth.
--   * (33) store a record whose `scope` is not its category's, whose
--     `period_value` is not its granularity's canonical token, or whose
--     `activity_value` is negative, NaN, infinite or past any figure the
--     engine can price — refused only at commit (K11) or by the engine.
-- The API does none of these: it changes a geography in its own session,
-- audited in the same transaction; it creates records as `tonyai_runtime`; it
-- derives the scope from the category, canonicalises the period and (now)
-- bounds the value in its DTOs. None of this changes what the API does.
--
-- 1. (27) `geography_code_writer` (TA015): a subsidiary's or a site's
--    geography changes in the API's session or the owner's alone. A trigger,
--    not a REVOKE (D1a): the service role holds UPDATE on the whole table, so
--    a column REVOKE is no refusal, and the triggers are what refuse it here
--    (LP4-01's rule) — whatever a later GRANT ALL hands back.
-- 2. (29) `activity_records_lifecycle_writer`'s INSERT branch (TA006, K11's
--    rule): a record is inserted in the API's session or the owner's alone —
--    the e2e suite already creates its drafts through the API; `rls:probe`
--    and the integration fixtures insert theirs as the owner (D2a).
--    What no guard can tell apart: a session holding the runtime login's own
--    credential IS the API to the database (`session_user` is all it can
--    read; `application_name` is the client's to say). That residual is the
--    credential's custody (LP2), behind K11's recompute, the author's own
--    submit and another super_admin's approval.
-- 3. (33) three CHECKs, every writer — the owner included: the scope is the
--    category's (CATEGORY_SCOPE_MAP), the period value is one of its
--    granularity's canonical tokens (PERIOD_VALUES), and 0 ≤ activity_value ≤
--    ACTIVITY_VALUE_MAX (1e12; NaN and ±Infinity fail it). Each CASE ends in
--    ELSE false: a category or a granularity it does not name is refused,
--    not NULL — and a NULL CHECK passes. A new category or token needs a
--    migration here; `record-checks.spec.ts` holds both copies together.
--
-- `runtime-role.mjs check` holds it all: the two new triggers present,
-- ENABLE ALWAYS and unaltered (`locations` joins the guarded tables), the
-- lifecycle writer's new body, and the three CHECKs' definitions (md5 pins).

-- The migration holds ACCESS EXCLUSIVE on `activity_records` (the CHECKs scan
-- it) and SHARE ROW EXCLUSIVE on `subsidiaries` and `locations` until it
-- commits. Each lock wait gives up after 5 s rather than stall every request
-- behind a long transaction. Then, or if a stored record breaks a CHECK (the
-- error names the constraint; a committed record is K5's, so its repair is
-- the owner's decision), Prisma records the migration as failed and rolls it
-- back whole: resolve it with `prisma migrate resolve --rolled-back
-- 20261017120000_lp4_02_record_write_guards` before deploying again.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. (27) A geography is the API's to change
-- ---------------------------------------------------------------------------

-- A whole-row trigger, not UPDATE OF: the integrity check refuses a narrowed
-- one. An INSERT is not guarded (D4a): a new subsidiary or site has no
-- record priced under it yet.
CREATE FUNCTION "public"."geography_code_writer"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF NEW."geography_code" IS DISTINCT FROM OLD."geography_code"
     AND session_user <> 'tonyai_runtime'
     AND session_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA015',
      MESSAGE = format('%s %s keeps its geography — the factor its records are priced with: only the API, which audits it, or the database owner changes it, not %s', TG_TABLE_NAME, OLD."id", session_user);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "subsidiaries_geography_writer"
  BEFORE UPDATE ON "subsidiaries"
  FOR EACH ROW EXECUTE FUNCTION "public"."geography_code_writer"();
ALTER TABLE "subsidiaries" ENABLE ALWAYS TRIGGER "subsidiaries_geography_writer";

CREATE TRIGGER "locations_geography_writer"
  BEFORE UPDATE ON "locations"
  FOR EACH ROW EXECUTE FUNCTION "public"."geography_code_writer"();
ALTER TABLE "locations" ENABLE ALWAYS TRIGGER "locations_geography_writer";

-- ---------------------------------------------------------------------------
-- 2. (29) A record is the API's to insert
-- ---------------------------------------------------------------------------

-- LP4-02 PR B1's body, and an insert outside the API's session or the
-- owner's is refused (TA006), after the born-a-draft rule (TA005) — replica
-- mode (a data-only restore, which only the owner may set) excepted, as there.
CREATE OR REPLACE FUNCTION "public"."activity_records_lifecycle_writer"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft'
       AND pg_catalog.current_setting('session_replication_role') <> 'replica'
       AND session_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA005',
        MESSAGE = format('activity record %s is created as a draft, not as %s: a committed status comes from the review lifecycle, not an insert', NEW."id", NEW."status");
    END IF;
    IF session_user <> 'tonyai_runtime'
       AND pg_catalog.current_setting('session_replication_role') <> 'replica'
       AND session_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA006',
        MESSAGE = format('activity record %s is created by the API, which computes its figure from the inputs it was given, not by %s', NEW."id", session_user);
    END IF;
  ELSIF session_user <> 'tonyai_runtime'
        AND session_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA005',
        MESSAGE = format('activity record %s moves from %s to %s only through the API, not as %s', OLD."id", OLD."status", NEW."status", session_user);
    END IF;
    IF NEW."input" IS DISTINCT FROM OLD."input"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR (OLD."status" IN ('draft', 'rejected') AND (
            NEW."calculation" IS DISTINCT FROM OLD."calculation"
         OR NEW."activity_type" IS DISTINCT FROM OLD."activity_type"
         OR NEW."category" IS DISTINCT FROM OLD."category"
         OR NEW."activity_value" IS DISTINCT FROM OLD."activity_value"
         OR NEW."activity_unit" IS DISTINCT FROM OLD."activity_unit"
         OR NEW."scope" IS DISTINCT FROM OLD."scope"
         OR NEW."reporting_year" IS DISTINCT FROM OLD."reporting_year"
         OR NEW."reporting_period" IS DISTINCT FROM OLD."reporting_period"
         OR NEW."period_value" IS DISTINCT FROM OLD."period_value"
         OR NEW."subsidiary_id" IS DISTINCT FROM OLD."subsidiary_id"
         OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
       )) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA006',
        MESSAGE = format('activity record %s keeps the figure the API computed, the inputs it computed it from and who wrote it: only the API changes them, not %s', OLD."id", session_user);
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 3. (33) What a record says, at the door
-- ---------------------------------------------------------------------------

ALTER TABLE "activity_records"
  ADD CONSTRAINT "activity_records_scope_check" CHECK (
    CASE "category"
      WHEN 'Electricity' THEN "scope" = 2
      WHEN 'Natural Gas' THEN "scope" = 1
      WHEN 'Fuel' THEN "scope" = 1
      WHEN 'Mobile Combustion' THEN "scope" = 1
      WHEN 'Refrigerants' THEN "scope" = 1
      WHEN 'Purchased Goods' THEN "scope" = 3
      WHEN 'Waste' THEN "scope" = 3
      WHEN 'Water' THEN "scope" = 3
      WHEN 'Business Travel' THEN "scope" = 3
      WHEN 'Commuting' THEN "scope" = 3
      WHEN 'Logistics' THEN "scope" = 3
      ELSE false
    END
  ),
  ADD CONSTRAINT "activity_records_period_value_check" CHECK (
    CASE "reporting_period"
      WHEN 'monthly' THEN "period_value" IN ('January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December')
      WHEN 'quarterly' THEN "period_value" IN ('Q1', 'Q2', 'Q3', 'Q4')
      WHEN 'annual' THEN "period_value" IN ('Annual')
      ELSE false
    END
  ),
  ADD CONSTRAINT "activity_records_activity_value_check" CHECK ("activity_value" >= 0 AND "activity_value" <= 1e12::double precision);

-- ---------------------------------------------------------------------------
-- 4. The new function's EXECUTE
-- ---------------------------------------------------------------------------

-- Born owner-only since OQ 14 (this role's defaults); said explicitly, so the
-- function stays owner-only on a database whose defaults differ. A trigger
-- fires without its function's EXECUTE. CREATE OR REPLACE kept the lifecycle
-- writer's ACL.
REVOKE ALL ON FUNCTION "public"."geography_code_writer"() FROM PUBLIC;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping their EXECUTE';
    RETURN;
  END IF;
  REVOKE ALL ON FUNCTION "public"."geography_code_writer"() FROM anon, authenticated, service_role;
END
$$;
