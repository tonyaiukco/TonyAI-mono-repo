# Tasks

This change is a decision record only. No task touches code, a migration, the API contract, a factor release or the UI. The build changes named in `design.md` (Migration Plan) carry the work.

## 1. Owner answers

- [x] 1.1 Put D1–D9 to the owner, each with its recommendation. For D1, ask for the v2.5 approvers' names and roles. Where an answer differs from the recommendation, rewrite that decision in `design.md` (choice, rationale, rejected alternative) and correct the draft requirements and the Migration Plan to match. Verify: every decision in `design.md` states the owner's answer, and no draft requirement contradicts it.

## 2. Fresh-eyes review of the decisions

- [x] 2.1 Ask a `data-factors`-seat reviewer to check D2 and D3 against `packages/db/factor-releases/tr-2026-11/ipcc.json` and `apps/api/src/calculations/tr-rules.ts`. The checks are:
  - the ratio 8,250 / 9,155 comes from rows the release already holds, with their sources;
  - the restated GV-NG-kWh-B (182.17 kg) and the unchanged A and C values follow from the net factor 0.20215548 kgCO2e/kWh;
  - the D3 counter-examples at GCV 8,100 and 10,427 are correct;
  - nothing in D2 or D3 needs a new edition.

  Fix every correctness finding in the design. Verify: the reviewer's list of what it checked and what it found is recorded for the PR body.
- [x] 2.2 Ask an `architect`-seat reviewer to check D4–D6 and D8 against `packages/shared-types/src/index.ts` (`CALCULATION_REFUSAL_STATUS`, `NaturalGasRecordParameters`, `scope2MethodFor`, `FIRST_PERIOD_CEILINGS`), `apps/api/src/calculations/calculations.service.ts` (the `parameters_not_applicable` guard, `assertTrGasUnit`) and the `emission-calculation` spec. The checks are:
  - the 404→422 move breaks no web flow that keys on status;
  - Electricity parameters fit the record-parameters JSON and its CHECK without a second scope on one record;
  - the GV-SG-2 two-record reading keeps the totals;
  - the K4 recorded fact holds.

  Fix every correctness finding in the design. File P3s under the status file's Open questions. Verify: the review is recorded for the PR body.

## 3. Status file

- [x] 3.1 Add a dated Decisions log entry (`docs/roadmap_docs/project_status_roadmap_phases.md`) with the owner's D1–D9 answers. It names this change and states the two v2.5 values it restates: GV-NG-kWh-B 182.17 kg, and GV-SG-2 as two records. Verify: the entry names `uat3-decisions` and every decision number.
- [x] 3.2 Add cards LP4-06 (natural gas kWh: `ng-kwh-engine`, `ng-kwh-form`) and LP4-07 (self-generation Case A: `self-gen-model`, `self-gen-form`) to B5's LP4 section. Add LP7-09 (market-based Scope 2, certificates, avoided emissions, Cases B/C) to LP7. Give each card a ledger row: LP4-06 and LP4-07 `BACKLOG`, depending on this change; LP7-09 `DEFERRED`, G6. If the owner moves v2.5 to LP7 under D1, all three become LP7 cards instead. Verify: each card links `design.md` and claims nothing the design does not decide.
- [x] 3.3 Update Next up with the change order from the Migration Plan. Add a Current status entry for this change, applying the ten-entry rule (move the oldest entries to Archive verbatim). Record the open items under Open questions: the external review of D3's formula, and S1's QA operation, which has no recorded run. Verify: Next up's head and Current status agree, and Current status holds at most ten entries.

## 4. Validation

- [x] 4.1 Run `openspec validate uat3-decisions --strict` and verify it passes with `skip_specs: true`.
- [x] 4.2 Check that every file path, symbol and release row named in `design.md` exists on the branch (`grep` for each). Check that `git diff --stat origin/main` lists only `openspec/changes/uat3-decisions/` and the status file, and that the Turkish reports under `docs/uat/` are not staged. Verify: no code, migration, `docs/api`, factor-release or `docs/uat/` file is in the diff.

## Workflow follow-up

- Branch `chore/uat3-decisions` off `origin/main`. Commit and push only on the owner's word. The PR is docs-only, so the QA deploy skips it, and the owner merges.
- Archive the change (`/opsx:archive`; no specs to sync), in the same PR before merge, because nothing deploys. The new cards then link the archived path.
- Next: `/opsx:propose uat3-ui-polish` (D9) and `/opsx:propose calc-refusal-422` (D4) from fresh branches off `origin/main`.
