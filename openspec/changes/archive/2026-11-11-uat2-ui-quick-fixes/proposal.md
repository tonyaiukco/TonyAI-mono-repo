# Proposal

## Why

UAT round 2 found three screen defects that mislead users (QA report Rev02, section 2):

- **BUG-R2-06.** The dashboard matrix offers a blue "Click to view details" that cannot be clicked: it sits inside a hover tooltip. The volume correction factor that Data Entry asks for on a natural gas reading in m³ has no explanation beyond one line.
- **BUG-R2-09 (the legend only).** Nothing on screen says which geographies and reporting years the factor library covers. A user who picks UK sees "no factor" with no reason. UK factors are out of the pilot (Decisions 2026-11-05), so the fix here is the legend, not the factors.
- **BUG-R2-12.** A withdrawn record is described as counting "towards nothing" ("hiçbir şeye sayılmaz"), which QA reads as informal.

The owner triaged these as one change, next after the anomaly short-history check (Next up, 2026-11-11).

## What Changes

- **Dashboard matrix.** A matrix cell opens a click popover instead of navigating at once. The popover keeps the cell's summary and offers two real links:
  - **Open in Data Entry**: today's deep link, `subsidiaryId`, `category` and `year`.
  - **View record history**: Emissions, opened on its History tab and filtered to that subsidiary, category and year.
  
  The hover tooltip and its dead "Click to view details" line go.
- **Emissions.** The page accepts a page-local `tab=history` parameter so a link can open the History tab.
- **Data Entry: volume correction factor.** An ⓘ button beside the field opens four points:
  - the standard conditions (15 °C, 1013.25 mbar);
  - the arithmetic (value × factor = Sm³, then the Sm³ → energy chain at the net calorific value shown on the form);
  - the accepted range, 0.75–30;
  - that a bill already in Sm³ is entered as Sm³ with no factor.
  
  It says nothing about where the factor comes from.
- **New read-only endpoint `GET /api/v1/factors/coverage`.** It returns each geography and reporting year that the factor library can price, with the status of the releases behind it. It counts sealed, non-withdrawn releases, under the same placeholder policy the calculation engine applies.
- **Data Entry: factor coverage legend.** A legend under the "Factor geography" line is built from that endpoint:
  - Authoritative coverage is listed plainly.
  - Coverage that rests only on placeholder or fixture releases is labelled "placeholder — not authoritative".
  - The legend turns amber when the selected geography and year are outside coverage.
- **Copy, Turkish and English.** The dashboard cell's withdrawn line and the two Emissions withdrawn messages say the record is "not included in the calculation" ("hesaplamaya dahil edilmedi / edilmez").

**Out of scope.** These are filed under Open questions:

- removing UK from the geography pickers (`SELECTABLE_GEOGRAPHY_CODES`);
- the sealed edition label `TONYAI-EF-TR-UK-2026.11-AR6-SEALED`;
- loading UK factors and validating them in the engine;
- a link to the Review page, which takes no URL filters;
- the bulk upload's draft wording ("hiçbir toplama sayılmaz").

## Capabilities

### New Capabilities
- `completeness-dashboard`: the dashboard's data collection matrix, and what a cell offers when it is chosen.

### Modified Capabilities
- `emission-factor-library`: the library reports its own coverage (geography × reporting year × release status) to any signed-in user, under the pricing policy.
- `activity-data-entry`: Data Entry shows the factor coverage legend, and explains the volume correction factor for metered m³.
- `record-lifecycle`: the dashboard and Emissions describe a withdrawn record as not included in the calculation.

## Impact

- **API:** a new route on `CalculationsController` with a service method that reads `emission_factors` joined to `factor_releases`. It is read-only and needs no audit or RBAC, like `GET /factors`. There is no migration and no new table or grant.
- **Shared types:** a new `FactorCoverageDTO` in `@tonyai/shared-types`.
- **Web:**
  - `components/dashboard/status-cell.tsx`, `tracking-matrix.tsx`, `app/page.tsx` (link building);
  - `app/emissions/page.tsx` (the `tab` parameter);
  - `components/data-entry/record-inputs.tsx`, `app/data-entry/page.tsx`;
  - `lib/api.ts`;
  - the `dashboard`, `dataEntry` and `emissions` catalogues, en and tr.
- **Tests:**
  - the new API and web specs;
  - `e2e/analytics.spec.ts`: three cell-click flows now click a popover link;
  - `e2e/completeness-dashboard.spec.ts`: the accessible-name checks stay.
- **Docs:** `docs/api/endpoints.md`, `docs/md_docs/ui_spec.md` (the tooltip rule), and the status file.
- **Review:** the change adds a factor-library read path and a shared-types contract, so `security-rls`, `qa-auditor` and `architect` review it before the PR.
