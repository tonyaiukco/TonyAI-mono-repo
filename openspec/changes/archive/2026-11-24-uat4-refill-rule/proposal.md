# Proposal

## Why

The refrigerant and fire-suppression rule adds the capacity-based leak estimate and the year's refill on the same
equipment line (`capacity × leak rate + refill`). A refill replaces gas that leaked, so a line with both counts the
same leak twice. UAT round 4 files this as BUG-17 (Go-Live Readiness Review, decided 2026-11-24), and the data
request form that the pilot companies fill in collects refill amounts, so the double count would reach real figures.

## What Changes

- **The rule, per equipment line:** a line with a refill above zero is priced on the refill alone; a line with no
  refill is priced on `capacity × leak rate`. Never both. New golden vector: an FM200 system of 50 kg with a 35 kg
  refill gives **126.00 tCO2e** (the sum rule gave 129.60). Golden value 9 (the owner's GV-8: 40 kg of FM200, no
  refill) stays **2,880.00 kgCO2e**. The preview follows, because it runs the same engine.
- **Committed figures keep their rule (owner decision 8, 2026-11-24).** Approved and locked records are neither
  rewritten nor re-read under the new rule. A snapshot marks a line with positive capacity and refill when it
  was priced on its refill alone, so reports can explain each figure according to the rule used.
- **No needless staleness.** A record whose lines have no refill, or no capacity, has the same snapshot under both
  rules and is not refused as stale.
- **Reports:** for a marked line, the calculation-inputs text names the refill as the released mass and explains
  that the capacity estimate was excluded. PDF and XLSX use the report's Turkish or English locale. CSV uses
  English. Both issued renderers (PDF and tables) move to v6.
- **Open drafts are re-priced (owner decision 8).** A new operator command re-prices Türkiye refrigerant records in
  `draft` or `rejected` that hold a line with both a capacity and a refill; `rejected` counts as an open draft
  (owner, 2026-11-24). Dry run by default; one `reprice` audit
  row per record; the anomaly verdict is re-derived. It never writes a `submitted`, `under_review`, `approved`,
  `locked` or `voided` record. It lists `submitted` and `under_review` records still priced under the earlier
  sum rule, with no writes to those records.
- **Submitted and under-review records with both masses** are refused `calculation_stale` at approval, as any record
  priced by an earlier rule is today, and return to their author, whose next save prices them under the new rule.
  This is the existing behaviour, kept on the owner's confirmation (2026-11-24; `design.md`, decision 5).
- **Screen and template wording:** the Data Entry help text and the bulk template's refill column say "refill if
  there was one, otherwise the estimate".
- **The refill ceiling keeps its numbers** (125% of the line's capacity, capped at 500 kg). Only its rationale in the
  code and the docs changes, because it cites the sum formula.
- Docs that state the formula are corrected.

Not in this change: fire suppression as its own Scope 1 entry and the g/kg selector (BUG-12, WP3); running the
re-pricing command on hosted QA (an owner release after the deploy); the "figure out of date" marker on screens
(LP7-07, deferred); any factor value.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `emission-calculation`: the refrigerant capacity method becomes "refill if known, else estimate" per line; a
  committed snapshot keeps the rule it was priced under; reports state how a line was priced.
- `activity-data-entry`: the refrigerant equipment inputs say how a line with a refill is priced.
- `record-lifecycle`: open refrigerant drafts are re-priced by an operator command with its own audit verb, and
  committed records are never written by it.

## Impact

- **API:** `calculations/tr-rules.ts` (the rule), `common/calculation-inputs.ts` (the report line),
  `reports/i18n` and `report-issuances/i18n` (TR/EN), `report-issuances/issuance-html.ts` and
  `report-issuances/issuance-tables.ts` (renderer v6 for PDF and tables), a new
  re-pricing service and CLI under `activity-records/`, `bulk-upload/template-workbook.ts` (wording),
  `audit/` (the `reprice` verb).
- **Shared types:** `RefrigerantTerm` gains one optional field and a helper that gives a term's priced mass;
  `AUDIT_ACTIONS` gains `reprice`; the ceiling's comment is corrected. No required field changes.
- **Web:** `messages/{en,tr}/dataEntry.json` (help text), the audit viewer's label for `reprice`. No web code
  computes the leak.
- **Database:** no migration expected. The audit action is free text, and the snapshot is JSON.
- **Tests:** engine unit tests and the new vector, the vector against the sealed TR release, snapshot staleness,
  report text for old and new snapshots, the re-pricing command (unit and integration), one e2e spec whose
  alternative-rate case was written with a refill.
- **Docs:** `docs/md_docs/calculation_logic.md`, `docs/md_docs/validation_anomaly_rules.md`,
  `docs/api/reports-and-issuance.md`, `docs/development/commands.md`, the planning file and the sprint ledger.
- **Data:** hosted QA may hold drafts with both masses; how many is not known until the command's dry run is run
  there. Re-priced drafts and rejected records affect inventory totals when their authors submit them. A record
  awaiting review still contributes its stored figure until the author recalls it or a reviewer rejects it.
