# TonyAI — UAT Guide (Phase 1)

> **Audience:** UAT testers validating the Phase-1 scope (Scope 1 & 2 carbon accounting, local environment).
> **Version:** Phase 1 complete (WP1–WP6), 2026-07-19.
> All figures use **prototype demo emission factors** — clearly labelled in-app; not authoritative DEFRA/AIB values.

## 1. Environment & access

| | |
| --- | --- |
| Prerequisites | Docker Desktop running, Node ≥ 20, pnpm |
| One-command setup | `pnpm setup` (Supabase up → env sync → migrate → seed) |
| Start the app | `pnpm dev` → web at **http://localhost:3000**, API at :3001 |
| Reset demo data | `pnpm db:reset` (recreates the full seed) |

**Test users** (password for both: `TonyAI!2026`):

| User | Role | Sees |
| --- | --- | --- |
| `admin@tonyai.local` | `super_admin` | all **5** subsidiaries; can manage everything |
| `entry@tonyai.local` | `data_entry` | only **2** subsidiaries (TonyAI Energy, TonyAI Logistics); cannot manage org structure |

**Seed data:** 1 organisation, 5 subsidiaries, 8 operational locations, 102 approved monthly 2024 activity records (each with a demo evidence file), 3 reduction targets, 10 intensity denominators.

## 2. What to test — scenario checklist

### 2.1 Authentication & route protection
1. Open http://localhost:3000 while signed out → you are redirected to `/login`.
2. Sign in as `admin@tonyai.local` → you land on the **Carbon Dashboard**.
3. Sign out → any page visit redirects back to `/login`.

### 2.2 Dashboard (`/`)
1. As admin: KPI cards show live values (Total Subsidiaries = 5, locations, records).
2. The **Data Collection Status** matrix renders red/yellow/green cells per subsidiary × category.
3. Click a matrix cell → a drill-down sheet opens with that cell's records.

### 2.3 Tenant isolation & RBAC (`/subsidiaries`)
1. As admin: 5 rows; **Add Subsidiary** and per-row **Delete** are visible; create a subsidiary and delete it again.
2. As `entry@tonyai.local`: exactly **2** rows; Add/Delete controls are **not rendered**.
3. As entry, open **Manage period locks** (padlock icon) → the drawer opens read-only: no *Lock period* form, an "only a super_admin" note instead.
4. Expected API behaviour behind the UI: non-admin writes return **403**, unauthenticated calls **401**.

### 2.4 Data entry lifecycle (`/data-entry`)
1. As admin, pick **TonyAI Energy · Electricity · 2024 · Quarterly · Q1** (an empty period), enter e.g. `12500` kWh → a **live tCO₂e preview** appears with the factor, source and version.
2. **Save draft** → the record appears under Previous submissions; the **Evidence vault** appears.
3. Click **Submit for review** *without* a file → blocked: "requires at least one evidence file" (evidence gate, FR §4.1).
4. Upload a PDF/JPG/XLSX into the vault → **Submit for review** → "Submitted for review".
5. **Anomaly gate:** enter a value ~10× the usual for a period that has history → on save, an amber banner appears and submit is blocked until a **variance reason** is entered (VAR §4).
6. **Duplicate protection:** saving the same subsidiary+period+category twice → clear error (409).
7. *Note:* **approve/reject has no UI in Phase 1** — reviewers act via the API. For UAT the seed already contains approved data; the full submit→approve flow is covered by the automated E2E suite.

### 2.5 Period locking (`/subsidiaries` → padlock)
1. As admin, open **Manage period locks** on a subsidiary → lock e.g. **2024 / Quarterly / Q1**.
2. Go to `/data-entry`, try to create/edit a record in that period → blocked: "is locked" (FR §4.2).
3. Unlock the period → entry works again. Both actions are recorded in the audit log.

### 2.6 Emissions analytics (`/emissions`)
1. Tabs **Summary / Breakdown / History / Trends** all render live data (totals ≈ 3,177 tCO₂e for 2024 seed).
2. Scope and category filters change every tab consistently.
3. **Targets tab:** three demo targets — one **On track**, one **At risk**, one honest **"Progress n/a"** (its baseline year has no later data). As admin, add a target and delete it.
4. **Absolute ↔ Intensity toggle:** switch to Intensity → four metric cards (tCO₂e per m², per FTE, per M EUR, per unit). As admin, add/remove a denominator; as entry the manage controls are hidden.

### 2.7 Reports (`/reports`) — new in WP6
1. The preview shows the **live** executive summary: status badge (**Approved** only when reviewed data exists and nothing is pending/incomplete — an empty year is never "Approved"), scope tiles, charts, category table.
2. **Download PDF** → a branded, multi-page A4 PDF (`tonyai-…​.pdf`) with totals, tables and — when *Methodology notes* is ticked — the **emission-factor appendix** (value, source, version per factor).
3. **Export Excel** → 3 sheets: *Summary*, *Raw Activity Data* (full committed ledger), *Factors Used*.
4. **Export CSV** → the committed ledger (one row per record, evidence counts included).
5. Switch template to **GHG Protocol Detail** → the PDF also contains the full activity-records ledger.
6. Tick **Evidence summary** → the PDF lists evidence *file names + counts* (links are deliberately not embedded — they expire).
7. Scope the report to a single subsidiary → all outputs shrink accordingly. As `entry` (data_entry), the export buttons are **not available** — the permissions matrix denies report generation to data_entry (the API also returns 403); the preview stays tenant-scoped to its 2 subsidiaries.
8. Every generation writes an audit row (`entity: report`).

## 3. Out of scope for this UAT (planned later)
- **Approve/reject UI** (API-only in Phase 1) · **report sharing** by link/email · **Scope 3** categories & factors · supplier management · bulk CSV upload · email notifications · i18n/dark mode · cloud/staging deployment (Phase 2) · authoritative DEFRA/AIB factor libraries (Phase 4).
- Dashboard year-over-year badges show "—" until a second year of data exists.

## 4. Verification status (what is already proven by automation)
- **161 API unit tests** (Vitest) — calculation engine, tenant isolation, RBAC, all lifecycle gates, targets/intensity math, report assembly.
- **14 end-to-end tests** (Playwright) — login, CRUD, the full data-entry lifecycle incl. evidence upload and approve, all three submit gates, RBAC/tenant negatives, analytics/dashboard smoke, targets round-trip, report downloads (exact filenames + magic-byte checks) and the data_entry no-export rule.
- **18 live RLS containment probes** (6 tenant tables × 3 checks) — the database layer independently hides cross-tenant rows even when the API is bypassed.
- Every mutation writes an append-only **audit log** row.

## 5. Reporting issues
Note the page, user, steps, expected vs. actual, and a screenshot. The demo data can always be restored with `pnpm db:reset`.
