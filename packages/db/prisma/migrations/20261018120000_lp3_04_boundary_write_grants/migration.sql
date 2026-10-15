-- LP3-04's write path — the service and routes (W1, W13; Decisions
-- 2026-10-15 (fifth), E1–E9): the runtime role's grants on the inventory
-- boundary, which PR B's migration left SELECT only. Grants only — no table,
-- key, CHECK, trigger or policy changes; RLS and the client roles' SELECT-only
-- grants stay as they are. `runtime-role.mjs` lists the same.
--
--  * `inventory_boundaries`: INSERT on the columns a new open version is
--    written with — never `decided_by`, `decided_at`, `frozen_at` or
--    `created_at` (the database's clock), so not even a bug can insert a
--    version already confirmed, frozen or backdated (the guard refuses a
--    frozen insert as well). UPDATE on the four columns `confirm` writes, the
--    only ones the guard lets change (TA014); the grant is also what lets the
--    routes take the header's row lock (FOR UPDATE, FOR SHARE). DELETE, for
--    an open version (the guard refuses a frozen one).
--  * The five row tables: INSERT, never UPDATE. A PUT replaces a
--    subsidiary's declaration by deleting its row and inserting the new one,
--    so no row is ever re-keyed — a policy never takes its sources along
--    through their cadence key's ON UPDATE CASCADE — and the guard's key rule
--    is never met. DELETE on the subsidiaries' rows alone: their keys cascade
--    to the sites, policies, cells and sources as those tables' owner, so none
--    of them is deleted one by one outside an audited replace.
--
-- GRANT takes no lock beyond the catalogue's; the timeout is the house rule.
SET LOCAL lock_timeout = '5s';

GRANT INSERT ("id", "organisation_id", "reporting_year", "version", "decision", "created_by")
  ON "inventory_boundaries" TO "tonyai_runtime";
GRANT UPDATE ("decision", "decided_by", "decided_at", "frozen_at")
  ON "inventory_boundaries" TO "tonyai_runtime";
GRANT DELETE ON "inventory_boundaries" TO "tonyai_runtime";

GRANT INSERT, DELETE ON "inventory_boundary_subsidiaries" TO "tonyai_runtime";
GRANT INSERT ON "inventory_boundary_sites", "inventory_attribution_policies",
  "inventory_applicability_cells", "inventory_sources" TO "tonyai_runtime";
