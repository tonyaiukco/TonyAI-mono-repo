# TonyAI: API reports and issuance

> Moved from [`README.md`](../../README.md) on 2026-11-05 (OpenSpec change `refactor-readme`); the text is unchanged.

## Live reports and issued reports (LP4-03)

Decisions 2026-10-24, K1–K13. A live report (the Reports preview, `GET
/reports/{context/,}{meta,pdf,excel,csv}`) is **live and says so**; an issued
report is retained and retrieved, never regenerated.

**One snapshot (K2).** Every read of one live request — the organisation, the
status counts, the committed and withdrawn ledgers, their evidence links, the
releases' standing, the Scope 3 disclosure and the boundary's coverage — runs
in ONE REPEATABLE READ transaction set `READ ONLY` (`CaptureSnapshot.openReadOnly`,
the capture's own guard), and the PDF, workbook or CSV is written after it
closes. A preview holds that connection for its whole read, so it takes a
permit of its own — one at a time per user, apart from the exports' lease
(`runtime-request.ts`); the Reports page retries a refused preview once after
`Retry-After`. A read whose snapshot
cannot start in time (P2028), like one whose pool is exhausted (P2024), is a
429 with `Retry-After`. The Reports preview reads its tiles and tables from
this one answer (`meta.summary`), never from the emissions summary. The totals
and tables are the report's own sum of the ledger rows it read
(`summariseCounted`, `emissions.service.ts`), never a second read, so an
approval, a withdrawal, a new record or a rename committed mid-report cannot make
its badge, counts, totals and ledger disagree (`live-report-consistency.int.spec.ts`
holds the read mid-way and commits all four). Every figure is stated as of the
snapshot's own clock (`generatedAt`, UTC). `GET /reports/context/meta` is the
preview's one read: its counts, `summary`, `scope3` and `coverage` are one moment's.

**Scope 1 and 2 only (K4).** A live report counts, lists and totals every
committed Scope 1/2 record of its selection (a dataset holds Scope 1/2 too, but
sums only the records attached to its boundary's obligations — an issuance is
the authoritative figure): `Total` is Scope 1 + Scope 2, and Scope 3 is "not
covered" — its committed records counted and their calculated tonnes named in
`scope3` (`ReportScope3Disclosure`), never summed into a tile, a total or a
percentage; a Scope 3 selection — `scope=3`, or a Scope 3 category with no
scope — reads "Not covered" everywhere. `summary` is a `ReportInventorySummary` — Scope 3 the literal 0 —
not the emissions summary, whose totals include Scope 3. A `scope=3` selection reads no Scope 1/2 record; its tiles and
the workbook's cells read "Not covered", never 0. The PDF prints one decimal of
the full-precision total; the workbook and CSV print full precision.

**Review status is not coverage (K3).** `ReportStatus` keeps its values and is
labelled for what it is — "All records approved — not an inventory
certification". `ReportMetaDTO.coverage` (`ReportLiveCoverage`) is the year's
NEWEST boundary version (open, frozen or confirmed) assessed by the capture's
rule (`assessDataset`) over every Scope 1/2 record of the REPORT's selection,
any status, as it stands in the same snapshot (`reports/live-coverage.ts`) —
a subsidiary the boundary leaves out included, its records `unmapped_record`
gaps, because the live total counts them (unlike a capture, which reads the
version's declared subsidiaries alone). States: `no_boundary` (coverage
unknown), `not_readable` (the version declares a subsidiary outside the
caller's access — nothing of it is disclosed; a partially granted data_entry
user's usual answer), `not_covered` (a Scope 3 selection — no boundary is
read), `too_broad` (more records or evidence links than one report reads — the
figures stand, coverage unknown), or `assessed` — the version, its decision,
the selection's included obligations and how many are satisfied, excluded
sources, gaps by code, and a `reading`: `complete` (no gap, at least one
included obligation), `gaps`, `nothing_included` (every category excluded) or
`outside_boundary` (an extract of a subsidiary the version does not declare).
An unconfirmed version is never complete, and a one-record year is not either —
its missing months are `missing_record` gaps. Still not a certification:
approval, locks, factor standing and uncalculated figures are a final
issuance's gate, so a scope can read `complete` live and `partial` issued.

**Live, in words, in the report's language (K6, K8).** The PDF opens with a
banner ("Live report — not an issued report…, read at <time> UTC"), the
workbook's Summary sheet with the same row, and every live file is named
`tonyai-live-…` and sent `Cache-Control: no-store`; the CSV keeps its one header row. The PDF and workbook print
every heading, note, label and categorical cell through the module's TR/EN
catalogue (`reports/i18n/`, `report-vocabulary.ts`; English prints exactly what
it printed before), with the language's number separators on the PDF; a
full-precision figure inside a workbook note (the withdrawn tonnes, Scope 3's
calculated tonnes) keeps every digit of the stored number, its exponent
expanded, with the language's decimal mark (`fullFigure`); the CSV
keeps English machine keys, raw statuses and dot-decimal figures. The
generation audit row (`report` / `generate`) adds the snapshot time
(`readAt`), the badge it printed (`status`), what the boundary said
(`coverage`) and — PDF and workbook — the `language`.

**Calculation inputs and Scope 2's method (LP4-02 PR5).** Every report, live
or issued, prints a record's own calculation inputs read from its snapshot
(`common/calculation-inputs.ts`): a natural gas record's NCV and its origin
(the release's default, entered, or derived from a billed GCV) beside the
row's generic basis, and a refrigerant's capacity, leak rate and refill per
equipment line beside its activity value, which is the total capacity rather
than the mass priced. They sit under the quantity in the PDFs, and in a
trailing `calculation_inputs` column (Excel "Calculation inputs") appended
last so no column moves. Scope 2 is labelled location-based, and since no
certificate data exists every report says "No market-based result" (TR
"Piyasa bazlı sonuç bulunmamaktadır") instead of copying the location-based
figure: on the PDF tile, as a Summary row in Excel, and in a trailing
`scope2_market_based` CSV column on every Scope 2 row (English, as every CSV
cell). The issued renderers are `tonyai-issuance-pdf-v2` and
`tonyai-issuance-tables-v2`; a retained dataset's fingerprint is unchanged,
since neither the dataset nor its assessments moved.

**Issued Excel and CSV (K5).** `GET /report-issuances/:id/xlsx` and `/csv`
project the issuance's RETAINED dataset — re-read, re-verified as an issue
verifies it (fingerprint, assessments, frozen version), and bound to the
issuance by its fingerprint — exactly as its PDF does: the scopes' counted
records, the same figures, gaps, exclusions and withdrawals
(`report-issuances/issuance-tables.ts`, renderer `tonyai-issuance-tables-v2`).
Written on request and never stored (no migration, no new bucket); the same
issuance always yields the same rows and figures under one renderer, which the
tables name, so an issuance made under v1 now downloads with v2's two trailing
columns, its figures unchanged. The workbook follows the
issuance's language with numeric figures and names the issuance, dataset,
fingerprint, capture and issue times on its Summary (its file clock is the
issue time; its labels are the catalogue's current words); the CSV opens with
one `row_kind: issuance` row — the identity and status, every other cell empty
— so an issuance with no ledger row (an all-excluded final, an empty extract)
still names itself, then carries the issuance, dataset, fingerprint and status
on every row, the entity's `subsidiary_id` and `location_id`, then
`calculation_inputs` and `scope2_market_based` last (LP4-02 PR5), and a withdrawn row's
aggregatable cells read `Withdrawn` (values in `voided_*`), so a SUM over
`tco2e` is the issuance's counted total. Neither writes an audit row: each is a
read of retained data, as the PDF download is. The PDF, workbook and CSV of one
issuance share one file name — year, template, language, status, issue date
and a short id, so two finals of a year no longer share a name.

**The list and the preview (K7).** `GET /report-issuances?year=&status=`
answers a `ReportIssuanceList`: at most 50 `ReportIssuanceSummary` items
(gaps counted in SQL, never listed; the issued dataset's selection, context,
boundary and capture time), `truncated` when more are readable, and
`currentFinalIssuanceId` — the year's newest readable final, whether or not it is
on the page. `GET /report-datasets/:id/issuance-preview` runs the issue's own
read, verification and gate (`deriveIssuance`) and answers status, gaps and
`finalAllowed` (super_admin only), writing nothing; issuers only. The tables
and the preview take the EXPORT quota and lease, as the PDF download does.

**Analytics budgets (K11).** `GET /emissions/summary`, the context summary
and trends, the tracking matrix and the completeness drill-down read one
year within `REPORT_RECORD_LIMIT`, as the reports do, and a year-less read
(the Emissions history's trend) within `ACTIVITY_RECORD_METADATA_MAX_ROWS`;
one row past either is `query_too_broad`, 422 — LP4-05 PR C follow-up (17).
`GET /report-datasets?year=` answers `{ items, truncated }` too.

**The screens (LP4-03 PR B; K8, K9).** Reports has two tabs, the choice in
the URL (`?tab=issued`, kept beside the reporting context):
- **Live preview** — marked live on its first line ("Live preview — not an
  issued report"); the review badge ("All records approved", never
  "Approved") with its note that it certifies nothing; the boundary's
  coverage card (`components/reports/coverage-card.tsx`, every state and
  reading worded, gaps by code); the Scope 3 disclosure; tiles reading "Not
  covered" for a Scope 3 selection; the live PDF/Excel/CSV downloads as
  before (`tonyai-live-…`).
- **Issued reports** (`components/reports/issued-reports.tsx`) — the year's
  issued reports (final or partial, gaps counted, "Current final" = the newest
  final the caller can read, `truncated` said) with each one's PDF, Excel and
  CSV; the year's captured datasets with **Check** (the issuance preview, on
  request — never per row, the EXPORT quota is five a minute: final or partial
  and each blocking gap named) and **Issue** (the dialog shows that preview
  first — issuing is irreversible —, then template, language — the caller's
  by default —, options; a final the caller may not issue is not offered);
  **Capture the
  inventory** of the year's newest boundary version (super_admin; a consultant
  once the version is frozen). An executive viewer reads; data_entry is told
  its role reads no issued report.

The dashboard's figure is **data entry progress**, never coverage, with the
same coverage card beside it, and its Total is Scope 1 + 2 as every report's
(Scope 3 on its own card, "Not covered — outside the total") — so are each
subsidiary's figure in the table, the bar chart and the detail drawer
(`scope12Total`), and a Scope 3 selection reads "Not covered", never 0 —
on the cards, the chart and a subsidiary's drawer. A coverage read refused
for capacity is retried once when the server's `Retry-After` is short
(`lib/report-preview.ts`; a longer one is not retried early), then the card
says the coverage is unavailable — never left out. Data Entry
shows the selected subsidiary's coverage card beside the invoice panel; a
data_entry user granted part of an organisation whose boundary declares other
subsidiaries reads `not_readable` there — the expected answer (Decisions
2026-10-24, follow-up (1): option A). The Reports screen's copy is in the
`reports` catalogue (TR/EN), the dashboard's changed words in `dashboard`;
the client calls are `api.listInventoryBoundaries`, `listReportDatasets`,
`captureReportDataset`, `previewIssuance`, `issueReport`,
`listReportIssuances` and `downloadIssuance`. `e2e/report-issuances.spec.ts`
drives capture → check → issue → the three downloads through the UI on a year
no other spec reads (2021): a frozen version, a dataset and an issuance are
never deleted, so it declares a new version each run.

**The boundary editor (LP4-03 PR C; Decisions 2026-10-24, D1–D10).**
`/inventory-boundary?year=` (sidebar "Inventory Boundary"; the coverage card
and the Issued tab link to it — "Declare or edit the boundary" for a
super_admin, "View the boundary" for every other role) lists the year's
versions with their state — open, confirmed, or frozen unconfirmed by a
capture — and, for the selected one, each subsidiary (named as the version
names it: the trading name, else the legal one — live while open, frozen
once frozen): declared or not, its months, sites, sources and gaps. A super_admin starts a version (empty, a
copy of the selected frozen one, or of the previous year's newest when the
year has none), declares, edits or removes a subsidiary, confirms the open
version (the dialog names the undeclared subsidiaries a confirmation leaves
out and is disabled while the version is empty or has gaps) and deletes it;
every other role reads, a data_entry user only its granted subsidiaries'
part, and a frozen version is read-only for everyone. The declaration form
(`components/inventory-boundary/declaration-editor.tsx`) holds every field
the PUT takes — months; sites (each with its months); per category the
attribution (company or sites, and a cadence that is never defaulted) and a
decision per entity, with its reason; named sources (mapped to a category
and activity type, or unsupported with its reason and scope; included with
an evidence cadence, or not with a reason). `lib/inventory-boundary-form.ts`
reads a subsidiary's declaration from the snapshot and writes the PUT body
back losslessly (a body entered through the API is shown and resent as it
is), and words on its field every refusal the API would answer
`validation_failed` (the server stays the authority; what it stores as a gap
it reports after the save). The API's last write wins, so a save first
re-reads the version and refuses — "changed by someone else" — when that
subsidiary's declaration moved since the form opened, and a confirmation
first re-reads the whole version and refuses when any declaration, name or
geography it would freeze differs from what the screen shows (checks, not
atomic preconditions: "LP3-04 write-path contract follow-ups" (1)). A write
that answers after the user has moved to another year or version is not
shown over it. Copy in the
`boundary` catalogue (TR/EN); the client calls are `getInventoryBoundary`,
`createInventoryBoundary`, `putInventoryBoundarySubsidiary`,
`deleteInventoryBoundarySubsidiary`, `confirmInventoryBoundary` and
`deleteInventoryBoundary`. `e2e/inventory-boundary-editor.spec.ts` declares,
is refused, resolves the gaps and confirms through the UI, copies, meets a
concurrent change (to a save and to a confirmation) and deletes, and reads
as a consultant and a data_entry
user, on a year no other spec reads (2028; each run confirms one version).
