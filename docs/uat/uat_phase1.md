# TonyAI — Phase 1 UAT Plan & Test Catalog

> ⚠️ **Re-seed before this round.** The demo dataset moved from 2024 to **2026**
> (round-1 **DE-9**), so a database seeded earlier still holds 2024 data and the
> scenarios below will not match it. Run **`pnpm db:reset`** — plain `pnpm db:seed`
> upserts, so it would leave the old 2024 rows sitting beside the new ones.
> Reporting years now offer **2015–2026**; emission factors still cover 2026 only,
> so any other year honestly reports that no factor exists for the selection.

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
| **After pulling new code** | Run `pnpm setup` (not just `pnpm install`) — recent work added dependencies AND the API now refuses to start unless `apps/api/.env` carries a flag that `pnpm setup` writes. A stale env presents as "the app is broken": the page loads, login succeeds, no data appears. |
| **Data handling** | Use only the seeded demo data on your local stack — never enter real personal or company data. When your UAT participation ends, wipe the local database (`supabase stop` then `docker volume rm` the project volumes, or simply delete the repo clone). |

> **One-time sign-out after updating (not a bug).** The Phase-2 containerization work renamed the browser session cookie, so the first time you open the app after pulling you will land on `/login` even if you were signed in before. Sign in again with the same credentials — it happens once, and `AUTH-01`…`AUTH-04` behave normally afterwards.

**Test users** (password for both: `TonyAI!2026`):

| User | Role | Sees |
| --- | --- | --- |
| `admin@tonyai.local` | `super_admin` | all **5** subsidiaries; can manage everything |
| `entry@tonyai.local` | `data_entry` | only **2** subsidiaries (TonyAI Energy, TonyAI Logistics); cannot manage org structure, cannot generate reports |
| `review@tonyai.local` | `consultant` | organisation-wide read; may review and reject records but **may not approve**, and may not enter, edit or submit data |

**Seed data:** 1 organisation · 5 subsidiaries · 8 operational locations · 102 approved monthly 2026 activity records (each with a demo evidence file) · 3 reduction targets · 10 intensity denominators.

**Recommended free period for entry tests:** any **2026 · Quarterly** period (the seed only fills monthly periods).

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
| SUBS-06 | As admin: click the **pencil** on a subsidiary | Dialog opens titled *Edit subsidiary*, **pre-filled** with that subsidiary's current values (round-1 **SUB-1**) | |
| SUBS-07 | Change the legal name only → **Save changes** | Saves straight away with *Subsidiary settings updated successfully.*; the row shows the new name | |
| SUBS-08 | Edit again, change **Geography** → **Save changes** | A confirmation appears first, naming the old and new geography, warning about the factor basis **and** stating that already-committed records keep their existing factor — their figures do not change | |
| SUBS-09 | Press **Cancel** in that confirmation | Nothing is saved — the row still shows the old geography | |
| SUBS-10 | Repeat and press **Continue** | Saved; the row shows the new geography. Then check `/emissions` → **History**: the tCO₂e of existing records for that subsidiary is **unchanged** | |
| SUBS-11 | Sign in as `entry@tonyai.local` | **No pencil icon** on any row (and none as `review@tonyai.local`) | |

### 3.4 Data entry lifecycle (`/data-entry`) — the core flow

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| ENTRY-01 | As admin: pick **TonyAI Energy · Electricity · 2026 · Quarterly · Q1**, enter `12500` kWh | **Live tCO₂e preview** appears with factor value, source and version | |
| ENTRY-02 | Click **Save draft** | Record appears under *Previous submissions* as **Draft**; the **Evidence vault** appears | |
| ENTRY-03 | Click **Submit for review** *without* uploading a file | Blocked with "requires at least one evidence file" (evidence gate) | |
| ENTRY-04 | Upload a PDF/JPG/XLSX into the vault → **Submit for review** | "Submitted for review"; status badge turns **Submitted** | |
| ENTRY-05 | Repeat ENTRY-01 with the **same** period/category → Save draft | Clear duplicate error (a record for this combination exists) | |
| ENTRY-06 | Pick a period **with history** (e.g. Energy · Electricity · 2026 · Quarterly · Q2 after committing Q1), enter a value ~10× Q1 → Save draft | Amber **anomaly banner** + mandatory *Reason for variance* field; submit blocked until a reason is entered | |
| ENTRY-07 | Switch category to **Mobile Combustion** or **Refrigerants**, enter a value | Preview says "No emission factor for this selection" — expected: Phase 1 seeds factors only for Electricity / Natural Gas / Fuel | |
| ENTRY-08 | As entry: create + submit a record on TonyAI Energy | Same flow works for the data_entry role on its own subsidiaries | |

> **Review/approve note:** as of WP7 PR 3 the reviewer actions have a UI at **`/review`** — a queue of records awaiting a decision, with Start review / Reject / Approve. Approve renders for `super_admin` only; a `consultant` may take a record into review and reject it, and the API refuses an approve from that role regardless of what the UI offers. A rejection's reason is written to the record's review note and shown to the submitter on `/emissions`. The seed also contains 102 already-approved records feeding analytics and reports.

### 3.4b Review queue (`/review`) — WP7 PR 3

Run **after** ENTRY-04, so at least one record is sitting in `submitted`.

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| REV-01 | As admin: open **Review Queue** in the sidebar | Table lists only records awaiting a decision (`submitted` / `under_review`), oldest first, with subsidiary, period, category, activity, tCO₂e, status and **Age** | |
| REV-02 | Click a row | Detail panel opens showing the subsidiary, the activity value, the calculated tCO₂e, the **factor source + version**, the evidence file(s) and a *Reason* box | |
| REV-03 | Click the evidence file name | The uploaded file opens in a new tab (signed link). **If it does not open, do not decide the record** — report it | |
| REV-04 | Try **Reject** with the reason box empty | Reject is disabled — a rejection must say what to fix | |
| REV-05 | Type a reason → **Reject** | Toast confirms; the row leaves the queue | |
| REV-06 | Go to `/emissions` → **History** → open that record | Status **rejected**, and a **"Why this was sent back"** block shows the exact reason you typed | |
| REV-07 | As the record's author, submit it again (Data Entry → *Submit for review*) | Accepted: a rejected record can be fixed and resubmitted, and it reappears in the queue | |
| REV-08 | Back on `/review`, click a `submitted` row → **Start review** | Row **stays** in the queue and its status changes to **under review** (it is still undecided) | |
| REV-09 | Click a row → **Approve** | Toast confirms; the row leaves the queue and the record reads **approved** on `/emissions` | |
| REV-10 | Sign in as `review@tonyai.local` (consultant) → `/review` | Queue is visible with **Start review** and **Reject**, but **no Approve button**, plus a line explaining approval is `super_admin` only | |
| REV-11 | Sign in as `entry@tonyai.local` → `/review` | An explanation card ("Reviewing is done by a consultant or a super_admin"), **not** an error or an empty page | |

> **Note for testers:** `review@tonyai.local` (password `TonyAI!2026`) is a new seeded user — if signing in fails, re-run `pnpm db:seed`.

### 3.4c Dashboard matrix shortcut (round-1 **DASH-2**)

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| DASH-01 | As admin: look at **Data Collection Status** on the dashboard | The heading carries a **year** (e.g. 2026) — the grid describes that one year, not all years at once | |
| DASH-02 | Click a **coloured cell** (not the subsidiary name) | Lands on **Data Entry** with that subsidiary **and that category** already selected, and the year from the grid | |
| DASH-03 | Click the **subsidiary name** or the **chevron** on the same row | Still opens the subsidiary detail drawer as before — only the cells changed | |
| DASH-04 | Click a cell for a category that already has one record that year | The existing record **opens in the form** for editing (if it is a draft or was sent back); if it is submitted/approved you are told so instead of getting a blank form | |
| DASH-05 | Click a cell for a category with several records that year | You are told how many exist and asked to pick one from *Previous submissions* — nothing is guessed for you | |
| DASH-06 | On Data Entry, click any row in **Previous submissions** | A draft or sent-back record reopens in the form; anything else says it can no longer be edited | |

### 3.4d Units & intensity metric (round-1 **DE-3 / EM-1**)

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| UNIT-01 | Data Entry → category **Natural Gas** → open **Unit** | Offers kWh, m³, **Sm³**, Therms, GJ — and **no** liquid-fuel or distance units | |
| UNIT-02 | Pick **Sm³**, enter a value | Clear refusal: standard cubic metres need a sourced calorific value, which arrives with the Phase-4 factor library. **Saving is refused too**, not just the on-screen note | |
| UNIT-03 | Pick **m³**, enter a value | Calculates, **and** states that ×11.36 is a prototype assumption with no cited source and no stated calorific basis | |
| UNIT-04 | Switch category to **Electricity** | Unit list narrows to kWh / MWh; the previously chosen gas unit does not stay selected | |
| UNIT-05 | Emissions → **Intensity** toggle | **Sales output** is offered as a denominator metric (MWh) | |

### 3.4e Geography / grid regions (round-1 **DE-6 / DE-7**)

> **Read this before running these.** The "Grid Region" picker you saw on Data
> Entry did **not** affect the emission factor — it was saved as metadata only,
> even though its helper text said otherwise. It has been removed. The factor
> geography comes from the subsidiary (or the location the record targets), and
> Data Entry now states which one it will use. If that is not what you expected,
> say so in round 2 — it is a deliberate change from what DE-6 literally asked for.

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| GEO-01 | Data Entry, pick any subsidiary | A line reads **"Factor geography: TR — Türkiye, from … (subsidiary)"** with the right code, and no "Grid Region" picker exists | |
| GEO-02 | Choose a **location** that has a different geography | The line switches to that location's geography and says **(location)** | |
| GEO-03 | Subsidiaries → **Add Subsidiary** → Geography | Offers **United Kingdom (UK)** and **Türkiye (TR)** only | |
| GEO-04 | Edit **TonyAI Manufacturing GmbH** (Munich) | Geography shows **European Union (EU)** — not blank — and saving without touching it keeps EU | |
| GEO-05 | Manage locations on the Munich subsidiary → edit a location | Same: its EU value is shown, not blanked | |
| GEO-06 | Subsidiary table / audit trail | Still show the raw codes (TR / UK / EU) — labels are for choosing, codes are what is stored | |

### 3.5 Period locking (`/subsidiaries` → padlock)

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| LOCK-01 | As admin: lock **TonyAI Energy · 2026 · Quarterly · Q3** (an empty period) | Lock appears in the drawer list | |
| LOCK-02 | Go to `/data-entry`, try to save a record in that period | Blocked: "…is locked — a super_admin must unlock it" | |
| LOCK-03 | Try to lock a period that has a **submitted** (unreviewed) record | Blocked with "awaiting review" (409) — locking cannot bypass review | |
| LOCK-04 | Unlock the period from the drawer | Entry works again | |

### 3.6 Emissions analytics (`/emissions`)

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| EMIS-01 | Open all four tabs (Summary / Breakdown / History / Trends) | Live data everywhere; 2026 total ≈ **3,177 tCO₂e** on the pristine seed | |
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
| REP-02 | Status badge on the pristine seed (2026, whole org) | **Approved** (all 102 records reviewed) | |
| REP-03 | Switch Reporting year to **2023** | Badge is **not** "Approved" (no data — an empty year is never approved); tables show "No committed data" | |
| REP-04 | **Download PDF** (2026, Methodology notes ticked) | Branded multi-page A4 `tonyai-executive_summary-2026.pdf` with totals, tables and the **emission-factor appendix** (value/source/version) | |
| REP-05 | Template → **GHG Protocol Detail** → Download PDF | PDF additionally contains the full activity-records ledger | |
| REP-06 | Tick **Evidence summary** → Download PDF | Evidence appendix lists **file names + counts** (no links — they expire by design) | |
| REP-07 | **Export Excel** | 3 sheets: *Summary*, *Raw Activity Data*, *Factors Used* | |
| REP-08 | **Export CSV** | Committed ledger, one row per record, evidence counts included | |
| REP-09 | Scope the report to a single subsidiary | All outputs shrink to that subsidiary | |
| REP-10 | Sign in as `entry@tonyai.local` → `/reports` | Preview visible (tenant-scoped to its 2 subsidiaries) but **no export buttons** — role note shown instead | |

## 4. Known limitations — do NOT report these as bugs

**By design in Phase 1 (recorded decisions):**
- **Bulk review has no UI** — the `/review` queue decides one record at a time; there is no multi-select approve yet.
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
- Unknown URLs and unexpected render failures now show **branded TonyAI pages** ("Page not found" / "Something went wrong" with a reference code) instead of the framework's default screens — that is the new error handling, not a defect. While signed out, any URL still redirects to `/login` first, so the 404 page only appears once you are signed in. Do report the error that *caused* such a page, quoting the reference code.

## 5. Reporting an issue

For each issue please capture:

1. **TC ID** (or "exploratory"), **user** (admin/entry) and **page**.
2. **Steps** you took (numbered), **expected** vs **actual**.
3. A **screenshot** (and the browser console if something crashed).
4. Severity: **S1** blocks testing · **S2** wrong result/data · **S3** cosmetic/UX.

The demo dataset can always be restored with `pnpm db:reset`.

## 5b. Results

**Round 1 feedback received (2026-07-27, product-owner walkthrough):**
[`uat_phase1_feedback_round1.md`](uat_phase1_feedback_round1.md) — 16 items across
Subsidiaries, Data Entry, Overview and Emissions, tagged functional gap / UX /
new capability. Prioritisation was deliberately left to development; the triage
and the round-1 close-out are tracked in
[`../roadmap_docs/project-status.md`](../roadmap_docs/project-status.md).

### What happens to round-1 feedback

Fixes land **incrementally while UAT continues** — you are not waiting for one big
release. Each merged PR names the feedback IDs it closes (e.g. "closes DE-6, DE-7").
When you are told a fix has landed:

1. `git pull` and re-run **`pnpm setup`** (not just `pnpm install` — see §2).
2. Re-test only the item(s) named in that PR, plus anything you were mid-way through.

Some items are deliberately **not** quick fixes and are scheduled later — mobile
combustion and refrigerants need emission-factor values we do not have yet, and the
invoice-level completeness tracking is a data-model change. The routing for all 16
items is in [`../roadmap_docs/project-status.md`](../roadmap_docs/project-status.md).

## 6. Sign-off

| Area | Tester | Date | Verdict (Pass / Pass w/ notes / Fail) |
| --- | --- | --- | --- |
| Authentication & RBAC (3.1–3.3) | | | |
| Data entry & gates (3.4–3.5) | | | |
| Analytics, targets & intensity (3.6) | | | |
| Reports (3.7) | | | |

## 7. Automation baseline (already verified before this UAT)

- **245 API unit tests** — calculation engine (unit conversions to the digit), tenant isolation, RBAC, all lifecycle gates incl. the review transition, targets/intensity math, report assembly/status honesty, JWT verification under both signing schemes.
- **14 end-to-end tests** (Playwright) — login, CRUD, full data-entry lifecycle incl. evidence upload and approval, all three gates, RBAC/tenant negatives, analytics/dashboard smoke, targets round-trip, report downloads (exact filenames + magic-byte checks) and the data_entry no-export rule.
- **18 live RLS containment probes** — the database layer independently hides cross-tenant rows even when the API is bypassed.
- Every mutation writes an append-only **audit log** row.
