# Tasks

## 1. The rule and the snapshot marker (BUG-17)

- [x] 1.1 Add the optional `pricedBy: 'refill'` to `RefrigerantTerm` and a `refrigerantTermMassKg(term)` helper in `packages/shared-types` (marked term gives `refillKg`, any other gives `leakedKg + refillKg`), with unit tests for a marked term, a sum-rule term with both masses, a no-refill term and a no-capacity term; verify `pnpm --filter @tonyai/shared-types test` passes
- [x] 1.2 Change `capacityMethod` in `apps/api/src/calculations/tr-rules.ts` to price each line by the helper and to write the marker only on a line with `capacityKg > 0` and `refillKg > 0`; add `capacityMethod` cases to `tr-rules.spec.ts` (refill replaces the estimate, mixed lines, no capacity, no refill, alternative rate with a refill, missing rate still refused); verify the spec passes
- [x] 1.3 Add the BUG-17 vector to `calculations.service.spec.ts` (HFC-227ea, 50 kg, 35 kg refill gives 126,000 kgCO2e and a marked term) beside golden value 9, which must pass unchanged; verify both pass
- [x] 1.4 Add a byte-identity test: for a no-refill record and for a no-capacity record, the snapshot the engine writes now deep-equals a fixture captured from `main` before 1.2, and `compareSnapshots` reads it as not stale; for a both-masses record it reads as stale with class `figure`; verify `snapshot-staleness.spec.ts` passes
- [x] 1.5 Add the vector to `apps/api/test/int/tr-factor-package.int.spec.ts` against the sealed TR release (126,000.0 kgCO2e), keeping the FM200 2,880.0 case and the `committedBefore` byte-identical check; verify the spec passes on `test:int`
- [x] 1.6 Add an integration case to `calculation-staleness.int.spec.ts`: a both-masses record submitted under the sum rule is refused `calculation_stale` at approve and changes nothing; a no-refill one is approved; verify it passes
- [x] 1.7 Correct the formula in `docs/md_docs/calculation_logic.md` (the rule, the 126.00 t vector, the unchanged golden value 9 and its owner name GV-8); verify no doc under `docs/md_docs` or `docs/api` still states `capacity × leak rate + refill` as the current rule (`grep`)

## 2. Report text for a refill-priced line

- [x] 2.1 Read the term's mass through the helper in `apps/api/src/common/calculation-inputs.ts` and print `inputsLineRefill` for a marked term, `inputsLine` otherwise; add the key to `reports/i18n/{en,tr}.json` and `report-issuances/i18n/{en,tr}.json`; verify the catalogue parity tests pass
- [x] 2.2 Extend `calculation-inputs.spec.ts`, `issuance-html.spec.ts`, `issuance-tables.spec.ts` and `report-columns-inputs.spec.ts` to verify marked lines in Turkish and English PDF and XLSX views, English live and issued CSV with their existing columns, and the existing wording for unmarked sum-rule, zero-refill and zero-capacity lines
- [x] 2.3 Set `ISSUANCE_RENDERER` to `tonyai-issuance-pdf-v6` and `ISSUED_TABLES_RENDERER` to `tonyai-issuance-tables-v6`, and update both version comments. Pin the PDF version and the issued workbook's Summary version in tests. Run `pnpm --filter @tonyai/api test`
- [x] 2.4 Update `docs/api/reports-and-issuance.md` and verify it names both calculation-inputs wordings, the locale per format, both v6 renderers and the retained PDF behavior

## 3. Re-pricing open drafts

- [x] 3.1 Add `reprice` to `AUDIT_ACTIONS` with its comment, the audit viewer's label in the EN and TR catalogues, and its handling in `apps/web/lib/audit-view.ts` where `rescore` is handled; verify `audit-view.spec.ts` and the message parity test pass
- [x] 3.2 Add `DraftRepriceService` under `apps/api/src/activity-records/` per design decision 4. Recompute outside the transaction and re-check status, period, inputs and current snapshot in the lifecycle lock protocol. Write calculation, anomaly verdict and one `reprice` audit row in the same transaction. In DB-free tests verify dry run, draft and rejected updates, identical-snapshot no-ops, `snapshot_changed`, locked periods, engine refusals, status or input changes, and separate reporting of sum-rule and unclassified review-queue candidates
- [x] 3.3 Add `draft-reprice.cli.ts` and the `draft-reprice` package script (dry run by default, `--apply`, `--allow-remote` required off loopback, unknown switches refused, exit code non-zero on a refusal); verify with a CLI spec for the switches and the remote guard
- [x] 3.4 Confirm the runtime role can do what the command needs (update `activity_records`, insert `audit_log`) by reading `packages/db/scripts/runtime-role.mjs`; verify no grant or migration is needed, or add the grant in a migration and to that script
- [x] 3.5 Add `apps/api/test/int/draft-reprice.int.spec.ts` and run it on `test:int`. Verify that applying to a draft and a rejected record writes one audit row each and that a re-priced draft submits. Synchronize two runs after reading the same draft and verify one write and one audit row. Verify locked-period skips and that approved, locked, voided, submitted and under-review records keep their snapshot, figure, anomaly columns and `updatedAt` with zero new audit rows. Include old and new review-queue snapshots and verify the trigger still refuses direct edits to approved snapshots
- [x] 3.6 Document command selection, switches, review-queue output and the dry-run-first order for hosted QA in `docs/development/commands.md`. Verify the documented dry run against the local database

## 4. Screen, template and ceiling wording

- [x] 4.1 Replace `dataEntry.inputs.equipmentHelp` in the EN and TR catalogues with the refill-or-estimate wording; verify `messages.spec.ts` parity passes and the text renders on Data Entry in both languages
- [x] 4.2 Reword the refill column note in `apps/api/src/bulk-upload/template-workbook.ts`; verify the template spec passes and the downloaded workbook shows the new note
- [x] 4.3 Correct the ceiling's rationale in the `REFRIGERANT_REFILL_RATIO` comment in `shared-types` and in `docs/md_docs/validation_anomaly_rules.md` (the refill is the line's whole leak; numbers unchanged); verify the ceiling specs pass untouched
- [x] 4.4 Rewrite the alternative-rate case in `e2e/data-entry-tr-inputs.spec.ts` to use no refill (10 kg at 50% gives 5 kg), and add a case where a refill of 1 kg on the same line previews and saves the figure for 1 kg whichever rate is chosen; verify the spec passes on capped built servers

## 5. Integration and records

- [x] 5.1 Run `pnpm typecheck`, `pnpm lint`, `pnpm build` and `pnpm test` on Node 22 and verify all pass with no new warnings
- [x] 5.2 Run `pnpm --filter @tonyai/api test:int` with CI rate limits and no other Vitest run, then `pnpm rls:probe` against the local stack. Verify both pass
- [x] 5.3 Against the running local API, preview HFC-227ea with 50 kg and 35 kg refill (126.00 tCO2e) and with 40 kg and no refill (2.88 tCO2e). Save a both-masses draft on the previous build, run the command as a dry run and with `--apply`, and verify the record and audit row. Verify that live reports and on-demand issuance exports render a retained unmarked sum-rule snapshot and a marked refill-rule snapshot correctly, and that download of a previously issued PDF returns its stored bytes
- [ ] 5.4 Run the fresh-eyes review pass on the diff before the PR: `security-rls` (can the command reach a committed record or another tenant's scope; the audit row; the remote guard), `qa-auditor` (the vectors, byte-identity, mutation of the rule and of the status check, stale handling) and `architect` (the `RefrigerantTerm` contract and the helper as the one reader), each in its own tree; verify every correctness, security or data-integrity finding is fixed and the rest are filed
- [ ] 5.5 Record the change in `docs/roadmap_docs/project_status_roadmap_phases.md` (Current status; Decisions: the refill rule, the marker, and the owner's two confirmations of 2026-11-24: `submitted` and `under_review` records are left to the stale refusal, and `rejected` counts as an open draft) and in `docs/roadmap_docs/Pilot_launch_v4.md` §9 (WP2's row; WP1's row with its merge and QA revision `ci90-1`); verify both name the PR

## Workflow follow-up

- Commit, push and open the PR only on the owner's word; the owner merges.
- Archive the change and sync its specs in the same PR when the owner asks, as for WP1.
- After the deploy: record WP2's QA revision in the sprint ledger; the owner releases the hosted QA run of `draft-reprice` (dry run first, then `--apply --allow-remote`).
- After the first marked snapshot write, apply the rollback rule in `design.md`: verify a fallback's report compatibility or fix forward.
- QA retests BUG-17 on the deployed revision with the 126.00 t vector and the unchanged GV-8.
