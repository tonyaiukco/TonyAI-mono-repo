# Proposal

## Why

The gate audit (Decisions 2026-11-09) found defects that would put a wrong or unlabelled figure in front of a pilot user. Emissions, target and intensity totals count Scope 3 beside banners saying it is not covered, a typed calorific value can be about 1,000× too low, and a report can read "final" with no figure in it. G3 cannot close until the total is fixed, and QA round 2 should test the corrected build.

## What Changes

- **Main total:** Emissions totals, shares and trends, target progress and intensity count Scope 1 and 2 only. Scope 3 stays recordable, and it is shown separately and labelled. `total` keeps its name, and its meaning changes. **BREAKING** for any reader that assumed Scope 3 was inside it.
- **Guards:** a target or intensity selection with no Scope 1 or 2 figure answers "no comparison" and never a fabricated 0 or 100%. A Scope 3 target shows "not covered".
- **Placeholder warnings:** the dashboard, each target row and each intensity card warn when their own figures rest on non-authoritative factors.
- **Live report line:** the live PDF's and XLSX's Scope 3 line states when its tonnes are not authoritative. Issued output keeps "Not covered" with no figure.
- **Input bounds:** a typed NCV outside the release's scaled range and a `volumeCorrectionFactor` outside 0.75–30 are refused with their own error codes. Both bounds are provisional until the external review (Decisions 2026-11-09 (8)).
- **Finals:** a final needs at least one included obligation. The database guard holds the same floor for every writer. Older all-excluded datasets stay issuable as partial, and issued rows stay as they are.
- **Proof:** an integration spec issues a counted final on the real TR releases and reconciles it across PDF, XLSX and CSV.
- **Web headers:** nosniff, frame protection, referrer and permissions policies, and a split CSP (structural directives enforced, the rest report-only).
- **Boot:** a failed API boot reports to Sentry when configured, then exits 1, with or without Sentry.

Not in this change, by owner decision: the Emissions record drawer's standing row, and tracking Scope 3 targets against a figure.

## Capabilities

### New Capabilities

- `inventory-totals`: what the main total counts, how Scope 3 is shown beside it, and how each screen labels non-authoritative figures.
- `report-finals`: what makes an issued report final, and what live and issued reports say about Scope 3.
- `web-response-security`: the security headers every web response carries.
- `service-startup`: how the API process ends when it cannot boot.

### Modified Capabilities

- `emission-calculation`: typed natural gas calorific and volume inputs gain bounds.

## Impact

- **API:** `emissions`, `targets`, `intensity`, `reports`, `report-issuances`, `calculations`, `bulk-upload` (through preview), `main.ts`.
- **Web:** Emissions page, dashboard, targets and intensity panels, Reports' issuance gaps, `next.config.mjs`, TR and EN catalogues.
- **Contract:** `@tonyai/shared-types` gains error codes, a gap code, bound constants and counts; `total`'s documented meaning changes. No report fingerprint or dataset schema changes.
- **Data:** one migration replaces the `report_issuances_guard` function. Stored records, snapshots and issued rows are not rewritten. Open drafts with an out-of-range value are refused at their next save or recompute.
- **Operations:** merging deploys to QA. Before merge: read the job's scheduled run, run a read-only query for out-of-range hosted records, and do runbook 03's owner preflight. After merge: re-pin `storage-verify`.
