-- Expand-only: two new columns (one nullable, one with a default), two CHECKs,
-- one foreign key and its index, four triggers and one column grant. No table,
-- index or policy is dropped or changed, nothing is renamed, and no existing
-- row is rewritten: `activity_records` takes no UPDATE (an empty reporting
-- entity means the record's own company), and every existing access row reads
-- `assigned` from its default. The previous API image keeps working on this
-- schema: it writes `assigned` rows and records with no reporting entity, which
-- is their true reading until a masterkey gives the first central reporter
-- grant; after one exists the triggers still store the right reporting entity
-- and hold single entry for that image's writes (design "Migration Plan" 4).
-- No forward-only mark.
--
-- WP8 (`inc26-central-reporter-onboarding`) — INC-2.6 Rev.3 §4: a record's
-- owning and reporting entity, the central reporter grant and the single-entry
-- rule (design D1–D5).
--
-- Order:
--   1. the columns, the CHECKs, the foreign key and its index;
--   2. the triggers TA024–TA027;
--   3. the runtime role's column grant.
--
-- Hand-written: `prisma migrate dev` re-proposes dropping the raw NULLS NOT
-- DISTINCT index "activity_records_reporting_entity_period_category_key" on
-- every generation (CLAUDE.md). This migration drops no index.

-- ALTER TABLE takes ACCESS EXCLUSIVE locks until commit; queued behind a long
-- transaction it would stall every request. Give up instead, and let the
-- deploy be retried.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Columns, CHECKs, foreign key (design D1, D3)
-- ---------------------------------------------------------------------------

-- The reporting entity. NULL = the record's own company. No backfill.
ALTER TABLE "activity_records" ADD COLUMN "reported_by_subsidiary_id" UUID;

-- RESTRICT both ways (pinned in runtime-role.mjs RECORD_FOREIGN_KEYS): a
-- company a record names as its reporting entity is not deleted (C6), and a
-- referential action never writes a record as the owner.
ALTER TABLE "activity_records"
  ADD CONSTRAINT "activity_records_reported_by_subsidiary_id_fkey"
  FOREIGN KEY ("reported_by_subsidiary_id") REFERENCES "subsidiaries"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The foreign key's own check on a company's delete, TA027 and the delete
-- guard look records up by their reporting entity.
CREATE INDEX "activity_records_reported_by_subsidiary_id_idx"
  ON "activity_records"("reported_by_subsidiary_id");

-- The kind of an access row: an assigned company, or a company of a central
-- reporter grant. Every existing row is `assigned`.
ALTER TABLE "user_subsidiary_access" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'assigned';

ALTER TABLE "user_subsidiary_access"
  ADD CONSTRAINT "user_subsidiary_access_kind_check"
  CHECK ("kind" IN ('assigned', 'central_reporter'));

-- A grant row always carries the grant's one category list (§4.1).
ALTER TABLE "user_subsidiary_access"
  ADD CONSTRAINT "user_subsidiary_access_grant_categories_check"
  CHECK ("kind" <> 'central_reporter' OR cardinality("categories") > 0);

-- ---------------------------------------------------------------------------
-- 2. Triggers (design D2, D4, D5)
-- ---------------------------------------------------------------------------
--
-- None is narrowed by an `UPDATE OF` list or a `WHEN` clause
-- (`runtime-role.mjs check` refuses one): each fires on every insert and
-- update and returns at once when its columns did not change. Each steps aside
-- in replica mode, as TA018–TA023 do (a restore replays rows already judged).

-- TA024: what is opened to whom (§4.2, second sentence). At one company, a
-- category is open to the company's own standard users (`assigned` rows) or to
-- a central reporter (`central_reporter` rows), never both. Only a row whose
-- holder is a standard_user is a party: a super_admin's row carries `{}`, and a
-- stray grant carried onto a masterkey or an auditor (WP6) holds every
-- category. Under an advisory lock per organisation, so two writes that are
-- each valid alone serialise and the second sees the first.
CREATE FUNCTION "public"."user_subsidiary_access_single_entry"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  holder_role text;
  other_kind text;
  overlap text[];
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."user_id" IS NOT DISTINCT FROM OLD."user_id"
     AND NEW."subsidiary_id" IS NOT DISTINCT FROM OLD."subsidiary_id"
     AND NEW."kind" IS NOT DISTINCT FROM OLD."kind"
     AND NEW."categories" IS NOT DISTINCT FROM OLD."categories" THEN
    RETURN NEW;
  END IF;
  -- A kind this rule does not know is the CHECK's to refuse, not a party.
  IF NEW."kind" NOT IN ('assigned', 'central_reporter') THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA024',
      MESSAGE = 'write company access under READ COMMITTED: a stricter isolation level cannot see an access row committed meanwhile';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('tonyai.single_entry'),
    pg_catalog.hashtext(NEW."organisation_id"::text));

  SELECT p."role"::text INTO holder_role
    FROM "public"."profiles" p
   WHERE p."id" = NEW."user_id";
  IF holder_role IS DISTINCT FROM 'standard_user' THEN
    RETURN NEW;
  END IF;

  other_kind := CASE NEW."kind" WHEN 'assigned' THEN 'central_reporter' ELSE 'assigned' END;
  -- A new statement under READ COMMITTED: it reads every row committed while
  -- this one waited for the lock.
  SELECT pg_catalog.array_agg(DISTINCT c ORDER BY c) INTO overlap
    FROM "public"."user_subsidiary_access" u
    JOIN "public"."profiles" p ON p."id" = u."user_id"
   CROSS JOIN LATERAL pg_catalog.unnest(u."categories") AS c
   WHERE u."subsidiary_id" = NEW."subsidiary_id"
     AND u."user_id" <> NEW."user_id"
     AND u."kind" = other_kind
     AND p."role"::text = 'standard_user'
     AND c = ANY (NEW."categories");
  IF overlap IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA024',
      MESSAGE = format('single_entry_conflict: side=%s; at subsidiary %s the categories %s are already open to %s',
        CASE other_kind WHEN 'assigned' THEN 'company_users' ELSE 'central_reporter' END,
        NEW."subsidiary_id", overlap,
        CASE other_kind WHEN 'assigned' THEN 'the company''s own standard users' ELSE 'a central reporter' END);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "user_subsidiary_access_single_entry"
  BEFORE INSERT OR UPDATE ON "user_subsidiary_access"
  FOR EACH ROW EXECUTE FUNCTION "public"."user_subsidiary_access_single_entry"();
ALTER TABLE "user_subsidiary_access" ENABLE ALWAYS TRIGGER "user_subsidiary_access_single_entry";

-- TA025: the reporting entity is worked out from the author's access when the
-- record is stored, for every writer, and never changes afterwards (§4; D2).
-- The author's access row for the record's company is read FOR SHARE: when it
-- is a central reporter's, the reporting entity is the author's one assigned
-- company (also read FOR SHARE, so a concurrent withdrawal or move of the main
-- company either commits first and is seen, or waits for this record);
-- otherwise it is NULL, the record's own company. A supplied value that
-- differs is refused. Both companies are read FOR SHARE and must share an
-- organisation, so a concurrent move of either (TA027) and this record never
-- both commit.
CREATE FUNCTION "public"."activity_records_reporting_entity"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  access_kind text;
  main_ids uuid[];
  computed uuid;
  record_org uuid;
  reporting_org uuid;
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."subsidiary_id" IS NOT DISTINCT FROM OLD."subsidiary_id"
       AND NEW."reported_by_subsidiary_id" IS NOT DISTINCT FROM OLD."reported_by_subsidiary_id" THEN
      RETURN NEW;
    END IF;
    -- A record's company never changes (the API never moves one), and the
    -- column only ever restates the entity it was stored with: so neither a
    -- record whose entity is its own company nor a central reporter's record
    -- can be carried to another company, together with the column or not
    -- (QA and security reviews).
    IF NEW."subsidiary_id" IS DISTINCT FROM OLD."subsidiary_id"
       OR (NEW."reported_by_subsidiary_id" IS DISTINCT FROM OLD."reported_by_subsidiary_id"
           AND NEW."reported_by_subsidiary_id" IS DISTINCT FROM COALESCE(OLD."reported_by_subsidiary_id", OLD."subsidiary_id")) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA025',
        MESSAGE = format('reporting_entity_fixed: record %s keeps its company and the reporting entity it was stored with (%s)',
          OLD."id", COALESCE(OLD."reported_by_subsidiary_id", OLD."subsidiary_id"));
    END IF;
    -- The same effective entity, spelt the stored way.
    NEW."reported_by_subsidiary_id" := OLD."reported_by_subsidiary_id";
    RETURN NEW;
  END IF;

  SELECT u."kind" INTO access_kind
    FROM "public"."user_subsidiary_access" u
   WHERE u."user_id" = NEW."created_by"
     AND u."subsidiary_id" = NEW."subsidiary_id"
     FOR SHARE;

  IF access_kind = 'central_reporter' THEN
    -- Lock first, then read: a row-locking read cannot aggregate.
    PERFORM 1
       FROM "public"."user_subsidiary_access" u
      WHERE u."user_id" = NEW."created_by"
        AND u."kind" = 'assigned'
      ORDER BY u."subsidiary_id"
        FOR SHARE;
    SELECT pg_catalog.array_agg(u."subsidiary_id" ORDER BY u."subsidiary_id") INTO main_ids
      FROM "public"."user_subsidiary_access" u
     WHERE u."user_id" = NEW."created_by"
       AND u."kind" = 'assigned';
    IF COALESCE(pg_catalog.cardinality(main_ids), 0) <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA025',
        MESSAGE = format('central_reporter_needs_main_entity: the author %s of a record for subsidiary %s holds it as a central reporter but has %s main companies, not exactly one',
          NEW."created_by", NEW."subsidiary_id", COALESCE(pg_catalog.cardinality(main_ids), 0));
    END IF;
    computed := main_ids[1];
  END IF;

  IF NEW."reported_by_subsidiary_id" IS NOT NULL
     AND NEW."reported_by_subsidiary_id" IS DISTINCT FROM COALESCE(computed, NEW."subsidiary_id") THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA025',
      MESSAGE = format('reporting_entity_mismatch: a record for subsidiary %s by %s reports for %s, not the supplied %s',
        NEW."subsidiary_id", NEW."created_by", COALESCE(computed, NEW."subsidiary_id"), NEW."reported_by_subsidiary_id");
  END IF;
  NEW."reported_by_subsidiary_id" := computed;

  IF computed IS NOT NULL THEN
    SELECT s."organisation_id" INTO record_org
      FROM "public"."subsidiaries" s
     WHERE s."id" = NEW."subsidiary_id"
       FOR SHARE;
    SELECT s."organisation_id" INTO reporting_org
      FROM "public"."subsidiaries" s
     WHERE s."id" = computed
       FOR SHARE;
    IF record_org IS DISTINCT FROM reporting_org THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA025',
        MESSAGE = format('reporting_entity_mismatch: subsidiary %s and its reporting entity %s are not in one organisation',
          NEW."subsidiary_id", computed);
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "activity_records_reporting_entity"
  BEFORE INSERT OR UPDATE ON "activity_records"
  FOR EACH ROW EXECUTE FUNCTION "public"."activity_records_reporting_entity"();
ALTER TABLE "activity_records" ENABLE ALWAYS TRIGGER "activity_records_reporting_entity";

-- TA026: what is entered for a period (§4.2, first sentence; §5.3). For one
-- owning company, category and period (year, granularity, value), records come
-- from one party: the company's own standard users, or a central reporter. A
-- record's party (C3): a central reporter's when its reporting entity is set
-- and differs from its company; the company's own user's when it is not and
-- its author is a standard_user now; neither otherwise — a masterkey's or a
-- super_admin's record never closes a period (B3). A voided record counts for
-- nobody. Fires after TA025 (trigger names run in order), so it reads the
-- stored reporting entity. Under an advisory lock per company, category and
-- period, so two parties storing at once serialise and the second is refused.
CREATE FUNCTION "public"."activity_records_single_entry"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  party text;
  author_role text;
  other_id uuid;
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."subsidiary_id" IS NOT DISTINCT FROM OLD."subsidiary_id"
     AND NEW."category" IS NOT DISTINCT FROM OLD."category"
     AND NEW."reporting_year" IS NOT DISTINCT FROM OLD."reporting_year"
     AND NEW."reporting_period" IS NOT DISTINCT FROM OLD."reporting_period"
     AND NEW."period_value" IS NOT DISTINCT FROM OLD."period_value"
     AND NEW."created_by" IS NOT DISTINCT FROM OLD."created_by"
     AND NEW."reported_by_subsidiary_id" IS NOT DISTINCT FROM OLD."reported_by_subsidiary_id" THEN
    -- A status step changes no party and no period, and a voided record never
    -- comes back: records are judged when they are entered and when their
    -- identity moves, never again on a submit, a decision, a lock or a void.
    RETURN NEW;
  END IF;
  IF NEW."status"::text = 'voided' THEN
    RETURN NEW;
  END IF;
  IF NEW."reported_by_subsidiary_id" IS NOT NULL
     AND NEW."reported_by_subsidiary_id" <> NEW."subsidiary_id" THEN
    party := 'central_reporter';
  ELSE
    SELECT p."role"::text INTO author_role
      FROM "public"."profiles" p
     WHERE p."id" = NEW."created_by";
    IF author_role IS DISTINCT FROM 'standard_user' THEN
      RETURN NEW;
    END IF;
    party := 'company_user';
  END IF;

  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA026',
      MESSAGE = 'write activity records under READ COMMITTED: a stricter isolation level cannot see a record committed meanwhile';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('tonyai.single_entry_period'),
    pg_catalog.hashtext(pg_catalog.concat_ws('|', NEW."subsidiary_id", NEW."category",
      NEW."reporting_year", NEW."reporting_period", NEW."period_value")));

  -- A new statement under READ COMMITTED: it reads every record committed
  -- while this one waited for the lock.
  SELECT r."id" INTO other_id
    FROM "public"."activity_records" r
    LEFT JOIN "public"."profiles" p ON p."id" = r."created_by"
   WHERE r."subsidiary_id" = NEW."subsidiary_id"
     AND r."category" = NEW."category"
     AND r."reporting_year" = NEW."reporting_year"
     AND r."reporting_period" = NEW."reporting_period"
     AND r."period_value" = NEW."period_value"
     AND r."id" <> NEW."id"
     AND r."status"::text <> 'voided'
     AND CASE party
           WHEN 'central_reporter' THEN
             (r."reported_by_subsidiary_id" IS NULL OR r."reported_by_subsidiary_id" = r."subsidiary_id")
             AND p."role"::text = 'standard_user'
           ELSE
             r."reported_by_subsidiary_id" IS NOT NULL AND r."reported_by_subsidiary_id" <> r."subsidiary_id"
         END
   LIMIT 1;
  IF other_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA026',
      MESSAGE = format('single_entry_period_conflict: side=%s; subsidiary %s already holds record %s of %s for %s %s %s %s',
        CASE party WHEN 'central_reporter' THEN 'company_users' ELSE 'central_reporter' END,
        NEW."subsidiary_id", other_id,
        CASE party WHEN 'central_reporter' THEN 'its own standard users' ELSE 'a central reporter' END,
        NEW."category", NEW."reporting_year", NEW."reporting_period", NEW."period_value");
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "activity_records_single_entry"
  BEFORE INSERT OR UPDATE ON "activity_records"
  FOR EACH ROW EXECUTE FUNCTION "public"."activity_records_single_entry"();
ALTER TABLE "activity_records" ENABLE ALWAYS TRIGGER "activity_records_single_entry";

-- TA027: a record's two entities stay in one organisation. A company does not
-- change organisation, for any session, while a record names it as reporting
-- entity or while it owns a record that names another company. The move's row
-- lock waits for a record being stored (its foreign keys and TA025 share-lock
-- both companies), and this check is a new statement that then sees it.
CREATE FUNCTION "public"."subsidiaries_reporting_entity_stays"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  record_id uuid;
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  IF NEW."organisation_id" IS NOT DISTINCT FROM OLD."organisation_id" THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA027',
      MESSAGE = 'move a company under READ COMMITTED: a stricter isolation level cannot see a record committed meanwhile';
  END IF;
  SELECT r."id" INTO record_id
    FROM "public"."activity_records" r
   WHERE r."reported_by_subsidiary_id" = OLD."id"
      OR (r."subsidiary_id" = OLD."id" AND r."reported_by_subsidiary_id" IS NOT NULL)
   LIMIT 1;
  IF record_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA027',
      MESSAGE = format('reporting_entity_stays: subsidiary %s cannot change organisation while record %s names it, or is owned by it with another company, as reporting entity',
        OLD."id", record_id);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "subsidiaries_reporting_entity_stays"
  BEFORE UPDATE ON "subsidiaries"
  FOR EACH ROW EXECUTE FUNCTION "public"."subsidiaries_reporting_entity_stays"();
ALTER TABLE "subsidiaries" ENABLE ALWAYS TRIGGER "subsidiaries_reporting_entity_stays";

-- ---------------------------------------------------------------------------
-- 3. Runtime grants (design D3; runtime-role.mjs RUNTIME_COLUMN_UPDATES)
-- ---------------------------------------------------------------------------

-- A carried-over account's assigned company becomes a grant company in place
-- (C7), so its audit row reads as a change of kind. The runtime role inserts
-- access rows table-wide already (with the default `assigned`), and never
-- updates `reported_by_subsidiary_id` in practice: TA025 refuses any change.
GRANT UPDATE ("kind") ON "user_subsidiary_access" TO "tonyai_runtime";
