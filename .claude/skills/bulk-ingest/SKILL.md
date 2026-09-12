---
name: bulk-ingest
description: Import many rows from an uploaded CSV/XLSX into an existing TonyAI resource — parsing in memory, routing every row through the resource's own create service (never a bulk upsert), reporting row-level errors, and offering a dry run that provably persists nothing. Use when a feature must accept a file of records rather than one record at a time. Not for single-file attachments (supabase-storage), new resources (tenant-api-module) or analytics (aggregation-endpoint).
---

# bulk-ingest

Accept a file of rows and turn each into a normal domain record. The **canonical
exemplar** is `apps/api/src/bulk-upload/` (WP8): activity records from CSV/XLSX.

## When to use
A feature where the user hands over many records at once — historical activity
data, a supplier list, a factor set. If the file IS the deliverable (an evidence
attachment), use `supabase-storage` instead.

## Rules (must hold)

- **Never bulk-upsert. Route every row through the resource's own create
  service.** Each row then gets its own factor snapshot (immutable, and the
  reason a historic figure is reproducible), its own lifecycle gates and its own
  audit row. `createMany` has none of those, and it writes past every rule the
  single-record path enforces.
- **The dry run must be a read-only code path, and a spec must PROVE it** by
  asserting the write spies were never called. Do not reach for a rolled-back
  transaction without checking that one is available: `ActivityRecordsService`
  opens none, and an interactive transaction would not survive a thousand-row
  loop anyway. Extract a read-only "preview" half of `create` instead — see
  `ActivityRecordsService.previewCreate`.
- **The preview cannot see uniqueness conflicts.** Postgres raises them on the
  insert. Without a batch-level check a dry run reports a thousand clean rows
  and the apply returns conflicts, which is worse than no dry run at all. You
  need BOTH: an in-memory `Set` for row-vs-row inside the file, and ONE up-front
  query for row-vs-stored. Mirror the index's own predicate — TonyAI's excludes
  `voided`, so a withdrawn figure does not hold its slot.
- **Parse strictly; never coerce.** `Number('')` is `0`, and a zero is a
  REPORTED quantity that enters the inventory. Refuse `''`, `'1,200'` (ambiguous
  across locales), `'1e3'` and `'0x10'`. A strict numeric regex also kills
  `=SUM(A1)` as a type error, with no allow-list and no false positives — the
  cheapest formula defence there is. Do **not** fix this with
  `@Type(() => Number)` on the DTO: that repairs the CSV case by breaking the
  live HTTP one.
- **Formula handling is asymmetric.** On parse, `isFormulaLead()` **FLAGS the
  row in the report — never rejects it, and never prefixes on the way in.** A
  stored apostrophe is re-neutralised on the next export and corrupts the user's
  value permanently; and a leading `-` is an ordinary variance reason
  (`-15% after a line shutdown`). `csvField()` neutralises on the way OUT. Both
  live in `apps/api/src/common/csv-cell.ts` — import from there, never from
  `reports/` (an ESLint rule says so, naming this case).
- **Validate through the resource's real DTO**, with the pipe options `main.ts`
  installs (`whitelist`, `forbidNonWhitelisted`) reproduced by hand — the global
  `ValidationPipe` does not run inside a loop.
- **Tenant-check the whole file before writing anything.** A file naming an
  entity the caller cannot reach is the wrong file; importing the rows that
  happen to match is worse than refusing all of them. Name the offending ROW
  NUMBERS (the user needs them), not the ids.
- **A partial import must be enumerable.** No transaction spans the batch, so a
  lock landing mid-file leaves rows 1..N written. The report lists accepted rows
  individually — a report that says only "failed" turns that into a
  data-integrity incident.
- **One audit row for the batch, plus the per-row rows the create path already
  writes.** Write the batch row even on a dry run and even when every row
  failed: `audit_log` is the only record that a file was pointed at this tenant.
  Reuse an existing `AuditAction`/`AuditEntity` with `entityId: null` (the
  `report` rows set that precedent) — adding a union member is a compile error
  in `apps/web`, whose action-colour map is exhaustive.
- **Cap rows and bytes explicitly.** Nest's 100 KB JSON body limit does **not**
  apply to a multipart upload. Derive the row cap from the per-row query budget,
  and write the arithmetic down beside the constant.
- **Check the extension AND the MIME type.** Windows browsers send `.csv` as
  `application/vnd.ms-excel`; a MIME-only rule (what `evidence` does) rejects an
  ordinary spreadsheet export. The extension picks the parser.
- **Strip the BOM** — belt and braces. This product's own CSV export writes one
  (#91), so re-importing a file TonyAI generated is the first thing a user
  tries. Measure before claiming it is the mechanism: `String.prototype.trim()`
  already removes U+FEFF, so a header matcher that trims is protected either
  way, and a comment claiming otherwise is disproved by its own test.

## Steps

1. **Contract** — add `XxxUploadReportDTO`, a row-issue interface, a closed
   issue-code union, the column list, and the caps to
   `packages/shared-types/src/index.ts`; `pnpm --filter @tonyai/shared-types build`.
2. **Seam** — if the target service has no read-only half, extract one first,
   **in its own PR**: it changes a shipped write path and needs its own review.
3. **Parser** — `parse-rows.ts`: extension sniff → papaparse (CSV) / exceljs
   (XLSX) → `Record<Column, string>` per row, carrying the file's own line
   number (header = 1, so it matches what Excel shows). Map headers by NAME,
   case- and space-insensitively; refuse unknown, missing and duplicated
   columns rather than dropping them.
4. **Service** — batch pre-flight (file, parse, row cap, tenant), one query for
   stored keys, then the loop: flag → map → validate → dedupe → preview or
   create, catching per row and continuing.
5. **Controller** — `FileInterceptor('file', { limits, defParamCharset: 'utf8' })`
   and a route-scoped `ThrottlerGuard`; never a second `APP_GUARD`.
6. **Specs** — DB-free, and THREE files, not one. A service spec (the dry-run
   proof, the dedupe pair, the error-code mapping, the partial-batch
   enumeration, a strict-parse table, and an assertion that the cell's number
   is the number written). A **route-metadata controller spec** in the
   `subsidiaries.controller.spec.ts` style — a Nest testing module cannot
   resolve these controllers, because vitest/esbuild emits no
   `design:paramtypes` — because hardcoding the dry-run flag in the controller
   otherwise passes the entire suite. And an **options-DTO spec**, because the
   flag that decides whether a thousand writes happen is one boolean. The
   multipart FIELD NAME is reachable from neither; it needs e2e.

7. **Bind, never retype, any message you branch on.** If two failures arrive as
   the same exception class and you tell them apart by text, import the
   thrower's own constant. A spec that retypes the literal tests your matcher
   against a string the spec owns, and the real rewording sails through green.

## The loop

```ts
for (const parsed of rows) {
  try {
    if (isFormulaLead(cells.freeText)) warn(row, 'formula_lead');   // FLAG only
    const mapped = mapRow(cells);                                   // strict parse
    if ('issue' in mapped) { error(row, mapped.issue); continue; }
    const dto = plainToInstance(CreateXxxDto, mapped.dto);
    const failures = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
    if (failures.length) { error(row, 'invalid', first(failures)); continue; }

    // Canonicalise BEFORE keying — the stored spelling is the slot's identity.
    // Skip the dedupe when the value names no period; the service's own 400
    // is the right answer there.
    const canonical = canonicalPeriodValue(dto.reportingPeriod, dto.periodValue);
    if (canonical === null) { /* fall through to the service */ }
    const key = slotKey(dto, canonical);            // the unique index's columns
    if (seenInFile.has(key)) { error(row, 'duplicate_in_file'); continue; }
    seenInFile.add(key);
    if (storedKeys.has(key)) { error(row, 'duplicate_existing'); continue; }

    if (dryRun) { const p = await svc.previewCreate(user, dto); accept(row, null, p); }
    else        { const r = await svc.create(user, dto);        accept(row, r.id, r); }
  } catch (e) {
    if (e instanceof ForbiddenException) throw e;   // a role cannot change mid-file
    error(row, mapException(e));                    // continue — never abort
  }
}
```

## Traps this skill exists to record

- **Join the slot key with `'\u0000'`**, which no cell can contain, so no segment can run into the next one. Check whether a collision is actually constructible in your schema before claiming it in a comment — and do not write a test for a state nothing can reach.
- **An anomalous row with no variance reason imports fine and can then never be
  submitted** — `submit` requires the explanation and re-evaluates the verdict.
  Warn about it in the report, or the user finds out a thousand rows later.
- **Drafts do not enter the anomaly baseline** (`BASELINE_STATUSES` excludes
  `draft`), so rows in one batch cannot shift each other's verdict — the batch
  is order-independent. Say so: it explains why a verdict stamped at import can
  differ from the one `submit` re-derives, and it is what would make hoisting
  the baseline query legal later. (The WP8 exemplar does NOT hoist it — the
  expensive query lives inside the record service, so memoising it means
  changing a shipped write path, which is its own PR.)
- **Never echo an unexpected error's text into the report.** It can carry a
  query, a path or a column. Log it; report a refusal.
- **`dryRun` must not coerce.** `Boolean('yes')` is `true` and `Boolean('0')` is
  `true`; a permissive flag imports a file the user asked to be told about, and
  every row is an audited write. Accept only recognised spellings of true/false
  and let anything else fail `@IsBoolean`.

## Verify

```bash
pnpm --filter @tonyai/shared-types build
pnpm --filter @tonyai/api typecheck && pnpm --filter @tonyai/api test
```
