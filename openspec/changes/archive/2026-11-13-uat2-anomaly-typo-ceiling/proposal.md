# Proposal

## Why

UAT round 2 (BUG-R2-07) asked for a third tier of the anomaly check: today the first period of a series is never checked, so an extra zero in a first-year electricity or gas figure reaches the reviewer unexplained. The team answered K4-3a on 2026-11-11 (option A, the honest first-period notice, shipped in `uat2-team-decisions-copy`; option B, a fixed typo ceiling), and the owner set the ceilings for the remaining units on 2026-11-12 (Decisions 2026-11-12). This change builds option B and closes BUG-R2-07.

## What Changes

- **First-period typo ceiling:** a record with a figure and no earlier comparable period (the first period of its series) is compared with a fixed ceiling for its category and unit. It does not depend on the facility type. Above the ceiling, the record is flagged. **BREAKING** for data entry: such a record now needs a variance reason before submit, where it used to pass.
- **The ceilings (owner's decision, plausibility guards, not factors):**
  - Electricity > 1,000,000 kWh
  - Natural Gas > 250,000 Sm³ or > 2,500,000 kWh
  - Mobile Combustion > 100,000 L, or > 100,000 kg
  - marine gas oil > 1,000 t
  - Fugitive Gas > 200,000 Sm³
  - Refrigerants > 500 kg installed capacity on any one equipment line
  - Refrigerant refill on any one line > 125% of that line's capacity, capped at 500 kg; 500 kg for a line with no capacity. This was added by the owner on 2026-11-13, after the `security-rls` review found refill unguarded. The 125% follows US EPA 40 CFR 82.157's reporting trigger, a leak of 125% or more of the full charge in a calendar year.
  - Fuel > 100,000 L, or > 150,000 kg
- **Other units are converted by definition (owner, 2026-11-13):** MWh, GJ, therms, UK and US gallons, and tonnes for Mobile Combustion other than marine gas oil all reach the same ceiling through exact unit equivalences. Uncorrected m³ of natural gas uses the Sm³ ceiling. No new limit value is introduced.
- **Refrigerant records without equipment lines get no ceiling (owner, 2026-11-13).** These are records outside TR, which are not in the pilot. They stay "first period, not checked".
- **Only where history cannot judge:** a first period, or earlier periods that average zero (owner, 2026-11-13, after review: a January of 0 must not let a February typo through). Once a series has an earlier figure above zero, the history checks (full and short) apply as today, and the ceiling does not. Scope 3 categories have no ceiling.
- **Metered gas uses its own factor (owner, 2026-11-13, after review):** m³ that carries a volume correction factor (the TR rules) is held to the Sm³ ceiling as m³ × factor, the figure the engine prices.
- **The refusal says why (owner, 2026-11-13):** `variance_reason_required` keeps its code and gains `params.basis` (`history` or `ceiling`). The ceiling case has its own Turkish and English wording on Data Entry. In bulk submit and the bulk import warning, the server's message names the ceiling. Their short labels ("Needs a variance reason", "Cannot be submitted yet") are true for both bases and stay as they are.
- **Every surface names the ceiling flag.** Data Entry, the review sheet and the emissions drawer show it with the entered amount and the ceiling it passed, and still ask for the evidence and the unit to be checked. The review queue and the matrix show the flag mark. The tracking cell turns amber, the dashboard alert is raised, and reports and CSV state "above the first-period ceiling". A ceiling-flagged record is never counted as "not checked".
- **Existing records keep their verdict:** nothing is re-scored when this deploys. A committed first-period record above a ceiling that was stored unflagged is a known difference for the consistency tools, not drift. A draft is checked at its next save.
- **No migration:** the verdict's three columns are reused. "Flagged with no earlier period" can only be a ceiling flag, so the basis is derived.

Not in this change:
- K4-3b, a consultant's manual "suspicious" flag. The team chose reject-with-comment, which exists today.
- Ceilings by facility type or size.
- Ceilings for Scope 3.
- A stored basis column.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `anomaly-check`: the requirement "No check without history" changes, because a first-period record above its ceiling is flagged. New requirements cover the ceiling table, the unit equivalences, the refrigerant line rule, the refusal's basis, what every surface says about a ceiling flag, and how the consistency tools treat verdicts stored before the ceiling.

## Impact

- **Contract (`@tonyai/shared-types`):**
  - The ceiling table, a pure ceiling verdict (category, activity type, unit, amount, parameters), and the `ceiling` value of the derived basis.
  - `isAnomalyEvaluated` treats a ceiling flag as checked.
  - `variance_reason_required` gains the `basis` param key.
  - `dist` must be rebuilt for the API and web.
- **API:**
  - `detectAnomalyFor` receives the activity amount, unit, type and parameters. Create, update, submit and the bulk import preview pass them.
  - `VarianceReasonRequiredError` carries the basis, and bulk submit forwards it.
  - The report anomaly column and its TR/EN vocabulary gain the ceiling wording.
  - The tracking matrix's not-checked count follows `isAnomalyEvaluated`.
  - No new endpoint, no new error code, no migration.
- **Database scripts:**
  - `anomaly:probe` holds a copy of the ceiling table in SQL, with a parity test against the contract.
  - `anomaly:recompute` uses the contract's ceiling verdict.
  - Both learn the "scored before the ceiling" known difference.
  - The seed's verdict helper follows the rule.
- **Web:**
  - `lib/anomaly-view.ts` gains the ceiling statement.
  - The `anomaly`, `errors` and `dataEntry` catalogues gain TR and EN copy.
  - Data Entry's pre-submit toast names the ceiling.
- **Tests:**
  - Unit specs for shared-types, the API service, bulk upload and submit, emissions, reports, the web view and messages, and the recompute lib.
  - Integration cases in the anomaly and probe suites.
  - One e2e flow.
  - The existing assertion that "a first-period record is never flagged" flips deliberately.
- **Data:** nothing is migrated. On hosted QA, first-period drafts above a ceiling will need a variance reason at submit. Count them with `anomaly:probe` (read-only) before the deploy.
- **Docs:**
  - `docs/md_docs/validation_anomaly_rules.md`, `calculation_logic.md`, `functional_requirements.md`
  - `docs/api/` (the error params)
  - `docs/uat/uat_round2.md`
  - The status file: BUG-R2-07 closed, and the Next up head moves to change 6.
- **Review:** the change touches the submit gate and the shared contract, so `security-rls`, `qa-auditor` and `architect` review it before the PR.
