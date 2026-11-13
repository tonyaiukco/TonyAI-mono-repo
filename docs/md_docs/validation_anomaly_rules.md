# Technical Spec: Validation and Anomaly Detection Rules
**Document ID:** `TONY-TECH-004`  
**Application Area:** Data Entry, API Validation, Quality Assurance

## 1. Purpose
This document defines the rules used to protect data integrity across TonyAI.

It covers:
- hard validation rules
- anomaly detection logic
- boundary checks
- metadata requirements
- quality related audit responses

These rules apply across frontend and backend workflows.

---

## 2. Validation Levels

Validation should be applied at two levels.

### 2.1 Draft Save Validation
Draft save should allow incomplete records, but still enforce minimum structural integrity.

Minimum checks for draft save:
- numeric fields must be valid if entered
- startDate and endDate must be valid if entered
- unit must belong to the selected category if entered
- no malformed payloads

### 2.2 Submit Validation
Submit validation must enforce full completion rules before a record can enter review.

Submit checks include:
- required fields complete
- valid date range
- valid unit for category
- required evidence attached where configured
- required anomaly comment present if anomaly is triggered

---

## 3. Hard Validation Rules

| Field | Validation Rule | Error Message |
| :--- | :--- | :--- |
| Reporting Period | Must align with the selected `reportingYear` | `Period falls outside the selected reporting year.` |
| Activity Value | Must be a positive numeric value | `Please enter a valid positive number.` |
| Unit Selector | Must match the allowed unit group for the selected `categoryKey` | `Invalid unit for this category.` |
| Evidence | Required if `categoryConfig.requiresEvidence === true` on submit | `Supporting evidence is required for this category.` |
| Date Alignment | `endDate` must be equal to or later than `startDate` | `End date cannot be before start date.` |

---

## 4. Anomaly Detection Logic

The system compares current input against historical baselines to identify unusual but technically valid values.

### 4.1 Baseline Calculation
The baseline is the rolling average of the previous 3 comparable periods for the same **reporting entity**:
- `subsidiaryId`
- `locationId` — **including `NULL`**, which is its own pool (see the deviation below)
- `categoryKey`
- `activityType` — diesel and petrol of one site are separate series (LP3-03); an untyped record pools only with untyped ones
- `reportingPeriod` (the granularity: monthly, quarterly, annual)

**The window is the three most recent earlier periods; one figure in it is
enough for the rule to run** (owner decision 2026-11-11, BUG-R2-07). What the
window holds decides the verdict's basis:

| Figures in the window | Verdict |
|---|---|
| 3 | Full history: compared with their average. |
| 1 or 2 | **Limited history**: compared with the average of those, under the same threshold. |
| 0 | **First period**: no history to compare with. Checked against the first-period typo ceiling (below); *not evaluated* when it is not above it. |

A limited-history verdict is a weaker claim than a full one, and *not evaluated*
is a different claim from *not anomalous*. Every surface must say which of the
three it is showing, with the number of periods for a limited verdict. The
record carries `baselinePriorCount` (0–3) and `baselineTCo2e` (the average, or
null when the rule did not run) beside `anomalyFlag` for exactly that reason.

An average of **zero** yields no ratio, whatever the count: the record is *not
evaluated* and is never flagged.

A prior that carries **no figure** — an invoice-tracked category with no seeded
factor — occupies one of the three slots and is then dropped rather than
zero-filled (zero-filling would deflate the average and manufacture a false
anomaly). The rule does not reach further back to refill the slot, so such a
window is judged on limited history. The window has no age limit: when nothing
newer exists, a period from two years ago is still the history.

#### First-period typo ceiling (K4-3a option B, Decisions 2026-11-12)
A record with a figure and **no earlier period** is compared with a fixed
ceiling for its category and unit, independent of the facility type. **Strictly
above** the ceiling, it is flagged exactly as a history flag is: a variance
reason is required before submit. At or below it, the record stays *not
evaluated* and is named a first-period record. The ceilings are plausibility
guards against an extra zero, not factors; no calculation reads them. The team
set them from the largest facilities in the pilot holding's V8-2 inventory with
a safety margin; the owner set the kg, marine gas oil and Fuel rows and may
revise any of them.

| Category | Ceiling |
|---|---|
| Electricity | 1,000,000 kWh |
| Natural Gas | 250,000 Sm³, or 2,500,000 kWh |
| Mobile Combustion | 100,000 L, or 100,000 kg |
| Mobile Combustion, marine gas oil | 1,000 t (checked instead of the kg row) |
| Fugitive Gas | 200,000 Sm³ |
| Refrigerants | 500 kg installed capacity on any **one** equipment line |
| Refrigerants, refill | on any **one** line, more than 125% of that line's capacity, capped at 500 kg; 500 kg for a line with no capacity |
| Fuel | 100,000 L, or 150,000 kg |

- **Other units** reach the same ceiling through exact definitional
  equivalences only (owner, 2026-11-13): MWh, GJ and therms to kWh, UK and US
  gallons to litres, tonnes to kg. A **metered m³** of natural gas that carries
  its own volume correction factor (the TR rules) is held to the Sm³ ceiling as
  m³ × factor, the figure the engine prices (owner, 2026-11-13); without a
  factor it is held to the Sm³ number, as a guard.
- **Refrigerants** are checked line by line; the record's totals are never
  compared. A line is above its ceiling when its capacity is over 500 kg or its
  refill is over its refill ceiling (owner, 2026-11-13). The refill limit
  follows US EPA 40 CFR 82.157's reporting trigger, a leak of 125% or more of
  the full charge in a calendar year, used as a yardstick. A line's emission is
  capacity × leak rate + refill, so a refill typo moves the figure most. A
  refrigerant record without equipment lines (outside TR) has no ceiling.
- **Only where history cannot judge.** A first period, or a window whose
  figures average zero (owner, 2026-11-13: a January of 0 must not let a
  February typo through). Once the window holds a figure above zero, the
  history rule alone applies. Scope 3 categories have no ceiling.
- **A refrigerant "line" is one equipment type in a record**, not one device:
  200 split air conditioners of 3 kg are one 600 kg line, which is flagged and
  needs one sentence of reason. The data model holds no device count, so a
  per-device ceiling is not possible (owner, 2026-11-13).
- **Stored** as `anomalyFlag` true beside the count and average history gave —
  a count of 0 and a null average, or an average of 0 — a state no earlier
  rule wrote; the basis (`ceiling`) is derived, and the record
  counts as evaluated. The submit refusal `variance_reason_required` carries
  `params.basis` = `ceiling` (or `history`).
- **Verdicts scored before the ceilings** (unflagged, above a ceiling, with the
  count and average history still gives — count 0 and no average, or an
  average of 0; any other stored average is drift)
  are kept on committed records and reported by the consistency tools as a
  known difference; a draft or a rejected record meets the ceiling at its next
  save.

The consultant has no manual "suspicious" flag (K4-3b): a doubtful first-period
figure is rejected with a comment.

#### Verdicts written before 2026-11-11
From 2026-08-27 to 2026-11-11 the rule needed three figures, and a record with
one or two was stored as *not evaluated*: a count of 1 or 2 beside a null
average. Those verdicts are **kept, not re-scored** — a committed record would
otherwise gain a flag its author never saw and never explained. Such a record
says that it was scored before the short-history check existed. A draft or a
rejected record is checked under the current rule at its next save or submit.
`pnpm anomaly:probe` lists the kept verdicts as a known difference, not as
drift, and `pnpm anomaly:recompute` leaves them alone on committed records.

#### The re-score tool never hands a reviewer an unanswered flag
`pnpm anomaly:recompute` repairs a stored verdict whose history has moved. On a
record waiting for review it does so with one exception (owner decision
2026-11-11): if the rule would now flag the record and it carries no variance
reason, the tool reports it and leaves it. A flagged record cannot be submitted
without a reason, so a flag written afterwards is a warning its author never
saw. It arises when an earlier period is committed after a later one was
submitted, which one earlier period is now enough to cause. The reviewer who
doubts the figure rejects it, and the resubmit asks for the reason.

Only records in a **counted** status (`submitted`, `under_review`, `approved`,
`locked`) seed a baseline — an unreviewed draft would add noise, and a withdrawn
(`voided`) figure has been taken out of the inventory. The window is **not**
year-scoped: the year enters only through the period's ordinal, so December
seeds the following January.

#### A record that was not evaluated does NOT cap the completeness cell (decision 2026-08-27)
A record the rule did not run on is not "clean", but it does not turn its
tracking-matrix cell amber either. Capping on it would paint every new site's
first period amber, and a warning that is always on is not a warning. The cell
reports `notEvaluatedRecordCount` instead and the surfaces state it, which is
the disclosure without the false alarm. Since 2026-11-11 that count holds only
records with no earlier period (below their ceiling), a zero average, or a
verdict kept from before the short-history check. A first-period **ceiling
flag** turns the cell amber and is not counted as not evaluated. A **flag** on limited history turns the cell amber and
raises the dashboard alert exactly as a full-history flag does.

#### Deviation from the original specification (deliberate, 2026-07-08 / 2026-08-27)
The key above is **not** the one this document carried until 2026-08-27, which
named `organisationId` and `subCategoryKey` and said nothing about location or
granularity. What changed and why:

- **`organisationId` and `subCategoryKey` are gone** — neither corresponds to a
  column on `activity_records`. A subsidiary implies its organisation, and the
  sub-category dimension arrives with the Scope-3 factor model (WP11); the
  baseline key must gain it then.
- **`locationId` was added.** Comparing a site meter against a whole-company
  roll-up flags a change of **scope** as a change of consumption. It is what
  stops a re-attribution — the same energy, reported at a site instead of at the
  company — from raising a false anomaly. The cost is stated plainly: a series
  whose attribution changes hands **restarts its run-up**, so the months after
  the change sit on a short window and are not evaluated. `pnpm anomaly:probe`
  is what makes those months visible instead of silent.
- **`reportingPeriod` was added** — an ordinal is only comparable within one
  granularity, so a quarter must never seed a month's baseline.
- **"the previous 3" was enforced as exactly three from 2026-08-27 to
  2026-11-11.** Before that the implementation accepted a single prior with
  nothing recording that it had, so the gate could degrade from a three-period
  average to one month against one month unseen. The strict reading fixed the
  silence at the cost of the check: a first-year business, a quarterly reporter
  until its fourth quarter and an annual category until its fourth year were
  never evaluated (UAT round 2, BUG-R2-07). Since 2026-11-11 one or two periods
  are evaluated again, as *limited history*, and the count that was missing in
  the first version is what every surface now states.

### 4.2 Trigger Threshold
An anomaly is triggered when the current calculated result differs by more than 50 percent from the rolling average baseline.

### 4.3 System Response
If anomaly is triggered:

1. the relevant input area and calculation card receive warning styling
2. warning banner is shown:
   `This value deviates significantly from historical average. Please verify.`
3. `varianceComment` becomes mandatory before submit
4. submit action remains disabled until comment is entered
5. payload includes `anomalyFlag: true`

---

## 5. Unit Normalization and Boundary Checks

### 5.1 Boundary Checks
The system should support configurable upper bound thresholds by category and entity type.

Example use:
- unusually large electricity value for a small office
- unusually large fuel consumption for a small fleet
- unrealistic travel distance in one reporting period

Prototype implementations may use demo thresholds. Production should use configurable thresholds.

### 5.2 Unit Change Safety
If a user changes the selected unit:
- the calculation preview must refresh immediately
- the UI must clearly prevent stale result display
- conversion behaviour must be consistent with category logic

---

## 6. Metadata and Traceability Checks

Before a record reaches `approved` status, it must pass metadata checks.

### Required Checks
- record has `userId` or `createdBy`
- record has timestamp fields
- record has factor traceability fields
- factor version matches the configured methodology and reporting year logic for that record

---

## 7. Audit Quality Rules

If a record is rejected during audit or review due to validation or quality concerns:

- set `status = rejected`
- store rejection reason
- store validation or quality rule reference where possible
- notify the relevant `data_entry` user

### Example Notification
`Revision required: your submitted record did not meet validation or evidence requirements.`

---

## 8. Notes for Development
- draft save and submit validation should not be treated as the same thing
- anomaly detection is warning based, not automatic rejection
- boundary checks should be configurable rather than hardcoded where possible
- validation logic must exist in both frontend and backend layers
- backend validation remains the final enforcement layer