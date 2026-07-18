---
name: e2e-flow
description: Add a Playwright end-to-end spec (or an RLS/API probe) for TonyAI against the running local stack — reusing the shared login / API-token / safe-period / evidence-upload / teardown helpers in e2e/helpers.ts. Use when covering a user flow through the real UI + API + Supabase, or proving a security invariant at the database layer. Not for isolated unit logic (Vitest specs live beside the code).
---

# e2e-flow

Cover a whole flow through the real app: UI → NestJS → Supabase. The **canonical exemplars** live in
`e2e/` — read them first: `data-entry-happy.spec.ts` (full lifecycle), `gates.spec.ts` (negative gates),
`rbac-tenant.spec.ts` (RBAC/tenant), `scripts/rls-probes.mjs` (DB-layer containment). Shared helpers are
in `e2e/helpers.ts`.

## Rules (must hold)
- **Never touch the seed's space.** The seed is **monthly-2024 only**, so every E2E write goes in the
  otherwise-empty **`quarterly` 2024** space (`E2E_YEAR` / `E2E_PERIOD`). `globalSetup` + `globalTeardown`
  wipe all quarterly rows (service-role, evidence cascades) — so runs are idempotent and the seed is
  preserved. If you need a new write space, keep it inside quarterly.
- **One subsidiary (or period value) per test.** Distinct tuples avoid the `NULLS NOT DISTINCT` 409 and
  keep anomaly baselines from bleeding across tests (the baseline is per subsidiary+category+period).
- **Arrange heavy state via the API, act via the UI.** Building a committed record (draft → evidence →
  submit) or an anomaly baseline through the UI is slow/flaky — use `createCommittedRecord`. All 2024
  factor categories are evidence-required, so committing always needs a file.
- **Approve is API-only** (no UI) — use `getAccessToken` + `approveRecord` for any flow that needs an
  approved record.
- **Select shadcn/Radix dropdowns by their field Label, not the trigger's accessible name.** Use
  `pickByFieldLabel(page, 'Value', 'Q3')` / `selectSubsidiary`. Matching the trigger by accessible name is
  unreliable (Radix composes it) and the Subsidiary field is a Skeleton until data loads — the
  field-scoped, auto-waiting locator handles both, and it waits for the listbox to close.
- **Assert on the toast/text the app actually renders.** Gate messages come from the API body via
  `saveErrorMessage` (e.g. `/requires at least one evidence file/`, `/is locked/`); the client anomaly
  guard is `/looks anomalous — add a variance comment/`.

## Recipe
1. **Fixtures/helpers first.** Reuse `e2e/helpers.ts`; add a helper there only if ≥2 specs need it.
   Evidence uploads use `EVIDENCE_FIXTURE` (`e2e/fixtures/sample-invoice.pdf`).
2. **Auth.** UI: `login(page, ADMIN_EMAIL | ENTRY_EMAIL)`. API/probe: `getAccessToken(request, email)`
   (Supabase password grant → the same HS256 JWT the guard verifies).
3. **Write the spec** — arrange (API) → act (UI, field-scoped selectors) → assert (rendered text +, where
   it matters, a DB/API cross-check). Keep `workers:1` / `retries:0` (serial writes share one DB).
4. **RLS/API probes** go in `scripts/rls-probes.mjs` (standalone, no browser). For each tenant table assert
   the triple: anon = 0, entry > 0, and entry == the service-role count of the user's *own-tenant* rows
   (exact containment — a mere `entry < service` "strict subset" would miss a partial leak). The `entry > 0`
   leg also proves the SELECT GRANT exists (a missing grant would look like false containment). PostgREST
   derives the role from the `Authorization` bearer, not `apikey`; rows need an explicit `id` (Prisma
   generates uuids client-side); tables without a `subsidiary_id` (evidence) are scoped via an inner join.
5. **Run** `pnpm exec playwright test` (starts/reuses web+api via `webServer`) and `node scripts/rls-probes.mjs`.
   Both need the local stack up (Docker + Supabase).

## Anti-patterns
- Writing in the monthly-2024 space (collides with the seed → 409, and pollutes analytics).
- `getByRole('combobox', { name })` on a Radix trigger, or `getByRole('combobox').first()` before the
  Subsidiary skeleton resolves.
- Deleting an approved record via the API in teardown (the remove gate forbids it) — rely on the quarterly
  wipe instead.
- Wiring E2E into CI — deferred to Phase 2 (needs Supabase in Actions). Keep `pnpm e2e` out of the turbo
  `test` pipeline.
