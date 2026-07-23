# Project Status & Roadmap Log

> **Purpose:** persistent, in-repo working memory across Claude Code sessions.
> **Update rule:** refresh this file in the same change whenever a PR merges, a
> decision is made, or the roadmap shifts. Read it at session start ("where did
> we leave off?"). Keep entries short — link to code/PRs instead of restating them.
> README stays the public-facing summary; this file is the granular working log.

## Current status — as of 2026-07-22

- **Phase:** Phase 1 COMPLETE + UAT running (1-2 external testers). **Phase 2 is GCP-blocked** (credit application pending) → working **Phase 3 (reordered, WP7+)** + GCP-independent Phase-2 prep in the meantime
- **Latest merged:** PR #24 (pre-UAT audit fixes + `docs/uat/uat_phase1.md`); UAT open to external testers
- **Tests:** 165 unit (Vitest, API) + 14 E2E (Playwright) + 18 live RLS containment probes — green
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

- ~~Reports page mock~~ → **shipped (WP6)**: live preview + PDF/Excel/CSV generation; the orphaned `emissions-data.ts` mock was deleted. Approve/reject remains API-only (no UI); report sharing (Resend) is Phase 3
- Dashboard **trend badges** show "—" until prior-year data exists
- ~~Targets tab + intensity toggle "not yet available"~~ → **shipped (WP5)**: reduction targets with live progress + per-year intensity denominators; toggle gated until metrics configured
- **Scope 3:** no factors seeded; intentionally empty (Phase 3)
- Pending Phase 1 work packages: none — Phase 1 complete; the UAT plan lives in `docs/uat/uat_phase1.md`
- E2E + RLS probes need a live Supabase, so they run locally only (not in CI) — wiring them into CI is Phase 2 (staging smoke E2E)

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
- [x] **WP4 — E2E harness & hardening** — 10 Playwright specs (demo lifecycle enter→preview→evidence→submit→approve→visible; the 3 submit gates evidence/anomaly/locked-period; RBAC + tenant isolation; analytics + dashboard smoke) + standalone `scripts/rls-probes.mjs` (12 checks — per tenant table: anon=0, entry>0, entry == own-tenant count (exact containment, catches a partial leak); the `entry>0` leg also proves the SELECT GRANT is present, so a missing grant can't masquerade as containment) + the `e2e-flow` skill. Every E2E write lives in the unseeded `quarterly` space; `globalSetup`/`globalTeardown` wipe it (runs idempotent, monthly seed preserved). Approve is API-only (no UI) → the demo flow approves via a Supabase password-grant token; shadcn/Radix selects are picked by field Label (the trigger's accessible name is unreliable). Verified: 10/10 E2E + 12/12 probes green; DB clean + seed intact (102 rows) after the run. **E2E-in-CI deferred to Phase 2** (needs Supabase in Actions). *Not the phase gate — this is the harness WP5/WP6 extend.*
- [x] **WP5 — Targets & intensity** — two new subsidiary-scoped tables (`targets`, `subsidiary_denominators`) + RLS (mirrors `period_locks`). `TargetsModule` (CRUD + `GET /targets/progress`) reuses `EmissionsService.summary` for live progress: baseline is a **declared** value, "current" = the most recent committed year AFTER the baseline → `null`/"n/a" when none exists (honest, no placeholder). `IntensityModule` (denominator CRUD + `GET /intensity`): emissions ÷ configured denominator per metric (the spec's four: area/revenue/headcount/production_output), scoped to the subsidiaries that have it. `super_admin`-only writes, all audited. Frontend: live Targets tab (cards + progress bars/n-a + create/delete) and a functional Absolute/Intensity toggle (gated until metrics configured, super_admin can open it to configure the first). Seed: 3 demo targets (baselines tuned near real 2024 → on_track/at_risk/n-a spread) + 10 denominators. 139 tests (+21). RLS probes extended to 6 tables (18 checks). Verified live: targets/progress/intensity endpoints, RBAC 403, tenant isolation, browser UI. `security-rls` review pass.
- [x] **WP6 — Reports** — `ReportsModule`: one tenant-scoped `assemble()` (reuses `EmissionsService.summary` + the committed ledger + deduped immutable factor snapshots + evidence file names) feeding three formats: **PDF** (API-side HTML template → Puppeteer `setContent` — never printing a web route, which would need cookie+Bearer double auth), **Excel** (exceljs, 3 sheets: Summary / Raw Activity Data / Factors Used) and **CSV** (dependency-free writer). `GET /reports/{meta,pdf,excel,csv}`; every generation audited (`entity:'report'` = the §10 generation log — no extra table per the 2026-07-19 decision). Status/completeness meta (`approved|draft|contains_incomplete_data` + >15% data warning) computed from real record counts. Reports page rewired to live data (mock `emissions-data.ts` deleted); 2 templates (Executive Summary + GHG Protocol Detail; comparison/supplier → Phase 3). Evidence appears as file names + counts, never signed URLs. 161 tests (+19) + reports E2E (exact filenames + magic bytes + data_entry no-export). `report-generation` skill extracted. UAT guide added (later merged into `docs/uat/uat_phase1.md`).

*Phase-1 exit criteria:* **SATISFIED (2026-07-19)** — every Phase-1 row in the README status table is ✅ and the full demo flow (enter → attach evidence → submit → approve → analytics → target progress → export a report) runs end-to-end locally (proven by the 13-spec E2E suite).

### Phase 2 — Staging cloud & CI/CD — **GCP-blocked** (credit application pending)

**GCP-independent prep — may be pulled forward between Phase-3 packages:**
- [ ] Dockerfiles (web, api — the api image needs Chromium for Puppeteer) + local `docker compose` proof
- [ ] Supabase **cloud** projects (dev/staging) + env & secrets strategy (`.env` per environment, no secrets in git)
- [ ] Cloud migration + seed strategy (demo records only in dev; staging gets clean fixtures)
- [ ] Observability baseline: Sentry (web + api), structured logs, uptime checks

**GCP-dependent (starts when the credit lands):**
- [ ] GitHub Actions **deploy pipeline** to GCP staging (Cloud Run)
- [ ] KVKK/GDPR-compliant data residency (EU/TR region selection, e.g. europe-west3)
- [ ] Staging smoke E2E running in CI on every deploy

*Exit criteria:* a stakeholder can use the full Phase-1 flow on a staging URL.

### Phase 3 — Advanced features (spec "Faz 2") — **active** (reordered 2026-07-22 while GCP is pending)

> Ordering rationale: UAT is running → ship the small UAT-visible fixes first, then the
> packages least likely to be invalidated by UAT feedback (no data-model churn), and the
> big data-model items (Scope 3, suppliers) after the first UAT round closes.
> GCP-independent Phase-2 prep may be interleaved between packages.

- [ ] **WP7 — UAT backlog & review UX** — the audit's tester-visible gaps: **audit-trail viewer** (read API + UI; G3), **subsidiary Edit dialog** incl. the geography-change recalculation warning (G5), **matrix → Data Entry shortcut** (G6), and a minimal **reviewer UI** for submit→review→approve/reject (turns the API-only flow into a testable screen). Includes the **consultant-permissions decision** (matrix says consultant may NOT approve; code allows it — user decides, docs align).
- [ ] **WP8 — Bulk upload** — historical data via CSV/Excel (Papa Parse) + validation report (row-level errors, dry-run), server-side processing; respects all lifecycle gates + dedup.
- [ ] **WP9 — Email notifications (Resend)** — submit/approve/reject events + anomaly alerts; dev-mode delivery (domain verification is Phase 4).
- [ ] **WP10 — Report sharing** — share a generated report via link/email (builds on WP9's Resend baseline; report_page.md §8).
- [ ] **WP11 — Scope 3** — categories, emission factors, dynamic forms (big data-model package; starts after the first UAT round).
- [ ] **WP12 — Supplier management** — module + Scope 3 supplier ESG scores (depends on WP11).
- [ ] **WP13 — i18n (TR/EN) + dark mode**
- [ ] **WP14 — Python/FastAPI analytics microservice** (forecasting / advanced analytics; revisit the `python-analytics` subagent decision here)
- [x] ~~**Targets backend** + intensity metrics~~ → **moved to Phase 1 (WP5)** per the 2026-07-15 decision
- [x] ~~**Reports** (PDF/Excel export)~~ → report *generation* **moved to Phase 1 (WP6)**; report *sharing* is WP10

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

**Next up:** **WP7 — UAT backlog & review UX** (audit-trail viewer, subsidiary Edit, matrix shortcut, minimal reviewer UI, consultant-permissions decision). Phase 2 starts the moment the GCP credit lands — its GCP-independent prep (Dockerfiles, Supabase cloud, Sentry) may be interleaved between Phase-3 packages.

## Decisions log

- **2026-07-22** — **Phase 3 started before Phase 2** (confirmed with the user): the GCP credit application is still pending, Phase 2's deploy target is blocked, and Phase 3 is pure app-layer work with no cloud dependency — waiting would be the expensive option. Phase 3 reordered into WP7–WP14 by two principles: (1) **UAT-feedback resilience** — small tester-visible fixes first (WP7), then packages that don't touch the data model (WP8 bulk upload, WP9 notifications, WP10 sharing), and the schema-heavy packages (WP11 Scope 3, WP12 suppliers) only after the first UAT round; (2) **GCP-independent Phase-2 prep** (Dockerfiles incl. Chromium, Supabase cloud projects, Sentry) split out and allowed to interleave between packages so the eventual GCP hookup shrinks to wiring the deploy pipeline. WP7 also absorbs a **minimal reviewer UI** (the API-only review flow is a UAT friction point) and forces the **consultant-permissions decision** (spec conflict recorded 2026-07-20).

- **2026-07-19** — WP6 design (confirmed with the user): **PDF via Puppeteer inside the API** — an HTML template string rendered with `page.setContent`, never printing a Next.js route (web routes sit behind the cookie `proxy` guard while the API is Bearer-only; printing a route would mean satisfying both auth systems and running a web server in the generation path). **2 templates** ship (Executive Summary + GHG Protocol Detail); Subsidiary Comparison + Supplier Scorecard → Phase 3. **Generation log = audit_log** (`entity:'report'`) — no dedicated table; the mock "Recent Reports" panel was dropped. Standing defaults applied: evidence rendered as **file names + counts** (signed URLs expire — worthless in a static artifact); Data Quality Score column deferred (inventing a metric violates the no-placeholder rule); reports are **year-scoped** in v1. Puppeteer needs `allowBuilds` in `pnpm-workspace.yaml` (pnpm 11) and Chromium in the future api Docker image (Phase 2 note).

- **2026-07-18** — WP5 design (confirmed with the user): targets are **subsidiary-level** (reuses every RLS/tenant/probe/progress pattern; report spec expects per-subsidiary intensity). Denominators live in a **per-year `subsidiary_denominators` table** `(subsidiary, year, metric)` so intensity over time stays honest. **All four spec metrics** (area/revenue/headcount/production_output). Progress: baseline tCO₂e is a **declared business input** (not computed); "current" = latest committed year strictly after the baseline, else **`null`/"n/a"** (satisfies the no-placeholder compliance rule while still showing real progress for a declared 2023 baseline against real 2024 data). Intensity numerator is scoped to exactly the subsidiaries that have the denominator; the Absolute/Intensity toggle is gated when nothing is configured (spec §2 "only valid configured metrics"), but a super_admin can always open the panel to add the first one. Reused `EmissionsService.summary` for both progress and intensity (single aggregation source).

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
- **2026-07-17** — WP4 E2E harness & hardening (`feat/e2e-hardening`): 10 Playwright specs + shared `e2e/helpers.ts` (login / password-grant API token / field-scoped Radix select / `createCommittedRecord` arrange / quarterly teardown) + `e2e/fixtures/sample-invoice.pdf` + `globalSetup`/`globalTeardown`; `scripts/rls-probes.mjs` (+`pnpm rls:probe`); `e2e-flow` skill; README + status refresh. Grounded the design on the live DB (quarterly 2024 = the only unseeded space; per-test subsidiary isolation). Debug arc: fixed the RLS-probe service-role role (PostgREST reads the role from the Authorization bearer, not apikey) + client-generated uuid on PostgREST insert; then two Playwright selector fixes — the Subsidiary field is a Skeleton until load (don't use `combobox.first()`), and Radix trigger accessible-name matching is unreliable (pick by field Label + wait for the listbox to close). Corrected two test premises against the real UI (data_entry DOES see Add Subsidiary / Manage-period-locks buttons — the write action is gated inside the drawer + at the API; matrix heading is "Data Collection Status"). Green: 10/10 E2E + 12/12 probes; DB clean + 102-row seed intact afterwards. Also folded in a small UI RBAC polish (the qa-auditor surfaced the gap): the subsidiaries-page **create/delete** controls are now hidden for non-`super_admin` via a single `canManage` flag (API + RLS remain the real enforcement); the read-only locations/period-locks drawers stay open to all, their write forms already gated. The rbac E2E asserts the hidden controls; `smoke.spec`'s admin create/delete proves admin visibility is intact.
- **2026-07-15** — WP3 (PR #17) merged; `main` synced, `feat/period-locking` deleted (local + remote). Planned **WP4** via `Explore` (existing E2E setup, gate flows, RLS-probe design + the missing-GRANT caveat, doc-cleanup list). User confirmed three decisions: E2E-in-CI → Phase 2; probes → standalone `scripts/rls-probes.mjs`; **Targets/Reports kept in Phase 1** → added WP5 + WP6 and pulled both from Phase 3. This log updated accordingly (status header, PR history #12–#17, known gaps, WP4 reframe, exit criteria, decisions log). No code yet — implementation starts next session with WP4.
- **2026-07-18** — WP5 Targets & intensity (`feat/targets-intensity`): `targets` + `subsidiary_denominators` tables (+ `rls_targets_intensity` migration; deleted the recurring spurious `DROP INDEX` on activity_records), `TargetsModule` (CRUD + progress) + `IntensityModule` (denominator CRUD + intensity), shared-types DTOs, api-client methods, live `TargetsPanel` + `IntensityPanel` on `/emissions` with a functional Absolute/Intensity toggle, 3 demo targets + 10 denominators seeded, `prisma.config.ts`-based migrate (from the #20 chore). 139 unit tests (+21) + 2 E2E + RLS probes on 6 tables (18 checks). Verified live: on_track/at_risk/n-a progress spread, 4 intensity metric cards, RBAC 403, tenant isolation, browser round-trip. `security-rls` review pass before the PR.
- **2026-07-19** — WP6 Reports (`feat/reports`), the final Phase-1 package: `ReportsModule` (assemble → PDF/Puppeteer + Excel/exceljs + CSV, all audited), `GET /reports/{meta,pdf,excel,csv}`, Reports page rewired to live data (orphan `emissions-data.ts` mock deleted), `report-generation` skill, UAT guide (later merged into `docs/uat/uat_phase1.md`). 161 unit (+19, incl. HTML-escaping, CSV-quoting/formula-neutralizing, meta-status math, Excel sheet structure) + 14 E2E (exact server filenames — proving the CORS `exposedHeaders` fix — plus magic-byte artifact checks and the data_entry no-export rule) + 18 RLS probes. `qa-auditor` review pass caught 7 findings, all fixed pre-PR: (1) HIGH — an empty in-scope year was badged "Approved" → committedCount=0 can never be approved; (2) MED-HIGH — the permissions matrix denies report generation to data_entry but nothing enforced it → 403 in the service + buttons hidden in the UI + docs aligned; (3) Content-Disposition not CORS-exposed (filenames never reached the browser — the green E2E masked it); (4) committed-status list divergence risk → single import from EmissionsService; (5) Puppeteer launch race leak → memoized promise; (6) header injection via subsidiaryId in the filename → sanitized; (7) hardcoded org name in the preview → live from /reports/meta. Live-verified: 4-page branded PDF, valid 3-sheet xlsx, 103-line CSV, truthful evidence counts (after killing stale API processes that masked a fix), tenant-scoped exports (entry sees only its 2 subsidiaries; cross-tenant request → empty), audit rows per generation, browser download round-trip. **Phase 1 exit criteria satisfied.**
- **2026-07-20** — Pre-UAT full requirements audit (`qa-auditor`, all 18 docs vs implementation; re-ran the whole verification stack itself). Verdict: **Phase-1 contract satisfied, with 7 unrecorded gaps** (none UAT-blocking) + 5 undocumented deviations. Fixed in `fix/uat-prep` before opening UAT: **G1** stale/dead `/emissions` Export button → now routes to `/reports`; two surviving orphan mocks deleted (`components/dashboard/header.tsx`, `lib/data.ts`); **G2** `under_review` was unreachable → new `POST /activity-records/:id/review` transition (reviewer roles, period-lock gated, audited; +4 tests → 165). Backlogged (recorded here, listed in the UAT doc's known-limits): G3 audit-trail viewer, G4 dashboard context bar, G5 subsidiary Edit UI, G6 matrix→data-entry shortcut, G7 VAR §5.1 boundary checks; deviations to resolve before Phase 4 — consultant approve powers exceed permissions_and_roles.md (specs self-conflict), 404-vs-403 on cross-tenant, audit rows lack `role` + use `update` for transitions, friendly category taxonomy, single-subsidiary report scope. UAT docs merged into **`docs/uat/uat_phase1.md`** (TC catalog AUTH/DASH/SUBS/ENTRY/LOCK/EMIS/REP + known-limits + bug template + sign-off); `uat-guide.md` deleted.
- **2026-07-22** — PR #24 merged (`main` synced, branch deleted); UAT opened to external testers. Phase-3 plan review with the user: reordered Phase 3 into WP7–WP14 (see decisions log), split Phase 2 into GCP-independent prep vs GCP-dependent, next up = WP7. Docs-only change.
