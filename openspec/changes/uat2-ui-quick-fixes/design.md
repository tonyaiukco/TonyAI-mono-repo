# Design

## Context

The proposal gives the motivation. The current state that shapes the approach:

- **The matrix cell.** `StatusCell` (`apps/web/components/dashboard/status-cell.tsx`) is a `<button>` wrapped in a Radix `Tooltip`.
  - Its click runs `onCategoryClick`, which `app/page.tsx` turns into `router.push('/data-entry?subsidiaryId&category&year')`.
  - The tooltip content holds the category, a status badge, counts, the withdrawn and uncalculated lines, and a blue `cell.details` paragraph that is not a link.
  - Five e2e selectors find cells by accessible-name prefix (`'TonyAI Energy Natural Gas'`), and three of them click to navigate (`e2e/analytics.spec.ts`).
- **Emissions.** The page reads `year`, `subsidiaryId`, `scope` and `category` through `useReportingContext`. Its tab is local state (`activeTab`, default `summary`).
  - History's ledger is filtered on the server by the context's category, together with the tab's own `historyCategory`.
  - Nothing sets the tab from the URL.
- **Factor pricing.**
  - It reads sealed releases (`SEALED`) whose status is in `LIVE_STATUSES` (authoritative, placeholder, fixture), or authoritative only when `FactorPolicy.allowPlaceholders` is false (`factor-lookup.ts`, `factor-policy.ts`).
  - The policy is frozen at boot and injected as `FACTOR_POLICY`.
  - `GET /factors` and `GET /factors/parameters` are read-only reference routes on `CalculationsController`, guarded only by the global `SupabaseAuthGuard`.
- **Reference values.** Data Entry takes its default NCV from `GET /factors/parameters`, so no form holds the NCV as a constant (`docs/api/endpoints.md`). The standard conditions are `STANDARD_REFERENCE_CONDITIONS = '15 °C, 101.325 kPa (ISO 13443)'` in shared-types; 101.325 kPa is 1013.25 mbar. The VCF bounds are `VOLUME_CORRECTION_FACTOR_MIN/MAX` (0.75 and 30).

## Goals / Non-Goals

**Goals:**
- Every link-styled text on the two screens works.
- The legend states coverage that is true in every environment, because it is read from the same rows and under the same policy as pricing.
- No number that the library or shared-types owns is typed into a catalogue string.

**Non-Goals:**
- Per-category coverage. The legend works at the level of geography × year. A category gap inside a covered year still surfaces as today's `no_factor` preview message.
- Any change to pricing, to the geography pickers or to factor data.

## Decisions

### D1. A Popover replaces the Tooltip, and the cell button becomes its trigger
- **How:**
  - `StatusCell` wraps the existing button in `PopoverTrigger asChild`; its `onClick` prop is gone (the trigger opens the popover), and its `aria-label` is unchanged in form, so the name prefix that e2e selects on survives.
  - `PopoverContent` holds the old tooltip body. The `cell.details` paragraph is replaced by two Next `<Link>`s, whose hrefs the parent passes in as `links: { dataEntry: string; history: string }`.
  - `onCategoryClick` becomes a `cellLinks(row, category)` prop. `matrixCellLinks` in `lib/dashboard-view.ts` is the one builder of both URLs, so the round-1 DASH-2 deep link keeps one owner; `app/page.tsx` supplies the grid's year and passes null when there is none.
- **Keyboard:** Radix Popover gives Enter/Space to open and Escape returning focus to the trigger. On open, focus goes to the first link (`onOpenAutoFocus`), so one more Enter reaches Data Entry.
- **Alternatives considered:**
  - Keeping the hover tooltip and adding a click popover. Two overlays on one trigger fight over focus and pointer events.
  - A HoverCard with links. It cannot be reached from the keyboard reliably, and it is a pointer-only affordance.
  - Navigating on click and putting the links in the tooltip. Tooltip content cannot be interacted with, which is the bug itself.

### D2. The History link uses the reporting-context keys plus a page-local `tab=history`
- **How:**
  - The URL is `/emissions?year=Y&subsidiaryId=S&category=C&tab=history`.
  - `year`, `subsidiaryId` and `category` are the existing `REPORTING_CONTEXT_KEYS`, so the context bar and the server-side ledger filter apply as they do today.
  - Emissions reads `tab` once on mount with `useSearchParams`. It accepts only `history` and ignores any other value, then initialises `activeTab`. The page does not write `tab` back to the URL; tab changes stay local, as now.
- **Why not add `tab` to the reporting context:** the context is shared by every page and describes *what* is reported. `tab` is one page's view state, and adding it to `@tonyai/shared-types` would widen a contract for a single page.

### D3. `GET /factors/coverage` is a grouped query under the injected policy
- **How:**
  - `CalculationsService.coverage()` runs one `groupBy` (or an equivalent `findMany` with `distinct`) over `emission_factors` on `(geographyCode, reportingYear, release.status)`.
  - It filters on `gas: CALCULATION_GAS`, `pricedMethodFilter()` and `release: { ...SEALED, status: { in: pricedStatuses(policy) } }`. `pricedStatuses` is exported from `factor-lookup.ts` and used by the lookup too, so the two cannot drift.
  - `pricedMethodFilter()`, also in `factor-lookup.ts`, admits each category only in the Scope 2 method the lookup reads it with (`scope2MethodFor`): location-based electricity, `not_applicable` everywhere else. A market-based row is legal to load but is never priced (D08), so a pair held only by market rows is not coverage, and an authoritative market row cannot hide a placeholder location one. The filter runs in the `where`, before `distinct`. (Added after the review of PR #305.) A row whose release comes back with a status the policy does not price (Prisma reads releases in a second query, so a withdrawal can race it) is skipped, never cast through.
  - It folds the rows into `FactorCoverageDTO = { entries: { geographyCode: string; reportingYear: number; statuses: ('authoritative'|'placeholder'|'fixture')[] }[] }`, sorted by geography and then year. The statuses come in a fixed order, authoritative first.
  - The route sits on `CalculationsController` next to `GET /factors/parameters` and declares no query DTO. A static route must be declared before any parameterised `factors/:x` route; none exists today.
- **Why on `CalculationsController`:** the policy is injected there already, and the route is reference data like its two neighbours. A new module would duplicate the policy wiring.
- **Why `statuses[]` and not one status:** a year can hold an authoritative release and a fixture together (in CI). The legend needs "is any of it authoritative" and "is all of it non-authoritative" without a second request.
- **Tenant scope:** the factor tables are global reference data with no tenant column, as are `GET /factors` and `/factors/parameters`. The response carries no factor value, release id, edition, reviewer or note.

### D4. The legend is a small client component fed once per page load
- **How:**
  - Data Entry fetches coverage once through `api.factorCoverage()`, alongside its other reference loads. `FactorCoverageLegend({ coverage, geography, year })` renders under the "Factor geography" line.
  - A pure view function, `coverageView(coverage, geography, year)`, in `apps/web/lib/`, sits beside the existing `*-view.ts` helpers. It returns the covered geographies with their year ranges (consecutive years collapsed, e.g. "2024–2026"), a `placeholder` flag per range, and `selected: 'authoritative' | 'placeholder' | 'uncovered'`. The Vitest spec targets this function.
  - The copy goes in `dataEntry.coverage.*`, en and tr, through the localise-ui skill. Years are formatted without grouping, and geography names come through the existing `geographyName`.
- **Failure:** a failed request omits the legend silently. It is advisory, and a toast on every Data Entry load would be noise. Data Entry's own error handling still covers 401/403 through its other calls.

### D5. The VCF explanation is an ⓘ button with a Popover in `ParameterNumberField`
- **How:**
  - `ParameterNumberField` gains an optional `info?: { label: string; content: ReactNode }`. When present, an icon `Button` (variant ghost, `aria-label` = `label`, from the catalogue) sits beside the `Label` and opens a `PopoverContent` holding `content` (`VolumeCorrectionInfo`). Only `NaturalGasInputs` passes it, and only for `cubic_metres`.
  - The four points are catalogue messages. The range comes in as ICU number params from `VOLUME_CORRECTION_FACTOR_MIN/MAX`, formatted by locale.
  - The NCV point names "the net calorific value above" with no number, because the number is release data.
  - The reference-conditions sentence is written per language ("15 °C and 1013.25 mbar" / "15 °C ve 1013,25 mbar"). `STANDARD_REFERENCE_CONDITIONS` is an English, kPa-worded string unfit for a Turkish UI. A spec pins `STANDARD_REFERENCE_CONDITIONS` to its current value, so a change to the constant fails a test and leads back to this copy.
- **Alternative considered:** interpolating the constant. It would print "101.325 kPa", which reads as one hundred thousand in Turkish number formatting.

### D6. Copy changes go through the catalogues only
The four withdrawn messages change in `dashboard.json` and `emissions.json`, en and tr. `cell.details` is deleted from both catalogues, since nothing renders it any more. The catalogue parity spec keeps en and tr aligned.

## Risks / Trade-offs

- **[A cell click no longer navigates]** Users from round 1 expect a click to go to Data Entry. → "Open in Data Entry" is the first link and takes the focus first, so a click and then Enter reach the same place. QA retests BUG-R2-06 against this flow.
- **[The e2e flows change]** The three click-to-navigate tests gain a step. The `completeness-dashboard.spec.ts` name assertions must stay untouched. → Update them in the same change. The full local e2e suite runs before the PR.
- **[Coverage is coarse]** TR 2026 is "covered" even if one category lacks a factor. → This is stated in Non-Goals and the legend copy says "factors are defined for". The per-record preview stays the authority for a specific category.
- **[Popover inside a scrolling table]** Radix portals the content, so the table's overflow does not clip it. → Check on the dashboard at a narrow width.
- **[The policy flag reaches the client indirectly]** A client can infer whether placeholders are allowed by seeing placeholder coverage. → Hosted environments hold no placeholder, and the flag is already logged at boot and visible through the preview's `placeholder_refused` code. Nothing new leaks.

## Migration Plan

There is no migration or data change. The change deploys with the web and API images. Rollback is a redeploy of the previous images; the new route has no caller in the old web.
