# TonyAI — Phase 1 UAT Plan & Test Catalog

> 📍 **Round 2 is running — start at [`uat_round2.md`](uat_round2.md).**
> That catalog covers what changed since round 1 (the review gate, per-location
> completeness, record withdrawal, report disclosure, anomaly provenance, the audit
> screen) and asks you to confirm the round-1 close-out item by item. **This** file
> stays as the baseline catalog for everything those packages did not touch; its
> figures have been refreshed to the current seed.

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
| `admin@tonyai.local` | `super_admin` | all **5** subsidiaries; can manage everything — except approve a record admin entered (D01) |
| `approver@tonyai.local` | `super_admin` | a second super_admin, so that what admin enters can be approved (REV-09) |
| `entry@tonyai.local` | `data_entry` | only **2** subsidiaries (TonyAI Energy, TonyAI Logistics); cannot manage org structure, cannot generate reports |
| `review@tonyai.local` | `consultant` | organisation-wide read; may review and reject records but **may not approve**, and may not enter, edit or submit data |

**Seed data:** 1 organisation · 5 subsidiaries · 8 operational locations · **96** approved monthly 2026 activity records (each with a demo evidence file) · 3 reduction targets · **12** intensity denominators.

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
| SUBS-06 | As admin: click the **pencil** on a subsidiary | Its own page opens at `/subsidiaries/<id>`, **pre-filled** with that subsidiary's current values (round-1 **SUB-1**, **SUB-2**). Editing moved off the register in WP16 PR 2b — there is no longer an *Edit subsidiary* dialog | |
| SUBS-07 | Change the legal name only → **Save changes** | Saves with *Subsidiary settings updated successfully.*; go back to the register and the row shows the new name | |
| SUBS-08 | Change **Reporting geography** → **Save changes** | A confirmation appears first, naming the old and new geography, warning about the factor basis **and** stating that already-committed records keep their existing factor — their figures do not change | |
| SUBS-09 | Press **Cancel** in that confirmation, then **Discard changes** | Nothing is saved. Reload the page: the old geography is still there. (A page has no Cancel-to-close, so discarding is explicit) | |
| SUBS-10 | Repeat and press **Continue** | Saved; the register row shows the new geography. Then check `/emissions` → **History**: the tCO₂e of existing records for that subsidiary is **unchanged** | |
| SUBS-11 | On the same page, fill **Reporting contact** (responsible person, work email, work phone) → **Save changes** | Saved. Note the wording: this is the person who *prepares* the inventory, not who signs it off, and it is visible to everyone in the organisation — including an external consultant — so a **role mailbox** is preferred over a personal number (round-1 **SUB-2**) | |
| SUBS-12 | Clear the work phone and save | The field comes back empty, not as a blank-looking value. Re-open the page to confirm | |
| SUBS-13 | In **Operational locations** on that page, add a location | It appears in the list without leaving the page. Changing an existing location's geography asks for the same confirmation as the subsidiary's | |
| SUBS-14 | Scroll to **What depends on this subsidiary** | Counts for locations, records by state, closed periods, targets and denominators. A subsidiary whose only dependants are locations **can** still be deleted — they go with it, each recorded in the audit log. If something else blocks it, the reason is spelled out and it is the **same sentence** the API gives if you try (round-1 **SUB-2**) | |
| SUBS-15 | As `entry@tonyai.local`, open a subsidiary you can see | The page is readable but every field is disabled, there is no **Save changes**, and locations say *Only a super_admin can add or modify locations* | |
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

> **Review/approve note:** as of WP7 PR 3 the reviewer actions have a UI at **`/review`** — a queue of records awaiting a decision, with Start review / Reject / Approve. Approve renders for `super_admin` only; a `consultant` may take a record into review and reject it, and the API refuses an approve from that role regardless of what the UI offers. A rejection's reason is written to the record's review note and shown to the submitter on `/emissions`. The seed also contains 96 already-approved records feeding analytics and reports.

### 3.4b Review queue (`/review`) — WP7 PR 3

Run **after** ENTRY-04, so at least one record is sitting in `submitted`.

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| REV-01 | As admin: open **Review Queue** in the sidebar | Table lists only records awaiting a decision (`submitted` / `under_review`), **longest wait first**, with subsidiary, period, category, activity, tCO₂e, status, **Entered by** and **Waiting** | |
| REV-02 | Click a row | Detail panel opens showing the subsidiary, the activity value, the calculated tCO₂e, the **factor source + version**, the evidence file(s) and a *Reason* box | |
| REV-03 | Click the evidence file name | The uploaded file opens in a new tab (signed link). **If it does not open, do not decide the record** — report it | |
| REV-04 | Try **Reject** with the reason box empty | Reject is disabled — a rejection must say what to fix | |
| REV-05 | Type a reason → **Reject** | Toast confirms; the row leaves the queue | |
| REV-06 | Go to `/emissions` → **History** → open that record | Status **rejected**, and a **"Why this was sent back"** block shows the exact reason you typed | |
| REV-07 | As the record's author, submit it again (Data Entry → *Submit for review*) | Accepted: a rejected record can be fixed and resubmitted, and it reappears in the queue | |
| REV-08 | Back on `/review`, click a `submitted` row → **Start review** | Row **stays** in the queue and its status changes to **under review** (it is still undecided) | |
| REV-09 | Sign in as `approver@tonyai.local` (the second super_admin) → `/review` → click a row admin entered → **Approve** | Toast confirms; the row leaves the queue and the record reads **approved** on `/emissions`. (As admin, approving admin's own record is refused — the approver may not be the creator, decision D01) | |
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
| GEO-02 | Choose a **location** in the Location picker | The line names that location and says **(location)** instead of (subsidiary). *(Every seeded location shares its parent's geography, so the code itself may not change — the source label is the thing to check.)* | |
| GEO-03 | Subsidiaries → **Add Subsidiary** → Geography | Offers **United Kingdom (UK)** and **Türkiye (TR)** only | |
| GEO-04 | Edit **TonyAI Manufacturing GmbH** (Munich) | Geography shows **European Union (EU)** — not blank — and saving without touching it keeps EU | |
| GEO-05 | Manage locations on the Munich subsidiary → edit a location | Same: its EU value is shown, not blanked | |
| GEO-06 | Subsidiary table / audit trail | Still show the raw codes (TR / UK / EU) — labels are for choosing, codes are what is stored | |

### 3.4f Layout & live counts (round-1 **DE-1 / DASH-1**)

> **On DASH-1, please read this first.** The round-1 report said the
> total-locations figure does not update when a **subsidiary** is added. That is
> correct behaviour, not a defect: a brand-new subsidiary has **no locations**,
> so the total must not move. We reproduced the exact steps and confirmed the
> Companies count rises while Locations correctly stays put. What we *did* fix is
> narrower — see DASH-01 below.

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| DE1-01 | Subsidiaries → add a company with a **very long** legal name, then open Data Entry and select it | The Subsidiary control stays inside its own column: the name is cut off with the control's edge, and it never covers the Location field beside it | |
| DE1-02 | Same on Emissions → Intensity → **Add denominator**, and on Reports | The selects there behave the same way | |
| DASH-01 | Leave the Dashboard open, add a **location** from another tab or window, then click back onto the Dashboard tab | The Locations figure updates when the tab regains focus | |
| DASH-02 | Add a **subsidiary** and return to the Dashboard | Companies rises by one; **Locations does not change** — the new company has no locations yet. This is correct | |

### 3.4g Turkish characters in evidence (round-1 **DE-8**)

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| TR-01 | Data Entry → save a draft → upload a file named with Turkish letters, e.g. `Şubat-Faturası-İĞÜÖÇ.pdf` | The evidence list shows the name **exactly** as on disk — no `Åubat`, no `Ä±` | |
| TR-02 | Click that file to open it, then save it | It downloads under the same Turkish name, not under an internal id | |
| TR-03 | Take the record through review (`/review`) and open the detail sheet | The name is intact there too | |
| TR-04 | Generate a **PDF report** with *Evidence summary* ticked | The evidence appendix lists the name correctly | |

> **If you uploaded files before this fix**, their stored names are already
> mangled and stay that way — the fix repairs the reading, not the past. Re-run
> `pnpm db:reset` (already required for the 2026 move) and upload again.

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
| EMIS-01 | Open all four tabs (Summary / Breakdown / History / Trends) | Live data everywhere; 2026 total is **2,906.61 tCO₂e** on the pristine seed (it read ≈3,177 before the six double-counted months were removed — see the round-2 catalog §2.2) | |
| EMIS-02 | Apply a Scope filter and a Category filter | All tabs update consistently | |
| EMIS-03 | History tab: open a record's detail sheet | Full calculation snapshot: factor value, source, version, methodology — and who **entered** and **decided** the record (a seeded record reads *Reviewed by —*: it was never reviewed by a person) | |
| EMIS-04 | **Targets** tab | 3 demo targets: one **On track**, one **At risk**, one honest **"Progress n/a"** (baseline year has no later data) | |
| EMIS-05 | As admin: add a target (use the seeded 2023/2030 pattern), then delete it | Create + delete round-trip with toasts | |
| EMIS-06 | Toggle **Absolute → Intensity** | Four metric cards (tCO₂e per m² / FTE / M EUR / unit) computed from configured denominators | |
| EMIS-07 | As admin in Intensity view: add a denominator for a year, then remove it | Round-trip works; metric cards update | |
| EMIS-08 | Click **Export** (top right) | Routes to `/reports` (exports live there) | |

### 3.7 Reports (`/reports`)

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| REP-01 | Open `/reports` as admin | **Live** preview: status badge, scope tiles, charts, category table; *Data completeness* panel shows real counts | |
| REP-02 | Status badge on the pristine seed (2026, whole org) | **Approved** (all 96 records reviewed) | |
| REP-03 | Switch Reporting year to **2023** | Badge is **not** "Approved" (no data — an empty year is never approved); tables show "No committed data" | |
| REP-04 | **Download PDF** (2026, Methodology notes ticked) | Branded multi-page A4 `tonyai-executive_summary-2026.pdf` with totals, tables and the **emission-factor appendix** (value/source/version) | |
| REP-05 | Template → **GHG Protocol Detail** → Download PDF | PDF additionally contains the full activity-records ledger | |
| REP-06 | Tick **Evidence summary** → Download PDF | Evidence appendix lists **file names + counts** (no links — they expire by design) | |
| REP-07 | **Export Excel** | **4** sheets: *Summary*, *Raw Activity Data*, **Withdrawn Records**, *Factors Used* — the withdrawn sheet is written even when it is empty | |
| REP-08 | **Export CSV** | **16 columns.** Committed ledger, one row per record, evidence counts included — plus any withdrawn rows in the same table (`status = voided`, their summable cells reading `Withdrawn`) and the `voided_*` disclosure block. The file opens with a UTF-8 byte-order mark so Excel on Windows reads Turkish names correctly | |
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
- ~~The audit trail has no viewing UI~~ — **closed**: `/audit` is a super_admin screen now (see the round-2 catalog §4.1).
- Dashboard has no year/period selector or organisation switcher (single-org, single-year seed makes this invisible).
- ~~Subsidiaries have no **Edit** dialog~~ — **closed**: a subsidiary is edited on its own page at `/subsidiaries/<id>` (round-1 SUB-1/SUB-2).
- ~~The matrix drill-down sheet has no "Go to Data Entry" shortcut~~ — **closed**: clicking a matrix cell lands on Data Entry with the subsidiary, category and year selected (round-1 DASH-2).
- `consultant` now **has** a seed user (`review@tonyai.local`) and is in scope. `executive_viewer` still has none and remains out of scope.
- Unknown URLs and unexpected render failures now show **branded TonyAI pages** ("Page not found" / "Something went wrong" with a reference code) instead of the framework's default screens — that is the new error handling, not a defect. While signed out, any URL still redirects to `/login` first, so the 404 page only appears once you are signed in. Do report the error that *caused* such a page, quoting the reference code.

## 5. Reporting an issue

For each issue please capture:

1. **TC ID** (or "exploratory"), **user** (admin/entry) and **page**.
2. **Steps** you took (numbered), **expected** vs **actual**.
3. A **screenshot** (and the browser console if something crashed).
4. Severity: **S1** blocks testing · **S2** wrong result/data · **S3** cosmetic/UX.

The demo dataset can always be restored with `pnpm db:reset`.

## 5b. Results

**Round 2 is open — catalog refreshed 2026-09-02:**
[`uat_round2.md`](uat_round2.md) is the document to test against; its §3 is the
round-1 close-out check. **Read it rather than this file for anything it
covers** — the rows in this script that WP20–WP22 changed (REP-07, REP-08,
EMIS-03) have been corrected, but round 2 is where the current behaviour is
described in full.

**Round 1 feedback received (2026-07-27, product-owner walkthrough):**
[`uat_phase1_feedback_round1.md`](uat_phase1_feedback_round1.md) — 16 items across
Subsidiaries, Data Entry, Overview and Emissions, tagged functional gap / UX /
new capability. Prioritisation was deliberately left to development; the triage
and the round-1 close-out are tracked in
[`../roadmap_docs/project_status_roadmap_phases.md`](../roadmap_docs/project_status_roadmap_phases.md).

### What happens to round-1 feedback

Fixes land **incrementally while UAT continues** — you are not waiting for one big
release. Each merged PR names the feedback IDs it closes (e.g. "closes DE-6, DE-7").
When you are told a fix has landed:

1. `git pull` and re-run **`pnpm setup`** (not just `pnpm install` — see §2).
2. Re-test only the item(s) named in that PR, plus anything you were mid-way through.

Some items are deliberately **not** quick fixes and are scheduled later — mobile
combustion and refrigerants need emission-factor values we do not have yet, and the
invoice-level completeness tracking is a data-model change. The routing for all 16
items is in [`../roadmap_docs/project_status_roadmap_phases.md`](../roadmap_docs/project_status_roadmap_phases.md).

## 6. Sign-off

| Area | Tester | Date | Verdict (Pass / Pass w/ notes / Fail) |
| --- | --- | --- | --- |
| Authentication & RBAC (3.1–3.3) | | | |
| Data entry & gates (3.4–3.5) | | | |
| Analytics, targets & intensity (3.6) | | | |
| Reports (3.7) | | | |

## 7. Automation baseline (already verified before this UAT)

- **934 unit tests** (708 API · 122 web · 63 shared-types · 41 database tooling) — calculation engine (unit conversions to the digit), tenant isolation, RBAC, all lifecycle gates incl. the review transition, the completeness rule, the withdrawal path, targets/intensity math, report assembly/status honesty, the anomaly baseline, JWT verification under both signing schemes.
- **84 end-to-end tests** (Playwright) — login, CRUD, full data-entry lifecycle incl. evidence upload and approval, all three gates, RBAC/tenant negatives, analytics/dashboard smoke, the completeness dashboard, the review gate, record withdrawal, the audit trail, targets round-trip, report downloads (exact filenames + magic-byte checks) and the data_entry no-export rule.
- **34 live RLS containment probes** — the database layer independently hides cross-tenant rows even when the API is bypassed, and a consultant can neither write nor withdraw a figure through it.
- Every mutation writes an append-only **audit log** row.
