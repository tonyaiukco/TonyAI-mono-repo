# Tasks

## 1. Contract

- [x] 1.1 Shared-types, in its own first commit: `total`'s documented meaning (`index.ts`, `report-consistency.ts`), the Scope 3 count block on `EmissionsSummary`, numerator counts on `TargetProgressDTO` and `ReportingIntensityMetric`, the "not covered" flag on target progress, error codes `ncv_out_of_range` and `volume_correction_out_of_range`, gap code `no_included_obligation`, the 0.75 and 30 constants

## 2. Main total

- [x] 2.1 `addScope`, subsidiary totals and shares count Scope 1 and 2; `percentOfTotal` is 0 on Scope 3 rows; specs with calculated Scope 3 rows
- [x] 2.2 Target latest year and guard read Scope 1 and 2; a Scope 3 target returns empty progress with "not covered"; negative specs for a Scope 3 only year
- [x] 2.3 Intensity numerator and `uncalculatedRecordCount` read Scope 1 and 2; a Scope 3 only selection returns no metric
- [x] 2.4 Emissions page: the empty test, pie, contributors, treemap, percent dash, trend stack and Scope 3 only view; `hint3` copy; targets and intensity panel copy, TR and EN through `localise-ui`
- [x] 2.5 Update `reporting-context-reconciliation.int.spec.ts` and `targets.service.spec.ts` to prove the Scope 1+2 total across screens and reports

## 3. Placeholder warnings

- [x] 3.1 Dashboard warning from the summary's count; hidden when zero
- [x] 3.2 Target rows and intensity cards warn from their own numerator's counts; specs for a target reading another year and for a Scope 3 only placeholder

## 4. Live report line

- [x] 4.1 Live PDF and XLSX Scope 3 line state a non-authoritative count in TR and EN; specs prove issued output is unchanged

## 5. Input bounds

- [ ] 5.1 `naturalGasChain` refuses a typed NCV out of the scaled range and a volume factor out of 0.75–30; a release lacking a row answers `parameter_missing`; billed path and `rowsUsed` unchanged
- [ ] 5.2 Wire both codes through the error registry, status map, catalogues and bulk row mapping (read `bulk-upload.service.ts`'s mapping first); a bulk `8.250` is refused in the dry run
- [ ] 5.3 Update `calculations.service.spec.ts`'s extreme-value and missing-range cases; add boundary values, golden value and stale-draft specs; `docs/api/endpoints.md`, `docs/md_docs/calculation_logic.md`

## 6. Counted final

- [ ] 6.1 Extract `loadTrReleases()` and add `counted-final.int.spec.ts`: final with no gap, authoritative links, dataset, PDF, XLSX and CSV reconcile to the golden values

## 7. Final rule

- [ ] 7.1 `deriveIssuance` adds `no_included_obligation`; catalogues in `issuance-html`, `issuance-tables`, report and web messages
- [ ] 7.2 Migration replaces `report_issuances_guard` (code list and floor); inspect for the spurious DROP; `runtime-role` trigger body entry; guard specs for a direct write
- [ ] 7.3 Move `report-issuance.int.spec.ts`, `issuance-html`, `issuance-tables` and `e2e/report-issuances.spec.ts` to the new rule; a retained all-excluded dataset still issues as partial with its fingerprint intact; rewrite `docs/api/report-datasets.md`'s stale final paragraph

## 8. Web headers

- [ ] 8.1 Headers and the split CSP in `next.config.mjs`, with a config test
- [ ] 8.2 E2E: headers on `/login` and on a redirect; no report-only violation on dashboard, Emissions and Reports; `docs/architecture/security.md`

## 9. Boot

- [ ] 9.1 Extract the boot failure handler with a DB-free spec (flush before exit; exit 1 on flush failure or timeout; no connection string logged); update `flushSentry`'s comment; verify with the database down, Sentry on and off

## 10. Reviews and records

- [ ] 10.1 Typecheck, lint, `pnpm test`, `test:int`, the changed e2e specs, migration-diff
- [ ] 10.2 Fresh-eyes pass on the diff: `security-rls`, `qa-auditor`, `architect`, `data-factors`; separate trees; findings fixed or dispositioned
- [ ] 10.3 Planning file: status, ledger, Open questions closed, the job's scheduled run, Next up
- [ ] 10.4 Prepare the owner's read-only query for out-of-range hosted records, all-excluded finals and Scope 3 targets; runbook 03's preflight; open the PR

## After merge (owner)

- Owner runs the foundation plan and apply to re-pin `storage-verify`; Claude reads back the monitoring chain.
- Archive this change.
