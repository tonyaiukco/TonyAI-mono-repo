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
  template/filters/exportType/recordCount) — this IS the generation log
  (report_page.md §10); no extra table needed.
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
   tenant scoping, factor dedupe, CSV quoting, HTML escaping) — never Puppeteer
   in unit tests. E2E: `page.waitForEvent('download')` → assert filename
   extension + non-empty file size.
6. Deps note: `puppeteer` needs `allowBuilds` in `pnpm-workspace.yaml` (pnpm 11)
   and downloads Chromium on postinstall; keep it API-only. `exceljs` for
   multi-sheet xlsx; plain string-building for CSV (quote `[",\n]`).

## Anti-patterns
- Rendering a web route with Puppeteer (double-auth trap, needs a running web server).
- Re-aggregating emissions in the report service.
- Embedding signed storage URLs in a static artifact.
- Asserting toast text alone in the E2E instead of the actual download event.
