# Design

## Context

See proposal.md for why. Measured on `ccfb9c4`:

- `addScope` (`emissions.service.ts`) adds every scope to `total`; target progress and intensity read that field. The dashboard and reports already use Scope 1+2 by their own means.
- The target guard counts all calculated records, so removing Scope 3 from `total` alone would turn a Scope 3 only year into "0 t, 100%, on track".
- `naturalGasChain` (`tr-rules.ts`) returns the billed path first, and the edited NCV path has no bound and `rowsUsed: []`.
- A final is derived in `deriveIssuance`, and `report_issuances_guard` holds a floor for every writer. An all-excluded boundary passes both.

The TR releases are sealed, so they cannot gain rows without a new edition. Retained datasets are bound by fingerprints and by K2's recheck at issuance.

## Goals / Non-Goals

**Goals:** every figure on a pilot screen means what its label says; a mistyped input is refused before it prices; no final without a figure.

**Non-Goals:** rewriting stored records or issued rows; Scope 3 methodology; the drawer's standing row; enforcing the full CSP in this PR.

## Decisions

**D1. `total` keeps its name and becomes Scope 1+2.** `addScope` stops adding Scope 3, which also corrects trends. `byCategory` keeps Scope 3 rows, because a Scope 3 filter needs them. Their `percentOfTotal` is 0 and the UI shows a dash. Rejected: a new field such as `scope12Total`, which leaves the misleading `total` for the next consumer; and `null`, which widens every consumer's type for no extra meaning.

**D2. Guards move with the total, in the same commit.** `EmissionsSummary` gains a Scope 3 count block beside its top-level counts, so targets and intensity can read Scope 1 and 2 counts by subtraction. `ReportInventorySummary` omits the block. The all-scope target's latest year excludes Scope 3. A Scope 3 target returns empty progress with a "not covered" flag. Intensity returns `metrics: []` for a Scope 3 only selection. Rejected: tracking Scope 3 targets against `totals.scope3` (owner decision).

**D3. Warnings count the figure's own records.** The dashboard reuses the summary's count through `nonAuthoritativeFigures`. `TargetProgressDTO` and `ReportingIntensityMetric` each carry their numerator's calculated and non-authoritative counts, because they read their own year and scope. Rejected: one page-level banner, the shape that mislabels today.

**D4. Bounds live in the calculation path, not the DTO.** The NCV range comes from loaded rows, so it needs no new edition. 0.75 and 30 are shared-types constants: the release is sealed and they are not factors. The DTO keeps its wide floor so a refusal is a coded calculation error, and the column CHECK stays so old rows stay readable. Only the typed NCV is checked. The billed GCV's derived NCV is not, because a valid bill at 10,427 derives 7,244. The edited path keeps `rowsUsed: []`, because adding rows would make every in-range draft read as stale.

**D5. The final rule sits above the dataset.** `deriveIssuance` adds `no_included_obligation` for an inventory with no obligations. `assessDataset` and `buildBoundarySnapshot` stay untouched, so fingerprints and K2 hold and no schema version is bumped. One migration replaces the guard function, which runs at insert only, with the new code and the floor. Rejected: failing an all-excluded boundary at capture, which breaks retained datasets and the agreed "named exclusion" examples.

**D6. The counted final is an integration spec.** `report-issuance.int.spec.ts` reuses its app and helpers, and a shared `loadTrReleases()` extracted from `tr-factor-package.int.spec.ts`, with a TR location in year 2025. `pricedCalculation` cannot price billed GCV, so the gas records store the engine's own figure for those parameters. ETKB's 2025 figure rests on its 2024 data year, which the spec pins as disclosed and not a gap. The rendered PDF has no parser here, so a spy on the renderer asserts its HTML, and the retained PDF is checked by hash and magic bytes. CSV, XLSX and dataset figures must equal the golden values: electricity 4,180.56 kWh → 1,814.36 kg; gas 73.953103 Sm³ → 140.37 kg. Figures derived from the release, not from the code under test.

**D7. E2E's final moves to partial.** e2e has no TR load and owns a fixture year, so `report-issuances.spec.ts` follows the new gap. A TR-loaded e2e final is added only if a year is free. Otherwise "Current final" rests on the integration spec and G4's hosted pass.

**D8. Split CSP in `next.config.mjs` `headers()`.** Enforced: `frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`. Report-only: `default-src 'self'`, scripts and styles `'self' 'unsafe-inline'`, images `'self' data: blob:`, `connect-src` for the API, Supabase and Sentry hosts as fixed at build. There is no report receiver, so violations are read from the browser console in e2e. Rejected: enforcing all now, which could break screens during QA round 2.

**D9. Boot catch extracted for a DB-free spec.** `bootstrap().catch` logs a cautious message, captures to Sentry, awaits the bounded `flushSentry`, and calls `process.exit(1)` whatever the flush does. Secrets are scrubbed by one helper for the log and Sentry's `beforeSend`, so a runtime error benefits too.

**D10. Added by the review pass.** The issuance guard's insert checks step aside in replica mode, so a dump holding an old all-excluded final restores with its `issued_at`. Issued PDFs and workbooks state how many counted figures use an earlier data year, and both renderers move to v3. The web also sets HSTS in production. A metric with records waiting for a figure keeps its card and shows no intensity, while the older `GET /intensity`, with no field to say so, leaves it out.

## Risks / Trade-offs

- [`total`'s meaning changes under existing readers] → sweep every consumer, pin Scope 3 rows in specs, and update the reconciliation fixture to prove the new total.
- [A declared target baseline may include Scope 3] → progress could look better or worse than real. Hosted data is synthetic today; record it for the pilot's onboarding.
- [An out-of-range open draft refuses at submit with `calculation_stale`, without naming why] → saving again names the bound. The pre-deploy query shows whether any exists.
- [A legitimate unusual value is refused] → the bounds are provisional and go to the external reviewer. A release can later carry them as rows.
- [The volume bound passes a tenfold slip inside its range] → recorded in Decisions; evidence review stays the control.
- [An old all-excluded final still reads "Current final"] → owner decision: retained, and superseded by the first counted final.
- [A report-only CSP catches nothing it does not enforce] → enforced after QA round 2, before the pen-test.
- [The TR load in integration is permanent, and spec order is not guaranteed] → `tr-factor-package` already has this property; the new spec reuses its idempotent load.

## Migration Plan

1. Before merge: read the job's scheduled run; run the read-only query for out-of-range hosted records (owner-run); runbook 03's owner preflight; e2e dispatch on the owner's word.
2. Merge deploys to QA: the migration replaces the guard function; no data is rewritten.
3. After merge: foundation plan and owner apply to re-pin `storage-verify`, then the monitoring readback.
4. Rollback: "Rollback QA" cannot cross a migration; the fallback is a forward fix.

## Open Questions

None that change what gets built. Unknown until read on hosted: whether any out-of-range record, any all-excluded final or any Scope 3 target exists on QA, and whether a report-only violation appears on hosted hosts.
