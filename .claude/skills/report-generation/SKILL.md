---
name: report-generation
description: Add a server-generated, tenant-scoped file artifact (PDF via Puppeteer, Excel via exceljs, or CSV) to the TonyAI API — assembling data from existing aggregation services and streaming it as a download with an audit row. Use when a feature must produce a downloadable document from live data (reports, exports, statements). Not for on-screen analytics (aggregation-endpoint) or new CRUD resources (tenant-api-module).
---

# report-generation

Produce audit-ready file artifacts from live data. The **canonical exemplar** is
`apps/api/src/reports/` (WP6): `reports.service.ts` (assembly + PDF/Excel/CSV),
`report-html.ts` (pure HTML builder), `reports.controller.ts` (streaming).

## Rules (must hold)
- **Assemble once, render many.** One `assemble()` produces a single `ReportData`
  shape consumed by every format (PDF/Excel/CSV). All tenant scoping happens in
  assembly — formats never touch the DB.
- **Reuse the aggregation layer.** Totals/breakdowns come from
  `EmissionsService.summary` (module `imports: [EmissionsModule]`) — never
  re-aggregate in the report path; one source of truth.
- **PDF = API-side HTML string + Puppeteer `page.setContent`.** Never print a
  Next.js route: web routes sit behind the cookie `proxy` guard while the API is
  Bearer-only — printing a route means satisfying two auth systems. The HTML
  builder is a **pure function** (unit-testable without Puppeteer); launch the
  browser lazily, share one instance, close it in `onModuleDestroy`, and pass
  `--no-sandbox --disable-dev-shm-usage` for container-friendliness.
- **Escape every user-influenced string** in the HTML builder (names can contain
  markup). Test it (`&lt;script&gt;`).
- **Audit every generation** (`entity: 'report'`, `action: 'generate'`, diff =
  template/filters/exportType/recordCount/withdrawnCount) — this IS the
  generation log (report_page.md §10); no extra table needed. Record what the
  artifact DISCLOSED, not only what it counted: the record set moves afterwards,
  so a disclosure count is not recoverable from the data later.
- **State what is absent, per format** (FR §5.4). Anything excluded from the
  totals — a withdrawn (`voided`) figure, a factor-less record — has to be
  visible in the artifact, with the reason where one exists; an export that
  quietly drops rows misstates by omission, and `voidedCount` shipped computed
  and then discarded for two work packages. In a FLAT export where the excluded
  rows share one table, **every column a reader could aggregate** carries a text
  marker (`Withdrawn`, `Not calculated`) and the real figures go in their own
  columns — never a number a SUM would pull back into a total, never a blank (a
  blank sums as zero). Enumerate those columns rather than protecting the
  obvious one: this shipped guarding tCO2e while leaving the activity quantity
  numeric, which overstated total energy by 394 MWh and made the CSV disagree
  with the Excel from the same request.
- **Name the reporting entity on every row** (`entityLabel` from
  `@tonyai/shared-types` — one phrase, three formats, and the same one the app
  shows). A ledger keyed on subsidiary alone cannot tell two figures for one
  month apart.
- **A column is DECLARED once, in `report-columns.ts`, and the writers read it.**
  Six hand-maintained literals for one column set — the PDF `<th>`s, its
  `<td>`s, the Excel header, its rows, the CSV header and its rows — used to be
  the standing trap here; WP22 replaced them with one `ColumnSpec` per column
  carrying a per-format slot (`csv` / `excel` / `pdf`, `null` where a format
  does not take it). **Adding a column is now one descriptor**, plus an entry in
  each hand-written table list that wants it (`WITHDRAWN_SHEET`,
  `PDF_WITHDRAWN` — the ledgers derive theirs). Append it; never insert one,
  because a formula pinned to a column position reads its neighbour after an
  insert. And declare `aggregatable` by asking "could a reader SUM or COUNT
  this?", never by the value's type: `anomaly_flag` holds a word and IS
  aggregatable, `activity_unit` holds a word and is not.
- **Honesty rules carry over:** committed statuses only; evidence appears as
  *file names + counts*, never signed URLs (they expire); completeness/status
  (`approved | draft | contains_incomplete_data`) computed from real record
  counts; the >15% incomplete data-warning banner renders in the artifact too.
- **Streaming:** controller uses `@Res()` + `Content-Disposition: attachment`
  (and `Content-Length` for buffers). Client side, `api.downloadReport` fetches
  with the Bearer header → blob → anchor click (no window.open, keeps auth).

## Recipe
1. Shared types: params/DTOs in `@tonyai/shared-types` (template enum, filter
   params mirroring FR §5.3, meta DTO), build the package.
2. Service: `assemble(user, query)` → tenant-scope via `accessibleSubsidiaryIds`
   intersection (out-of-scope → empty, never 403-after-leak), pull summary +
   ledger (+ evidence names) + deduped factor snapshots; `meta()` for the status
   badge. Then one `generateX` per format + the shared `audit()`.
3. Controller: `GET /reports/{meta,pdf,excel,csv}` with a validated query DTO.
4. Frontend: rewire the page to live endpoints (`wire-page` skill); downloads via
   `api.downloadReport`; loading/empty/error states; provenance banner.
5. Tests: unit-test **assembly + builders with fixtures** (meta status math,
   tenant scoping, factor dedupe, CSV quoting, HTML escaping — including free
   text a user wrote, e.g. a withdrawal reason). Mock `findMany` **by status**
   when assembly runs more than one read: a single `mockResolvedValue` answers
   every query with the same rows, so the excluded set arrives full of records
   nobody excluded and a writer that leaked them looks correct — never Puppeteer
   in unit tests. E2E: `page.waitForEvent('download')` → assert filename
   extension + non-empty file size.
6. Deps note: `puppeteer` needs `allowBuilds` in `pnpm-workspace.yaml` (pnpm 11)
   and downloads Chromium on postinstall; keep it API-only. `exceljs` for
   multi-sheet xlsx; plain string-building for CSV — but **never hand-roll the
   cell**: call `csvField()` from `apps/api/src/common/csv-cell.ts`. It quotes
   `[",\r\n]` (the bare `\r` too — most parsers end a record on it, so a
   reason containing one forges a ledger row behind no database row and no
   audit entry) and neutralises `/^\s*[=+\-@]/` BEFORE quoting, so the `'`
   lands inside the quotes. **Prepend a UTF-8 BOM to the finished CSV** — in the
   writer, after the rows are joined, never inside the header (there it lands
   within the first FIELD, where `csvField` re-examines it) and never in the
   controller (no controller spec, so it ships uncovered). The response header
   says `charset=utf-8`, but that is gone once the file is on disk and
   Excel-on-Windows then decodes it with the ANSI codepage. **Assert it on
   BYTES, untrimmed:** every ordinary CSV assertion calls `.trim()` first, and
   `String.prototype.trim()` strips U+FEFF — so a trimmed test cannot fail when
   the BOM disappears. The leading `\s*` is not cosmetic: anchored at
   index 0 the guard let `"   =SUM(A1)"` through raw AND unquoted. Finite
   numbers pass through unstringified — `-` leads a formula and every negative
   number, and text `'-12.5` is skipped by Excel's SUM while the xlsx writes a
   real numeric cell for the same column.

## Anti-patterns
- Rendering a web route with Puppeteer (double-auth trap, needs a running web server).
- Re-aggregating emissions in the report service.
- Embedding signed storage URLs in a static artifact.
- Asserting toast text alone in the E2E instead of the actual download event.
- Asserting a section by a phrase the surrounding prose also contains (a banner
  that quotes its own section title satisfies `toContain('<title text>')` with
  the section deleted — assert the heading markup).
- Computing a count that explains an omission and then not returning it.
- Neutralising inside a per-column renderer. One column can then opt out, and
  the opt-out is a forged row; keep it as the last transform over every cell.
- Asserting neutralisation with the writer's own regex (`expect(cell).not
  .toMatch(/^[=+\-@]/)`). It asks the writer about the writer — a cell holding
  `   =SUM(A1)` passes it and executes on open. Strip leading whitespace in the
  assertion first.
- Neutralising the **xlsx** path. exceljs writes a string as a string cell and
  Excel does not evaluate one on open; prefixing there would stringify tCO₂e
  and break numeric parity with the CSV.
