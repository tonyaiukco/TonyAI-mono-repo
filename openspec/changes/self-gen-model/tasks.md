# Tasks

## 1. Contract (shared-types)

- [x] 1.1 In `packages/shared-types/src/index.ts` add (design 2):
  - `GENERATION_TOPOLOGIES`, `ACCEPTED_GENERATION_TOPOLOGIES` and `SELF_GENERATION_SOURCES`, frozen, each with its type and type guard, following `CV_BASES`;
  - `ElectricityRecordParameters` (five optional `| null` fields), added to the `RecordParameters` union;
  - `recordParameterShape(category)`.

  Verify: `index.spec.ts` cases for each list, guard and category pass, and `pnpm typecheck` passes for every package.
- [x] 1.2 Add `selfGenerationIssue(parameters)` (design 3) with specs for:
  - null and an all-null block → no issue;
  - each missing required field, in the stated order;
  - topology `B` and `C`;
  - exports above, equal to and below the generation;
  - a block with the three required fields only.

  Verify: `pnpm --filter @tonyai/shared-types test` passes.
- [x] 1.3 Add `generationTopology`, `selfGenerationSource` and `selfGeneratedKwh` to `PARAMETERS_REQUIRED_INPUTS`, and add `errors.variants.parameters_required.<input>` for each to `apps/web/messages/{en,tr}/errors.json`, following the `localise-ui` skill (design 7). Verify: `apps/web/lib/i18n/messages.spec.ts` and `errors.spec.ts` pass, with a case per new input in both locales.

## 2. Database shape

- [x] 2.1 Add a hand-written migration that redefines `activity_records_parameters_check` with the Electricity branch of design 3, placed before `ELSE false`. Copy every other branch verbatim from `20261120120000_ng_kwh_cv_basis`, and state in the header that it is expand-only. Verify: `pnpm db:deploy` applies it on a database migrated to `main`, and a diff of the two definitions shows only the new branch.
- [x] 2.2 In `apps/api/test/int/record-write-guards.int.spec.ts` add direct-write cases:
  - accepted: a full block; the three required fields only; exports equal to the generation; optional fields as JSON null; an all-null block;
  - refused (SQLSTATE 23514): topology `B`, `C` and a number; an unknown source; a missing source, topology or generation; a negative generation; exports above the generation; a facility consumption of 0; an unknown key; a gas key on Electricity.

  Keep the existing "parameters on a category that takes none" case true by moving it to a category that still takes none, and update the accepted count. Verify: the spec passes (run per the memory notes: gate on `pgrep`, CI `RATE_*` env, `apps/api/.env`).
- [x] 2.3 Re-pin `activity_records_parameters_check` in `INTEGRITY_CHECKS` (`packages/db/scripts/runtime-role.mjs`) to the md5 measured on a freshly migrated database, and update its comment. Verify: `runtime-role.int.spec.ts` and `packages/db/scripts/runtime-role.spec.mjs` pass.
- [x] 2.4 Update `docs/architecture/data-model.md` (`activity_records.parameters`: the Electricity block and its CHECK rules). Verify: the row names the five fields and the all-or-nothing rule.

## 3. Engine and API

- [x] 3.1 In `record-parameters.dto.ts` add `ElectricityParametersDto` and make `recordParametersIssues` read `recordParameterShape` (design 3). Extend `activity-record-write.dto.spec.ts` and `calculation-input.dto.spec.ts`:
  - a valid block and a block of nulls pass;
  - topology `B` passes the DTO;
  - an unknown source, a negative number, a string number, an unknown key and a gas key fail with `record_parameters_invalid`;
  - parameters on a category with no shape still fail.

  Verify: `pnpm --filter api test` passes.
- [x] 3.2 In `calculations.service.ts` make the guard read the resolver and call `selfGenerationIssue` for an Electricity block in every geography (design 4), and build the snapshot inputs from exported name constants beside the engine (design 5). Leave the TR rule selection and the pricing branch untouched. Verify: typecheck passes and `git diff` shows no change to `normalize`'s call or to the gas and refrigerant branches.
- [x] 3.3 In `calculations.service.spec.ts` add a TR 2025 Electricity fixture at 0.434, labelled a fixture, and cases for:
  - each `parameters_required` input, `parameters_not_applicable` for `B` and `C`, and `record_parameters_invalid` for exports above generation, each with HTTP 400 and no factor lookup;
  - a valid block outside TR is not refused for its geography;
  - the blind-price table: figure, factor, conversion and scope equal the record's without a block, for kWh and MWh;
  - the snapshot inputs' names, order and origin, and `snapshotSchema` 3;
  - a record without a block keeps an empty input list.

  Verify: `pnpm --filter api test -- calculations.service` passes.
- [x] 3.4 In `activity-records.service.spec.ts` add cases:
  - a PATCH that omits `parameters` keeps the stored block;
  - a PATCH that changes the block recalculates;
  - a PATCH that moves the record to another category with the block is refused, and with `parameters: null` is accepted;
  - a create with a block stores it as sent.

  Verify: the spec passes.
- [x] 3.5 Add GV-SG-1 and GV-SG-2 to `apps/api/test/int/tr-factor-package.int.spec.ts` on the loaded TR releases (design 8): 260,400 kg; 260,400 kg + 969,167 kg = 1,229,567 kg; each ±0.5%, with the scope and the edition asserted, and the snapshot inputs of GV-SG-1. Verify: the int spec passes.
- [x] 3.6 Add a report test: a dataset holding an Electricity record with a block renders the same input text and appendix as the same record without one, and no renderer version changes (design 5). Verify: the reports spec passes.
- [x] 3.7 Add a bulk upload spec case: an Electricity row is accepted with no `parameters`, and the template has no self-generation column. Verify: `bulk-upload.service.spec.ts` and `template-workbook.spec.ts` pass.
- [x] 3.8 Update `docs/api/endpoints.md` (the record parameters and refusals paragraphs) and `docs/md_docs/calculation_logic.md` (Electricity: the block, never priced; GV-SG-1 and GV-SG-2 as restated by D5). Verify: both name the five fields, the three refusals and their status.

## 4. Web carries the block

- [x] 4.1 Add `selfGenerationFromRecord` to `apps/web/lib/record-inputs-view.ts` and make `gasInputsFromRecord`, `recordInputMode` and `readInputsLabel` take the category before the shape (design 2). Add specs with an Electricity record carrying a block for each reader. Verify: `pnpm --filter web test` passes.
- [x] 4.2 In `apps/web/app/data-entry/page.tsx` keep the opened or copied record's block in state and return it from `recordParameters` while the category is Electricity; clear it on a category change, a new record and reset (design 6). Verify: typecheck passes, and 4.3 proves the behaviour.
- [x] 4.3 Add `e2e/electricity-self-generation.spec.ts` with the `e2e-flow` skill: create a draft with a block through the API, then on Data Entry
  - edit the quantity and save → the block is unchanged when read back;
  - change the unit to MWh, re-enter and save → unchanged;
  - change the category to Natural Gas and save → saved, with no block;
  - a plain Electricity record still sends no parameters.

  Verify: the spec passes locally on built, capped servers (per the memory notes).

## 5. Integration and review

- [x] 5.1 Run `pnpm typecheck`, `pnpm build`, `pnpm test` and `pnpm lint` (ignoring `.claude/worktrees`), then `test:int` once. Verify: all pass, with the output recorded in the PR description.
- [x] 5.2 Exercise the live local API: create an Electricity record with a block, read it, PATCH it, and try each refusal. Verify: the statuses and codes match the spec deltas, and `audit_log` holds one row per mutation.
- [x] 5.3 Spawn `security-rls`, `qa-auditor` and `architect` in parallel on the branch diff, each in its own tree, with self-contained prompts. Ask what each verified. Fix correctness, security and data-integrity findings; file the rest under Open questions. Verify: each seat's report is summarised in the PR description.
- [x] 5.4 Update `docs/roadmap_docs/project_status_roadmap_phases.md`: LP4-07 `IN_PROGRESS` with this change, Next up, and LP4-06 closed once #342's deployment is read on live QA. Verify: Part A, the ledger row and the LP4-07 card agree.

## Workflow follow-up

- Open the PR on a `feat/self-gen-model` branch when the owner asks; the owner merges.
- After the merge: read the QA deployment's live state, then archive the change and record the PR in the planning file.
- Next change: `self-gen-form`.
