# Tasks

## 1. Contract: the rule and its documents

- [x] 1.1 In `packages/shared-types/src/index.ts`, add `ANOMALY_MIN_PRIORS = 1` beside `ANOMALY_BASELINE_PERIODS`, and make `computeAnomalyVerdict` evaluate when the window holds at least that many figures (design D1, D3, D5). A zero average with one or two figures is stored as average 0 with its count. Verify with `pnpm typecheck`.
- [x] 1.2 Change `isAnomalyEvaluated` to "count at least `ANOMALY_MIN_PRIORS`, average neither null nor zero". Add `anomalyBasis(record)` (`full`, `limited` or `null`) and `isLegacyShortWindowVerdict(record)` (count 1 or 2 with a null average), following the table in design D4. Verify with `pnpm typecheck`.
- [x] 1.3 Rewrite the JSDoc of the constants, `AnomalyVerdict`, `computeAnomalyVerdict`, `isAnomalyEvaluated` and the verdict fields on the record DTO, and the three column comments in `packages/db/prisma/schema.prisma`, so that none says "non-null only when the count is 3" or "0..2: the rule did not run". Verify that `pnpm --filter @tonyai/db exec prisma migrate diff` (or the repo's migration-diff gate) reports no schema change.
- [x] 1.4 Update `packages/shared-types/src/index.spec.ts`:
  - One prior of 10: 16 is flagged, 15 is not, 4 is flagged; count 1 and average 10 are returned.
  - Two priors of 8 and 12: 14 is not flagged; count 2, average 10.
  - A window of [10, null, 10] with an older 40 behind it gives count 2 and average 10.
  - One prior of 0 gives no flag, count 1, average 0, and `isAnomalyEvaluated` false.
  - No priors gives count 0 and a null average.
  - The existing three-prior cases are unchanged.
  - `anomalyBasis` and `isLegacyShortWindowVerdict` return each row of the D4 table.

  Flip the existing `it.each` over [0, 1, 2] "not evaluated" to cover only 0. Verify with `pnpm --filter @tonyai/shared-types test`, then rebuild `dist` (`pnpm --filter @tonyai/shared-types build`).
- [x] 1.5 Update the rule's documents: `docs/md_docs/validation_anomaly_rules.md` §4.1 (the short-history check, the one-period minimum, the superseded "three priors" paragraph and its 2026-08-27 deviation note), `docs/md_docs/calculation_logic.md` §7, `docs/md_docs/functional_requirements.md` §4.4 and the README's feature line. Verify by reading each against the `anomaly-check` spec: no document says three periods are required for the check to run.

## 2. API: gates, bulk paths, matrix and reports

- [x] 2.1 Update the comments in `apps/api/src/activity-records/activity-records.service.ts` around `detectAnomaly` and the `BASELINE_STATUSES` note that cites Decision 1 of 2026-08-27. No logic change is expected there; if one turns out to be needed, stop and update `design.md` first. Verify with `pnpm --filter @tonyai/api typecheck`.
- [x] 2.2 Update `apps/api/src/activity-records/activity-records.service.spec.ts`:
  - Flip the case that asserts 19.8 against two priors averaging 10 is not flagged: it is now flagged, with count 2 and average 10.
  - Submit of a record flagged on one prior with no variance reason is refused with `variance_reason_required`; nothing is updated and no audit row is written.
  - The same submit with a reason succeeds and stores the flag, count 1 and the average.
  - A draft saved as not checked is refused at submit after an earlier period is committed (the verdict is worked out again).
  - Approve of a flagged record with no reason is not refused for the anomaly.
  - A prior of 0 does not block submit.

  Verify with `pnpm --filter @tonyai/api test`.
- [x] 2.3 Update `apps/api/src/bulk-upload/bulk-upload.service.spec.ts`: a row that deviates by more than 50% from one committed prior carries `would_block_submit`; with a variance reason it does not. Add a `bulk-submit.service.spec.ts` case: January (10) and February (16) drafts of a new series sent together, February without a reason, gives January submitted and February refused for the variance reason. Verify with `pnpm --filter @tonyai/api test`.
- [x] 2.4 Update `apps/api/src/emissions/emissions.service.spec.ts`: a cell holding one record checked on 2 periods and one with no earlier period reports `notEvaluatedRecordCount` 1; a committed record flagged on 1 period turns its cell amber; a legacy verdict (count 2, null average) still counts as not checked. Verify with `pnpm --filter @tonyai/api test`.
- [x] 2.5 Change `anomalyCell` in `apps/api/src/reports/report-columns.ts`, the `anomaly` entry in `report-vocabulary.ts` and `apps/api/src/reports/i18n/{en,tr}.json` to the cells in design D6. The report row needs the stored average (or the derived basis) beside `anomalyEvaluated`; add it in `report-data.ts` and `reports.service.ts`. Update `reports.service.spec.ts` (the "2 of 3 priors" expectation) and `report-columns-inputs.spec.ts`, and add one case per D6 row in both languages. Verify with `pnpm --filter @tonyai/api test`.
- [x] 2.6 Add an integration case on the real database: in a fresh series, commit one period, create a second more than 50% away, and check that submit is refused without a reason and succeeds with one, storing count 1 and the average. Verify with `pnpm --filter @tonyai/api test:int` (CI rate-limit environment set; wait until no other vitest run is active).
- [x] 2.7 Update `docs/api/endpoints.md` (the anomaly fields and the submit refusal now cover one or two earlier periods) and `.claude/skills/workflow-gate/SKILL.md` (its anomaly-baseline line). Verify that each names the one-period minimum and no longer says three periods are required.

## 3. Database scripts and seed

- [x] 3.1 Change `rollingBaseline` in `packages/db/prisma/seed.ts` to average one to three figures through the contract's constants (design D8), and update the guard messages that cite "VAR §4.1 needs 3". Verify with `pnpm --filter @tonyai/db typecheck`.
- [x] 3.2 In `packages/db/scripts/anomaly-probe.mjs`, set the minimum to one period, reword section 3 ("thin" records are now checked on limited history), and add a section that lists legacy short-window verdicts on committed records as a known difference. They do not appear under drift and do not change the exit code (design D7). Verify with the probe's own spec, or add one beside it.
- [x] 3.3 In `packages/db/scripts/anomaly-recompute.lib.mjs`, leave a legacy short-window verdict alone on a submitted, under-review, approved or locked record and do not count it as unrepaired; re-score it on a draft or a rejected record. Update `anomaly-recompute.lib.spec.mjs` (its two-prior cases) and add cases for each status. Verify with `pnpm --filter @tonyai/db test`.
- [x] 3.4 Run `pnpm db:seed` twice against the local database, then `pnpm anomaly:probe` and `pnpm rls:probe`. Verify that the seed succeeds both times with the same record counts, that the probe reports no drift, and record how many seeded records are now checked on limited history and whether any is flagged.

## 4. Web: the statement and its copy

- [x] 4.1 In `apps/web/lib/anomaly-view.ts`, branch on `anomalyBasis` and `isLegacyShortWindowVerdict` for the six states in design D6, keeping the three tones. Add the keys to `apps/web/messages/{en,tr}/anomaly.json`: flagged on limited history, clean on limited history (with its own headline), no history without "needs 3 periods", scored before the short-history check, and the reworded matrix note. Follow the `localise-ui` skill. Verify with `pnpm --filter @tonyai/web typecheck`.
- [x] 4.2 Update `apps/web/lib/anomaly-view.spec.ts` and `apps/web/lib/i18n/turkish-views.spec.ts`: one case per D6 state in EN and TR, with the period count and the average in the sentence, and the singular form for 1 period. Verify with `pnpm --filter @tonyai/web test`.
- [x] 4.3 Read the call sites that render the statement or its copy (`apps/web/app/data-entry/page.tsx`, `apps/web/app/review/page.tsx`, `apps/web/app/emissions/page.tsx`, the dashboard alert in `apps/web/lib/dashboard-view.ts`, and the anomaly strings in `dataEntry.json`, `emissions.json`, `dashboard.json` and `errors.json`). Fix any string that says three periods or implies a full-history basis; update the stale comment in `apps/web/lib/bulk-submit-view.ts` and its spec. Verify with `pnpm --filter @tonyai/web test` and `pnpm lint`.
- [x] 4.4 On the running app (built, capped single-process servers, not full `pnpm dev`), enter the second period of a new series more than 50% from the first. Verify that Data Entry shows the limited-history flag with the average, refuses submit without a reason and accepts it with one, that a third period within range shows the limited-history note, and that the reviewer sees the same statement in the review queue in English and in Turkish. Done through `e2e/anomaly-short-history.spec.ts` (author `admin@tonyai.local`, reviewer `review@tonyai.local`); Data Entry's Turkish copy is covered by the catalogue tests of 4.2, not on screen.

## 5. End-to-end and UAT

- [x] 5.1 Re-trace the value series of every e2e spec that commits two or more periods of one series (`gates.spec.ts`, `review-queue.spec.ts`, `drafts-bulk-submit-evidence.spec.ts`, `bulk-submit-refusals.spec.ts`, `void-record.spec.ts`, `data-entry-happy.spec.ts`) under the one-period minimum. Fix any record that would now be flagged without a reason, and correct the comments that say the rule does not run with two priors. Verify by listing each spec's series and its deviations in the pull request description.
- [x] 5.2 Add an e2e flow in a subsidiary, category and period lane no other spec uses or locks (check `lockPeriod` and the subsidiary across `e2e/` first): commit one period, enter the next more than 50% away, see the limited-history flag, be refused without a reason, submit with one, and see the statement in the review queue. Follow the `e2e-flow` skill. Verify by running the new spec and the specs changed in 5.1 locally on prebuilt capped servers, with the rate-limit environment raised. `security-headers` and `data-entry-happy` are known to fail locally for unrelated reasons.
- [x] 5.3 Update `.claude/skills/e2e-flow/SKILL.md` (its lines on the three-prior baseline and safe periods) and `docs/uat/uat_round2.md` (ANOM-01, 02, 06 and 07: ANOM-02's expected text changes, and a new case for the limited-history flag; state that the first period is still not checked and belongs to K4). Verify that each case's expected text matches the catalogue strings.

## 6. Integration, review and records

- [x] 6.1 Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` from the repository root. Verify that all four pass, and report any failure with its output.
- [ ] 6.2 Commit, then run the fresh-eyes review pass in parallel, each seat in its own copy of the tree: `security-rls` (the submit gate cannot be passed without a reason on limited history; tenant scoping of the history query is unchanged), `qa-auditor` (the D4 table, the flipped assertions, mutation of the minimum and the threshold) and `architect` (the contract surface: constants, predicates, no DTO change). Only one seat runs `test:int`. Verify by recording what each seat verified and resolving every correctness, security or data-integrity finding; file the rest under Open questions.
- [ ] 6.3 Update `docs/roadmap_docs/project_status_roadmap_phases.md`: Current status and Next up; a Decisions entry for 2026-11-11 with the seven decisions, stating that it supersedes Decision 1 of 2026-08-27 and keeps Decision 2; Open questions for the look-back limit, stale stored verdicts after an earlier period changes, and the unmeasured hosted QA count; and the note for QA that the first period stays unchecked until K4. Verify that the file names this change and the pull request once it exists.

## Workflow follow-up

- Open the pull request from `feat/uat2-anomaly-tier2` when the owner asks; the owner merges.
- Before the QA deploy, count the hosted QA records with one or two earlier periods with `anomaly:probe` (read-only), on the owner's word.
- Dispatch the full e2e workflow only when the owner asks.
- Archive the change after merge and deploy, which creates `openspec/specs/anomaly-check/spec.md`, and record the archive in the status file.
