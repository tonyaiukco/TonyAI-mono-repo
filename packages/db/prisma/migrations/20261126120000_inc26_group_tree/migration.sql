-- Expand-only: new columns with defaults, a nullable self-reference, the
-- carry-over of existing companies into one tree per organisation, two CHECKs,
-- four triggers and column grants. No table, index or policy is dropped or
-- changed, and nothing is renamed. The previous API image keeps working on
-- this schema: a company it creates names no parent and is placed under the
-- organisation's root by the `subsidiaries_tree_shape` trigger (RD14), and it
-- meets a refusal only when it writes to an associate or a sector group, which
-- only the new image can create. No forward-only mark.
--
-- WP7 (`inc26-group-tree`) — INC-2.6 Rev.3 §2, §3, §5: the companies of an
-- organisation form one recursive tree (design D1–D3).
--
-- Order (design "Migration Plan" step 1):
--   1. enums and columns with their defaults;
--   2. the composite self-reference and its index;
--   3. the carry-over, with one audit row per created or changed node (D3);
--   4. the CHECKs;
--   5. the triggers TA018–TA023 (D2), created after the carry-over so it runs
--      as plain SQL;
--   6. the runtime role's column grants.
--
-- Hand-written: `prisma migrate dev` re-proposes dropping the raw NULLS NOT
-- DISTINCT index "activity_records_reporting_entity_period_category_key" on
-- every generation (CLAUDE.md). This migration drops no index. `audit_log` is
-- append-only: INSERT is the only statement run on it.

-- ALTER TABLE takes ACCESS EXCLUSIVE locks until commit; queued behind a long
-- transaction it would stall every request. Give up instead, and let the
-- deploy be retried.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Enums and columns (design D1)
-- ---------------------------------------------------------------------------

CREATE TYPE "subsidiary_node_type" AS ENUM ('holding', 'sub_holding', 'sector_group', 'company', 'child_company');
CREATE TYPE "subsidiary_control" AS ENUM ('controlled', 'associate');
CREATE TYPE "consolidation_approach" AS ENUM ('operational_control', 'financial_control');
CREATE TYPE "location_type" AS ENUM ('warehouse', 'office', 'factory', 'plant', 'refinery', 'retail_shop', 'mall', 'building', 'apartment', 'rms_station');

ALTER TABLE "locations" ADD COLUMN     "location_type" "location_type";

-- Every organisation, existing ones included, holds operational control.
ALTER TABLE "organisations" ADD COLUMN     "consolidation_approach" "consolidation_approach" NOT NULL DEFAULT 'operational_control';

ALTER TABLE "subsidiaries" ADD COLUMN     "control" "subsidiary_control" NOT NULL DEFAULT 'controlled',
ADD COLUMN     "created_by_role" "UserRole",
ADD COLUMN     "nace_code" TEXT,
ADD COLUMN     "node_type" "subsidiary_node_type" NOT NULL DEFAULT 'company',
ADD COLUMN     "parent_id" UUID,
ADD COLUMN     "share_percent" DECIMAL(5,2);

-- ---------------------------------------------------------------------------
-- 2. The self-reference (design D1)
-- ---------------------------------------------------------------------------

CREATE INDEX "subsidiaries_parent_id_idx" ON "subsidiaries"("parent_id");

-- Composite with the organisation, by the device of the other same-organisation
-- keys: a parent of another organisation cannot be stored. RESTRICT: a node
-- with a child is not deleted, and no key change carries children along.
ALTER TABLE "subsidiaries" ADD CONSTRAINT "subsidiaries_parent_id_organisation_id_fkey" FOREIGN KEY ("parent_id", "organisation_id") REFERENCES "subsidiaries"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 3. The carry-over (design D3, RD1)
-- ---------------------------------------------------------------------------
--
-- For each organisation with at least one subsidiary: the oldest subsidiary
-- carrying the organisation's legal name becomes the `holding` (its id,
-- records, grants and facilities untouched); with none, a `holding` is created
-- as the default subsidiary is (`apps/api/src/subsidiaries/default-subsidiary.ts`:
-- the organisation's legal name, trading name, sector and geography; Scope 1
-- and 2; subsidiary-level tracking; pending; no facility, grant or boundary
-- entry). Every other subsidiary becomes a controlled `company` under it. An
-- organisation with no subsidiary gets nothing: its first node becomes its
-- root.
--
-- One audit row per created or changed node, with the existing verbs and
-- entity, so the previous image's audit page reads them as ordinary rows: no
-- acting user and no role (the migration acted), `diff.source` naming the
-- carry-over, the earlier and new parent and type, and no company name (as the
-- default subsidiary's creation row). `updated_at` is not bumped on the
-- existing rows: nothing an editor typed changed. No record, grant, lock,
-- boundary or emission figure changes (a created root is one more company,
-- with no record, in a company count).

-- 3a. A root created where no company mirrors the organisation.
WITH needs_root AS (
  SELECT o."id", o."legal_name", o."trading_name", o."sector", o."geography_code"
  FROM "organisations" o
  WHERE EXISTS (SELECT 1 FROM "subsidiaries" s WHERE s."organisation_id" = o."id")
    AND NOT EXISTS (
      SELECT 1 FROM "subsidiaries" s WHERE s."organisation_id" = o."id" AND s."legal_name" = o."legal_name"
    )
), created AS (
  INSERT INTO "subsidiaries" (
    "id", "organisation_id", "legal_name", "trading_name", "sector", "geography_code",
    "reporting_status", "included_scopes", "tracking_granularity", "node_type", "control", "updated_at"
  )
  SELECT gen_random_uuid(), n."id", n."legal_name", n."trading_name", n."sector", n."geography_code",
         'pending', ARRAY[1, 2], 'subsidiary', 'holding', 'controlled', now()
  FROM needs_root n
  RETURNING "id", "organisation_id", "geography_code"
)
INSERT INTO "audit_log" ("id", "user_id", "action", "entity", "entity_id", "diff", "organisation_id", "role")
SELECT
  gen_random_uuid(),
  NULL,
  'create',
  'subsidiary',
  c."id"::text,
  jsonb_build_object(
    'source', 'migration:inc26-group-tree',
    'carryOver', true,
    'default', true,
    'geographyCode', c."geography_code",
    'includedScopes', jsonb_build_array(1, 2),
    'trackingGranularity', 'subsidiary',
    'reportingStatus', 'pending',
    'parentId', jsonb_build_object('before', NULL, 'after', NULL),
    'nodeType', jsonb_build_object('before', NULL, 'after', 'holding')
  ),
  c."organisation_id",
  NULL
FROM created c;

-- 3b. The oldest mirror company promoted to the root.
WITH mirror AS (
  SELECT DISTINCT ON (s."organisation_id") s."id"
  FROM "subsidiaries" s
  JOIN "organisations" o ON o."id" = s."organisation_id"
  WHERE s."legal_name" = o."legal_name"
    AND s."node_type" <> 'holding'
    AND NOT EXISTS (
      SELECT 1 FROM "subsidiaries" h WHERE h."organisation_id" = s."organisation_id" AND h."node_type" = 'holding'
    )
  ORDER BY s."organisation_id", s."created_at", s."id"
), promoted AS (
  UPDATE "subsidiaries" s
  SET "node_type" = 'holding', "control" = 'controlled'
  FROM mirror m
  WHERE s."id" = m."id"
  RETURNING s."id", s."organisation_id"
)
INSERT INTO "audit_log" ("id", "user_id", "action", "entity", "entity_id", "diff", "organisation_id", "role")
SELECT
  gen_random_uuid(),
  NULL,
  'update',
  'subsidiary',
  p."id"::text,
  jsonb_build_object(
    'source', 'migration:inc26-group-tree',
    'carryOver', true,
    'parentId', jsonb_build_object('before', NULL, 'after', NULL),
    'nodeType', jsonb_build_object('before', NULL, 'after', 'holding')
  ),
  p."organisation_id",
  NULL
FROM promoted p;

-- 3c. Every other company placed under its organisation's root.
WITH roots AS (
  SELECT s."organisation_id", s."id" AS "root_id"
  FROM "subsidiaries" s
  WHERE s."node_type" = 'holding'
), placed AS (
  UPDATE "subsidiaries" s
  SET "parent_id" = r."root_id", "node_type" = 'company', "control" = 'controlled'
  FROM roots r
  WHERE s."organisation_id" = r."organisation_id"
    AND s."id" <> r."root_id"
  RETURNING s."id", s."organisation_id", s."parent_id"
)
INSERT INTO "audit_log" ("id", "user_id", "action", "entity", "entity_id", "diff", "organisation_id", "role")
SELECT
  gen_random_uuid(),
  NULL,
  'update',
  'subsidiary',
  p."id"::text,
  jsonb_build_object(
    'source', 'migration:inc26-group-tree',
    'carryOver', true,
    'parentId', jsonb_build_object('before', NULL, 'after', p."parent_id"),
    'nodeType', jsonb_build_object('before', NULL, 'after', 'company')
  ),
  p."organisation_id",
  NULL
FROM placed p;

-- ---------------------------------------------------------------------------
-- 4. CHECKs (design D2; pinned in runtime-role.mjs INTEGRITY_CHECKS)
-- ---------------------------------------------------------------------------

-- Only the root has no parent, and the root is the holding. Backs the trigger;
-- a data-only restore, which the trigger lets through, is held by it too.
ALTER TABLE "subsidiaries" ADD CONSTRAINT "subsidiaries_root_check"
  CHECK ((("node_type" = 'holding') = ("parent_id" IS NULL)));

-- Inert, but a percentage.
ALTER TABLE "subsidiaries" ADD CONSTRAINT "subsidiaries_share_percent_check"
  CHECK ((("share_percent" IS NULL) OR (("share_percent" >= 0) AND ("share_percent" <= 100))));

-- ---------------------------------------------------------------------------
-- 5. The tree's integrity triggers (design D2)
-- ---------------------------------------------------------------------------
--
-- ENABLE ALWAYS, so they bind every session, the owner's included; the only
-- exemption is a data-only restore in replica mode (a setting only a
-- privileged role may change), because a restore inserts rows in no tree
-- order — the slot rule's own exemption. Each message starts with the API
-- error code it answers as (`apps/api/src/subsidiaries/tree-errors.ts`), so a
-- refusal reached through a race maps to the same code as the API's own check.
-- None is narrowed by an `UPDATE OF` list (`runtime-role.mjs check` refuses
-- one): each fires on every update and returns at once when its columns did
-- not change.

-- TA018: the shape of the tree. Every check reads the tree under an advisory
-- lock keyed on the organisation, so no concurrent writer changes it while the
-- check runs; under READ COMMITTED each statement then reads what such a
-- writer committed while this one waited.
CREATE FUNCTION "public"."subsidiaries_tree_shape"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  root_id uuid;
  parent_type text;
  parent_control text;
  subtree uuid[];
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."node_type" IS DISTINCT FROM OLD."node_type" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA018',
      MESSAGE = format('node_type_fixed: subsidiary %s keeps the type it was created with', OLD."id");
  END IF;
  -- A change of organisation (an owner session only; TA004) is a placement
  -- change too: a moved root must not become an organisation's second root.
  IF TG_OP = 'UPDATE'
     AND NEW."parent_id" IS NOT DISTINCT FROM OLD."parent_id"
     AND NEW."control" IS NOT DISTINCT FROM OLD."control"
     AND NEW."organisation_id" IS NOT DISTINCT FROM OLD."organisation_id" THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA018',
      MESSAGE = 'write the group tree under READ COMMITTED: a stricter isolation level cannot see a node or record committed meanwhile';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('tonyai.subsidiary_tree'),
    pg_catalog.hashtext(NEW."organisation_id"::text));

  -- A company written without a parent, by any writer (the previous image, the
  -- seed, a fixture): under the root, or the root itself when there is none
  -- (RD14).
  IF TG_OP = 'INSERT' AND NEW."parent_id" IS NULL AND NEW."node_type" <> 'holding' THEN
    SELECT s."id" INTO root_id
      FROM "public"."subsidiaries" s
     WHERE s."organisation_id" = NEW."organisation_id"
       AND s."node_type" = 'holding'
       AND s."id" <> NEW."id";
    IF root_id IS NULL THEN
      NEW."node_type" := 'holding';
    ELSE
      NEW."parent_id" := root_id;
    END IF;
  END IF;

  -- The holding is the one root.
  IF NEW."node_type" = 'holding' THEN
    IF NEW."parent_id" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA018',
        MESSAGE = format('node_placement_invalid: subsidiary %s is the holding, the root: it has no parent', NEW."id");
    END IF;
    IF EXISTS (
      SELECT 1 FROM "public"."subsidiaries" s
       WHERE s."organisation_id" = NEW."organisation_id"
         AND s."node_type" = 'holding'
         AND s."id" <> NEW."id"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA018',
        MESSAGE = format('node_placement_invalid: organisation %s already has its holding', NEW."organisation_id");
    END IF;
  ELSIF NEW."parent_id" IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA018',
      MESSAGE = format('node_placement_invalid: subsidiary %s needs a parent: only the holding has none', NEW."id");
  END IF;

  -- Placement by type (RD7); never under an associate.
  IF NEW."parent_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."parent_id" IS DISTINCT FROM OLD."parent_id") THEN
    SELECT s."node_type"::text, s."control"::text INTO parent_type, parent_control
      FROM "public"."subsidiaries" s
     WHERE s."id" = NEW."parent_id"
       AND s."organisation_id" = NEW."organisation_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA018',
        MESSAGE = format('node_placement_invalid: the parent of subsidiary %s is not a node of its organisation', NEW."id");
    END IF;
    IF parent_control = 'associate'
       OR NOT (
         (parent_type IN ('holding', 'sub_holding') AND NEW."node_type" IN ('sub_holding', 'sector_group', 'company'))
         OR (parent_type = 'sector_group' AND NEW."node_type" = 'company')
         OR (parent_type IN ('company', 'child_company') AND NEW."node_type" = 'child_company')
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA018',
        MESSAGE = format('node_placement_invalid: a %s cannot sit under a %s %s', NEW."node_type", parent_control, parent_type);
    END IF;
  END IF;

  -- A move: never under the node's own subtree, and never while the subtree
  -- holds a record in any status (RD6). The subtree's rows are locked before
  -- the records are counted, so a record being created for a node beneath —
  -- which share-locks that node's row (TA019) — has committed or waits.
  IF TG_OP = 'UPDATE' AND NEW."parent_id" IS DISTINCT FROM OLD."parent_id" THEN
    IF NEW."parent_id" = NEW."id" OR EXISTS (
      WITH RECURSIVE up ("id", "parent_id") AS (
        SELECT s."id", s."parent_id" FROM "public"."subsidiaries" s WHERE s."id" = NEW."parent_id"
        UNION
        SELECT s."id", s."parent_id" FROM "public"."subsidiaries" s JOIN up ON s."id" = up."parent_id"
      )
      SELECT 1 FROM up WHERE up."id" = NEW."id"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA018',
        MESSAGE = format('tree_cycle: subsidiary %s cannot move under itself or a node beneath it', NEW."id");
    END IF;
    WITH RECURSIVE down ("id") AS (
      SELECT NEW."id"
      UNION
      SELECT s."id" FROM "public"."subsidiaries" s JOIN down d ON s."parent_id" = d."id"
    )
    SELECT pg_catalog.array_agg(down."id") INTO subtree FROM down;
    PERFORM 1 FROM "public"."subsidiaries" s WHERE s."id" = ANY (subtree) FOR NO KEY UPDATE;
    IF EXISTS (SELECT 1 FROM "public"."activity_records" r WHERE r."subsidiary_id" = ANY (subtree)) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA018',
        MESSAGE = format('node_move_blocked: subsidiary %s or a node beneath it holds activity records', NEW."id");
    END IF;
  END IF;

  -- Associate: a company or child company only, and only while it has no
  -- child, no record and no grant (RD3; the API also checks the boundary).
  -- The node's own row is locked by this UPDATE, so a record or grant being
  -- created for it — which share-locks that row (TA019, TA020) — has
  -- committed, and is counted, or waits and is then refused.
  IF NEW."control" = 'associate'
     AND (TG_OP = 'INSERT' OR OLD."control" IS DISTINCT FROM 'associate') THEN
    IF NEW."node_type" NOT IN ('company', 'child_company') THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA018',
        MESSAGE = format('node_placement_invalid: a %s is always controlled', NEW."node_type");
    END IF;
    -- Nor while a year's current boundary — its newest version — declares it.
    -- An older version that declares it can never become current again:
    -- deleting the open version after it is refused then
    -- (`inventory_boundaries_keep_current_reportable`; owner reviews of WP7).
    IF TG_OP = 'UPDATE' AND (
      EXISTS (SELECT 1 FROM "public"."subsidiaries" c WHERE c."parent_id" = NEW."id")
      OR EXISTS (SELECT 1 FROM "public"."activity_records" r WHERE r."subsidiary_id" = NEW."id")
      OR EXISTS (SELECT 1 FROM "public"."user_subsidiary_access" a WHERE a."subsidiary_id" = NEW."id")
      OR EXISTS (
        SELECT 1
          FROM "public"."inventory_boundary_subsidiaries" d
          JOIN "public"."inventory_boundaries" b ON b."id" = d."boundary_id"
         WHERE d."subsidiary_id" = NEW."id"
           AND b."version" = (SELECT max(n."version") FROM "public"."inventory_boundaries" n
                               WHERE n."organisation_id" = b."organisation_id" AND n."reporting_year" = b."reporting_year"))
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA018',
        MESSAGE = format('control_change_blocked: subsidiary %s has a child, a record, a grant or a declaration in a current boundary', NEW."id");
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "subsidiaries_tree_shape"
  BEFORE INSERT OR UPDATE ON "subsidiaries"
  FOR EACH ROW EXECUTE FUNCTION "public"."subsidiaries_tree_shape"();
ALTER TABLE "subsidiaries" ENABLE ALWAYS TRIGGER "subsidiaries_tree_shape";

-- TA019: no record for a node closed to data entry (a sector group, an
-- associate). The subsidiary's row is read FOR SHARE, which waits for a
-- concurrent control change (its NO KEY UPDATE), closing the race between
-- "tick associate" and "create a record" without serialising an
-- organisation's inserts on one lock.
CREATE FUNCTION "public"."activity_records_entity_open"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  node_type_v text;
  control_v text;
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."subsidiary_id" IS NOT DISTINCT FROM OLD."subsidiary_id" THEN
    RETURN NEW;
  END IF;
  SELECT s."node_type"::text, s."control"::text INTO node_type_v, control_v
    FROM "public"."subsidiaries" s
   WHERE s."id" = NEW."subsidiary_id"
     FOR SHARE;
  IF node_type_v = 'sector_group' OR control_v = 'associate' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA019',
      MESSAGE = format('entity_closed_to_data_entry: subsidiary %s is outside the Scope 1 and 2 inventory (a %s %s) and takes no activity record', NEW."subsidiary_id", control_v, node_type_v);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "activity_records_entity_open"
  BEFORE INSERT OR UPDATE ON "activity_records"
  FOR EACH ROW EXECUTE FUNCTION "public"."activity_records_entity_open"();
ALTER TABLE "activity_records" ENABLE ALWAYS TRIGGER "activity_records_entity_open";

-- TA020: no grant for a node closed to data entry, with the same row lock.
CREATE FUNCTION "public"."user_subsidiary_access_assignable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  node_type_v text;
  control_v text;
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."subsidiary_id" IS NOT DISTINCT FROM OLD."subsidiary_id" THEN
    RETURN NEW;
  END IF;
  SELECT s."node_type"::text, s."control"::text INTO node_type_v, control_v
    FROM "public"."subsidiaries" s
   WHERE s."id" = NEW."subsidiary_id"
     FOR SHARE;
  IF node_type_v = 'sector_group' OR control_v = 'associate' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA020',
      MESSAGE = format('subsidiary_not_assignable: subsidiary %s (a %s %s) cannot be assigned to a user', NEW."subsidiary_id", control_v, node_type_v);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "user_subsidiary_access_assignable"
  BEFORE INSERT OR UPDATE ON "user_subsidiary_access"
  FOR EACH ROW EXECUTE FUNCTION "public"."user_subsidiary_access_assignable"();
ALTER TABLE "user_subsidiary_access" ENABLE ALWAYS TRIGGER "user_subsidiary_access_assignable";

-- TA021: a facility belongs to a node that can hold records' sites — never a
-- sector group (a label). A facility of an associate stays valid (§2.1: it is
-- registered; TA019 closes it to data entry). A sector group's type is fixed,
-- so no company holding a facility ever becomes one.
CREATE FUNCTION "public"."locations_company_holds_records"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  node_type_v text;
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."subsidiary_id" IS NOT DISTINCT FROM OLD."subsidiary_id" THEN
    RETURN NEW;
  END IF;
  -- A facility stays with its company (owner review of WP7, P1): moving it
  -- away would empty a company for a delete the API refuses (RD9).
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA021',
      MESSAGE = format('node_placement_invalid: facility %s stays with its company', NEW."id");
  END IF;
  SELECT s."node_type"::text INTO node_type_v
    FROM "public"."subsidiaries" s
   WHERE s."id" = NEW."subsidiary_id";
  IF node_type_v = 'sector_group' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA021',
      MESSAGE = format('node_placement_invalid: subsidiary %s is a sector group and holds no facility', NEW."subsidiary_id");
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "locations_company_holds_records"
  BEFORE INSERT OR UPDATE ON "locations"
  FOR EACH ROW EXECUTE FUNCTION "public"."locations_company_holds_records"();
ALTER TABLE "locations" ENABLE ALWAYS TRIGGER "locations_company_holds_records";

-- TA023: a company with a facility is not deleted (RD9), by any writer — the
-- key from `locations` still cascades, so the API's refusal alone left a
-- direct delete free to take the facilities with it (owner review of WP7,
-- P1). The previous API image swept a company's facilities and then deleted
-- it in one transaction: `locations_note_removal` notes each facility deleted
-- in the transaction, and the company of one is refused too, so a rollback
-- to that image cannot remove facilities either (its delete is refused). A
-- delete reached through a key's cascade — an organisation's offboarding —
-- is the cascade's, and passes.
CREATE FUNCTION "public"."subsidiaries_keep_facilities"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN OLD;
  END IF;
  IF pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM "public"."locations" l WHERE l."subsidiary_id" = OLD."id")
     OR pg_catalog.strpos(
          COALESCE(pg_catalog.current_setting('tonyai.facility_removed_from', true), ''),
          OLD."id"::text) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA023',
      MESSAGE = format('subsidiary_in_use: subsidiary %s holds a facility, or had one deleted in this transaction; delete each facility on its own first', OLD."id");
  END IF;
  RETURN OLD;
END
$fn$;

CREATE TRIGGER "subsidiaries_keep_facilities"
  BEFORE DELETE ON "subsidiaries"
  FOR EACH ROW EXECUTE FUNCTION "public"."subsidiaries_keep_facilities"();
ALTER TABLE "subsidiaries" ENABLE ALWAYS TRIGGER "subsidiaries_keep_facilities";

-- A facility deleted on its own names its company for the rest of the
-- transaction (TA023's second half). A cascade's delete is not noted.
CREATE FUNCTION "public"."locations_note_removal"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN OLD;
  END IF;
  IF pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  PERFORM pg_catalog.set_config(
    'tonyai.facility_removed_from',
    COALESCE(pg_catalog.current_setting('tonyai.facility_removed_from', true), '') || ',' || OLD."subsidiary_id"::text,
    true);
  RETURN OLD;
END
$fn$;

CREATE TRIGGER "locations_note_removal"
  AFTER DELETE ON "locations"
  FOR EACH ROW EXECUTE FUNCTION "public"."locations_note_removal"();
ALTER TABLE "locations" ENABLE ALWAYS TRIGGER "locations_note_removal";

-- TA022: an associate or a sector group is outside the inventory boundary
-- (D6): never declared in a version — a copy, a declaration or any other
-- writer. The company row is read FOR SHARE, so an associate tick (which
-- takes it FOR NO KEY UPDATE) and a declaration are serialised either way.
-- A row rewritten in place (a name copied in at confirmation) keeps its
-- company and is not re-read.
CREATE FUNCTION "public"."inventory_boundary_subsidiaries_reportable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  node_type_v text;
  control_v text;
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."subsidiary_id" IS NOT DISTINCT FROM OLD."subsidiary_id" THEN
    RETURN NEW;
  END IF;
  SELECT s."node_type"::text, s."control"::text INTO node_type_v, control_v
    FROM "public"."subsidiaries" s
   WHERE s."id" = NEW."subsidiary_id"
     FOR SHARE;
  IF node_type_v = 'sector_group' OR control_v = 'associate' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA022',
      MESSAGE = format('boundary_subsidiary_not_reportable: subsidiary %s (a %s %s) is outside the inventory boundary', NEW."subsidiary_id", control_v, node_type_v);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "inventory_boundary_subsidiaries_reportable"
  BEFORE INSERT OR UPDATE ON "inventory_boundary_subsidiaries"
  FOR EACH ROW EXECUTE FUNCTION "public"."inventory_boundary_subsidiaries_reportable"();
ALTER TABLE "inventory_boundary_subsidiaries" ENABLE ALWAYS TRIGGER "inventory_boundary_subsidiaries_reportable";

-- TA022's other half: a year's current boundary never comes to declare an
-- associate or a sector group by a delete. Deleting the newest version makes
-- the one before it current again; when that one declares a company ticked
-- associate since (the tick looks at the newest version only), the delete is
-- refused — the open version is edited or confirmed instead, and no frozen
-- version is ever rewritten (owner reviews of WP7). The companies are read
-- FOR SHARE, so a concurrent tick and the delete are serialised. An
-- organisation's offboarding cascade passes.
CREATE FUNCTION "public"."inventory_boundaries_keep_current_reportable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  previous_id uuid;
  previous_version integer;
  closed_id uuid;
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN OLD;
  END IF;
  IF pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM "public"."inventory_boundaries" n
              WHERE n."organisation_id" = OLD."organisation_id" AND n."reporting_year" = OLD."reporting_year"
                AND n."version" > OLD."version") THEN
    RETURN OLD;
  END IF;
  SELECT p."id", p."version" INTO previous_id, previous_version
    FROM "public"."inventory_boundaries" p
   WHERE p."organisation_id" = OLD."organisation_id" AND p."reporting_year" = OLD."reporting_year"
     AND p."version" < OLD."version"
   ORDER BY p."version" DESC
   LIMIT 1;
  IF previous_id IS NULL THEN
    RETURN OLD;
  END IF;
  -- Every company the version before declares, locked FOR SHARE in id order
  -- BEFORE any is judged — a company still controlled here may be mid-tick,
  -- and a lock taken only on rows already closed would let that tick and this
  -- delete both commit (owner's third review of WP7, P1). The API locks the
  -- same set the same way.
  PERFORM 1
     FROM "public"."subsidiaries" s
     JOIN "public"."inventory_boundary_subsidiaries" d ON d."subsidiary_id" = s."id"
    WHERE d."boundary_id" = previous_id
    ORDER BY s."id"
      FOR SHARE OF s;
  -- A new statement: it reads each company as committed once its lock was had.
  SELECT s."id" INTO closed_id
    FROM "public"."subsidiaries" s
    JOIN "public"."inventory_boundary_subsidiaries" d ON d."subsidiary_id" = s."id"
   WHERE d."boundary_id" = previous_id
     AND (s."node_type" = 'sector_group' OR s."control" = 'associate')
   ORDER BY s."id"
   LIMIT 1;
  IF closed_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA022',
      MESSAGE = format('boundary_subsidiary_not_reportable: deleting version %s would make version %s current again, which declares subsidiary %s outside the inventory boundary', OLD."version", previous_version, closed_id);
  END IF;
  RETURN OLD;
END
$fn$;

CREATE TRIGGER "inventory_boundaries_keep_current_reportable"
  BEFORE DELETE ON "inventory_boundaries"
  FOR EACH ROW EXECUTE FUNCTION "public"."inventory_boundaries_keep_current_reportable"();
ALTER TABLE "inventory_boundaries" ENABLE ALWAYS TRIGGER "inventory_boundaries_keep_current_reportable";

-- ---------------------------------------------------------------------------
-- 6. Runtime grants (design D2; runtime-role.mjs RUNTIME_COLUMN_UPDATES)
-- ---------------------------------------------------------------------------

-- A move, a control tick and the two inert fields. Never `node_type` (fixed at
-- creation) or `created_by_role` (written once, at insert): the runtime role
-- cannot change either. `locations` holds a table-wide UPDATE already.
GRANT UPDATE ("parent_id", "control", "share_percent", "nace_code") ON "subsidiaries" TO "tonyai_runtime";
-- The consolidation approach (D8), and the row's version.
GRANT UPDATE ("consolidation_approach", "updated_at") ON "organisations" TO "tonyai_runtime";
-- Registration inserts an organisation through listed columns only, and
-- Prisma fills a static schema default itself (as it does a boundary
-- version's `decision`): without this, every registration fails.
GRANT INSERT ("consolidation_approach") ON "organisations" TO "tonyai_runtime";
