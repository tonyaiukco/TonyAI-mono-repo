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
- **Never touch the seed's space.** The seed is **monthly-only**, so every E2E write goes in the
  otherwise-empty **`quarterly`** space of `E2E_YEAR` — read the constants, never retype the year: this
  line said 2024 for a release after the seed moved to 2026. `globalSetup` + `globalTeardown` wipe all
  quarterly rows (service-role, evidence cascades) — so runs are idempotent and the seed is preserved.
  If you need a new write space, keep it inside quarterly.
- **Clean up in the test's own `finally`, not by leaning on the global wipe.** That wipe runs once per
  RUN; the specs in between never see it. A record left `submitted` makes `lockPeriod` 409 in a spec
  several files later, with an error naming neither your file nor the record — and the API refuses to
  delete a submitted record, so that teardown has to go through the service role
  (`deleteRecordsAsService`).
- **Budget the throttled routes.** Bulk import is 5/min per user and one UI import cycle spends two of
  them. Alternate `ADMIN_EMAIL` / `ENTRY_EMAIL` across files, and give any test that deliberately
  exhausts a bucket a file of its own.
- **One subsidiary (or period value) per test.** Distinct tuples avoid the `NULLS NOT DISTINCT` 409 and
  keep anomaly baselines from bleeding across tests (the baseline is per subsidiary+category+period).
- **Arrange heavy state via the API, act via the UI.** Building a committed record (draft → evidence →
  submit) or an anomaly baseline through the UI is slow/flaky — use `createCommittedRecord`. Every
  category the seed's factor library covers is evidence-required, so committing always needs a file —
  and so does anything a bulk import produces. `seedE2EFactor` opens a non-evidence lane for the cases
  that need one.
- **Approve is API-only** (no UI) — use `getAccessToken` + `approveRecord` for any flow that needs an
  approved record.
- **Select shadcn/Radix dropdowns by their field Label, not the trigger's accessible name.** Use
  `pickByFieldLabel(page, 'Value', 'Q3')` / `selectSubsidiary`. Matching the trigger by accessible name is
  unreliable (Radix composes it) and the Subsidiary field is a Skeleton until data loads — the
  field-scoped, auto-waiting locator handles both, and it waits for the listbox to close.
- **Assert on the toast/text the app actually renders.** Gate messages come from the API body via
  `saveErrorMessage` (e.g. `/requires at least one evidence file/`, `/is locked/`); the client anomaly
  guard is `/looks anomalous — add a variance comment/`.
- **Build a locator's name from the shared label, above all when you assert its absence.** When an
  accessible name embeds a label that `@tonyai/shared-types` exports (e.g. `WHOLE_COMPANY_ENTITY_LABEL`),
  import it. A retyped label goes stale silently. When #104 renamed "Whole subsidiary" to "Whole
  company", the three `toHaveCount(0)` checks that ran on the old name kept passing, because nothing
  carried that name. The one positive check failed as "not found", which looks exactly like the
  regression that spec exists to catch. Copy is pinned by positive checks, where a rename fails loudly
  (`drafts-bulk-submit` ticks a checkbox by its full literal name).

## Recipe
1. **Fixtures/helpers first.** Reuse `e2e/helpers.ts`; add a helper there only if ≥2 specs need it.
   Evidence uploads use `EVIDENCE_FIXTURE` (`e2e/fixtures/sample-invoice.pdf`).
2. **Auth.** UI: `login(page, ADMIN_EMAIL | ENTRY_EMAIL)`. API/probe: `getAccessToken(request, email)`
   (Supabase password grant → the same JWT the guard verifies; scheme-agnostic).
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
- Writing in the seed's monthly space (collides with the seed → 409, and pollutes analytics).
- `getByRole('combobox', { name })` on a Radix trigger, or `getByRole('combobox').first()` before the
  Subsidiary skeleton resolves.
- Deleting an approved record via the API in teardown (the remove gate forbids it) — rely on the quarterly
  wipe instead.
- Assuming a killed run tidied up after itself. Playwright skips `globalTeardown` on SIGINT or a crash,
  and `pnpm db:seed` deletes nothing — so the fixture factor and any quarterly rows survive both. The
  repair is the next `pnpm e2e` (its `globalSetup` sweeps before it seeds) or `pnpm db:reset`. Worst
  case is a stranded `submitted` record: the API refuses to delete it, and once the fixture factor is
  gone it refuses to edit it too (`update` recomputes, and the category has no factor) — service role
  only.
- Assuming E2E is unwired from CI. It has run **nightly** since 2026-09-01 via
  `.github/workflows/e2e.yml`, plus `workflow_dispatch` — trigger it on a branch before merge with
  `gh workflow run e2e.yml --ref <branch>` (~15 min end to end, ~10 of it Playwright for
  109 tests, measured 2026-09-14). It is deliberately NOT on `pull_request`
  (serial by construction, billed per push), so `pnpm e2e` still stays out of the turbo `test`
  pipeline — but `pnpm typecheck` does cover `e2e/` on every PR.
- Dispatching E2E without looking first. `concurrency: e2e` with `cancel-in-progress` is **one group for
  the whole repo**, not one per branch, so a dispatch cancels whatever run is in flight, including
  another branch's verification (PR #103's first run was cancelled 53 s in this way). Wait until every
  run in `gh run list --workflow e2e.yml` is `completed`. After dispatching, confirm the new run's
  `headSha` is your branch tip before believing its result.
- Taking two green branch runs as proof of `main`. A dispatch proves only the branch it ran on.
  #103's new spec (run 34781049391) and #104's label rename (run 34780263258) were each green, but
  neither branch contained the other. The first run to hold both was the 2026-09-14 nightly on `main`,
  and it failed. When two open PRs touch the same screen, merge `main` into the second one, dispatch
  again, and let that run finish before the PR merges.
- Re-budgeting a spec over a 429 without counting first. List the route's requests per user in the
  run log (`gh run view <id> --log`, grep the path and the user id). In #108 a 429 arrived on the
  fourth import of a minute whose limit is five: `@nestjs/throttler` 6.5.0 had stopped the user's
  earlier hits from expiring when another user's block ended. The fix was in the API's throttler
  storage, not in the spec's budget.
