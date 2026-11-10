# Design

## Context

See `proposal.md` for the motivation. The facts below were read from the code on 2026-11-11.

- The rule lives in the contract package: `ANOMALY_THRESHOLD` (0.5), `ANOMALY_BASELINE_PERIODS` (3, both the window and the minimum), `computeAnomalyVerdict` and `isAnomalyEvaluated` in `packages/shared-types/src/index.ts`. The API, the seed and the re-score tool all call it, so no second copy of the arithmetic exists.
- `ActivityRecordsService.detectAnomaly` selects the history and passes it, newest first, to `computeAnomalyVerdict`. The comparison is on tCO2e, not on the activity amount.
- The verdict is stored on the record in three columns: `anomalyFlag`, `anomalyBaselinePriorCount` and `anomalyBaselineTCo2e`. It is written on create, update and submit. No database constraint ties the columns together, and they are outside the approved-snapshot immutability trigger.
- One flag drives six things: the submit gate (`variance_reason_required`), Data Entry's copy of that gate, bulk upload's `would_block_submit` warning, the amber tracking cell, the dashboard alert and the report anomaly column.
- Approve has no anomaly gate. Recall keeps the stored verdict.
- Today a record with one or two earlier periods is stored as flag false, count 1 or 2, average null.
- Decision 2 of 2026-08-27 stands: the re-score tool never rewrites an approved or locked record.

## Goals / Non-Goals

**Goals:**

- Run the check on one or two earlier periods with the smallest change to the rule's single implementation.
- Make every surface say which basis a verdict has, so that a weak check is never shown as a strong one.
- Leave existing committed records untouched and keep the consistency tools quiet about them.
- Leave room for the third tier without building any of it.

**Non-Goals:**

- Plausibility ranges or a manual flag for records with no history (K4).
- A year-on-year baseline.
- Re-scoring later records when an earlier period is edited, recalled or voided.
- A limit on how old a comparable period may be.
- Any new column, migration, endpoint or error code.

## Decisions

### D1. The baseline is the average of the one or two figures in the window

The window stays the three most recent earlier periods. `computeAnomalyVerdict` evaluates when the window holds at least `ANOMALY_MIN_PRIORS` (1) figures and averages what it holds.

Alternative considered: the same period of the previous year. It handles seasonality better, but it needs twelve months of history, so it does nothing for the first-year case QA reported. It would also need its own history query and a stored basis column. Rejected by the owner on 2026-11-11.

### D2. A short-history flag blocks submit like any flag

`anomalyFlag` keeps its single meaning. The submit gate, Data Entry's copy, bulk upload's warning and bulk submit need no logic change.

Alternative considered: a warning that does not block. It needs a second signal, and each of the six consumers would have to decide whether that signal blocks. Approve has no anomaly gate, so a non-blocking flag would reach the reviewer with no explanation attached. Rejected by the owner.

The refusal keeps its code and its params. `variance_reason_required` has no params, and its message ("deviates significantly from the historical average") is true for either basis. The basis is stated by the verdict statement shown beside the variance field, not by the refusal toast.

### D3. One earlier period is enough

`ANOMALY_MIN_PRIORS` is 1, as QA asked. With a minimum of 2, an annual category would stay unchecked through its second year.

The cost is accepted: one period is a noisy measure, and a season change or a partial first period can raise a flag. The price of a false flag is one sentence of explanation. Moving to 2 later is a one-constant change.

### D4. The basis is derived, not stored

A helper in the contract package, `anomalyBasis(record)`, returns `full`, `limited` or `null` (not checked) from the stored count and average:

| Stored count | Stored average | Meaning |
|---|---|---|
| null | null | Not checked: the record has no figure |
| 0 | null | Not checked: no earlier period |
| 1 or 2 | null | Not checked: scored before this change (D7) |
| 1 or 2 | 0 | Not checked: the average is zero |
| 1 or 2 | above 0 | Checked on limited history |
| 3 | 0 | Not checked: the average is zero |
| 3 | above 0 | Checked on full history |

`isAnomalyEvaluated` becomes "count at least 1, average neither null nor zero". Every consumer already calls it, so the tracking matrix's not-checked count and the report's `anomalyEvaluated` follow without their own change.

Alternative considered: a stored `anomaly_basis` enum. It needs a migration and a backfill, and tells nothing the count does not. A column is justified when the third tier arrives, because a plausibility verdict has no period count.

### D5. Edge cases follow the full-history rule

- A zero average is "not checked", stored as average 0 with its count, as today for three zero periods.
- A period with no figure occupies a place in the window. A window of [10, none, 10] is therefore checked on 2 periods; today it is not checked at all.
- No look-back limit. See Open Questions.

### D6. Wording per surface

`apps/web/lib/anomaly-view.ts` gains branches, keyed on `anomalyBasis`:

| State | Headline | Detail says |
|---|---|---|
| Flagged, full | unchanged | unchanged |
| Flagged, limited | unchanged | more than 50% against limited history of N periods, with the average |
| Clean, full | unchanged | unchanged |
| Clean, limited | "Within range on limited history" | compared with the average of N earlier periods |
| Not checked, no history | unchanged | no earlier period; the sentence "needs 3 periods" is removed |
| Not checked, scored before | unchanged | scored before the short-history check existed; checked again at the next save or submit |

The tone set (`flagged`, `clean`, `not_evaluated`) does not change. The emissions drawer prints every statement, so it needs no change. Data Entry and the review sheet print a statement only for a flag or for a record that was not checked, and nothing for a clean one. A clean verdict on limited history must not go unsaid there, so the statement carries a `qualified` field (not checked, or clean on limited history) and both screens show their neutral card when it is set. Found during implementation, 2026-11-11: the first draft of this section said no screen needed a change.

The report anomaly column (`anomalyCell` and the vocabulary's `anomaly`) becomes:

| State | Cell |
|---|---|
| Flagged, full | `yes` (unchanged) |
| Flagged, limited | `yes (limited history: N periods)` |
| Clean, full | empty (unchanged) |
| Clean, limited | `within range (limited history: N periods)` |
| Not checked, no history | `Not evaluated (no earlier period)` |
| Not checked, scored before | `Not evaluated (scored before the short-history check)` |
| Not checked, no figure or zero average | unchanged |

The matrix note ("N records not checked — too few comparable periods") is reworded so that it no longer names a period count as the cause.

### D7. Existing verdicts are a known difference

No record is re-scored when this change is deployed. A stored verdict with count 1 or 2 and a null average can only have been written by the old rule, because the new rule always stores an average when it holds at least one figure. `isLegacyShortWindowVerdict(record)` in the contract package names that state.

- **Screens and exports** give such a record its own sentence (D6).
- **`anomaly:probe`** lists these records in their own section and does not count them as drift. Its exit code is unaffected by them.
- **`anomaly:recompute`** leaves a legacy verdict alone on a committed record (submitted, under review, approved, locked) and does not count it as unrepaired. On a draft or a rejected record it re-scores as it does today, because the next save would do the same.

Alternative considered: re-score records waiting in review. It creates a state the normal flow cannot produce: a submitted, flagged record with no variance reason, whose author never saw the warning. Rejected by the owner.

### D8. The seed follows the rule

`rollingBaseline` in `packages/db/prisma/seed.ts` returns the average for one to three figures, through the contract's constants. The seed's existing guards (a staged flag must agree with its window) stay, so a seeded record that would now flag fails the seed loudly, not silently.

### D9. Constraints for the third tier

- A manual flag cannot reuse `anomalyFlag`, the count or the average: every save and submit overwrites them. It needs its own column.
- A count of 0 stays "not checked". Plausibility limits take over that state later.
- If a basis column is added then, it should have room for `plausibility` and `manual`.

## Risks / Trade-offs

- **False flags on one period** (season change, partial first period) → The cost is one sentence, the statement names the number of periods, and the minimum is one constant.
- **Hosted QA drafts newly blocked at submit** → This is the behaviour QA will retest. Count the affected records with `anomaly:probe` (read-only) before deploy.
- **Bulk submit of a new year:** the second and third periods are now checked against the first → The refusal names the record; the user adds a reason and sends again. Covered by a bulk-submit test.
- **A stored verdict goes stale faster.** One period changing moves a one-period average by up to 100%, against about a third for three periods → The submit gate works the verdict out again, so enforcement is right. Only the badge on an already submitted record can be stale. Unchanged in kind from today; recorded as an open question in the status file.
- **Existing assertions pin "two priors: not evaluated"** in the shared-types, API, reports and web specs → Each is flipped deliberately in the task that changes its subject, never deleted.
- **An e2e spec may rely on a large jump with one or two priors passing** → Each spec's value series is re-traced under the new rule before the suite is run.
- **The first period still says "not checked"** → QA is told that this is K4's subject, in the status file and the UAT catalogue.

## Migration Plan

No schema change and no data change. Deploy is the normal image deploy. Rollback is the previous image: under it, a verdict written by the new rule (count 1 or 2 with an average) keeps its flag and its submit gate if flagged, and reads as "not evaluated" if clean. Both are re-scored on their next save.

## Open Questions

- Should history older than a set number of periods be ignored? It applies to both tiers and is not a defect, so it is filed under Open questions in the status file and does not change this change.
