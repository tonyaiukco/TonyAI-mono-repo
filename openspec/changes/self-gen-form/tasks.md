# Tasks

## 1. Contract (shared-types)

- [x] 1.1 Branch `feat/self-gen-form` from an up-to-date `main` (fetch first; in a fresh worktree run `pnpm install` and `pnpm --filter @tonyai/db exec prisma generate`). Verify: `pnpm typecheck` passes before any edit.
- [x] 1.2 Move `SELF_GENERATED_KWH_INPUT`, `EXPORTED_TO_GRID_KWH_INPUT`, `FACILITY_CONSUMPTION_KWH_INPUT` and `GROSS_TO_NET_RATIO_INPUT` to `packages/shared-types/src/index.ts` with their `satisfies` checks (design 9). Import them from there in `apps/api/src/calculations/self-generation.ts`, `tr-rules.ts`, `tr-rules.spec.ts` and `calculations.service.spec.ts`, with no re-export; read `GROSS_TO_NET_RATIO_INPUT` in `apps/web/lib/conversion-view.ts`. Verify: `grep -rn "'grossToNetRatio'" apps/web/lib apps/api/src/calculations` finds no definition or comparison outside shared-types, and `pnpm typecheck` and the api, web and shared-types unit suites pass with no expectation changed.
- [x] 1.3 Add `ENERGY_BALANCE_TOLERANCE` (0.05) and `selfGenerationBalance(importValue, importUnit, block)` (design 5), with `index.spec.ts` cases for:
  - every scenario of the delta's *An energy balance gap warns and never blocks* (balanced, above 5%, exactly 5%, a netted figure, MWh, generation above consumption, no facility consumption);
  - null for no block, no generated kWh, no quantity, and a unit with no kWh route;
  - an expected import of exactly 0 with an import of 0 (no warning) and above 0 (warning).

  Verify: `pnpm --filter @tonyai/shared-types test` passes.
- [x] 1.4 Add the source-to-fuel-record map and the `generationFuelRecord` value list, type and guard (design 6), with specs that every `SELF_GENERATION_SOURCES` entry has a map entry, that the fuel entries name a category in `CATEGORIES` and, for diesel, a type in `CATEGORY_ACTIVITY_TYPES.Fuel`. Verify: the shared-types suite passes.
- [x] 1.5 Add `generationFuelRecord` to `ActivityRecordDTO`, required and nullable, with a comment that it is resolved at read time and never stored. Reword the `seenUpdatedAt` doc comment (design 11). Verify: `pnpm typecheck` fails only on places that build an `ActivityRecordDTO`; list them for 2.2 and 3.x.

## 2. API: the fuel-record state

- [x] 2.1 Add the lookup helper beside `apps/api/src/activity-records/closed-periods.ts` (design 6): no query when no record needs one; otherwise one `findMany` with one `OR` branch per distinct subsidiary, location, year and fuel record, `status` not voided, bounded by the accessible subsidiary ids. Add a DB-free spec with a stubbed Prisma for:
  - no Electricity record with a fuel source → no query at all;
  - two records of one site and year → one branch;
  - the `where` carries each record's own `subsidiaryId`, the accessible set, `locationId` null as null, and the voided exclusion;
  - `natural_gas_chp` asks for Natural Gas with a null type, `diesel_generator` for Fuel `diesel`;
  - a block of nulls, solar and wind → no state.

  Verify: `pnpm --filter api test -- generation-fuel` passes.
- [x] 2.2 Pass the state through `toDTO` and add the field to `ResolvedRecordFields`; resolve it in `listPage` (one query for the page), `get`, create, update and the status transition, and in any other caller the typecheck names (bulk submit). Extend `activity-records.service.spec.ts`: each of those answers carries `present`, `missing` or null as the stub decides; the audit row written by a create and an update holds no `generationFuelRecord`. Verify: `pnpm --filter api test` and `pnpm typecheck` pass.
- [x] 2.3 Add `apps/api/test/int/generation-fuel-record.int.spec.ts` against Postgres, one case per scenario of the delta's *A record read states whether a fuel-sourced block has its fuel record*: the same site with a monthly gas draft (present); none; another site; whole company against a site, both ways; a voided record; another year; another subsidiary of the same organisation and of another organisation, read by a user who can access both; Fuel diesel present and Mobile Combustion diesel alone missing; solar null; the list page and a review transition's answer. Verify: the spec passes, run alone with `-t` (memory notes: wait until no other vitest runs, CI `RATE_*` env, `apps/api/.env`).
- [x] 2.4 Reword `EditVersionRequiredError`'s rationale and the comment at its throw site (design 11); leave the message and the rule. Verify: `grep -rn "no screen\|on no screen\|shows yet" apps/api/src packages/shared-types/src` finds nothing, and the existing version specs pass unchanged.
- [x] 2.5 Update `docs/api/endpoints.md`: the record object's `generationFuelRecord` with its match rule and that it blocks nothing; the self-generation paragraph, which must no longer imply the block is invisible. Verify: the paragraph names the three values and D5's four match conditions.

## 3. Data Entry: the section

- [x] 3.1 In `apps/web/lib/record-inputs-view.ts` add the section's form state type, its reading from a record, the block it sends and its issue (design 3 and 4); remove `selfGenerationToSend` and `editLeavesParametersToServer` with their specs; reword the three comments (design 11). Add specs for:
  - a round trip, record → form → block, for the three required fields only, optional fields null, and all five;
  - no source → null block; a source → topology `A` added;
  - each issue in the design's order: an unread field, a negative generation, a negative export, a facility consumption of 0, the generated kWh missing, exports above and equal to generation;
  - a block of nulls and a non-Electricity record read as an empty form.

  Verify: `pnpm --filter web test -- record-inputs-view` passes.
- [x] 3.2 Add the copy with the `localise-ui` skill, EN and TR, under `dataEntry.inputs.selfGeneration`: the section title, the source label and its five options, the three field labels with units, the Case A statement, the import statement (D8), one sentence per issue, the two fuel reminders, the balance warning with both figures as arguments, and the category-move notice. Verify: `apps/web/lib/i18n/messages.spec.ts` passes (key parity, arguments, nothing untranslated).
- [x] 3.3 Add `SelfGenerationInputs` to `apps/web/components/data-entry/record-inputs.tsx` (design 3): the source select, the three `ParameterNumberField`s keyed on the epoch, the two statements, the issue sentence (`role="status"`, `aria-invalid` on the field it concerns), the reminder for a fuel source and the balance warning. Give each a `data-testid`. Verify: typecheck passes; 3.6 and group 5 prove the behaviour.
- [x] 3.4 Wire the page (`apps/web/app/data-entry/page.tsx`, design 1, 2 and 4):
  - one state for the section, filled in `fillForm` and the copy prefill, emptied in `resetForm`, kept through a category change;
  - `recordParameters` builds the block from it while the category's shape is `electricity`;
  - the edit body always carries `parameters`;
  - the issue joins `hasValidInput`;
  - `selfGenerationBalance` is called with the form's quantity, unit and block;
  - the component is mounted after `EquipmentLines`.

  Verify: typecheck and lint pass, and `grep -n "editLeavesParametersToServer\|selfGenerationToSend" apps/web` finds nothing.
- [x] 3.5 Add the category-move notice (design 8): keep whether the opened record held a block, and show the line in Edit mode while the category's shape is not `electricity`. Reword the `ownSelfGeneration` comment or remove it with the state it described. Verify: a view-level spec for the predicate (edit mode × stored block × category) passes.
- [x] 3.6 Add the `record_changed` case to `saveErrorDescription` and its key to `SaveErrorKey`, with the EN and TR sentence (design 10). Extend `record-lifecycle-view.spec.ts`: `record_changed` gets the Data Entry sentence, `record_duplicate` and a 5xx keep theirs, and any other code keeps the generic description. Verify: the web suite passes.
- [ ] 3.7 Check the section in the browser on capped, built servers (memory notes: never the full `pnpm dev` beside Docker), EN and TR at 1280 px: a source opens the fields; each issue sentence; the reminder for both fuel sources; the balance warning with figures in the locale's format; the notice on a category move and its removal; a save, a reopen and a removal of the block. Verify: a screenshot per state, and the saved block read back through the API.

## 4. Review sheet

- [x] 4.1 Add `reviewSelfGeneration(record)` to `apps/web/lib/review-view.ts` (design 7) with specs: an Electricity record with a block; one without; a block of nulls; a Natural Gas record whose parameters happen to hold other keys. Verify: `pnpm --filter web test -- review-view` passes.
- [x] 4.2 Add the copy with `localise-ui`, EN and TR, under `review.sheet.selfGeneration`: the line labels, the source values, the missing-fuel-record notice for each fuel record (with the site and year as arguments), and the balance notice with both figures. Verify: `messages.spec.ts` passes.
- [x] 4.3 Show the lines and the two notices in `apps/web/app/review/page.tsx`, each with a `data-testid`, without touching the review actions' enablement. Verify: typecheck passes; `git diff` shows no change to the approve, reject or start-review handlers or their `disabled` conditions.

## 5. End to end

- [x] 5.1 Rework `e2e/electricity-self-generation.spec.ts` with the `e2e-flow` skill. The edit cases that assert `not.toHaveProperty('parameters')` now assert the body's block equals the form's; the three stale-form cases, the version-less client case and the three `078ca233` cases keep their outcomes. Reword the file's header comment. Verify: the file passes locally on built, capped servers with CI's `RATE_*` env.
- [x] 5.2 Add form cases to the same file, in its lane (grep `e2e/` for the site, the category and `lockPeriod` before adding a record):
  - a new record: choose solar, enter the generation, save → the stored block has topology `A`;
  - a source without a generation figure → no preview request is sent and the save buttons are disabled;
  - exports above generation hold the save; equal exports save;
  - an opened block is corrected and saved; the source set to none stores no block;
  - a CHP source shows the reminder and saves without a gas record;
  - a gap above 5% shows the warning and the record still saves;
  - a move to Natural Gas in Edit mode shows the notice, and the move back shows the block.

  Verify: the file passes, and each new test fails when its behaviour is disabled on the page (commit before any mutation; restore with `git checkout --`).
- [x] 5.3 Add review-sheet cases (in this file, or beside `e2e/review-shows-gas.spec.ts` if the lane fits better): a submitted Electricity record with a CHP block and no gas record shows the block and the missing-fuel notice and can be approved by the second super_admin; with a gas draft at the same site and year the notice is absent; a block with a balance gap shows the balance notice. Verify: the cases pass and delete every record they create.
- [x] 5.4 Run the neighbouring specs that share Data Entry and the review sheet: `natural-gas-energy-bill`, `record-edit`, `void-record`, `data-entry-tr-inputs`, `review-queue`, `review-shows-gas`. Verify: all pass.

## 6. Integration and review

- [ ] 6.1 Run `pnpm typecheck`, `pnpm build`, `pnpm test` and `pnpm lint` (ignoring `.claude/worktrees`), then the whole local e2e suite once. Verify: all pass, with the counts recorded for the PR description.
- [ ] 6.2 Exercise the live local API: list and read an Electricity record with a CHP block before a Natural Gas draft is created at its site, after it is created and after it is deleted, and read it as a user of another organisation. Verify: `generationFuelRecord` reads `missing`, `present`, then `missing` again, and the other organisation gets 404; `audit_log` holds no row for any read and no `generationFuelRecord` in any written row.
- [x] 6.3 Update `docs/md_docs/calculation_logic.md` (§2.3: the form, the energy balance rule with its 5% and its two warning conditions, the fuel-record notice, D8's import statement). Verify: the section states that neither the balance nor the notice blocks or changes a figure.
- [ ] 6.4 Spawn `security-rls`, `qa-auditor` and `architect` in parallel on the branch diff, each on its own `git archive` copy, with self-contained prompts; only one seat runs `test:int`. Ask what each verified. Probes to name: the lookup's scope (another organisation, an inaccessible subsidiary, the accessible-set filter removed by mutation); the form writing a block over a newer one; the save gate against the API's refusals; the DTO field on every answer. Fix correctness, security and data-integrity findings; file the rest under Open questions. Verify: each seat's report is summarised for the PR description.
- [ ] 6.5 Update `docs/roadmap_docs/project_status_roadmap_phases.md` in the same PR: a Current status entry (moving the oldest to Archive if it is the eleventh), the LP4-07 card's second box, the ledger row, Next up item 4, and Open questions, where the four `self-gen-model` review notes this change closes are removed (snapshot input names, the two comments, the category move, the `record_changed` sentence) and the design's two open questions are added. Verify: Part A, the ledger row and the LP4-07 card agree, and the other review notes are still filed.

## Workflow follow-up

- Open the PR from `feat/self-gen-form` when the owner asks; the owner merges.
- After the merge: read the QA deployment's live state, then archive the change and record the PR and the deploy in the planning file. LP4-07 closes with it.
