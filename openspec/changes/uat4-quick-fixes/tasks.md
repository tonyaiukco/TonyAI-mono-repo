# Tasks

## 1. Default icon (BUG-10)

- [x] 1.1 Add `apps/web/app/favicon.ico` built from the existing 32 px mark; verify with a built web server that `GET /favicon.ico` answers 200 with an icon content type for a client with no cookies
- [x] 1.2 Add an e2e case (signed-out request to `/favicon.ico` is 200, not a redirect) and verify it passes

## 2. Gas basis default and wording (BUG-11)

- [x] 2.1 Add `effectiveGasBasis` to `lib/record-inputs-view.ts` with unit tests: null gives gross, a held net or gross is returned as held; verify `record-inputs-view.spec.ts` passes
- [x] 2.2 Read the effective basis in Data Entry for the choice, the preview request and the save; verify by unit or component test that a new TR kWh record with no click sends `cvBasis` `gross`, and that an opened record with stored net sends net
- [x] 2.3 Reorder the choice to gross first and replace the labels and help text in the EN and TR `dataEntry` catalogues (unit in the label); verify `messages.spec.ts` parity passes and the two labels render for kWh and MWh
- [x] 2.4 Rewrite `e2e/natural-gas-energy-bill.spec.ts` for the new behaviour (gross preselected, 182.17 kg previewed without a click, saved as gross, net still selectable, UK copy moved to TR lands on gross, back-to-Türkiye lands on gross) and verify the spec passes on built servers
- [x] 2.5 Run a `qa-auditor` pass on this group's diff, asking it to find any path where the form sends net without the author or the record choosing it; verify its findings are fixed or filed

## 3. Invoice number and supplier (BUG-16)

- [x] 3.1 Add the two key names, their limits and `recordSupplier` to `@tonyai/shared-types` with unit tests (Electricity reads `utility_provider`, others read `supplier`); verify the shared-types suite passes
- [x] 3.2 Validate the two keys on `input` in the create and update DTOs (string, trimmed, 64 and 200, empty stored as absent) with DTO spec cases for accepted, too long, wrong type and untouched other keys; verify the API unit suite passes
- [x] 3.3 Add `invoice_no` and `supplier` to the context field sets (Electricity: `invoice_no` only) with EN and TR labels and placeholders; verify `context-fields.spec.ts` and catalogue parity pass
- [x] 3.4 Show Invoice number and Supplier on the review sheet when present, through `lib/review-view.ts`, with unit tests for both, Electricity and neither; verify `review-view.spec.ts` passes
- [x] 3.5 Document the two `input` keys in `docs/api/endpoints.md`; verify the documented limits match the shared constants
- [x] 3.6 Add an e2e case: enter both on a Mobile Combustion draft, save, reopen (Additional context open, values shown), submit, and see both on the review sheet with the tCO₂e unchanged; verify it passes

## 4. Way to the entries from the top (BUG-15, screen part)

- [x] 4.1 Add the header control with the record count and its empty wording (EN and TR), scrolling to and focusing the records table heading, honouring reduced motion; verify by component test that the count follows the total and the handler focuses the heading
- [x] 4.2 Add an e2e case: with records present, use the control and assert the table heading is in the viewport and focused, and that typed form values are unchanged; verify it passes

## 5. Integration and records

- [x] 5.1 Run `pnpm typecheck`, `pnpm lint` and `pnpm test`; verify all pass with no new warnings
- [x] 5.2 Run the touched e2e specs on capped built servers and check the four fixes in the browser in TR and EN; verify BUG-09's toggle still works on sign-in and set-password
- [x] 5.3 Record the change in `docs/roadmap_docs/project_status_roadmap_phases.md` (Current status, Decisions: the basis default reverses `ng-kwh-form`) and set WP1's row in `docs/roadmap_docs/Pilot_launch_v4.md`; verify both name the PR

## Workflow follow-up

- Open the PR for the owner to merge; QA retests BUG-09, BUG-10, BUG-11, BUG-15 (screen part) and BUG-16 on the deployed revision.
- Archive the change after the merge and record the QA revision in the sprint ledger.
