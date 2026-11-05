# TonyAI: API reporting context

> Moved from [`README.md`](../../README.md) on 2026-11-05 (OpenSpec change `refactor-readme`); the text is unchanged.

## Reporting context contract (LP3-02)

**PR A published the shared contract; the context summary, tracking-matrix,
intensity, report metadata and PDF/Excel/CSV routes are implemented, and N1
wired the dashboard, emissions (absolute and intensity) and reports screens to
them through one URL-carried context (below).** Existing routes and clients
retain their response shapes. The expanded `REPORTING_YEARS` list already affects
existing year selectors: the accepted range is **2000–2100 inclusive**, matching
the API's existing DTO bounds. `DEFAULT_REPORTING_YEAR` stays **2026** (D06),
independently of list order and calendar rollover. Selecting 2027 does not promise
factor coverage: D07 still refuses a calculation without its activity-year factor;
there is no "latest overall" fallback or recalculation of historical snapshots.

`ReportingContext` in `@tonyai/shared-types` requires `year` and optionally carries
`subsidiaryId`, `scope` and `category`. Omitted subsidiary means **all accessible
subsidiaries**, which may be less than the whole organisation. One subsidiary
includes its company- and site-attributed records; no company-only or individual
site selector is added. Scope and category combine with AND; a conflicting pair
is invalid. `isReportingYear` and `isReportingContext` validate values, not tenant
access or factor availability. APIs must recheck access on every request and keep
an inaccessible selection empty instead of broadening it to the accessible set.

The implementation must make the URL authoritative for this context across
navigation, refreshes and exports. Resolve **each field** in this order, scope and category as one pair: a valid,
explicit URL value; otherwise its remembered selection, if one exists; otherwise
`DEFAULT_REPORTING_YEAR` for year, all accessible subsidiaries for subsidiary,
and unfiltered scope/category. Write the resolved year into the canonical URL.
An invalid explicit URL value is refused, never replaced by remembered state or
a default; duplicate context keys and a resolved scope/category conflict are
also refused. Dashboard, absolute
emissions, intensity, the ledger and reports use the selected year. Explicit
historical comparisons may span years; targets retain their own baseline, target
and actual progress years and inherit only the subsidiary selection. Search,
record status, sort and export formatting remain view-local options. Clients
strip view-local `status`, `search`, `sort`, `limit` and `cursor`, but refuse a
defined `locationId`, `period` or `periodValue` (including null) before fetching:
silently dropping those would broaden the requested inventory.

**URL and screens (N1).** `apps/web/lib/reporting-context-url.ts` is the grammar:
`?year=2027&subsidiaryId=<id>|all&scope=1|2|3|all&category=<Category>|all`. Each
key is read from its raw text. An empty value, a repeated key, a leading zero
(`02027`, `01`), an id without the 8-4-4-4-12 hex shape, a wrong-case category or
an explicit scope/category conflict is refused: the screen names every refused
key, loads no context data and offers one explicit way out (the default
selection); it never substitutes a default or remembered value. `all` is the URL-only clear
value. The canonical URL carries the four keys once, in that order, then the
page's own keys. `useReportingContext` (`lib/use-reporting-context.ts`) resolves
each field (URL, then remembered, then default; scope and category together) and
writes the canonical URL with the History API, which Next's router follows at
once and without a server round trip — `router.replace` on load kept a route
fetch in flight, and `LocaleSync`'s `router.refresh()` after sign-in was lost
under it (any client navigation during that refresh still discards it; Open
questions). Each selection is a
history entry, so Back returns to the previous one. The remembered selection is
in memory only (`useReportingContextStore`), per user, cleared at every sign-in
and dropped on any Supabase auth event for another user or a sign-out (another
tab's included): a reload is the URL's job, and a sidebar link without a query inherits
the last selection. `ReportingContextBar` (year, subsidiary, scope, category; the
TR/EN `reportingContext` catalogue) never decides access: a selection outside the
caller's set stays selected as *Unavailable subsidiary*, and every context route
answers it empty.

The screens: the dashboard's Emissions Overview (summary and tracking matrix; its
deep links into Data Entry carry the selected year); the emissions summary,
breakdown and ledger (the selected year and subsidiary; scope and category filter
the ledger too); intensity (`reportingIntensity`, each metric disclosing how many
selected subsidiaries contribute and how many committed records have no usable
figure); and Reports (preview through `reportingSummary` and `reportingMeta`; an
export sends exactly the context the preview on screen was computed for and stays
disabled until that preview has loaded). Trends is the one explicit all-year
comparison: labelled *All years*, it inherits only the subsidiary. Targets
inherit only the subsidiary, and say so. A scope or category shows a *Filtered
view* notice on the dashboard and a *Filtered extract* notice on Reports
(follow-up (10) stays LP4-03's); with one subsidiary selected, the dashboard's
location count is that subsidiary's. Every load carries a sequence
token, so an older answer cannot replace a newer selection; a load that fails
clears the previous selection's figures (and the intensity panel's deletable
denominators) instead of leaving them under the new bar; a mutation's follow-up
refresh (a target or denominator saved or removed, a withdrawal) reads the
selection on screen when it completes, not the one it started in; and the
dashboard's subsidiary drawer closes on a new selection, its row always read
from the matrix on screen. Data Entry deep links read their year by the same rule; an invalid one
refuses the whole link with a visible message and applies none of it (the form
keeps its own defaults). The legacy annual clients (`reportMeta`,
`downloadReport`, `trackingMatrix`, `intensity`) are `@deprecated`; no screen
calls them.

**Bounds (follow-ups (19), (15)).** The context DTO's `subsidiaryId` must have the
id shape (`UUID_SHAPE`, not lowercased: the acknowledgement echoes it verbatim,
and an uppercase spelling matches no stored id, so it answers empty); the legacy
report DTOs accept a blank selector (whitespace included; its meaning is open
question (2)) or that id shape, at most 36 characters — a NUL, markup or a bidi
control no longer reaches the generation audit row (a NUL used to fail its jsonb
with a 500 after the whole artifact was built). Every export, context and legacy PDF/Excel/CSV, answers HEAD `405` with
`Allow: GET` (`ExportGetOnlyGuard`) before anything is assembled or audited; the
refused HEAD still spends the EXPORT quota, because the runtime limits run first.

The following GET paths are relative to
`/api/v1`, declared once in `REPORTING_CONTEXT_API_PATHS`; the web calls them only
through `apps/web/lib/api.ts`:

| Route | Client | Response contract |
|---|---|---|
| `/emissions/context/summary` | `reportingSummary` | `ReportingSummaryResponse` |
| `/emissions/context/tracking-matrix` | `reportingMatrix` | `ReportingMatrixResponse` |
| `/intensity/context` | `reportingIntensity` | `ReportingIntensityResponse` |
| `/reports/context/meta` | `reportingMeta` | `ReportingMetaResponse` |
| `/reports/context/{pdf,excel,csv}` | `downloadReportingReport` | File bytes; `ReportingExportParams` request |

JSON responses use `{ context, data }`, echoing every requested inventory field
verbatim even for empty results: absent keys are omitted, never null; scope is
never derived from category; numbers remain numbers. Clients reject a missing or
mismatched acknowledgement.
The separate paths make an older API refuse instead of silently ignoring new
filters; clients never fall back to a legacy path. Exports use the same context
as preview/meta and apply it to totals, committed and withdrawn ledgers, labels
and the generation audit. Binary responses have no context acknowledgement. PDF and Excel display the
selected subsidiary, scope and category; context filenames include scope/category
alongside year/subsidiary. CSV retains its rectangular English machine-key ledger,
with no metadata preamble: its filename and generation audit carry the selection,
including an empty export. Tests inspect artifacts and filter predicates; `tenant-isolation.int.spec.ts` proves every context route's tenant isolation on the real database, auth and runtime role (the PDF with Puppeteer replaced by the HTML it is handed; e2e renders it) — another organisation's subsidiary, an ungranted one and an unknown one answer alike, and context and legacy exports share the report lease and the EXPORT quota.
New selection labels have EN/TR server catalogues. Since LP4-03 (K6, D16) the
whole PDF and workbook follow the report's language — `language`, else the
caller's `profiles.language` — category, period and status labels included,
recorded on the generation audit row; the CSV keeps its English machine keys.
This also changes legacy artifact layout: Excel Summary now has subsidiary,
scope and category filter rows 4–6 (Status moves from row 5 to row 7); the old
"Scope filter" row named a subsidiary, while the new one names the actual scope.
The legacy PDF header gains the same three filter label lines. A JSON acknowledgement likewise
does not prove arithmetic, tenant isolation or a consistent database snapshot.

For **D14 intensity**, the new contract permits only `revenue` for an
all-accessible selection, even when that set contains one subsidiary. Physical
metrics require an explicitly selected subsidiary. Different monetary units stay
separate; there is no FX conversion. `selectedSubsidiaryIds` describes authorized
coverage, and each metric's `contributingSubsidiaryIds` identifies the subset with
that exact metric/unit denominator. Only those subsidiaries contribute to its
filtered numerator; the denominator stays annual, without scope/category
proration. Missing denominators are disclosed as missing coverage, never zero.
Each metric also returns a non-negative safe-integer `uncalculatedRecordCount`:
committed records of its contributing subsidiaries, for the same year/scope/category,
excluded from `emissionsTotal` because they have no usable figure. The summary's
count for all selected subsidiaries cannot substitute for this numerator-specific
disclosure. Metric/unit pairs must be unique, with disjoint contributor sets
across units of the same metric (one denominator per subsidiary/year/metric).
The summary, matrix and intensity context routes require a valid year and refuse
unknown fields, repeated parameters and conflicting scope/category filters with
`validation_failed`. Legacy and context reads share their aggregation methods.
The service uses one nonblank-subsidiary predicate for access selection and D14,
including internal callers; context HTTP validation still rejects blank selectors.
Both `GET /intensity` and `GET /intensity/context` now enforce D14; the legacy
route retains its existing response envelope. Report context routes are
implemented with context filtering and EXPORT classification shipped together.

The filtered tracking matrix must filter both records and emitted category cells,
then recompute per-row `totalTCo2e`, `uncalculatedRecordCount`, `completeCount` and
`categoryCount`, and overall `totals: { complete, incomplete, missing }`.
`reportingYear` must equal `context.year`. Filtering records alone would
manufacture missing obligations. Clients also reject a mismatched matrix year,
a row outside the selected subsidiary, or cells outside selected scope/category.
Existing cell coverage rules remain. This contract does not
implement D11/D12 attribution/applicability or D13 final/PARTIAL reporting, which
remain LP3-04/LP4-03 work. Consumers still need request-generation/cancellation
guards so an older response cannot replace a newer selection.

Implementation obligations before activating the context routes (met: the routes
in #167/#170, the URL in N1):

- Classify `/reports/context/{pdf,excel,csv}` as **EXPORT** under #160, preserving
  `RATE_EXPORT_PER_MINUTE` (5) and the `reports` concurrency lease
  (`REPORT_CONCURRENCY = 1`). The current exact-path matcher would classify them
  READ (120/min) and take no report lease. Derive the EXPORT set from
  `REPORTING_CONTEXT_API_PATHS` plus the legacy export paths, with a `routeGroup`
  test covering both. PR A does not change the runtime classifier.
- Report meta and the export record-limit pre-check must count the filtered set;
  the current assembly pre-check counts the whole year. Test each format's
  context labels, totals against the same-context summary, and filtering of both
  committed and withdrawn ledgers. Name the append-only generation audit keys
  `scope` and `category` once, and test that the diff carries those filters.
- URL parsing must preserve raw values for validation: no `x || undefined` that
  erases an invalid empty value. Convert valid numeric syntax to wire numbers
  without coercing empty or malformed input, then use `isReportingContext`.
  Data Entry deep links must visibly refuse invalid years instead of falling
  back to the default. Define an explicit URL representation for clearing
  optional selections and serialize the resolved optional context too, so a
  shared link cannot inherit the recipient's remembered narrowing filters.
- Deploy the API before, or together with, the web build that calls these routes.
- Before implementation starts, obtain owner slots for
  `apps/api/src/intensity/**` and `apps/api/src/common/runtime-limits.ts`.
  This PR's shared-contract grant does not authorize edits to either area.

PR A merges alone and first after the required architecture review; LP4-01 and
the LP3-02 implementation rebase on its merged contract. No migration is needed.
Contract/client tests cover year bounds, context preservation and rejection,
denominator coverage and export requests. Completing LP3-02 also requires the
two-year/two-subsidiary reconciliation, URL and refresh behavior, 2027 missing
factor refusal, and live API/browser evidence on an authorized isolated environment.
N1 adds them. `reporting-context-reconciliation.int.spec.ts` runs two years × two
subsidiaries × three filters, plus an empty 2027, on the real database, auth and
runtime role: summary, matrix, intensity numerator, report meta, CSV ledger and
generation audit each match a figure computed from the fixture; a 2027
calculation is refused with `no_factor`; a data_entry granted one subsidiary is
never broadened. It also proves HEAD 405 on all six exports and a NUL, markup or bidi selector
refused with no audit row. `e2e/reporting-context.spec.ts` covers
canonicalisation, Back and Forward (with their data), reload and sidebar
navigation, the export's own request, a remembered selection forgotten when
someone else signs in, Back closing an open drawer, a target deletion held until
after a new selection refreshing the new one, a refused link that loads nothing,
an inaccessible selection, Data Entry's refused year and the Turkish copy; D06 under a 2027
clock is a unit test (a faked browser clock makes every Supabase session look
expired).
