# Proposal

## Why

UAT round 2 (BUG-R2-07, P2) found that the review screen says "at least 3 periods of history are needed" and runs no anomaly check for a business entering its first year of data. The rule needs three earlier periods, so a company that reports quarterly goes unchecked until its fourth quarter, and an annual category (Refrigerants) until its fourth year. QA asked for a three-tier check; the owner decided on 2026-11-11 to build the second tier now: a check against one or two earlier periods, stated as such wherever it is shown.

This reverses Decision 1 of 2026-08-27 (WP21), "three priors, or the rule does not run". That decision was taken because no screen said how many periods a verdict rested on. This change adds that statement, which removes the reason for it.

## What Changes

- **Short-history check:** a record with one or two earlier comparable periods carrying a figure is compared with their average. A deviation above 50% flags it, as with three periods. **BREAKING** for data entry: such a record now needs a variance reason before submit, where it was let through before.
- **Three periods stay as they are:** with three earlier periods the rule, its threshold and its window are unchanged.
- **No history stays unchecked:** a record with no earlier period is still "not checked". Plausibility limits and a manual flag for that case are a separate decision (K4) and not part of this change.
- **The basis is stated:** Data Entry, the review queue and the emissions drawer say when a verdict rests on limited history and on how many periods, for a flagged record and for a clean one. Reports and CSV exports state it in the anomaly column.
- **Matrix and dashboard:** a flag on limited history turns the tracking cell amber and raises the dashboard alert like any other flag. The "not checked" count shrinks to records that were not checked.
- **Existing records keep their verdict:** nothing is re-scored. A record scored before this change on one or two periods says that it was scored before the short-history check existed. The consistency probe and the re-score tool treat those verdicts as a known difference, not as drift.
- **No migration:** the verdict's three columns are reused. Which check ran is derived from the stored period count.

Not in this change: the third tier (K4: plausibility ranges and a consultant's manual "suspicious" flag); a year-on-year baseline; a limit on how far back history may reach; re-scoring later records when an earlier one changes.

## Capabilities

### New Capabilities

- `anomaly-check`: how a record's figure is compared with its own history (which earlier periods count, the full and short-history checks, when no check runs), what a flag requires at submit, and what every screen and export must say about the verdict's basis.

### Modified Capabilities

None. `record-lifecycle` and `activity-data-entry` do not state the anomaly rule today, and the submit gate is specified beside the rule in `anomaly-check`.

## Impact

- **Contract (`@tonyai/shared-types`):** the anomaly constants, `computeAnomalyVerdict`, `isAnomalyEvaluated` and their docs; one new derived helper for the basis and one for a verdict scored before this change. No DTO field is added or removed. `dist` must be rebuilt for the API and web.
- **API:** no change to how history is selected. The submit gate, bulk upload's `would_block_submit` warning, bulk submit and the tracking matrix follow the flag unchanged. The report anomaly column and its TR and EN vocabulary gain the basis wording. No new endpoint, no new error code, no migration.
- **Database scripts:** the seed's baseline helper, `anomaly:probe` and `anomaly:recompute` learn the one-period minimum and the known-difference class.
- **Web:** `apps/web/lib/anomaly-view.ts` and the `anomaly` catalogues (TR and EN) gain the limited-history and scored-before wordings. The screens that render the statement need no logic change.
- **Tests:** shared-types, API service, bulk upload, bulk submit, emissions, reports, web view and Turkish view specs; one integration case; one e2e flow. Several existing assertions flip, because they pin "two priors: not evaluated".
- **Data:** none migrated. On hosted QA, drafts with one or two earlier periods may need a variance reason at submit. The number of such records has not been measured.
- **Docs:** `docs/md_docs/validation_anomaly_rules.md`, `calculation_logic.md`, `functional_requirements.md`, `docs/api/endpoints.md`, `README.md`, `docs/uat/uat_round2.md`, two skills, and the status file (the decision, and that it supersedes Decision 1 of 2026-08-27).
- **Review:** the change touches the submit gate and the shared contract, so the `security-rls`, `qa-auditor` and `architect` review seats run before the pull request.
