---
name: aggregation-endpoint
description: Add a tenant-scoped, read-only aggregation endpoint to the TonyAI API (dashboard/analytics/reporting rollups over activity records) — accessible-set intersection with empty-set early return, committed-status filtering, math over immutable calculation snapshots, response types in @tonyai/shared-types, and a DB-free Vitest spec. Use when a feature needs server-computed totals, breakdowns, matrices or trends rather than a CRUD resource.
---

# aggregation-endpoint

Add a read-only rollup endpoint (totals, breakdowns, matrices, trends) computed **server-side**.
For CRUD resources use **`tenant-api-module`** instead. Canonical references — read one first:

- `apps/api/src/emissions/emissions.service.ts` → `summary()` (scope totals, breakdowns, bucketed trends)
- `apps/api/src/emissions/emissions.service.ts` → `trackingMatrix()` (per-subsidiary × category status grid)

## Why server-side
One source of truth: the same numbers feed dashboards, analytics and (later) reports. Never
re-derive aggregation math in the browser — pages consume the DTO as-is (map to view models if needed).

## Rules (must hold)
- **Tenant scope:** filter by `subsidiaryId: { in: user.accessibleSubsidiaryIds }`. If the caller requests
  a specific `subsidiaryId` outside their set, return the **empty result** (never 403 — don't leak existence).
  If the accessible set is empty, return the empty result **without querying**.
- **Committed statuses only** for emission figures: `submitted | under_review | approved | locked`
  (the `COUNTED_STATUSES` list). Drafts/rejected never contribute tCO₂e — though completeness-style
  endpoints may still *inspect* them (e.g. a draft makes a tracking-matrix cell "incomplete").
- **Math over immutable snapshots:** read `tCo2e` from the record's `calculation` snapshot
  (`Number.isFinite` guard); never recompute from factors at read time — historic results must not drift.
- **Response types in `@tonyai/shared-types`**, imported by both API and web. Document status semantics
  (which statuses count) in the type's doc comment.
- **Query DTO** with `class-validator` (+ `@Type(() => Number)` for numeric params). No pagination unless
  the result is per-record.
- Wire the method into the existing domain module where it belongs (e.g. `emissions`); only create a new
  module for a genuinely new domain.

## Steps
1. **Types** — add the DTO shape(s) to `packages/shared-types/src/index.ts`; `pnpm --filter @tonyai/shared-types build`.
2. **Query DTO** — `apps/api/src/<module>/dto/<name>-query.dto.ts`, all filters optional.
3. **Service method** — empty-set early return → parallel `findMany` for records + any lookup tables
   (`Promise.all`) → aggregate with `Map` accumulators → return sorted, percentage-annotated DTO.
4. **Controller** — thin `@Get('<path>')` passing `@CurrentUser()` + `@Query()`.
5. **Client** — add the typed method to `apps/web/lib/api.ts` (build the query string only from set params).
6. **Spec** — extend the module's `.spec.ts` (DB-free, mocked Prisma):
   - empty accessible set → empty result, **no DB call**
   - inaccessible requested `subsidiaryId` → empty result, no DB call
   - `where` clause scoped to the accessible set (assert the mock call args)
   - known input → known output for the aggregation math (hand-checkable numbers)

## Verify
```bash
pnpm --filter @tonyai/api typecheck && pnpm --filter @tonyai/api test
```
Then hit the endpoint with a `data_entry` token and confirm it only reflects that user's subsidiaries.
