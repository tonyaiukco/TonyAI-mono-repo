# TonyAI — UAT Round 2: Test Catalog

> **Purpose:** the single document for the second UAT round. It covers (a) whether
> round-1 feedback actually landed, and (b) the capabilities built since — none of
> which existed when you tested in July.
> **Version:** 2026-09-02 · Phase 1 + Phase-3 packages WP7, WP15–WP22, plus the
> follow-ups merged since (the withdrawer's name on screen, and the exports that
> name them). The catalog was first written 2026-08-27; everything WP22 and later
> added is marked **new in 2026-09-02** where it appears.
> **Focused addendum:** 2026-10-04 — §4.9 records LP1-04 XLSX escape verification;
> the rest of this catalogue has not been re-baselined by this addendum.
> **Scope under test:** Scope 1 & 2 carbon accounting, local environment.
> **Baseline for round 1** stays in [`uat_phase1.md`](uat_phase1.md) — anything not
> mentioned here is unchanged and its round-1 cases still apply.
> All figures use **prototype demo emission factors** — clearly labelled in-app; not authoritative DEFRA/AIB values.

---

## 1. What is different this round

Round 1 found 16 items. **Thirteen are closed, one is half closed, two are
scheduled for Phase 4** — §3 asks you to confirm that, item by item, rather than
taking our word for it.

Round 2 also introduces things round 1 never saw, and they change what the app
*claims*:

| | What changed | Why it matters to you |
| --- | --- | --- |
| **Completeness now means "accepted"** | A category no longer turns green the moment data is keyed in. It stays amber while anything is left to look at — still a draft, sent back, awaiting review, flagged as anomalous, or missing a file. | This is round-1 **DE-2**, applied to every cell. A completion percentage now answers *"how much has been accepted"*, not *"how much has been typed"*. |
| **A subsidiary can be measured per location** | `TonyAI Energy` is tracked as **one monthly invoice per site**, so its cells read `3/24` rather than a yes/no tick. | This is round-1 **DASH-3**. It is also honest about the gap: 9 of its electricity entries are filed for the whole company and close no site invoice. |
| **An approved figure can be withdrawn** | Approved records are immutable, so a wrong one is *withdrawn* with a reason instead of edited or deleted. | A double-counted month can now be corrected without falsifying history. |
| **Reports say what was taken out** | PDF, Excel and CSV all disclose withdrawals and name the **reporting entity** (site or whole company) of every row. | An export can no longer drop a figure silently. |
| **The anomaly check says what it judged against** | It needs **three** prior periods. Fewer than three means *not evaluated* — which is a different claim from *not anomalous*. | Round 1 could not tell "checked and clean" from "never checked". |
| **There is an audit-trail screen** | `/audit`, super_admin only. | Round 1 was told the audit log existed but had no UI. It has one now. |
| **Every record says who touched it** *(new in 2026-09-02)* | The review queue names who **entered** a record and how long it has been **waiting**; the detail panels name who entered it and who **decided** it; a withdrawal names who withdrew it. | Round 1 could see *that* a record was approved but never *by whom* — the person was reachable only through `/audit`, which only an admin can open. |
| **Exports name the withdrawer, and open cleanly on Windows** *(new in 2026-09-02)* | Every export carries the withdrawer's **user id** — an opaque id, deliberately not a name (§6.5) — and the CSV now opens as UTF-8 in Excel on Windows. | Round 1 never opened an export on Windows, where Turkish names came out mojibaked. |

---

## 2. Environment & access

| | |
| --- | --- |
| Prerequisites | Docker Desktop running · Node ≥ 20 · pnpm |
| **After pulling this round's code** | `pnpm setup` — **not** just `pnpm install`. New dependencies landed, and the API refuses to start unless `apps/api/.env` carries a flag `pnpm setup` writes. A stale env presents as *"the app is broken"*: the page loads, login succeeds, no data appears. |
| **Re-seed — mandatory this round** | `pnpm db:reset`. The seed changed: it no longer writes the six double-counted months round 1's dataset contained. Plain `pnpm db:seed` **upserts**, so it would leave the old rows beside the new ones and every number below would be wrong. |
| Start the app | `pnpm dev` → web at **http://localhost:3000**, API at **:3001** |
| Data handling | Seeded demo data only — never real personal or company data. When your UAT participation ends, wipe the local database (`supabase stop`, then remove the project's Docker volumes) or delete the clone. |

### 2.1 Sign-in

| User | Role | Sees |
| --- | --- | --- |
| `admin@tonyai.local` | `super_admin` | all **5** subsidiaries. The **only** role that can approve, withdraw, lock a period, or open `/audit`. |
| `entry@tonyai.local` | `data_entry` | exactly **2** subsidiaries (TonyAI Energy, TonyAI Logistics). Cannot manage org structure, cannot generate reports. |
| `review@tonyai.local` | `consultant` | organisation-wide read. May take a record into review and **reject** it, but **may not approve**, and may not enter, edit or submit data. **May** generate reports. |

Password for all three: `TonyAI!2026`.
`executive_viewer` exists as a role but has no seed user — it is out of scope again this round.

### 2.2 Baseline after `pnpm db:reset` — check these first

Everything in this catalog is written against these numbers. **If your app does
not show them, stop and tell us before testing further** — a stale database is
the single most likely reason a case below "fails".

| What | Expected |
| --- | --- |
| Subsidiaries / locations (dashboard KPI cards) | **5** and **8** |
| Activity records | **96**, every one of them `approved`, all in reporting year **2026** |
| Withdrawn records | **0** (§4.4 has you create one) |
| Records filed against a **site** rather than the whole company | **6** — Istanbul HQ · Electricity · Jan–Mar, and Izmir Freight Hub · Fuel · Jan–Mar. No screen shows this as a count; you see it per record (the drawer's *Reporting Entity*) or in the CSV export's `reporting_entity` column |
| 2026 inventory total — `/reports` preview (2026, whole organisation) | **2,906.6 tCO₂e**. This is the only place the app prints the total to a decimal |
| The same total elsewhere | `/emissions` → **Summary** shows three cards rounded to whole tonnes — Scope 1 **1,211**, Scope 2 **1,696**, Scope 3 **0** — and no combined figure. The dashboard KPI card abbreviates it to **2.9k**. All three are the same number rendered differently |
| Data Collection Status totals (dashboard) | **5 complete · 3 incomplete · 47 missing** |
| Review queue (`/review`) | **empty** — every seeded record is already approved |
| **Entered by / Reviewed by** on any seeded record | **Entered by Tony Admin · Reviewed by —.** All 96 seeded records were written straight to `approved` without passing through a person's review, so the reviewer really is blank. Only a record **you** approve (§4.3) names a reviewer. **Expected — please do not file it.** |
| Review queue **Waiting** column | Nothing to see on the fresh seed (the queue is empty). A record you submit yourself reads `0d`; one whose submission predates this build reads an em dash, never `0d` |
| Period locks | **none** |

> **Note the change from round 1.** The inventory read ≈3,177 tCO₂e in July. It
> reads 2,906.6 now, and **nothing was lost** — six months were counted twice
> (once for the whole company, once for the site that actually reported them) and
> the duplicate half is gone. This is the correct number; the old one was not.

---

## 3. Round-1 close-out — verify each item

One row per round-1 item. **Do the check, then mark it.** If a check fails, that
is a round-2 finding: quote the round-1 ID.

| ID | Round-1 ask | Status | How to verify | P/F |
| --- | --- | --- | --- | --- |
| **SUB-1** | Subsidiaries must be editable | ✅ closed | `/subsidiaries` → click the **pencil** on a row → its own page opens at `/subsidiaries/<id>`, pre-filled. Change the legal name → **Save changes** → the register row shows it. | |
| **SUB-2** | Super-admin subsidiary control panel | ✅ closed | On that same page: **Reporting contact** (person, work email, work phone), **Operational locations**, and **What depends on this subsidiary** (locations, records by state, closed periods, targets, denominators). | |
| **SUB-3** | Multiple locations on create + Google Places autofill | ⚠️ **half closed** | **Add Subsidiary** now takes several locations in the create form — verify that. **Google Places autofill was not built** (needs an API key, billing and a product decision). Addresses are still typed by hand. Tell us whether that blocks you. | |
| **DE-1** | Long subsidiary names overlap the location field | ✅ closed | Create a company with a very long legal name (the form requires at least one operational location too), then open Data Entry and select it: the control truncates inside its own column and never covers the Location field. | |
| **DE-2** | Status must stay yellow until everything is in | ✅ closed | §4.3 — this is now a rule on **every** cell, not just invoice-tracked ones. | |
| **DE-3** | Add "standard cubic metres" | ✅ closed | Data Entry → **Natural Gas** → Unit offers **Sm³**. Picking it refuses the calculation *and* the save: Sm³ needs a sourced calorific value that arrives with the Phase-4 factor library. | |
| **DE-4** | Refrigerants — expand reporting scope | ⏳ **Phase 4** | Not built. Refrigerants still reports "no emission factor for this selection". We do not have sourced factor values, and inventing them is not an option in a compliance product. | |
| **DE-5** | Mobile combustion — factors + on-road/off-road | ⏳ **Phase 4** | Same reason as DE-4. | |
| **DE-6** | Electricity — add Turkey grid region | ✅ closed | Data Entry shows a **Factor geography** line (e.g. `TR — Türkiye, from … (subsidiary)`) instead of a Grid Region picker. | |
| **DE-7** | Standardise grid regions to UK + Turkey | ✅ closed | Geography choices are **United Kingdom (UK)** and **Türkiye (TR)** only; the Munich subsidiary keeps its existing **European Union (EU)** value and does not blank on save. | |
| **DE-8** | Evidence upload must read Turkish characters | ✅ closed | Upload `Şubat-Faturası-İĞÜÖÇ.pdf` — the name is intact in the vault, on download and in `/review`. For the PDF appendix: the record must be **approved** first, and you must tick **Evidence summary** on `/reports` — it is off by default. | |
| **DE-9** | Extend selectable reporting years | ✅ closed | Reporting year offers **2015–2026**. Factors exist for 2026 only, so any other year honestly reports no factor rather than guessing. | |
| **DASH-1** | Total-locations count must update live | ✅ closed | Add a location in a second tab, click back onto the Dashboard: the Locations figure updates on focus. Note that adding a **subsidiary** now moves the Locations figure too — the create form requires at least one operational location, so a company can no longer exist without one. | |
| **DASH-2** | "Click to view details" boxes are not clickable | ✅ closed | Click a coloured matrix cell → lands on Data Entry with that subsidiary, category and year selected. The subsidiary name and chevron still open the drawer. | |
| **DASH-3** | Per-scope / per-category / invoice-level completeness | ✅ closed | §4.2 — TonyAI Energy is measured per site, per month. | |
| **EM-1** | "Sales output" metric + natural-gas units | ✅ closed | `/emissions` → **Intensity** → **Sales output** (MWh) is offered as a denominator. | |

---

## 4. New since round 1 — the test catalog

**Order matters — read this before you start.**

- **§4.4 (withdrawal) must come before §4.6 (report disclosure) and before ANOM-06.** A freshly seeded database has no withdrawn records at all, so those surfaces are correctly invisible until you create one.
- **§4.4 must also come before §4.3.** GATE-02→GATE-04 have you approve a new record, which raises the inventory total — and VOID-08 checks an absolute figure that only holds on the untouched seed. If you have already done §4.3, check VOID-08 as a *difference* instead: the total must fall by exactly the tonnage the confirmation dialog named.
- Everything else can be done in any order.

### 4.1 Audit trail (`/audit`)

> **Precondition: the seed writes no audit rows.** Straight after `pnpm db:reset`
> this screen correctly reads *"No audit entries match these filters."* **First make
> two or three changes** as admin — edit a subsidiary's legal name, add a location,
> generate a report — then run the cases below against them.

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| AUD-01 | As admin: open **Audit Trail** in the sidebar | A paginated table: **When · Actor · Role at the time · Action · Entity · Change**, newest first | |
| AUD-02 | Click a row | A panel showing when, the actor, the role they held **at the time**, the entity id, and the recorded change | |
| AUD-03 | Use the entity and action filters, and the text box | The text box is labelled **"Filter this page…"** — it filters the rows in front of you, not the whole log. Confirm that is clear rather than misleading | |
| AUD-04 | Page through with **Previous** / **Next** | Paging works and the counter reads `Page n of m` | |
| AUD-05 | Sign in as `entry@tonyai.local` and as `review@tonyai.local`, then open `/audit` | Both are refused with **"Only a super_admin can read the audit trail"** — an explanation, not an error page or an empty table | |
| AUD-06 | As admin: make any change (edit a subsidiary), then return to `/audit` | Your change is the newest row, with your account as the actor | |

### 4.2 Completeness measured per location (round-1 **DASH-3**, WP17)

Only **TonyAI Energy** is measured this way in the seed. The other four are
measured as a whole, exactly as in round 1.

> **There is no screen to switch a subsidiary between the two modes.** It is set
> through the API only. If you need that control, say so — it is a deliberate open
> question, not an oversight.

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| COV-01 | Dashboard → **Data Collection Status** → the **TonyAI Energy** row | Its cells carry a fraction on their face: **Electricity `3/24`**, **Natural Gas `0/24`**. 24 = 2 sites × 12 months. *(These are the untouched-seed values — §4.5 deliberately moves Electricity to `4/24`.)* | |
| COV-02 | **Hover** the Electricity cell (the detail is in the hover card, not on the cell face) | It reads **3 of 24** in words, **Entries (all statuses) 12**, and names the shortfall — not just a number | |
| COV-03 | Read what it says about the 9 entries that closed nothing | They are **recorded for the whole company**, so they close none of the site invoices tracked here. Judge whether that sentence explains the gap to you, or reads like a bug | |
| COV-04 | Click the **TonyAI Energy row name** (or the chevron at the end of the row) — **not** the coloured cell, which navigates to Data Entry instead — and scroll to **Invoices by site and month** | A per-site, per-month grid showing which months are missing at which location | |
| COV-05 | Compare with **TonyAI Gas** (measured as a whole) | Its cells show a **tCO₂e figure** and a colour, with **no fraction** — the two measurement modes are meant to look different | |
| COV-06 | `/data-entry` → pick TonyAI Energy · Electricity | The entry panel repeats the **fraction** — `3/24`, "3 of 24 invoices keyed in" — and it must match the dashboard cell. Its next line, *"3 of those approved"*, answers a different question from the cell's *Entries (all statuses) 12*; they are not meant to match | |
| COV-07 | Look at the **Water** cell on TonyAI Energy | Red, reading `0/24`: Water is **tracked** (it has the same 24-invoice denominator) but nothing has been recorded. The "tracked but never calculated" behaviour needs an actual record — that is UNC-01/UNC-02 in §4.8 | |

### 4.3 The review gate on every cell (round-1 **DE-2**, WP19)

The complaint in round 1 was: *"on submit for review, the status turns green
immediately."* It no longer does — anywhere.

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| GATE-01 | As admin, note the colour of **TonyAI Mfg · Electricity** (green on the fresh seed) | Green = every committed entry has been **accepted**, not merely keyed in | |
| GATE-02 | As `entry@tonyai.local`: create a draft on **TonyAI Logistics · Natural Gas**, attach a file, **Submit for review** | The cell does **not** go green. It reads amber and says how many entries are awaiting review | |
| GATE-03 | Read the wording on that amber cell | Something like *"1 entry is keyed in but nobody has reviewed it yet, so this category is not finished."* Is that the right sentence for the person who has to act on it? | |
| GATE-04 | As admin: approve that record in `/review`, then reload the dashboard | The cell turns green now — and only now | |
| GATE-04a *(new)* | Before approving it, look at that row in the queue | An **Entered by** column names **Eda Entry** — the person who keyed it, not the admin reading the screen — and a **Waiting** column reads `0d`, measured from when it was submitted rather than when it was created | |
| GATE-04b *(new)* | After approving it, open the same record in `/emissions` → History → its detail panel | **Entered by Eda Entry** and **Reviewed by Tony Admin**: the pair that was invisible in round 1. (Every *seeded* record still reads *Reviewed by —* — see §2.2) | |
| GATE-05 | Look at **TonyAI Logistics · Fuel** on the fresh seed | Amber even though every entry in it is already approved — because one of them is **flagged as anomalous**. The cell itself does not say so: the reason surfaces in the dashboard **Alerts** panel (*"Anomaly flag on Fuel records"*), and the record is July 2026 in `/emissions` → History. **Tell us if that is too far to look** — an amber with no on-cell reason is exactly the kind of thing round 2 should catch | |
| GATE-06 | As admin: create a draft anywhere and do **not** submit it | That cell goes amber too — a draft is something left to look at | |

### 4.4 Withdrawing an approved figure (WP18)

An approved figure is immutable — it cannot be edited or deleted. If it is
wrong, it is **withdrawn**, with a reason that becomes part of the record.

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| VOID-01 | As admin: `/emissions` → **History** → click **TonyAI Energy · Electricity · April 2026** | The detail panel opens. It is the only screen in the app that shows an approved record on its own | |
| VOID-02 | Find **Withdraw this figure** | Present for admin only, and only on an `approved` record. Sign in as `review@tonyai.local` and confirm the section is **absent** | |
| VOID-03 | Type a 3-character reason | The **Withdraw from inventory** button stays disabled and says a reason needs at least **10** characters, counting as you type | |
| VOID-04 | Type a real reason (e.g. `Meter misread — supplier issued a corrected invoice.`) → **Withdraw from inventory** | A confirmation appears naming the record in full — *category · subsidiary · reporting entity · period · year* — and the exact tonnage it removes | |
| VOID-05 | Read the consequences in that dialog | Five statements, including **"It cannot be undone."** and that your reason is **printed verbatim in every generated report**. Confirm the dialog gives you enough to check the click against | |
| VOID-06 | Press **Cancel** | Nothing happens. The record is still approved | |
| VOID-07 | Repeat and confirm with **Withdraw** | The record's badge turns grey and struck through, and the panel shows **"Why this figure was withdrawn"** with your reason — and beneath it *(new in 2026-09-02)* **"Withdrawn by Tony Admin"** with the date. Round 1's version named nobody | |
| VOID-08 | Check the total on `/reports` (2026, whole organisation) | It has dropped by exactly the tonnage the dialog named: **2,906.6 → 2,842.8 tCO₂e** (April at TonyAI Energy is 63.800). On `/emissions` → Summary the **Scope 2** card goes **1,696 → 1,632**. *(If you did §4.3 first, the starting figure is higher — check the difference, not the absolute.)* | |
| VOID-09 | Dashboard → **hover** the same cell | The withdrawn entry is reported separately as **"Withdrawn (counts towards nothing)"** while *Entries (all statuses)* still reads 12 — so the cell reconciles rather than looking like it lost one | |
| VOID-10 | `/audit` | A new row naming you, whose **Change** column reads *Approved → Voided*. Your reason is in the row's **detail panel**, not in the table | |
| VOID-11 | Try to withdraw the same record again | Not offered — a withdrawn record is not `approved` any more, and there is no route back | |

### 4.5 Moving a record between reporting entities (WP18)

The whole point of §4.2's gap: an entry filed for the whole company can be
re-attributed to the site that actually reported it.

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| MOVE-01 | As admin: `/data-entry` → **TonyAI Energy · Electricity · 2026 · Monthly · February** with **Location = Whole subsidiary** → enter a value → **Save draft**. *(February's whole-company slot is free: that month was reported by Istanbul HQ, not by the company.)* | The control is labelled **Location** and offers **Whole subsidiary** plus each of that subsidiary's locations | |
| MOVE-02 | Reopen that draft from *Previous submissions* and change **Location** to **Ankara Power Plant**, but do not save yet | A notice appears saying the next **Save moves this record** — it is not copied — and that the emission factor is recalculated for its geography | |
| MOVE-03 | **Save draft** | The record moves. Only one record exists afterwards; nothing was duplicated | |
| MOVE-04 | Attach a file, **Submit for review**, approve it, then check the dashboard cell for **TonyAI Energy · Electricity** | The fraction moves **3/24 → 4/24**: the entry now closes a site invoice it previously closed none of. A *draft* closes nothing, and neither does an invoice with no file attached — the fraction only moves once it is committed with evidence | |
| MOVE-05 | Change any **other** field on an open record | Every other field starts a *fresh* record. Only the Location control moves the one you have open — confirm the difference is obvious enough to be safe | |

### 4.6 Reports disclose withdrawals and the reporting entity (WP20)

**Precondition: complete §4.4 first.** With no withdrawals, every surface below is
correctly invisible.

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| DISC-01 | `/reports` (2026, whole organisation) after one withdrawal | A banner: *"1 record was withdrawn from this reporting year. It counts towards no figure above, and every export lists it with the reason recorded at the time."* | |
| DISC-02 | **Data completeness** panel on the same page | A **Withdrawn** row with the count. On the fresh seed (0 withdrawals) the row and the banner are both absent — that is correct, not a missing feature | |
| DISC-03 | **Download PDF** → *Executive Summary* | Under the metric tiles, a **Restatement** paragraph naming the count and the tonnage removed; further down a **"Withdrawn from this inventory"** table (subsidiary, reporting entity, category, period, tCO₂e removed, withdrawn-at, reason, withdrawn-by — the last being an opaque user id, and an em dash where a record carries none) ending in **Total withdrawn** | |
| DISC-04 | **Download PDF** → *GHG Protocol Detail* | Everything above, **plus** the activity-records ledger — and the ledger now carries a **Reporting entity** column reading the site's name or *Whole company* | |
| DISC-05 | **Export Excel** | **Four** sheets: *Summary*, *Raw Activity Data*, **Withdrawn Records**, *Factors Used*. The Withdrawn Records sheet is present **even when empty** | |
| DISC-05a *(new)* | Excel → *Withdrawn Records* sheet, **last** column | **Withdrawn by (user id)** — the same opaque id the CSV's `voided_by` carries. Empty when a withdrawal has no actor; the PDF prints an em dash there instead | |
| DISC-06 | Excel → *Summary* sheet | A row reading **"Withdrawn records (excluded from every figure below)"** with the count and the tonnage removed — always present, including at zero | |
| DISC-07 | Excel → *Raw Activity Data* | **Reporting entity** is the **second** column | |
| DISC-08 | **Export CSV**, open in a spreadsheet | 16 columns, the last being `voided_by` (an opaque user id, never a name). Withdrawn rows sit in the same table with `status = voided`; their numeric cells read the word **`Withdrawn`** and the real figures move into `voided_activity_value` / `voided_tco2e`, beside `voided_at_utc` and `void_reason` | |
| DISC-09 | Sum the whole `tco2e` column in the spreadsheet | It equals the total the app reports — because a withdrawn row contributes text, not a number. This is the check that used to fail: before this change the same file summed to more than the inventory | |
| DISC-10 | Sign in as `review@tonyai.local` → `/reports` | A consultant **can** generate and export | |
| DISC-11 | Sign in as `entry@tonyai.local` → `/reports` | Preview visible, tenant-scoped to its 2 subsidiaries, **no export buttons** — a role note instead | |
| DISC-13 *(new — **needs a Windows machine with Excel**)* | Export the CSV, then **double-click the file** to open it in Excel on Windows | Turkish text renders correctly — `TonyAI Enerji A.Ş.`, not `TonyAI Enerji A.Åž.`. **Round 1 never tested this and it was a genuine defect until this build**: the download carries a UTF-8 byte-order mark now, because the header that says "this is UTF-8" is gone once the file is on disk and Windows then guesses. If you have no Windows machine, say so and skip — it is the one case macOS cannot exercise | |
| DISC-12 | Every report you generate, then `/audit` | One row per generation, recording the template, year and export type | |

### 4.7 The anomaly check says what it judged against (WP21)

The rule needs **three** prior committed periods. Fewer than three means the rule
**did not run** — reported as *not evaluated*, which is a different claim from
*not anomalous*.

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| ANOM-01 | `/emissions` → **History** → open **TonyAI Energy · Electricity · January 2026**. *(The list does not show which site a row belongs to — the panel's **Reporting Entity** field does, and it must read **Istanbul HQ**. January is unique: the company's own series starts in April.)* | The panel states: *"No earlier committed period exists for this reporting entity, so there is no history to compare against. The check needs 3."* | |
| ANOM-02 | Open **March 2026** for the same site | *"Only 2 earlier committed periods exist for this reporting entity; the check needs 3."* | |
| ANOM-03 | Open a record with a full history (e.g. TonyAI Gas · Electricity · June 2026) | It names the average it was compared against — a number, not just a verdict | |
| ANOM-04 | Open **TonyAI Logistics · Fuel · July 2026** (the one seeded anomaly) | Flagged, and the text names the historical average it deviates from and the >50% threshold | |
| ANOM-05 | As `entry@tonyai.local`: **TonyAI Energy · Location = Istanbul HQ · Electricity · April 2026**, enter ~**400,000** kWh → Save draft | Amber banner naming the average it deviates from (that site has three priors at 17.6 tCO₂e), and a mandatory **Reason for variance** — submit is blocked until it is filled. *(Pick that exact series: most other 2026 months are already taken, and the free ones have no history to deviate from.)* | |
| ANOM-06 | Export CSV and read the `anomaly_flag` column (**do §4.4 first**, or the `Withdrawn` reading will not appear) | Five distinct readings: `yes`, blank (checked and clean), `Not evaluated (n of 3 priors)`, `Not evaluated (no figure)` — for a category that produces no tonnage, so §4.8's Water record — and `Withdrawn`. A blank must never be confused with "never checked" | |
| ANOM-07 | Judge the wording | Does *"Not checked for anomalies"* read as reassuring or as a warning? It is meant as neither — it is a statement of what the system does not know | |

> **A short history deliberately does not turn a cell amber.** The first months of
> any new site are always short. If you think a tester would read the green as
> *"checked"*, tell us — that is a decision we would revisit.

### 4.8 A category with no emission factor (WP17)

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| UNC-01 | `/data-entry` → category **Water** → enter a value | The preview states there is no emission factor. The record can still be **saved** — the activity data is kept, it simply produces no tCO₂e | |
| UNC-02 | Attach a file (Water requires evidence like any other category), **Submit for review**, approve it, then look at `/emissions`, the dashboard, PDF, Excel and CSV | Every surface says **Not calculated** rather than printing a `0`. A zero would be a claim that the emissions are zero | |
| UNC-03 | Switch to **Mobile Combustion** or **Refrigerants** | The same honest refusal — those factor libraries are Phase 4 (round-1 DE-4 / DE-5) | |
| UNC-04 | Do UNC-01/UNC-02 on **TonyAI Energy** (which is measured per site), then look at its **Water** cell on the dashboard | The cell now carries the "no emission factor" wording it could not show while the category was empty — Water is counted towards completeness but contributes no tonnage | |

---

### 4.9 XLSX escape fidelity and refusal before writes (LP1-04)

**Verified existing implementation**, not a new parser change: [#133](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/133)
(`defaf4a`). [#145's verification](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/145)
records **460/460** focused `parse-rows`, `xlsx-reader`, `bulk-upload.service` and
`caller-text` tests passing on Node 22 at `f14c81f`, with #133's escape implementation
and regression cases unchanged. Refusal before writes was verified through control flow
and existing parser/preflight coverage; there is no dedicated apply-mode XLSX
no-write service test in that evidence. It is **not a live database or browser UAT run**.
The P/F cells below remain open for an operator's execution on the selected UAT
release. Record its SHA, fixture variant, outcome and write-count evidence.

Use the **seeded organisation**, signed in as **`entry@tonyai.local`** or
**`admin@tonyai.local`**. Do not use `review@tonyai.local`: that role cannot import,
and its authorization refusal occurs before parsing and is audited. Run **§4.9
last**, after the other UAT cases: XLSX-03/04 leave drafts occupying reporting
slots. Save the evidence, then restore the disposable local dataset with
**`pnpm db:reset`**; do not reset a shared session while another operator is using it.

Go to **`/data-entry` → Bulk upload card → Download template**. Use valid rows
with accessible entities and a fresh unused reporting slot for each successful
import, so permissions, duplicate slots or factor coverage do not obscure the
parser outcome. Keep all other headers/cells valid and stay below the row cap
except in XLSX-07. **Pace uploads: the limit is 5 requests per minute per user,
including dry runs.** Selecting a file triggers a dry run, and Import sends a
second request. A **429 / “Too many import attempts…” is not a case result**:
wait for the limit to reset and repeat that attempt before recording P/F.

Engineering should prepare equivalent workbooks using **inline strings**
(`inlineStr` in the sheet XML) and **shared strings** (sheet index into
`xl/sharedStrings.xml`); execute each case in both forms. Change the XML escape
sequences themselves: merely typing `_x0000_` in Excel can escape the underscore
and create the literal positive-control case. **Write hexadecimal digits in
uppercase**, keeping the marker lowercase `_x`, as Excel does: `_xD800_`, not
`_xd800_`, which remains literal.
The existing fixtures in `apps/api/src/bulk-upload/parse-rows.spec.ts` demonstrate
both representations and the exact refusal wording. These are synthetic input
fixtures, not authoritative emission-factor data.

| TC | Steps | Expected | P/F |
| --- | --- | --- | --- |
| XLSX-01 | Put `before_x0000_after` in the first data row's `varianceReason`; upload through bulk import. | Whole file refused before import. Error names **row 2**, **varianceReason** and **U+0000**; no generic server error, silent replacement or partial successful rows. | |
| XLSX-02 | Repeat with `_xD800_` (lone high surrogate), `_xDE00_` (lone low), then `_xDE00__xD83D_` (reversed pair). | Each whole file is refused, identifying row/column and **U+D800**, **U+DE00**, **U+DE00**, respectively; the reversed pair reports its first unpaired unit (the low surrogate). | |
| XLSX-03 | Put `meter swapped _xD83D__xDE00_` in `varianceReason`. Import the otherwise valid file, then inspect `varianceReason` through `GET /api/v1/activity-records/:id` or a read-only DB query (preview does not expose it). | Valid pair is retained as **meter swapped 😀**. No replacement character, truncation or surrogate refusal. Acceptance remains subject to ordinary domain validation. | |
| XLSX-04 | Put `_x005F_x0000_` in `varianceReason`. Import the otherwise valid file, then inspect `varianceReason` through `GET /api/v1/activity-records/:id` or a read-only DB query (preview does not expose it). | The seven literal characters **`_x0000_`** are retained; they are not decoded twice into NUL or falsely refused. | |
| XLSX-05 | Add header `t_x0000_e`, with a value beneath it. | Header-specific refusal begins **`Unrecognised column(s): "t<U+0000>e"`**. It names the character safely; it does not become a data-cell or generic workbook error. | |
| XLSX-06 | Send an authenticated **direct apply** request: `POST /api/v1/bulk-upload/activity-records`, multipart `file` plus `dryRun=false`. Use a valid first data row and a later XLSX-01/02 fault; repeat with an XLSX-05 header fault. Compare the seeded organisation's rows and import-source objects before/after each request. | **HTTP 400** naming the actual later fault row/column/code point, or the header-specific refusal for XLSX-05, before **any** write: zero new activity records/calculation snapshots, import batches, source objects/storage intents or audit rows, including for the earlier valid row. A malformed-file refusal is not an audited caller-authorization event. | |
| XLSX-07 | Combine an escaped bad cell with a 1,005-data-row workbook; separately combine an unlabelled value in row 2 with the bad cell in row 3. | Existing refusal order is preserved: **`The file has 1005 rows; the limit is 1000.`** wins in the first file; the unlabelled row-2 value wins in the second. Both refuse the whole file before writes. | |

For XLSX-03/04, take `recordId` from the apply response's `accepted[]` and use it
for the authenticated GET above. Inspect the decoded response string or stored
value, not its UI rendering: compare the exact Unicode characters with the
expected value. A visual glyph or JSON escape spelling alone does not prove fidelity.

For XLSX-06, the UI **never offers Import for a refused file**; a dry run's lack
of writes does not prove apply-mode refusal. Use an API client with the importing
user's **Supabase access token in `Authorization: Bearer …`** (browser cookies
alone are insufficient). Send `file` as the XLSX attachment and `dryRun` as the
literal multipart value `false`; let the client set the multipart boundary.
Keep tokens out of saved evidence. Require the expected parser/header **400**,
not a 401, 403, 429 or unrelated validation error.

A test operator must compare exact organisation-scoped database/object counts in
the local environment, including every write surface listed in XLSX-06, during a
quiet window with no concurrent writers. Attach the before/after counts and
sanitized refusal response for each variant. If those observations are unavailable,
leave the case unexecuted; existing unit assertions or absence from the UI cannot
stand in for a manual PASS. Do not use production data or delete append-only audit
rows to prepare this case. Keep the historical automated result separate from new
manual P/F results; the LP1-04 completion proposal relies on the existing regression
evidence and this catalogue update, not an invented live acceptance run.

---

## 5. Known limitations — do **not** report these as bugs

**Deliberate, recorded decisions:**
- **No screen sets a subsidiary's tracking mode** (whole-subsidiary vs per-location) — API only. Say if you need it.
- **No Google Places autofill** on addresses (round-1 SUB-3) — needs an API key, billing and a product decision.
- **Refrigerants and Mobile Combustion have no factors** (round-1 DE-4, DE-5) — Phase 4. Sm³ for natural gas is refused for the same reason (DE-3).
- **Bulk review has no UI** — `/review` decides one record at a time.
- **Seeded records name no reviewer.** All 96 were written straight to `approved` without a review step, so **Reviewed by** is blank on every one of them. Records you approve yourself do name you. (Their **Waiting** time is blank for the same reason: they were never submitted.)
- **Reports are scoped by year + subsidiary only**; scope/category-filtered exports and report sharing (link/email) come later.
- **A withdrawal cannot be undone** — by design. The corrected figure is entered as a new record.
- **Scope 3**, supplier management, email notifications, i18n and dark mode → Phase 3. Cloud/staging deployment → Phase 2.
- User lifecycle (invite, password reset, role management UI) → Phase 4; UAT uses the three seeded accounts.
- `executive_viewer` has no seed user and is not part of this round.
- Dashboard year-over-year badges show "—" until a second year of data exists.
- Dashboard has no organisation switcher (single-org seed).

**Known gaps already in the backlog — skip reporting:**
- The activity-record list is **not paginated** on the wire: `/review` fetches every pending record and pages in memory, and `/emissions` → History fetches the whole history and does not page at all.
- The review queue loads only when you open it; a record submitted afterwards does not appear until you reload.
- The count of records the anomaly rule did not evaluate is computed and sent to the browser, but **no screen shows it yet**.
- `/emissions` fetches its totals **without a year filter**, so the figures under the 2026 heading are really all-years figures. Identical today, because the seed holds one year only — but if you enter data in another year (round-1 DE-9 made 2015–2026 selectable), expect that tab to include it. Report anything odd you see there, but not this.
- Unknown URLs and render failures show branded TonyAI pages with a reference code — that is the error handling, not a defect. Report the error that *caused* it, quoting the code.

---

## 6. What we would most like your judgement on

Not bugs — decisions. Round 2 exists partly to test these.

1. **Does green now mean what you expect?** A cell is green only when every entry in it has been accepted. Amber means *something is left to look at* — awaiting review, flagged as anomalous, missing a file, or still a draft. Is one amber for four different reasons useful, or does it need to distinguish them?
2. **Is "not evaluated" understood?** A record with fewer than three prior periods was never checked. We report that but deliberately do **not** colour the cell amber for it. Right call?
3. **Is withdrawal the right model?** An approved figure cannot be edited, only withdrawn with a reason and replaced. Does that match how your organisation restates a published number?
4. **Is the per-location view worth the extra reading?** `3 of 24` carries more information than a tick, but it also demands more of the reader. Would you want it on every subsidiary, or only where invoices really are per site?
5. **The withdrawer, named two different ways — is the split defensible?** The *screen* names the person (*Withdrawn by Tony Admin*). Every *export* carries their **opaque user id** instead, and never their name. The reasoning: a filed report cannot be recalled, so putting a natural person's name into one is a data-protection commitment we have not yet answered (erasure, redaction), while the id still lets a verifier with system access identify who acted. **Is that id enough for your auditor, or does a filed report have to carry the name?** This is the question we would most like answered this round.

---

## 7. Reporting an issue

For each issue please capture:

1. **TC ID** (or "exploratory"), **user** (admin / entry / review) and **page**.
2. **Steps** you took (numbered), **expected** vs **actual**.
3. A **screenshot** (and the browser console if something crashed).
4. Severity: **S1** blocks testing · **S2** wrong result or wrong data · **S3** cosmetic / UX.

If a number disagrees with §2.2, say which number and what you saw — a wrong
figure in a compliance product is an S2 at minimum.

The demo dataset can always be restored with `pnpm db:reset`.

### How round-2 feedback gets handled

Same as round 1: fixes land **incrementally while UAT continues** — you are not
waiting for one release. Each merged change names the feedback IDs it closes.
When you are told a fix has landed: `git pull`, re-run **`pnpm setup`**, then
re-test only the named items plus anything you were mid-way through.

Round-1 feedback and its routing are in
[`uat_phase1_feedback_round1.md`](uat_phase1_feedback_round1.md) and
[`../roadmap_docs/project_status_roadmap_phases.md`](../roadmap_docs/project_status_roadmap_phases.md).

---

## 8. Sign-off

| Area | Tester | Date | Verdict (Pass / Pass w/ notes / Fail) |
| --- | --- | --- | --- |
| Round-1 close-out (§3) | | | |
| Audit trail (§4.1) | | | |
| Completeness & the review gate (§4.2, §4.3) | | | |
| Withdrawal & re-attribution (§4.4, §4.5) | | | |
| Report disclosure (§4.6) | | | |
| Anomaly provenance (§4.7, §4.8) | | | |
| XLSX escape fidelity and refusal before writes (§4.9) | | | |

---

## 9. Automation baseline — measured on this build, 2026-09-02

Everything below was run and passed before this document was issued:

- **934 unit tests** across 35 files — 708 API, 122 web, 63 shared-types, 41 database tooling. Covers the calculation engine to the digit, tenant isolation, RBAC, every lifecycle gate, the completeness rule, the withdrawal path, report assembly and the anomaly baseline.
- **84 end-to-end tests** (Playwright, real browser against the real API and database) — login, the full data-entry lifecycle including evidence upload and approval, all three gates, RBAC and tenant negatives, the completeness dashboard, the review gate, withdrawal, the audit trail, targets, and report downloads verified by filename and file signature.
- **34 live RLS containment probes** — the database independently hides cross-tenant rows even when the API is bypassed, and a consultant cannot write or withdraw a figure through it.
- Every mutation writes an append-only **audit log** row.

These prove the mechanics. What they cannot test is whether the product answers
the question you actually have — which is what §6 is for.
