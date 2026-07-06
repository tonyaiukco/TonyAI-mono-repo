# Project Status & Roadmap Log

> **Purpose:** persistent, in-repo working memory across Claude Code sessions.
> **Update rule:** refresh this file in the same change whenever a PR merges, a
> decision is made, or the roadmap shifts. Read it at session start ("where did
> we leave off?"). Keep entries short — link to code/PRs instead of restating them.
> README stays the public-facing summary; this file is the granular working log.

## Current status — as of 2026-07-06

- **Phase:** Phase 1 — Core MVP (Scope 1 & 2)
- **Latest merged:** PR #9 (`dffb7ac`, dashboard wiring); Locations work on `feat/locations` (uncommitted)
- **Tests:** 77 unit (Vitest, API) + 2 E2E (Playwright) — green
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

## What works today

- Supabase Auth login, route protection, `/me` with role + `accessibleSubsidiaryIds`
- Two-layer tenant isolation: NestJS guard (primary) + Postgres RLS (defense-in-depth)
- Subsidiaries CRUD (RBAC: writes `super_admin` only) + dashboard KPIs endpoint
- Calc engine: `POST /calculations/preview`, `GET /factors` — factor versioning, unit normalization
- Activity records: CRUD + submit/approve/reject, immutable calc snapshots, append-only audit log
- Data Entry UI (`/data-entry`), Emissions Analytics UI (`/emissions`) and the home dashboard Emissions Overview (`/`) fully on live data
- Operational locations: tenant-scoped CRUD API (`/locations`, `super_admin` writes, audit-logged) + management drawer on the subsidiaries page; `/kpi` counts real locations
- Seed: 1 org, 5 subsidiaries, **8 operational locations**, 2 users, demo factors, **96 approved monthly Scope 1 & 2 activity records for 2024** (prototype values, explicitly labelled)

## Known gaps / placeholders

- **Reports page** still renders mock "demo data"
- Dashboard trend badges and the Locations count show "—" until prior-year data / the locations backend exist
- **Targets tab + intensity toggle** on `/emissions`: no backend yet — shown as "not yet available" (no placeholder numbers, compliance rule)
- **Scope 3:** no factors seeded; intentionally empty (Phase 2)
- Pending Phase 1 items: evidence upload (Supabase Storage), period locking, real anomaly detection (seed only sets a demo flag), Emissions e2e coverage

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
- [ ] **Activity-record ↔ location linkage** — let entries target a location (not just a subsidiary): add `geographyCode` to `Location`, `locationId` to `ActivityRecord`, revise the uniqueness constraint, resolve factor geography from the location, and add a location picker to Data Entry (FR §5.2). Deferred out of the locations PR because it touches the calc path + a migration.
- [ ] **Evidence upload** — Supabase Storage; ≥1 evidence file required at submit (FR §4.1); pdf/image/spreadsheet types; evidence listed on record detail
- [ ] **Period locking** — lock approved periods (FR §4.2): `locked` transitions + guards; `super_admin`-only unlock with audit row; locked periods block new/edited records
- [ ] **Anomaly detection v1** — server-side check at save/submit: >±50% deviation vs. previous-period baseline (VAR §4) → `anomalyFlag` + mandatory `varianceReason`
- [ ] **Submit validation levels** — lenient draft-save vs. strict submit validation (VAR §2–3)

**Hardening (exit gate)**
- [ ] E2E coverage: data-entry and analytics happy paths + RBAC/tenant negative cases
- [ ] RLS for new tables (`evidence`) via the `rls-for-table` skill (`locations` already covered)

*Exit criteria:* every Phase-1 row in the README status table is ✅ and the full demo flow (enter → submit → approve → analytics) runs end-to-end locally.

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
- [ ] **Targets backend** + Targets tab wired (replaces "not yet available"); **intensity metrics** (requires revenue/employee denominator data per subsidiary)
- [ ] **Reports**: audit-ready PDF (Puppeteer) + Excel/CSV export, filter-aware (FR §5); sharing via Resend
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

**Next up:** Locations level (first unchecked item of Phase 1).

## Decisions log

- **2026-07-02** — Analytics aggregation is computed **server-side** (`GET /emissions/summary`), not in the browser: single source of truth, reusable by Reports later.
- **2026-07-02** — Analytics counts only **committed** statuses (`submitted`, `under_review`, `approved`, `locked`); drafts and rejected records are excluded.
- **2026-07-02** — Demo activity records are seeded (approved, monthly 2024, Scope 1 & 2 only) so analytics is demoable; provenance labelled prototype/DEMO_SOURCE everywhere.
- **2026-07-02** — Features without a real backend (targets, intensity) show an explicit "not yet available" state instead of mock numbers.
- **2026-07-03** — Agent/skill review before resuming Phase 1: the 7 subagents cover everything through Phase 2 (no additions/removals); revisit at Phase 3 for a `python-analytics` agent (FastAPI microservice). Skills updated: `tenant-api-module` now documents both write patterns (admin-managed vs. author-based workflow), `wire-page` gained the data-entry/emissions references and the two-label honesty rule. A `supabase-storage` skill will be extracted in the same PR that first implements evidence upload.
- **2026-07-04** — Tracking-matrix statuses (FR §2.2 interpretation): `under_review` counts as committed/green (it is submitted data in review); the anomaly flag makes a cell yellow ("flagged for review"); the "required evidence" green-condition is deferred until the evidence backend ships. Matrix status math lives server-side in `GET /emissions/tracking-matrix`; the recurring rollup recipe is now the `aggregation-endpoint` skill.

## Session log

- **2026-07-02 → 03** — Built + verified PR #6 (typecheck, 61 tests, live browser check of all 5 analytics tabs, tenant-isolation probes). Merged; branch deleted; `main` synced. Created this roadmap log.
- **2026-07-03** — Expanded the roadmap into a full phased plan to production (Phases 0–4 + post-launch), derived from `technical_analysis.md` §5 + `functional_requirements.md`; added launch-readiness items the specs didn't cover. Renumbered README roadmap to match.
- **2026-07-03** — Reviewed the agent team + skills against the phased roadmap before resuming Phase 1 (see decisions log). Committed `.claude/launch.json` (preview tooling config).
- **2026-07-04** — Dashboard wiring (PR #9): built `GET /emissions/tracking-matrix` + 4 specs (65 total), mapped DTOs onto the existing dashboard components via `lib/dashboard-view.ts`, null-safe trend/locations badges, real anomaly alerts, drill-down verified live (sheet total 1,003 tCO₂e = endpoint value). Extracted the `aggregation-endpoint` skill in the same PR.
- **2026-07-06** — Locations level (`feat/locations`): tenant-scoped `/locations` CRUD (`tenant-api-module` admin-managed pattern) + 11 specs (77 total), `LocationsDrawer` on the subsidiaries page, `/kpi` location count, 8 seeded locations. `locations` table + RLS already existed (init migration) so no new migration. Deleted two orphan mock components (`subsidiary-form.tsx`, `entry-header.tsx`). Record↔location linkage deferred to its own item. Decisions: hierarchy-only scope + orphan deletion (both confirmed with the user).
