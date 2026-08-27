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
- `reportingPeriod` (the granularity: monthly, quarterly, annual)

**Three priors are required.** Fewer than three comparable periods carrying a
figure means the rule does **not** run: the record is *not evaluated*, which is
a different claim from *not anomalous*, and every surface must say which. The
record carries `baselinePriorCount` (0–3) and `baselineTCo2e` (the average, or
null when the rule did not run) beside `anomalyFlag` for exactly that reason.

A prior that carries **no figure** — an invoice-tracked category with no seeded
factor — occupies one of the three slots and is then dropped rather than
zero-filled (zero-filling would deflate the average and manufacture a false
anomaly). A short window is a short window; the rule does not reach further back
to refill it.

Only records in a **counted** status (`submitted`, `under_review`, `approved`,
`locked`) seed a baseline — an unreviewed draft would add noise, and a withdrawn
(`voided`) figure has been taken out of the inventory. The window is **not**
year-scoped: the year enters only through the period's ordinal, so December
seeds the following January.

#### A short window does NOT cap the completeness cell (decision 2026-08-27)
A record the rule did not run on is not "clean", but it does not turn its
tracking-matrix cell amber either. Capping on it would paint every new site's
first quarter amber until its fourth month — permanently, for a subsidiary
reporting quarterly in its first year — and a warning that is always on is not
a warning. The cell reports `notEvaluatedRecordCount` instead and the surfaces
state it, which is the disclosure without the false alarm. Revisit if UAT round
2 shows testers reading a green cell as "checked".

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
- **"the previous 3" is now enforced as three**, not as "up to three". The
  implementation accepted a single prior until 2026-08-27, so the gate could
  degrade from a three-period average to one month against one month with
  nothing recording that it had.

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