# Project Status & Roadmap Log

> **Purpose:** persistent, in-repo working memory across Claude Code sessions.
> **Update rule:** refresh this file in the same change whenever a PR merges, a
> decision is made, or the roadmap shifts. Read it at session start ("where did
> we leave off?"). Keep entries short — link to code/PRs instead of restating them.
> README stays the public-facing summary; this file is the granular working log.

## Current status — as of 2026-07-03

- **Phase:** Phase 1 — Core MVP (Scope 1 & 2)
- **main:** `573c814` (PR #6 merged)
- **Tests:** 61 unit (Vitest, API) + 2 E2E (Playwright) — green
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

## What works today

- Supabase Auth login, route protection, `/me` with role + `accessibleSubsidiaryIds`
- Two-layer tenant isolation: NestJS guard (primary) + Postgres RLS (defense-in-depth)
- Subsidiaries CRUD (RBAC: writes `super_admin` only) + dashboard KPIs endpoint
- Calc engine: `POST /calculations/preview`, `GET /factors` — factor versioning, unit normalization
- Activity records: CRUD + submit/approve/reject, immutable calc snapshots, append-only audit log
- Data Entry UI (`/data-entry`) and Emissions Analytics UI (`/emissions`) fully on live data
- Seed: 1 org, 5 subsidiaries, 2 users, demo factors, **96 approved monthly Scope 1 & 2 activity records for 2024** (prototype values, explicitly labelled)

## Known gaps / placeholders

- **Home dashboard `/`** and **Reports page** still render mock "demo data"
- **Targets tab + intensity toggle** on `/emissions`: no backend yet — shown as "not yet available" (no placeholder numbers, compliance rule)
- **Scope 3:** no factors seeded; intentionally empty (Phase 2)
- Pending Phase 1 items: evidence upload (Supabase Storage), period locking, real anomaly detection (seed only sets a demo flag), Emissions e2e coverage

## Next steps (proposed order)

1. **Wire home dashboard `/`** to live `GET /kpi` + `GET /emissions/summary` (drop the "Demo data" badge)
2. **Evidence upload** — Supabase Storage attachments on activity records
3. **Period locking** — `locked` status transition paths + guards
4. **Anomaly detection** — server-side variance check vs. historical baseline
5. Hardening: negative/security tests, then **Phase 2** (cloud staging, CI/CD, Scope 3, reports, i18n, Resend, Sentry)

## Decisions log

- **2026-07-02** — Analytics aggregation is computed **server-side** (`GET /emissions/summary`), not in the browser: single source of truth, reusable by Reports later.
- **2026-07-02** — Analytics counts only **committed** statuses (`submitted`, `under_review`, `approved`, `locked`); drafts and rejected records are excluded.
- **2026-07-02** — Demo activity records are seeded (approved, monthly 2024, Scope 1 & 2 only) so analytics is demoable; provenance labelled prototype/DEMO_SOURCE everywhere.
- **2026-07-02** — Features without a real backend (targets, intensity) show an explicit "not yet available" state instead of mock numbers.

## Session log

- **2026-07-02 → 03** — Built + verified PR #6 (typecheck, 61 tests, live browser check of all 5 analytics tabs, tenant-isolation probes). Merged; branch deleted; `main` synced. Created this roadmap log.
