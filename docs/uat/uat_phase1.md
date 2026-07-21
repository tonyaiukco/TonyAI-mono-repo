# TonyAI — Phase 1 UAT Plan & Test Catalog

> **Purpose:** the single UAT document for opening TonyAI Phase 1 to external testers (1-2 users).
> **Version:** Phase 1 complete (WP1–WP6) + UAT-prep fixes · 2026-07-20.
> **Scope under test:** Scope 1 & 2 carbon accounting, local environment.
> All figures use **prototype demo emission factors** — clearly labelled in-app; not authoritative DEFRA/AIB values.

---

## 1. What you are testing

TonyAI is a multi-tenant carbon-accounting platform for holding companies. Phase 1 delivers the full local vertical: subsidiary/location management, activity-data entry with a live calculation engine, an evidence vault, a review workflow with three enforcement gates (evidence, anomaly, period-lock), emissions analytics with reduction targets and intensity metrics, and audit-ready report generation (PDF/Excel/CSV). Every mutation is audit-logged; tenant isolation is enforced in two independent layers (API guard + database RLS).

## 2. Environment & access

| | |
| --- | --- |
| Prerequisites | Docker Desktop running · Node ≥ 20 · pnpm |
| One-command setup | `pnpm setup` (Supabase up → env sync → migrate → seed) |
| Start the app | `pnpm dev` → web at **http://localhost:3000**, API at :3001 |
| Reset demo data | `pnpm db:reset` — restores the full seed at any time |

**Test users** (password for both: `TonyAI!2026`):

| User | Role | Sees |
| --- | --- | --- |
| `admin@tonyai.local` | `super_admin` | all **5** subsidiaries; can manage everything |
| `entry@tonyai.local` | `data_entry` | only **2** subsidiaries (TonyAI Energy, TonyAI Logistics); cannot manage org structure, cannot generate reports |

**Seed data:** 1 organisation · 5 subsidiaries · 8 operational locations · 102 approved monthly 2024 activity records (each with a demo evidence file) · 3 reduction targets · 10 intensity denominators.

**Recommended free period for entry tests:** any **2024 · Quarterly** period (the seed only fills monthly periods).

## 3. Test-case catalog

Conventions: run as `admin@tonyai.local` unless the TC says otherwise. Mark each TC **Pass / Fail** and note anything surprising even when it passes.

### 3.1 Authentication & route protection

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| AUTH-01 | Open http://localhost:3000 while signed out | Redirected to `/login` | |
| AUTH-02 | Sign in as admin | Land on the **Carbon Dashboard** | |
| AUTH-03 | Sign out, then open `/emissions` directly | Redirected back to `/login` | |
| AUTH-04 | Sign in with a wrong password | Clear error; no crash | |

### 3.2 Dashboard (`/`)

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| DASH-01 | Review the KPI cards | Live values: Total Subsidiaries **5**, locations **8**, real record counts | |
| DASH-02 | Review **Data Collection Status** matrix | Red/yellow/green cells per subsidiary × category | |
| DASH-03 | Click any matrix cell | Drill-down sheet opens with that cell's records and tCO₂e values | |
| DASH-04 | Year-over-year badges | Show "—" (only one seeded year exists — expected, not a bug) | |

### 3.3 Subsidiaries, tenant isolation & RBAC (`/subsidiaries`)

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| SUBS-01 | As admin: count rows | **5** subsidiaries | |
| SUBS-02 | As admin: **Add Subsidiary** (any name) → then delete it | Created with toast, appears in list; delete removes it | |
| SUBS-03 | As admin: open **Manage locations** (map-pin icon) | Drawer lists that subsidiary's locations; add + delete a location works | |
| SUBS-04 | Sign in as `entry@tonyai.local`: count rows | Exactly **2** rows; **no** Add/Delete controls rendered | |
| SUBS-05 | As entry: open **Manage period locks** (padlock) | Drawer opens read-only: no *Lock period* form, "only a super_admin" note | |

### 3.4 Data entry lifecycle (`/data-entry`) — the core flow

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| ENTRY-01 | As admin: pick **TonyAI Energy · Electricity · 2024 · Quarterly · Q1**, enter `12500` kWh | **Live tCO₂e preview** appears with factor value, source and version | |
| ENTRY-02 | Click **Save draft** | Record appears under *Previous submissions* as **Draft**; the **Evidence vault** appears | |
| ENTRY-03 | Click **Submit for review** *without* uploading a file | Blocked with "requires at least one evidence file" (evidence gate) | |
| ENTRY-04 | Upload a PDF/JPG/XLSX into the vault → **Submit for review** | "Submitted for review"; status badge turns **Submitted** | |
| ENTRY-05 | Repeat ENTRY-01 with the **same** period/category → Save draft | Clear duplicate error (a record for this combination exists) | |
| ENTRY-06 | Pick a period **with history** (e.g. Energy · Electricity · 2024 · Quarterly · Q2 after committing Q1), enter a value ~10× Q1 → Save draft | Amber **anomaly banner** + mandatory *Reason for variance* field; submit blocked until a reason is entered | |
| ENTRY-07 | Switch category to **Mobile Combustion** or **Refrigerants**, enter a value | Preview says "No emission factor for this selection" — expected: Phase 1 seeds factors only for Electricity / Natural Gas / Fuel | |
| ENTRY-08 | As entry: create + submit a record on TonyAI Energy | Same flow works for the data_entry role on its own subsidiaries | |

> **Review/approve note:** approving is **API-only** in Phase 1 (no reviewer UI). The transitions `submitted → under_review → approved/rejected` exist and are fully tested at the API (`POST /activity-records/:id/review|approve|reject`, reviewer roles only). For UAT purposes the seed already contains 102 approved records feeding analytics and reports.

### 3.5 Period locking (`/subsidiaries` → padlock)

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| LOCK-01 | As admin: lock **TonyAI Energy · 2024 · Quarterly · Q3** (an empty period) | Lock appears in the drawer list | |
| LOCK-02 | Go to `/data-entry`, try to save a record in that period | Blocked: "…is locked — a super_admin must unlock it" | |
| LOCK-03 | Try to lock a period that has a **submitted** (unreviewed) record | Blocked with "awaiting review" (409) — locking cannot bypass review | |
| LOCK-04 | Unlock the period from the drawer | Entry works again | |

### 3.6 Emissions analytics (`/emissions`)

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| EMIS-01 | Open all four tabs (Summary / Breakdown / History / Trends) | Live data everywhere; 2024 total ≈ **3,177 tCO₂e** on the pristine seed | |
| EMIS-02 | Apply a Scope filter and a Category filter | All tabs update consistently | |
| EMIS-03 | History tab: open a record's detail sheet | Full calculation snapshot: factor value, source, version, methodology | |
| EMIS-04 | **Targets** tab | 3 demo targets: one **On track**, one **At risk**, one honest **"Progress n/a"** (baseline year has no later data) | |
| EMIS-05 | As admin: add a target (use the seeded 2023/2030 pattern), then delete it | Create + delete round-trip with toasts | |
| EMIS-06 | Toggle **Absolute → Intensity** | Four metric cards (tCO₂e per m² / FTE / M EUR / unit) computed from configured denominators | |
| EMIS-07 | As admin in Intensity view: add a denominator for a year, then remove it | Round-trip works; metric cards update | |
| EMIS-08 | Click **Export** (top right) | Routes to `/reports` (exports live there) | |

### 3.7 Reports (`/reports`)

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| REP-01 | Open `/reports` as admin | **Live** preview: status badge, scope tiles, charts, category table; *Data completeness* panel shows real counts | |
| REP-02 | Status badge on the pristine seed (2024, whole org) | **Approved** (all 102 records reviewed) | |
| REP-03 | Switch Reporting year to **2023** | Badge is **not** "Approved" (no data — an empty year is never approved); tables show "No committed data" | |
| REP-04 | **Download PDF** (2024, Methodology notes ticked) | Branded multi-page A4 `tonyai-executive_summary-2024.pdf` with totals, tables and the **emission-factor appendix** (value/source/version) | |
| REP-05 | Template → **GHG Protocol Detail** → Download PDF | PDF additionally contains the full activity-records ledger | |
| REP-06 | Tick **Evidence summary** → Download PDF | Evidence appendix lists **file names + counts** (no links — they expire by design) | |
| REP-07 | **Export Excel** | 3 sheets: *Summary*, *Raw Activity Data*, *Factors Used* | |
| REP-08 | **Export CSV** | Committed ledger, one row per record, evidence counts included | |
| REP-09 | Scope the report to a single subsidiary | All outputs shrink to that subsidiary | |
| REP-10 | Sign in as `entry@tonyai.local` → `/reports` | Preview visible (tenant-scoped to its 2 subsidiaries) but **no export buttons** — role note shown instead | |

## 4. Known limitations — do NOT report these as bugs

**By design in Phase 1 (recorded decisions):**
- **Approve/reject/review has no UI** — reviewer actions are API-only; a reviewer UI arrives with the consultant workflow.
- **Emission factors are prototype demo values** for Electricity / Natural Gas / Fuel only; the other categories show "No emission factor" (authoritative DEFRA/TR/AIB libraries arrive in Phase 4).
- **Reports are year+subsidiary scoped** — scope/category filter-aware exports arrive later; report **sharing** (link/email) is Phase 3.
- Report generation history ("Recent Reports" panel) is not shown; generations are recorded in the audit log.
- **Scope 3**, supplier management, bulk CSV upload, email notifications, i18n/dark mode → Phase 3. Cloud/staging deployment → Phase 2.
- User lifecycle (invite, password reset, role management UI) → Phase 4; UAT uses the two seeded accounts.
- FR §4.3 formal revision workflow deferred — the audited change path for a closed period is super_admin unlock.
- Dashboard year-over-year badges show "—" until a second year of data exists.

**Known minor gaps (already in the backlog — skip reporting):**
- The audit trail is written for every mutation but has **no viewing UI** yet (verifiable via Supabase Studio).
- Dashboard has no year/period selector or organisation switcher (single-org, single-year seed makes this invisible).
- Subsidiaries have no **Edit** dialog yet (create/delete only; editing exists in the API).
- The matrix drill-down sheet has no "Go to Data Entry" shortcut.
- Consultant / executive_viewer roles exist but have no seed users; their flows are not part of this UAT.

## 5. Reporting an issue

For each issue please capture:

1. **TC ID** (or "exploratory"), **user** (admin/entry) and **page**.
2. **Steps** you took (numbered), **expected** vs **actual**.
3. A **screenshot** (and the browser console if something crashed).
4. Severity: **S1** blocks testing · **S2** wrong result/data · **S3** cosmetic/UX.

The demo dataset can always be restored with `pnpm db:reset`.

## 6. Sign-off

| Area | Tester | Date | Verdict (Pass / Pass w/ notes / Fail) |
| --- | --- | --- | --- |
| Authentication & RBAC (3.1–3.3) | | | |
| Data entry & gates (3.4–3.5) | | | |
| Analytics, targets & intensity (3.6) | | | |
| Reports (3.7) | | | |

## 7. Automation baseline (already verified before this UAT)

- **165 API unit tests** — calculation engine (unit conversions to the digit), tenant isolation, RBAC, all lifecycle gates incl. the review transition, targets/intensity math, report assembly/status honesty.
- **14 end-to-end tests** (Playwright) — login, CRUD, full data-entry lifecycle incl. evidence upload and approval, all three gates, RBAC/tenant negatives, analytics/dashboard smoke, targets round-trip, report downloads (exact filenames + magic-byte checks) and the data_entry no-export rule.
- **18 live RLS containment probes** — the database layer independently hides cross-tenant rows even when the API is bypassed.
- Every mutation writes an append-only **audit log** row.
