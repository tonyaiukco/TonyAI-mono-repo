# Tasks

## 1. Contract and API: the factor coverage report

- [x] 1.1 Add `FactorCoverageEntry` and `FactorCoverageDTO` to `packages/shared-types/src/index.ts`, beside `ReleaseParametersDTO`. Each status is the live factor status union (`authoritative | placeholder | fixture`), never `withdrawn` (design D3). Verify with `pnpm --filter @tonyai/shared-types build` and `pnpm typecheck`.
- [x] 1.2 Add `CalculationsService.coverage()`, reading sealed releases under the injected `FactorPolicy` with the same status set as `factor-lookup.ts` (reuse `SEALED` and `LIVE_STATUSES`, no copy). Add `@Get('factors/coverage')` to `CalculationsController`. Verify with `pnpm --filter @tonyai/api typecheck`.
- [x] 1.3 Add cases to `apps/api/src/calculations/calculations.service.spec.ts`:
  - Placeholders refused: the query asks for authoritative only.
  - Placeholders allowed: the query asks for all three live statuses.
  - Rows for one geography and year with two statuses fold into one entry, authoritative first.
  - Entries are sorted by geography, then year.
  - An empty library gives `{ entries: [] }`.
  - The query selects no factor value, edition or release id.
  
  Verify with `pnpm --filter @tonyai/api test`.
- [x] 1.4 Add an integration case against the real local library: under each policy the report equals an oracle computed straight from SQL (so placeholder coverage is asserted wherever the database holds it); withdrawing every release behind one pair, inside a transaction that rolls back, removes that pair and keeps every pair another release still covers; withdrawing all releases empties the report. Verify with `pnpm --filter @tonyai/api test:int` (CI rate-limit environment set; wait until no other vitest run is active). If withdrawal cannot be exercised without a write to append-only tables, cover it in 1.3 and say so in the PR.
- [x] 1.5 Document `GET /factors/coverage` in `docs/api/endpoints.md`, next to `/factors/parameters`: the response shape, the policy rule, that withdrawn releases are excluded, and that it is reference data for any role. Verify by reading the entry against the `emission-factor-library` delta spec.

## 2. Dashboard: the cell popover and the History link

- [x] 2.1 In `apps/web/app/emissions/page.tsx`, read `tab` once with `useSearchParams` and start on History when it equals `history`, ignoring any other value (design D2). Verify with `pnpm --filter @tonyai/web typecheck`.
- [x] 2.2 Replace `onCategoryClick` with a `cellLinks(row, category)` builder in `apps/web/app/page.tsx`, returning the Data Entry and History URLs. Put the URL construction in a pure helper in `apps/web/lib/dashboard-view.ts` and add a Vitest case: both URLs carry `subsidiaryId`, `category` and `year`; History adds `tab=history` and goes to `/emissions`. Verify with `pnpm --filter @tonyai/web test`.
- [x] 2.3 In `components/dashboard/status-cell.tsx` and `tracking-matrix.tsx`, swap `Tooltip` for `Popover` (design D1). Keep the button's `aria-label` exactly as built today, move the summary into `PopoverContent`, and replace the `cell.details` paragraph with two `<Link>`s whose copy goes in new `dashboard.cell.openDataEntry` and `dashboard.cell.viewHistory` keys, en and tr (localise-ui skill). Delete `cell.details` from both catalogues. Verify with `pnpm --filter @tonyai/web typecheck` and `pnpm --filter @tonyai/web test` (catalogue parity).
- [x] 2.4 Update `e2e/analytics.spec.ts`. Its three cell-click tests click the cell, then "Open in Data Entry", and assert the same URLs and form state as today. Add one test: the History link lands on Emissions with the History tab selected and the category filter applied. Leave the accessible-name assertions in `e2e/completeness-dashboard.spec.ts` untouched. Verify by running these two specs locally on built servers.
- [x] 2.5 Change the "Hover" rule in `docs/md_docs/ui_spec.md` (§ around line 106), which says matrix cells show a "Click to view details" tooltip, to the click popover with its two links. Verify that no doc still prescribes a "Click to view details" tooltip (`grep -rn "Click to view details" docs/`).

## 3. Data Entry: the coverage legend and the VCF explanation

- [x] 3.1 Add `api.factorCoverage()` to `apps/web/lib/api.ts`, returning `FactorCoverageDTO`. Verify with `pnpm --filter @tonyai/web typecheck`.
- [x] 3.2 Add `coverageView(coverage, geography, year)` in `apps/web/lib/factor-coverage-view.ts` (design D4), with a Vitest spec covering:
  - consecutive years collapsing into one range;
  - a gap splitting a range;
  - placeholder-only ranges flagged;
  - a mixed authoritative and fixture year counted as authoritative;
  - the selected pair returning `authoritative`, `placeholder` or `uncovered`;
  - empty coverage.
  
  Verify with `pnpm --filter @tonyai/web test`.
- [x] 3.3 Render `FactorCoverageLegend` under the "Factor geography" line in `apps/web/app/data-entry/page.tsx`. Load coverage once with the page's reference data, omit the legend on failure, and turn the selected-pair line amber when it is uncovered. The copy goes in `dataEntry.factorCoverage.*` (not `coverage`, which reads as the invoice coverage panel), en and tr: TR "Emisyon faktörleri şu kapsamlar için tanımlıdır: …", the placeholder label "yer tutucu — resmi değil" and the uncovered line. Add a render spec in en and tr (the `record-inputs-view.spec.ts` pattern) for the pilot case and the uncovered UK case. Verify with `pnpm --filter @tonyai/web test`.
- [x] 3.4 Add `info?: ReactNode` to `ParameterNumberField` in `components/data-entry/record-inputs.tsx`, and pass the VCF explanation only from `NaturalGasInputs` for `cubic_metres` (design D5).
  - Four catalogue messages under `dataEntry.inputs.volumeCorrectionInfo.*`, en and tr.
  - The range comes from `VOLUME_CORRECTION_FACTOR_MIN/MAX` as locale-formatted params.
  - The NCV point carries no number.
  - The info button has a translated `aria-label`.
  
  Extend `apps/web/lib/record-inputs-view.spec.ts`: for m³ the info control renders and the range reads "0.75–30" / "0,75–30"; for Sm³ neither the field nor the control renders. Verify with `pnpm --filter @tonyai/web test`.
- [x] 3.5 Add a spec that pins `STANDARD_REFERENCE_CONDITIONS` to `'15 °C, 101.325 kPa (ISO 13443)'`, with a message pointing to `volumeCorrectionInfo` (design D5). Verify with `pnpm test`.

## 4. Withdrawn wording

- [x] 4.1 Change `dashboard.cell.withdrawnOne` and `withdrawnMany`, and in `emissions.json` the `withdrawnNoFigure` and `staysOnTrail` messages, to the agreed texts, en and tr (the `record-lifecycle` delta spec). Add a catalogue assertion that no tr `dashboard` or `emissions` message contains "hiçbir şeye sayılmaz". Verify with `pnpm --filter @tonyai/web test`, and check that `grep -rn "counts towards nothing\|count towards nothing" apps/web/messages e2e` finds nothing.

## 5. Integration checks, review and status

- [x] 5.1 Run the full gate from the repo root: `pnpm typecheck`, `pnpm build`, `pnpm test` and `pnpm lint` (with the worktree ignore pattern). Verify that all four are green.
- [x] 5.2 Run the full local e2e suite on capped built servers (the full-local-e2e recipe). Verify it is green, apart from any failure known on main, which must be shown to fail on main too.
- [x] 5.3 Check the behaviour in the running app (English and Turkish):
  - the dashboard cell popover, keyboard included, and both links;
  - the Data Entry legend for TR and UK;
  - the VCF ⓘ for m³;
  - the withdrawn line on a cell with a voided record.
  
  Verify with screenshots or Playwright evidence noted in the PR.
- [x] 5.4 Run the fresh-eyes review. Spawn `security-rls`, `qa-auditor` and `architect` in parallel on the branch diff, each in its own `git archive` copy, with only `qa-auditor` running `test:int`. Fix or file each finding. Verify that every seat reports what it verified.
- [x] 5.5 Update `docs/roadmap_docs/project_status_roadmap_phases.md`:
  - **Current status:** a new entry; move the oldest to Archive if there are more than ten.
  - **Next up:** move the UI quick fixes to done; BUG-R2-05 is next.
  - **Open questions:** UK in the geography pickers, the sealed `TR-UK` edition label, a Review page link from the matrix, and the bulk upload's draft wording.
  
  Verify with a diff read: Part A has no stale mention of these three bugs as pending.

## Workflow follow-up

- Commit, push and open the PR only on the owner's word, on branch `fix/uat2-ui-quick-fixes`. The QA report and the untracked `.claude/commands/` and `.claude/skills/openspec-*` stay out of the commit.
- After the merge and the QA deploy, tell QA that BUG-R2-06, the R2-09 legend and R2-12 can be retested.
- Archive the change with `/opsx:archive` once merged and deployed. Record the archive and the deploy in the status file.
