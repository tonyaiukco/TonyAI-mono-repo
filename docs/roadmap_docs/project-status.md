# Project Status & Roadmap Log

> **Purpose:** persistent, in-repo working memory across Claude Code sessions.
> **Update rule:** refresh this file in the same change whenever a PR merges, a
> decision is made, or the roadmap shifts. Read it at session start ("where did
> we leave off?"). Keep entries short — link to code/PRs instead of restating them.
> README stays the public-facing summary; this file is the granular working log.

## Current status — as of 2026-07-15

- **Phase:** Phase 1 — Core MVP (Scope 1 & 2) — WP1–WP3 done; **WP4–WP6 remain** (E2E harness/hardening → Targets & intensity → Reports; Targets/Reports kept in Phase 1 per the 2026-07-15 decision)
- **Latest merged:** PR #17 (WP3 period locking); `main` synced, branch deleted
- **Tests:** 118 unit (Vitest, API) + 2 E2E (Playwright) — green
- **Local stack:** Docker + Supabase (`pnpm setup`), `pnpm dev` → web :3000, api :3001

## Delivered (PR history)

| PR | Scope | Highlights |
| --- | --- | --- |
| #1 | workflow | Branch/PR workflow (no direct push to `main`), CI on Node 22 |
| #2 | backend | Emission-factor library + Scope 1 & 2 calculation engine (unit normalization, factor versioning, immutable snapshots) |
| #3 | backend | Activity-records API + review workflow (`draft → submitted → under_review → approved/rejected`), audit logging |
| #4 | tooling | `wire-page` skill + tooling/process rules |
| #5 | frontend | Data Entry page wired to live API (tCO₂e preview, draft → submit), 409 on duplicate record |
| #6 | full-stack | Emissions Analytics wired to live `GET /emissions/summary` aggregation; demo seed records; Targets/intensity labelled "not yet available" |
| #7 | docs | This status log + full phased roadmap to production (Phases 0–4 + post-launch) |
| #8 | tooling | Agent/skill review: two write patterns in `tenant-api-module`, richer `wire-page`, launch.json |
| #9 | full-stack | Dashboard Emissions Overview wired: `GET /emissions/tracking-matrix` (FR §2 statuses), live KPI cards (null-safe trends/locations), real anomaly alerts; `aggregation-endpoint` skill extracted |
| #10 | full-stack | Operational locations (FR §1.1 third tier): tenant-scoped `/locations` CRUD, subsidiaries-page drawer, live `/kpi` location count, 8 seeded locations; orphan mock components deleted |
| #11 | full-stack | Evidence upload: private bucket + upload-through-API + signed URLs, `Evidence` table + RLS, Data Entry vault, submit-gate + matrix-green enforcement (FR §4.1/§2.2), 96 demo files; `supabase-storage` skill extracted |
| #12 | docs | Post-#11 plan review — reordered remaining Phase 1 into WP1–WP4 |
| #13 | full-stack | **WP1** — activity-record ↔ location linkage: `locationId`, location geography drives the factor (FR §5.2), `NULLS NOT DISTINCT` unique index, reporting-entity picker |
| #14 | tooling | Adopted the token-efficient working mode in `CLAUDE.md` |
| #15 | ci | Upgraded GitHub Actions to the Node.js 24 runtime |
| #16 | backend | **WP2** — anomaly detection v1 + submit validation (VAR §4): rolling-baseline check, mandatory variance on submit |
| #17 | full-stack | **WP3** — period locking (FR §4.2): `period_locks` table + RLS, six-path gate, super_admin lock/unlock with in-transaction audit, `PeriodLocksDrawer`; `workflow-gate` skill extracted |

## What works today

- Supabase Auth login, route protection, `/me` with role + `accessibleSubsidiaryIds`
- Two-layer tenant isolation: NestJS guard (primary) + Postgres RLS (defense-in-depth)
- Subsidiaries CRUD (RBAC: writes `super_admin` only) + dashboard KPIs endpoint
- Calc engine: `POST /calculations/preview`, `GET /factors` — factor versioning, unit normalization
- Activity records: CRUD + submit/approve/reject, immutable calc snapshots, append-only audit log
- Data Entry UI (`/data-entry`), Emissions Analytics UI (`/emissions`) and the home dashboard Emissions Overview (`/`) fully on live data
- Operational locations: tenant-scoped CRUD API (`/locations`, `super_admin` writes, audit-logged) + management drawer on the subsidiaries page; `/kpi` counts real locations
- Evidence: private `evidence` bucket, upload-through-API + signed-URL downloads, `Evidence` table + RLS, Data Entry vault; evidence-required categories gate submit + matrix "green"
- Seed: 1 org, 5 subsidiaries, **8 operational locations**, 2 users, demo factors, **96 approved monthly Scope 1 & 2 activity records for 2024** each with a demo evidence file (prototype values, explicitly labelled)

## Known gaps / placeholders

- **Reports page** still renders mock "demo data" (now **Phase 1 WP6** — kept in Phase 1 per 2026-07-15)
- Dashboard **trend badges** show "—" until prior-year data exists
- **Targets tab + intensity toggle** on `/emissions`: no backend yet — shown as "not yet available" (no placeholder numbers, compliance rule; now **Phase 1 WP5** — kept in Phase 1 per 2026-07-15)
- **Scope 3:** no factors seeded; intentionally empty (Phase 3)
- Live **RLS containment probes** (PostgREST as anon/authenticated) were never run for `activity_records`/`locations`/`evidence`/`period_locks` — policies applied + API-level 404s verified, but no direct-client proof (Phase 1 WP4 → `scripts/rls-probes.mjs`)
- Pending Phase 1 work packages: **WP4** E2E harness & hardening · **WP5** Targets & intensity · **WP6** Reports

## Roadmap to production (phased)

> Sources: `docs/tech_docs/technical_analysis.md` §5 (phasing strategy),
> `docs/md_docs/functional_requirements.md` (FR), `docs/md_docs/validation_anomaly_rules.md` (VAR).
> Items beyond the original specs (operational launch readiness) are tagged **(launch-add)**.
> Legend: `[x]` done · `[ ]` pending. **Next up** is always the first unchecked item of the active phase.

### Phase 0 — Foundation & vertical slice ✅ complete

- [x] Turborepo monorepo (web + api + shared-types + db), one-command local bootstrap
- [x] Supabase Auth login + route protection; NestJS JWT guard + tenant isolation; Postgres RLS
- [x] Subsidiaries CRUD + `/kpi`; RBAC (`super_admin` writes); append-only `audit_log`
- [x] Branch/PR workflow, CI on Node 22, Vitest + Playwright baseline

### Phase 1 — Core MVP (Scope 1 & 2) — **active**

**App features**
- [x] Emission-factor library + versioning (prototype demo values, explicitly labelled)
- [x] Calculation engine: unit normalization, factor resolution, immutable snapshots, `POST /calculations/preview`
- [x] Activity records + review workflow (`draft → submitted → under_review → approved/rejected`) + audit rows
- [x] Data Entry UI on live API (tCO₂e preview, draft → submit, 409 on duplicate)
- [x] Emissions Analytics: `GET /emissions/summary` + live Summary/Breakdown/History/Trends tabs
- [x] **Dashboard `/` wiring** — Emissions Overview cards + tracking matrix (red/yellow/green cell rules, FR §2) from live `emissions/summary` + `emissions/tracking-matrix`; "Demo data" badge removed (PR #9)
- [x] **Locations level** — Holding > Subsidiary > **Location** hierarchy (FR §1.1): tenant-scoped CRUD API + management drawer + live `/kpi` location count (RLS already existed on the `locations` table from the init migration). *(Record↔location linkage deferred — see below.)*
- [x] **Evidence upload** — private Supabase Storage bucket, upload-through-API (service-role) + signed-URL downloads; `Evidence` table + RLS; Data Entry vault; evidence-required categories (Electricity/Natural Gas/Fuel) gate submit + the matrix "green" (FR §4.1 / §2.2); 96 demo files seeded. `supabase-storage` skill extracted.
- [x] RLS for new tables — `locations` (init migration) and `evidence` (`rls_evidence` migration) both covered

**Remaining work packages (ordered — reviewed 2026-07-06, see decisions log)**

- [x] **WP1 — Activity-record ↔ location linkage** — records target the whole subsidiary or a location (`locationId`); the entity's `geographyCode` drives the factor (FR §5.2). `Location.geographyCode` (backfilled), the 5-col unique constraint replaced by a single **`NULLS NOT DISTINCT`** index (subsidiary-level rows still deduplicated), reporting-entity picker on Data Entry + geography field on the locations drawer, 6 location-level demo records. 90 tests. Verified live: 10/10 (location geography drives factor, coexistence, 409/404 paths, detach).
- [x] **WP2 — Anomaly detection v1 + submit validation levels** — server-side check on create/update: tCO₂e vs. the rolling average of the previous 3 committed periods for the same reporting entity + category; > ±50% → `anomalyFlag` (VAR §4). Submit gate re-evaluates the baseline as of submit time (never trusts a stale flag) and requires a `varianceReason` when anomalous; `periodValue` validated per granularity; Data Entry warning banner + mandatory variance field. 102 tests. `qa-auditor` review pass done (4 findings fixed). Verified live: 7/7 API + browser banner. *(Hard-validation §3 rules with no backing fields — e.g. start/end date range — scoped out; unit-for-category is already enforced by the calc engine.)*
- [x] **WP3 — Period locking** — new `period_locks` table (+RLS) as period-level state; gate on create/update/remove/submit/approve/reject (409); `super_admin`-only lock/unlock, audited **inside the transaction**; locking requires all records reviewed (no submitted/under_review), flips `approved`→`locked`, unlock reverts; `PeriodLocksDrawer` on the subsidiaries page. 118 tests. `workflow-gate` skill extracted. `security-rls` review pass fixed 4 findings pre-PR — incl. a CRITICAL: Prisma migrate had silently dropped the `NULLS NOT DISTINCT` uniqueness index (guard rule added to CLAUDE.md). Verified live: 16/16 API + browser lock/unlock round-trip.
- [ ] **WP4 — E2E harness & hardening** — Playwright coverage of the Scope 1 & 2 slice. **P0:** data-entry happy path (subsidiary/entity/category/period → value → live tCO₂e preview → save draft → **evidence upload via `setInputFiles`** → submit → **approve via an in-test API call**, since approve has no UI → value visible in `/emissions`); the three submit gates as negative tests (evidence-required, anomaly+variance, locked-period); RBAC/tenant negatives (entry sees 2 subsidiaries, lock control hidden, direct `lockPeriod` → 403). **P1 smoke:** analytics tabs, dashboard matrix, subsidiaries drawers. Plus a standalone **`scripts/rls-probes.mjs`** — password-grant token → direct PostgREST reads (anon + entry Bearer) against `activity_records`/`locations`/`evidence`/`period_locks`; pass = cross-tenant rows `[]` **and** own-tenant rows visible (double criterion so a missing table GRANT can't masquerade as containment). Extract the **`e2e-flow` skill** (shared login / API-token / safe-unseeded-period / upload fixtures). **E2E-in-CI deferred to Phase 2** (needs Supabase in Actions — dated, deliberate defer). `qa-auditor` review pass before the PR. *Not the phase gate — this builds the harness that WP5/WP6 extend.*
- [ ] **WP5 — Targets & intensity** — replace the `/emissions` "not yet available" state with a real backend: emission-reduction **targets** (per subsidiary/org: baseline year + target year + % or absolute) and **intensity metrics** (tCO₂e per revenue/employee — needs a denominator field per subsidiary). Targets tab wired to live data, tenant-scoped + RBAC (`super_admin` manages targets), audit rows, E2E via the `e2e-flow` skill. *Compliance rule holds: no placeholder numbers until the backend is real.*
- [ ] **WP6 — Reports** — audit-ready **PDF** (Puppeteer) + **Excel/CSV** export, filter-aware (FR §5), replacing the Reports-page mock; tenant-scoped generation off the live aggregation. E2E for a generated report; a `report-generation` skill is a candidate. *(Email/Resend sharing stays Phase 3.)*

*Phase-1 exit criteria (after WP6):* every Phase-1 row in the README status table is ✅ and the full demo flow (enter → attach evidence → submit → approve → analytics → target progress → export a report) runs end-to-end locally.

### Phase 2 — Staging cloud & CI/CD

- [ ] Supabase **cloud** projects (dev/staging), env & secrets strategy (`.env` per environment, no secrets in git)
- [ ] Cloud migration + seed strategy (demo records only in dev; staging gets clean fixtures)
- [ ] Dockerfiles (web, api) + GitHub Actions **deploy pipeline** to GCP or Azure staging
- [ ] KVKK/GDPR-compliant data residency (EU/TR region selection)
- [ ] Observability baseline: Sentry (web + api), structured logs, uptime checks
- [ ] Staging smoke E2E running in CI on every deploy

*Exit criteria:* a stakeholder can use the full Phase-1 flow on a staging URL.

### Phase 3 — Advanced features (spec "Faz 2")

- [ ] **Scope 3**: categories, emission factors, dynamic forms
- [ ] **Supplier management** module (Scope 3 supplier ESG scores)
- [x] ~~**Targets backend** + intensity metrics~~ → **moved to Phase 1 (WP5)** per the 2026-07-15 decision
- [x] ~~**Reports** (PDF/Excel export)~~ → report *generation* **moved to Phase 1 (WP6)**; report *sharing via Resend* stays here (see Email notifications below)
- [ ] **Bulk upload**: historical data via CSV/Excel (Papa Parse) + server-side queue/worker
- [ ] **Email notifications** (Resend): submit/approve/reject events, anomaly alerts
- [ ] **i18n** (TR/EN) + dark mode
- [ ] **Python/FastAPI analytics microservice** (forecasting / advanced analytics)

*Exit criteria:* feature-complete against `functional_requirements.md`.

### Phase 4 — Production launch **(launch-add)**

- [ ] **Authoritative emission factors**: replace prototype set with licensed/official DEFRA (UK), Türkiye grid and AIB residual-mix values — source + version cited per factor; define the annual factor-update process (historic calcs stay immutable)
- [ ] **Security**: penetration test, API rate limiting, dependency scanning, secrets rotation
- [ ] **Performance**: load test, DB index review, cold-start budget
- [ ] **Backup/DR**: PITR enabled, restore drill executed, data-retention policy
- [ ] **User lifecycle**: invite flow, password reset, role-management UI (all 4 roles usable end-to-end)
- [ ] **Legal/compliance**: privacy policy, ToS, DPA (KVKK/GDPR)
- [ ] **Production environment**: domain + SSL, email deliverability (Resend domain verification), prod Supabase project
- [ ] **Go-live**: org provisioning/onboarding flow, zero demo data in prod, go-live checklist + rollback plan

*Exit criteria:* first real holding company onboarded and reporting in production.

### Post-launch operations **(launch-add)**

- [ ] Annual factor-library update cadence (new versions, never mutate history)
- [ ] Monitoring/alert review, incident-response process, support channel
- [ ] Dependency & security update cadence
- [ ] Roadmap grooming — keep this file current

### Open questions (decide before Phase 4)

- Billing/subscription model — not covered by any spec
- Depth of `executive_viewer` / `consultant` UX flows
- Mobile/responsive support targets

**Next up:** WP4 — E2E harness & hardening: Playwright coverage of the Scope 1 & 2 slice + `scripts/rls-probes.mjs` + `e2e-flow` skill (E2E-in-CI deferred to Phase 2). Phase 1 then extends with WP5 (Targets & intensity) and WP6 (Reports); the phase gate lands after WP6.

## Decisions log

- **2026-07-02** — Analytics aggregation is computed **server-side** (`GET /emissions/summary`), not in the browser: single source of truth, reusable by Reports later.
- **2026-07-02** — Analytics counts only **committed** statuses (`submitted`, `under_review`, `approved`, `locked`); drafts and rejected records are excluded.
- **2026-07-02** — Demo activity records are seeded (approved, monthly 2024, Scope 1 & 2 only) so analytics is demoable; provenance labelled prototype/DEMO_SOURCE everywhere.
- **2026-07-02** — Features without a real backend (targets, intensity) show an explicit "not yet available" state instead of mock numbers.
- **2026-07-03** — Agent/skill review before resuming Phase 1: the 7 subagents cover everything through Phase 2 (no additions/removals); revisit at Phase 3 for a `python-analytics` agent (FastAPI microservice). Skills updated: `tenant-api-module` now documents both write patterns (admin-managed vs. author-based workflow), `wire-page` gained the data-entry/emissions references and the two-label honesty rule. A `supabase-storage` skill will be extracted in the same PR that first implements evidence upload.
- **2026-07-04** — Tracking-matrix statuses (FR §2.2 interpretation): `under_review` counts as committed/green (it is submitted data in review); the anomaly flag makes a cell yellow ("flagged for review"); the "required evidence" green-condition is deferred until the evidence backend ships. Matrix status math lives server-side in `GET /emissions/tracking-matrix`; the recurring rollup recipe is now the `aggregation-endpoint` skill.
- **2026-07-06** — Evidence upload scope + architecture (both confirmed with the user): full scope = **capability + enforcement** (matrix green + submit-gate need evidence, so 96 committed records get a seeded demo file so the dashboard doesn't regress); **upload-through-API** (browser → NestJS → service-role Storage), not browser→Storage, to keep enforcement in the guard layer. Evidence-required set = `Electricity`, `Natural Gas`, `Fuel` (billed, invoice/meter-backed); the earlier deferred matrix "green needs evidence" condition (2026-07-04) is now wired.
- **2026-07-07** — WP1 uniqueness design (confirmed with the user): a single **`NULLS NOT DISTINCT`** unique index over `(subsidiary, location, year, period, periodValue, category)` — chosen over two partial indexes (simpler, PG17 supports it). Prisma's `@@unique` can't express it, so it lives in raw SQL (like the RLS policies) and the seed switched from upsert-by-compound-key to find-or-create. Also confirmed: seed a few location-level demo records; `locationId` is editable while the record is a draft (re-target or detach), `subsidiaryId` stays immutable.
- **2026-07-08** — WP2 anomaly semantics follow VAR §4 over the looser brief (confirmed with the user): baseline = rolling average of up to 3 prior committed periods (not a single previous period); deviation measured on **calculated tCO₂e** (not raw activity value); threshold strict `> ±50%`. First entry / zero baseline → not anomalous. Baseline keyed on `(subsidiaryId, locationId, category, reportingPeriod)` — spec's `organisationId`/`subCategoryKey` omitted (no such fields; subsidiary implies org), `locationId` + granularity added (both improvements). `anomalyFlag` computed on every write; the mandatory-variance gate fires only at submit and **recomputes** the baseline (API is the final enforcement layer, per the qa-auditor review). Field kept as `varianceReason` (existing column), not the spec's `varianceComment`.
- **2026-07-15** — WP3 period-lock semantics (granularity/status-sync/UI confirmed with the user; review-pass hardening): lock unit = one subsidiary's specific period tuple `(subsidiary, year, reportingPeriod, periodValue)` via a **`period_locks` table** (record status alone cannot block NEW records). **A period with `submitted`/`under_review` records cannot be locked** (409) — otherwise a lock/unlock round-trip would bulk-promote unreviewed data past the consultant workflow (security-rls finding). Flip is therefore strictly `approved`↔`locked` and reconstructible from the audit row (tuple + count); audits write **inside the lock/unlock transaction**. approve/reject also gate on the lock (defense-in-depth vs. the submit race). Manual locking only (no auto-lock on approve, per FR). FR §4.3 full revision workflow deferred — v1's formal change path is audited super_admin unlock. **Recurring hazard documented in CLAUDE.md:** every `prisma migrate dev` generation emits a spurious `DROP INDEX activity_records_reporting_entity_period_category_key` (raw index invisible to Prisma) — always delete it from generated migrations.
- **2026-07-15** — Phase-1 scope + WP4 shape (confirmed with the user in the WP4 plan review): **Targets/intensity and Reports stay in Phase 1**, not deferred to Phase 3 — so Phase 1 gains **WP5 (Targets & intensity)** and **WP6 (Reports)** after WP4, and those two items were pulled out of Phase 3. The README's existing "⏳ Phase 1" labels for Targets/Reports are therefore *correct* (the roadmap moved to match README, not the reverse — no README relabel needed). **WP4 reframed** from "the exit gate" to "the E2E harness + hardening of the Scope 1 & 2 slice"; the phase gate now lands after WP6. WP4 decisions: **RLS probes live in a standalone `scripts/rls-probes.mjs`** (reusable as the `rls-for-table` "Verify" evidence, no browser dependency) with a **double pass-criterion** — cross-tenant `[]` AND own-tenant visible — to catch a missing table GRANT that would otherwise read as false containment (migrations contain no explicit GRANTs; Supabase's default public-schema grants are relied on → verify live). **E2E-in-CI deferred to Phase 2** (Supabase-in-Actions is Phase-2 scope; the exit criteria only needs the flow to run locally). **`e2e-flow` skill extracted in WP4.** Approve has no UI (API-only) → the demo-flow E2E approves via an in-test password-grant token.
- **2026-07-06** — Post-#11 plan review (all three confirmed with the user): **(1) Remaining Phase 1 reordered** into 4 work packages — linkage first (data model finalises before features; anomaly baselines get the right key from day one), anomaly + submit validation **merged into one PR** (VAR §2–4 is one spec, same code path), then period locking, then E2E/hardening. **(2) Skills:** no additions/deletions now; `workflow-gate` to be extracted in the period-locking PR (third lifecycle gate), `e2e-flow` a candidate during WP4. **(3) Subagents:** all 7 unchanged; `python-analytics` still deferred to Phase 3; extend `backend-integrator` with report generation at Phase 3 start; `data-factors` retained (critical for Phase 3 Scope-3 factors + Phase 4 authoritative data). Also surfaced a hardening gap: live PostgREST RLS containment probes were never run → added to WP4.

## Session log

- **2026-07-02 → 03** — Built + verified PR #6 (typecheck, 61 tests, live browser check of all 5 analytics tabs, tenant-isolation probes). Merged; branch deleted; `main` synced. Created this roadmap log.
- **2026-07-03** — Expanded the roadmap into a full phased plan to production (Phases 0–4 + post-launch), derived from `technical_analysis.md` §5 + `functional_requirements.md`; added launch-readiness items the specs didn't cover. Renumbered README roadmap to match.
- **2026-07-03** — Reviewed the agent team + skills against the phased roadmap before resuming Phase 1 (see decisions log). Committed `.claude/launch.json` (preview tooling config).
- **2026-07-04** — Dashboard wiring (PR #9): built `GET /emissions/tracking-matrix` + 4 specs (65 total), mapped DTOs onto the existing dashboard components via `lib/dashboard-view.ts`, null-safe trend/locations badges, real anomaly alerts, drill-down verified live (sheet total 1,003 tCO₂e = endpoint value). Extracted the `aggregation-endpoint` skill in the same PR.
- **2026-07-06** — Locations level (`feat/locations`): tenant-scoped `/locations` CRUD (`tenant-api-module` admin-managed pattern) + 11 specs (77 total), `LocationsDrawer` on the subsidiaries page, `/kpi` location count, 8 seeded locations. `locations` table + RLS already existed (init migration) so no new migration. Deleted two orphan mock components (`subsidiary-form.tsx`, `entry-header.tsx`). Record↔location linkage deferred to its own item. Decisions: hierarchy-only scope + orphan deletion (both confirmed with the user).
- **2026-07-06** — Evidence upload (`feat/evidence-upload`): `Evidence` table + `rls_evidence` migration, `StorageService` (service-role) + `evidence` module (upload/list/signed-url/delete), submit-gate + matrix green now require evidence, Data Entry `EvidenceVault` (drag-drop), 96 seeded demo files. 88 tests (11 new). Extracted the `supabase-storage` skill. Verified live: 13/13 API checks (upload, submit-gate 400/OK, signed URL, tenant 404, delete-frozen, matrix green) + browser (vault renders, submit-gate toast blocks, no console errors).
- **2026-07-06** — PR #11 merged; `main` synced, branch deleted. Full plan/skills/agents review before continuing (see decisions log): Phase 1 remainder reordered into WP1–WP4, stale status-log sections refreshed (PR history #10–11, known gaps, next-up pointer), PostgREST containment probes added to hardening.
- **2026-07-07** — WP1 record↔location linkage (`feat/record-location-linkage`): `Location.geographyCode` + `ActivityRecord.locationId` (migration backfills geography, drops the old unique, adds a `NULLS NOT DISTINCT` index), factor geography resolves from the location, reporting-entity picker on Data Entry + geography on the locations drawer, seed find-or-create + 6 location-level records. 90 tests (+2). Verified live: DB dedup proof + 10/10 linkage script + browser (Location select populated with geo-tagged options, no console errors).
- **2026-07-08** — WP2 anomaly detection + validation (`feat/anomaly-detection`), first work package under the new working mode: `Explore` produced the plan (spec+code investigation stayed out of the main context); implemented in the main thread; `qa-auditor` review pass before the PR caught 4 real issues — all fixed: **(1)** submit now re-evaluates the baseline instead of trusting the write-time flag (baseline-drift gap); **(2)** `periodValue` validated per granularity (silent wrong-baseline from non-canonical tokens); **(3)** test coverage hardened (query-scope assertion, update-path/excludeId, 3-period cap, quarterly ordinal); **(4)** non-finite priors dropped from the average. 102 tests. Live verify was blocked while Docker was down; once up: 7/7 API (flag ↑↓, invalid period, submit gate block+pass) + browser banner + variance field, no console errors.
- **2026-07-15** — WP3 period locking (`feat/period-locking`): `period_locks` table + RLS migration, `PeriodLocksModule` (lock/unlock/list), six-path gate in activity-records, `PeriodLocksDrawer`, `workflow-gate` skill extracted, CLAUDE.md migration-drift guard. 118 tests (+16). `security-rls` review pass caught 4 findings (1 CRITICAL index drop, 1 HIGH review-bypass) — all fixed before the PR. Verified live: 16/16 API checks (RBAC 403, lock 201, status flip, 6× 409 paths, pending-review guard, tenant scoping, unlock revert, audit rows) + browser round-trip (drawer lock → list → unlock), no console errors.
- **2026-07-15** — WP3 (PR #17) merged; `main` synced, `feat/period-locking` deleted (local + remote). Planned **WP4** via `Explore` (existing E2E setup, gate flows, RLS-probe design + the missing-GRANT caveat, doc-cleanup list). User confirmed three decisions: E2E-in-CI → Phase 2; probes → standalone `scripts/rls-probes.mjs`; **Targets/Reports kept in Phase 1** → added WP5 + WP6 and pulled both from Phase 3. This log updated accordingly (status header, PR history #12–#17, known gaps, WP4 reframe, exit criteria, decisions log). No code yet — implementation starts next session with WP4.
