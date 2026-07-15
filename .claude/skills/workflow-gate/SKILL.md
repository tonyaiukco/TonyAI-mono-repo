---
name: workflow-gate
description: Add a server-side lifecycle gate to TonyAI activity records — a precondition checked in the API before a create/update/delete or status transition, with a DB-free spec and a client mirror on Data Entry. Use when a rule must block record mutations based on record state, linked data (evidence), computed state (anomaly baseline), or period state (locks) — not for new resources (tenant-api-module) or analytics (aggregation-endpoint).
---

# workflow-gate

Enforce an invariant on the activity-record lifecycle. The **canonical exemplars** all live in
`apps/api/src/activity-records/activity-records.service.ts` — read them first:

- **Evidence gate** (`submit`): evidence-required category + 0 files → block submit (FR §4.1).
- **Anomaly gate** (`submit`): recomputes the baseline at submit time; flagged + no `varianceReason` → block (VAR §4).
- **Period-lock gate** (`create`/`update`/`remove`/`submit`): a `period_locks` row for the record's
  (subsidiary, year, period, periodValue) → block everything (FR §4.2).

## Rules (must hold)
- **The API is the final enforcement layer** (VAR §8). The frontend mirror (toast / disabled button /
  banner) is UX only — never the enforcement.
- **Recompute at the transition; never trust a write-time flag.** State may have changed between save and
  submit (the anomaly gate re-evaluates its baseline; the period gate re-reads the lock table).
- **Exception style:** `ForbiddenException` = role/ownership; `BadRequestException` = domain invariant on
  the record itself (missing evidence, missing comment, invalid period token); `ConflictException` = a
  state clash with other data (duplicate key, locked period). Message must be user-actionable — it is
  surfaced verbatim as a toast.
- **Gate placement:** `create` → after role + input validation, before persisting; `update`/`remove` →
  after `loadScoped` + `assertCanMutate` (check the record's current tuple, and on `update` ALSO the
  target tuple if the period fields change); `submit` → after the status guard, before `transition()`.
- Derived flags the gate writes (e.g. `anomalyFlag`) are **server-computed only** — never accepted from a
  DTO.
- If the gate needs a new table (like `period_locks`): tenant-scope it under `subsidiaries`, apply the
  **`rls-for-table`** skill, and audit every state change (`lock`/`unlock` style actions).

## Steps
1. **Helper** — a private `assertXxx(...)`/`detectXxx(...)` on the service that reads the minimum state
   (a `count`, `findFirst`, or a scoped `findMany`) and throws (or returns a boolean the caller gates on).
2. **Hook the mutation paths** listed above. Cover ALL paths that could violate the invariant — including
   re-targeting on `update` (e.g. moving a record INTO a locked period).
3. **Spec (DB-free)** — in `activity-records.service.spec.ts`:
   - Add the gate's prisma surface to `createPrismaMock()` **defaulting to "open/pass"** (e.g.
     `periodLock.findFirst → null`, `evidence.count → 1`) so every existing test stays green.
   - For each hooked path: mock the blocking state, assert the throw (`/actionable message/i`) AND that
     no write happened (`create/update/delete not called`).
   - Assert the gate's query `where` clause once, so a regression can't silently widen/narrow its scope.
4. **Client mirror** — Data Entry already surfaces API errors via `toast.error(saveErrorMessage(e))`;
   add a proactive UI state only when the user can fix it in place (e.g. the anomaly banner + mandatory
   variance field). Status badges live in the `statusBadge`/STATUS maps.
5. **Docs** — README behaviour note + `project-status.md` entry (decision + verification evidence).

## Verify
`pnpm --filter @tonyai/api test && pnpm typecheck`, then live: trigger the gate through the real API
(blocked → 4xx with the actionable message, nothing persisted), clear the condition, and confirm the same
call succeeds. Gates on compliance paths also get a fresh-eyes review pass (`security-rls`/`qa-auditor`)
before the PR, per the working mode.
