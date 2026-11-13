# Tasks

## 1. The activity-type word (design D1)

- [x] 1.1 In `apps/web/lib/vocabulary.ts`, add `activity(category, activityType): string | null` to `RecordWords` and `recordWordsOf`. Apply the rules in order:
  - an empty or null type returns `null`;
  - `UNSPECIFIED_ACTIVITY_TYPE` returns `dataEntry.notSpecifiedLegacy`;
  - a value in `recordActivityTypesFor(category)` whose `dataEntry.activityTypes.<value>` key the messages own returns that label;
  - anything else returns the stored value.

  Also add `categoryWithActivity(words, record)`, which returns `"Category (Label)"`, or the category alone when the label is `null`. Verify: `pnpm typecheck` passes with no hand-built `RecordWords` to fix.
- [x] 1.2 Add `apps/web/lib/vocabulary.spec.ts`, using `recordWordsFor("en")` and `recordWordsFor("tr")`. Cover:
  - Refrigerants with R-410A;
  - Fuel with diesel, in EN and TR;
  - a null type, and an empty-string type;
  - Fugitive Gas, which has no types;
  - a value outside its category's list, which is shown raw;
  - a type valid in another category but not this one, which is shown raw;
  - `unspecified`, in EN and TR;
  - `constructor` as a type, which is shown raw and never as a key path;
  - no empty brackets in any case.

  Verify: the web unit suite passes (`pnpm --filter web test`).

## 2. The `/review` screen (design D2, D3)

- [x] 2.1 In `apps/web/app/review/page.tsx`, render the queue row's Category cell text with `categoryWithActivity(recordWords, row)`. Keep the anomaly icon and the first-period marker in the same flex row, unchanged. Verify: typecheck passes, and the row reads "Refrigerants (R-410A)" against the local stack.
- [x] 2.2 Pass `categoryWithActivity(recordWords, selected)` as the `category` argument of the sheet title. Leave `sheet.title` unchanged in both catalogues. Verify: the title reads "Refrigerants (R-410A) · Annual 2026" in EN, and `lib/i18n/messages.spec.ts` and `turkish-views.spec.ts` still pass.

## 3. End-to-end and browser checks

- [x] 3.1 Recheck the existing `/review` e2e specs for exact-text matches on the Category cell or the sheet title, and adjust any that break:
  - `review-queue.spec.ts` and `review-queue-races.spec.ts`;
  - `anomaly-short-history.spec.ts` and `anomaly-typo-ceiling.spec.ts`;
  - `bounded-reads.spec.ts` and `data-entry-tr-inputs.spec.ts`;
  - `uat2-team-decisions.spec.ts`, `review-gate.spec.ts` and `admin-screens-turkish.spec.ts`.

  Verify: list each spec as checked, and say whether it changed.
- [x] 3.2 Add `e2e/review-shows-gas.spec.ts`, following the `e2e-flow` skill and its shared helpers (API token, safe period, evidence upload, teardown).
  - Setup: as `admin@` (TonyAI Mfg is outside `entry@`'s access set, and a consultant never enters data), create and submit, with evidence, two Refrigerants records of one site and year that differ only by gas (R-410A and R-32), plus one Fuel diesel record.
  - Checks, as `review@` in EN: the three rows read "Refrigerants (R-410A)", "Refrigerants (R-32)" and the Fuel row with its diesel label; opening the R-32 row gives a sheet title naming R-32.
  - Checks in TR: the same rows carry the Turkish labels, read from `apps/web/messages/tr/*.json`, never hard-coded.
  - Teardown removes what the spec created.

  Verify: the spec passes locally.
- [x] 3.3 Run the `/review` e2e set: the new spec and every spec in 3.1. Verify: all pass locally; `security-headers` is a known local-only failure and is not in this set.
- [x] 3.4 Browser check on the local stack, as `review@`, in EN and TR, at desktop width and at phone width (375 px):
  - the queue rows from 3.2 show their gas, and long labels wrap without overlapping the markers;
  - the sheet title names the gas.

  Verify: screenshots in the session scratchpad, findings noted in the PR's review section.

  Done 2026-11-13. EN and TR at 1280 px show the gas in the rows and the sheet title. At 375 px, `/review` cannot be used even with the sidebar collapsed: the content column stays narrow and the table is clipped. This is the screen's own layout, it predates this change, and it is filed under Open questions (4.2) rather than fixed under the pre-pilot rule.

## 4. Docs and status

- [x] 4.1 Update the docs that name what the review row shows or how record words resolve: `docs/architecture/` (the localisation doc, if it lists `RecordWords`' members) and `docs/development/testing.md` (if it lists e2e specs, add `review-shows-gas`). Verify: `grep -rn "RecordWords\|review-queue.spec" docs/` shows no stale list.
- [x] 4.2 In `docs/roadmap_docs/project_status_roadmap_phases.md`, make two entries:
  - in the Decisions log, "2026-11-13 (third)": the owner chose to show the activity type on `/review` for every typed category, not only Refrigerants, still under the pre-pilot exception of 2026-11-13 (second), item 3;
  - under Open questions, "Review shows gas follow-ups": consolidate Data Entry's local activity-label helpers (records-table, data-entry page ×2, bulk-upload-view) onto `categoryWithActivity` / `RecordWords.activity`. Records-table shows `unspecified` raw today.

  Verify: both entries are present; Current status and Next up are left for the archive PR.

## 5. Review and validation

- [x] 5.1 Run a fresh-eyes review by `qa-auditor`, given the branch, the diff range and this change's specs. Ask it to probe:
  - null, unknown and prototype-key types;
  - TR coverage;
  - the e2e teardown;
  - exact-text regressions in other specs.

  Fix any P1 or P2. File P3s under the Open questions entry from 4.2. Verify: the review's verified items and its findings are recorded for the PR body.

  Done 2026-11-13. `qa-auditor` found no P1 or P2. Fixed in this change: P3-1 (the `unspecified` scenario: legacy records store an empty type, which is now its own scenario), P3-3 (the e2e rows are tied to their subsidiary) and P3-5 (this task's author is `admin@`). Filed under Open questions: P3-2 (nested brackets), P3-4 (a `createCommittedRecord` leak that predates this change) and P3-6 (implicit values resolve differently on Data Entry and `/review`).
- [x] 5.2 Run the full local gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and `openspec validate uat2-review-shows-gas --strict`. Verify: all green, with the counts noted for the PR body.

## Workflow follow-up

- Commit, push and open a PR only on the owner's word. The owner reviews the branch first and merges; Claude Code never self-merges.
- After the merge, QA deploys automatically (image-affecting web change; no migration or preflight). QA rechecks the review queue with several refrigerant records of one facility.
- Archive PR: run `/opsx:archive` and sync the `record-lifecycle` delta. In the status file, add a Current status entry and mark Next up (7) done. The next item is LP7-07, which waits for G6; its CO2 part can come earlier only on the owner's word.
