-- WP6 (`inc26-roles-approval-chain`) — the role model of INC-2.6 §1 and §6.
--
-- The stored roles become the document's: `masterkey`, `super_admin`,
-- `standard_user`, `auditor` (owner decisions 2026-11-24 (third) 2–3 and
-- 2026-11-25 (sixth)). Every existing account is carried over in place:
-- `super_admin` → `masterkey` (still the whole organisation), `data_entry` →
-- `standard_user` (grants kept, every category ticked), `consultant` and
-- `executive_viewer` → `auditor`. Nobody holds the new, company-scoped
-- `super_admin` afterwards: a masterkey appoints them.
--
-- NOT EXPAND-ONLY — the one exception of the UAT round 4 sprint
-- (`Pilot_launch_v4.md` §8). The enum's values are renamed, so the API image
-- that is live when this migration lands cannot read a profile any more
-- (Prisma refuses the unknown value `masterkey`) and every request fails until
-- the new image rolls out. Adding values instead would leave three dead roles
-- in Prisma for ever, an added enum value cannot be used in the transaction
-- that adds it, and recreating the type would drop and re-create all sixteen policies
-- (Postgres refuses `ALTER COLUMN … TYPE` under a policy) for no gain. There
-- is no rollback across it: a defect is fixed forward (the PR's deploy note).
--
-- Order (design "Migration Plan" step 1):
--   1. the organisation's cut-over time, read by the audit views;
--   2. one `role_model_change` audit row per profile, read BEFORE the renames;
--   3. the four renames and the fold of `executive_viewer` into `auditor`;
--   4. `user_subsidiary_access.categories`, back-filled, and its runtime grant;
--   5. the sixteen policies that name a role, restated.
-- The wrong reading of step 3 alone (an organisation-wide branch naming the
-- new scoped `super_admin`) never exists outside this transaction.
--
-- Hand-written: `prisma migrate dev` re-proposes dropping the raw NULLS NOT
-- DISTINCT index "activity_records_reporting_entity_period_category_key" on
-- every generation (CLAUDE.md). This migration drops no index. `audit_log` is
-- append-only: INSERT is the only statement run on it.

-- ALTER TYPE and ALTER POLICY take ACCESS EXCLUSIVE locks until commit; queued
-- behind a long transaction they would stall every request. Give up instead,
-- and let the deploy be retried.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The cut-over instant (design Decision 10)
-- ---------------------------------------------------------------------------

-- A `super_admin` on an audit row older than this was the earlier,
-- organisation-wide administrator (shown as such, `displayRole`). An
-- organisation created later keeps NULL: every row of it is today's model.
ALTER TABLE "organisations" ADD COLUMN "role_model_changed_at" TIMESTAMPTZ(6);
-- Truncated to milliseconds: `audit_log.created_at` keeps three decimals, so
-- the carry-over rows below carry exactly this instant.
UPDATE "organisations" SET "role_model_changed_at" = date_trunc('milliseconds', now());

-- ---------------------------------------------------------------------------
-- 2. One audit row per carried account (before the renames read the old role)
-- ---------------------------------------------------------------------------

-- No acting user and no acting role: nobody acted, the migration did.
-- `created_at` is the cut-over instant in UTC (the column is a timestamp(3)
-- without time zone, written in UTC), equal to the organisation's cut-over,
-- so the row is never "before" it. No address or name: the profile id only.
INSERT INTO "audit_log" ("id", "user_id", "action", "entity", "entity_id", "diff", "created_at", "organisation_id", "role")
SELECT
  gen_random_uuid(),
  NULL,
  'role_model_change',
  'profile',
  p."id"::text,
  jsonb_build_object(
    'role', jsonb_build_object(
      'before', p."role"::text,
      'after', CASE p."role"::text
        WHEN 'super_admin' THEN 'masterkey'
        WHEN 'consultant' THEN 'auditor'
        WHEN 'executive_viewer' THEN 'auditor'
        WHEN 'data_entry' THEN 'standard_user'
      END
    )
  ),
  (date_trunc('milliseconds', now()) AT TIME ZONE 'UTC'),
  p."organisation_id",
  NULL
FROM "profiles" p;

-- ---------------------------------------------------------------------------
-- 3. The renames (design Decision 1)
-- ---------------------------------------------------------------------------

-- RENAME VALUE is transactional and the renamed value is usable at once. The
-- policies, the column default and every stored row follow by OID.
ALTER TYPE "UserRole" RENAME VALUE 'super_admin' TO 'masterkey';
ALTER TYPE "UserRole" RENAME VALUE 'consultant' TO 'auditor';
ALTER TYPE "UserRole" RENAME VALUE 'data_entry' TO 'standard_user';

-- An executive viewer reads like an auditor (INC-2.6 §1, ruling R2).
UPDATE "profiles" SET "role" = 'auditor' WHERE "role" = 'executive_viewer';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "profiles" WHERE "role" = 'executive_viewer') THEN
    RAISE EXCEPTION 'executive_viewer still held after the fold; not reusing the value';
  END IF;
END
$$;

-- The emptied slot becomes the new, company-scoped role, which no account
-- holds. The type ends with exactly four values.
ALTER TYPE "UserRole" RENAME VALUE 'executive_viewer' TO 'super_admin';

-- ---------------------------------------------------------------------------
-- 4. A standard user's categories (design Decision 5)
-- ---------------------------------------------------------------------------

-- Every existing grant is a carried-over `standard_user`'s: all thirteen
-- categories, sorted as the API stores them, so nobody loses anything today.
-- A `super_admin`'s grant keeps '{}' and is never read for categories. No
-- CHECK on the names, as for `activity_records.category`: the API validates
-- them against `CATEGORIES`.
ALTER TABLE "user_subsidiary_access" ADD COLUMN "categories" TEXT[] NOT NULL DEFAULT '{}';
UPDATE "user_subsidiary_access" SET "categories" = ARRAY[
  'Business Travel',
  'Commuting',
  'Electricity',
  'Fire Suppression',
  'Fuel',
  'Fugitive Gas',
  'Logistics',
  'Mobile Combustion',
  'Natural Gas',
  'Purchased Goods',
  'Refrigerants',
  'Waste',
  'Water'
]::TEXT[];

-- A categories change is one UPDATE and one audit row; the grant's keys stay
-- insert-and-delete only (`runtime-role.mjs` pins the column).
GRANT UPDATE ("categories") ON "user_subsidiary_access" TO "tonyai_runtime";

-- ---------------------------------------------------------------------------
-- 5. The sixteen policies that name a role (design Decisions 1 and 6)
-- ---------------------------------------------------------------------------

-- After step 3 their organisation-wide branch would read
-- ('masterkey', 'auditor', 'super_admin'): the new scoped role must not be in
-- it. Restated from the catalogue's own text with only these changes:
--   * the organisation-wide branch names `masterkey` and `auditor`;
--   * `audit_log_select_scoped` admits `masterkey` and `auditor` (it admitted
--     the earlier `super_admin` alone);
--   * on `activity_records` and `activity_record_evidence` the grant branch
--     also needs, for a `standard_user`, the row's category ticked on the
--     grant or the row (the evidence link's record) to be the holder's own.
-- The other thirteen grant branches are unchanged: their rows carry no
-- category. All sixteen stay SELECT-only and are never FORCEd.

ALTER POLICY "activity_record_evidence_select_scoped" ON "activity_record_evidence" USING (
(EXISTS ( SELECT 1
   FROM subsidiaries s
  WHERE ((s.id = activity_record_evidence.subsidiary_id) AND ((EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN profiles p ON ((p.id = usa.user_id)))
          WHERE ((usa.subsidiary_id = s.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = s.organisation_id) AND ((p.role <> 'standard_user'::"UserRole") OR (EXISTS ( SELECT 1 FROM activity_records ar WHERE ((ar.id = activity_record_evidence.activity_record_id) AND ((ar.category = ANY (usa.categories)) OR (ar.created_by = ( SELECT auth.uid() AS uid)))))))))) OR (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = s.organisation_id))))))))
);

ALTER POLICY "activity_records_select_scoped" ON "activity_records" USING (
(EXISTS ( SELECT 1
   FROM subsidiaries s
  WHERE ((s.id = activity_records.subsidiary_id) AND ((EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN profiles p ON ((p.id = usa.user_id)))
          WHERE ((usa.subsidiary_id = s.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = s.organisation_id) AND ((p.role <> 'standard_user'::"UserRole") OR (activity_records.category = ANY (usa.categories)) OR (activity_records.created_by = ( SELECT auth.uid() AS uid)))))) OR (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = s.organisation_id))))))))
);

ALTER POLICY "audit_log_select_scoped" ON "audit_log" USING (
(EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id IS NOT NULL) AND (p.organisation_id = audit_log.organisation_id))))
);

ALTER POLICY "evidence_select_scoped" ON "evidence" USING (
(EXISTS ( SELECT 1
   FROM subsidiaries s
  WHERE ((s.id = evidence.subsidiary_id) AND ((EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN profiles p ON ((p.id = usa.user_id)))
          WHERE ((usa.subsidiary_id = s.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = s.organisation_id)))) OR (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = s.organisation_id))))))))
);

ALTER POLICY "import_batches_select_scoped" ON "import_batches" USING (
((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = import_batches.organisation_id) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"]))))) OR ((uploaded_by = ( SELECT auth.uid() AS uid)) AND (cardinality(subsidiary_ids) > 0) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = import_batches.organisation_id)))) AND (NOT (EXISTS ( SELECT 1
   FROM unnest(import_batches.subsidiary_ids) sid(sid)
  WHERE (NOT (EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN subsidiaries s ON ((s.id = usa.subsidiary_id)))
          WHERE ((usa.user_id = ( SELECT auth.uid() AS uid)) AND (usa.subsidiary_id = sid.sid) AND (s.organisation_id = import_batches.organisation_id))))))))))
);

ALTER POLICY "inventory_applicability_cells_select_scoped" ON "inventory_applicability_cells" USING (
(EXISTS ( SELECT 1
   FROM subsidiaries s
  WHERE ((s.id = inventory_applicability_cells.subsidiary_id) AND ((EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN profiles p ON ((p.id = usa.user_id)))
          WHERE ((usa.subsidiary_id = s.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = s.organisation_id)))) OR (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = s.organisation_id))))))))
);

ALTER POLICY "inventory_attribution_policies_select_scoped" ON "inventory_attribution_policies" USING (
(EXISTS ( SELECT 1
   FROM subsidiaries s
  WHERE ((s.id = inventory_attribution_policies.subsidiary_id) AND ((EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN profiles p ON ((p.id = usa.user_id)))
          WHERE ((usa.subsidiary_id = s.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = s.organisation_id)))) OR (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = s.organisation_id))))))))
);

ALTER POLICY "inventory_boundaries_select_scoped" ON "inventory_boundaries" USING (
((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = inventory_boundaries.organisation_id)))) OR (EXISTS ( SELECT 1
   FROM ((inventory_boundary_subsidiaries bs
     JOIN user_subsidiary_access usa ON ((usa.subsidiary_id = bs.subsidiary_id)))
     JOIN profiles p ON ((p.id = usa.user_id)))
  WHERE ((bs.boundary_id = inventory_boundaries.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = inventory_boundaries.organisation_id)))))
);

ALTER POLICY "inventory_boundary_sites_select_scoped" ON "inventory_boundary_sites" USING (
(EXISTS ( SELECT 1
   FROM subsidiaries s
  WHERE ((s.id = inventory_boundary_sites.subsidiary_id) AND ((EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN profiles p ON ((p.id = usa.user_id)))
          WHERE ((usa.subsidiary_id = s.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = s.organisation_id)))) OR (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = s.organisation_id))))))))
);

ALTER POLICY "inventory_boundary_subsidiaries_select_scoped" ON "inventory_boundary_subsidiaries" USING (
(EXISTS ( SELECT 1
   FROM subsidiaries s
  WHERE ((s.id = inventory_boundary_subsidiaries.subsidiary_id) AND ((EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN profiles p ON ((p.id = usa.user_id)))
          WHERE ((usa.subsidiary_id = s.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = s.organisation_id)))) OR (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = s.organisation_id))))))))
);

ALTER POLICY "inventory_sources_select_scoped" ON "inventory_sources" USING (
(EXISTS ( SELECT 1
   FROM subsidiaries s
  WHERE ((s.id = inventory_sources.subsidiary_id) AND ((EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN profiles p ON ((p.id = usa.user_id)))
          WHERE ((usa.subsidiary_id = s.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = s.organisation_id)))) OR (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = s.organisation_id))))))))
);

ALTER POLICY "locations_select_scoped" ON "locations" USING (
(EXISTS ( SELECT 1
   FROM subsidiaries s
  WHERE ((s.id = locations.subsidiary_id) AND ((EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN profiles p ON ((p.id = usa.user_id)))
          WHERE ((usa.subsidiary_id = s.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = s.organisation_id)))) OR (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = s.organisation_id))))))))
);

ALTER POLICY "period_locks_select_scoped" ON "period_locks" USING (
(EXISTS ( SELECT 1
   FROM subsidiaries s
  WHERE ((s.id = period_locks.subsidiary_id) AND ((EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN profiles p ON ((p.id = usa.user_id)))
          WHERE ((usa.subsidiary_id = s.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = s.organisation_id)))) OR (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = s.organisation_id))))))))
);

ALTER POLICY "subsidiaries_select_scoped" ON "subsidiaries" USING (
((EXISTS ( SELECT 1
   FROM (user_subsidiary_access usa
     JOIN profiles p ON ((p.id = usa.user_id)))
  WHERE ((usa.subsidiary_id = subsidiaries.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = subsidiaries.organisation_id)))) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = subsidiaries.organisation_id)))))
);

ALTER POLICY "subsidiary_denominators_select_scoped" ON "subsidiary_denominators" USING (
(EXISTS ( SELECT 1
   FROM subsidiaries s
  WHERE ((s.id = subsidiary_denominators.subsidiary_id) AND ((EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN profiles p ON ((p.id = usa.user_id)))
          WHERE ((usa.subsidiary_id = s.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = s.organisation_id)))) OR (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = s.organisation_id))))))))
);

ALTER POLICY "targets_select_scoped" ON "targets" USING (
(EXISTS ( SELECT 1
   FROM subsidiaries s
  WHERE ((s.id = targets.subsidiary_id) AND ((EXISTS ( SELECT 1
           FROM (user_subsidiary_access usa
             JOIN profiles p ON ((p.id = usa.user_id)))
          WHERE ((usa.subsidiary_id = s.id) AND (usa.user_id = ( SELECT auth.uid() AS uid)) AND (p.organisation_id = s.organisation_id)))) OR (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])) AND (p.organisation_id = s.organisation_id))))))))
);
