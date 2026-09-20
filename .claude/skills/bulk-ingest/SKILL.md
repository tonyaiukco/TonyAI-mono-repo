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
  reason a historic figure is reproducible), its own lifecycle gates and its
  own audit row. `createMany` has none of those and writes past every rule the
  single-record path enforces.
- **The dry run must be a read-only code path, and a spec must PROVE it** by
  asserting the write spies were never called. Do not reach for a rolled-back
  transaction without checking one is available: `ActivityRecordsService` opens
  none, and an interactive transaction would not survive a thousand-row loop.
  Extract a read-only half of `create` instead (`previewCreate`).
- **The preview cannot see uniqueness conflicts** — Postgres raises them on the
  insert, so a dry run reports a thousand clean rows and the apply returns
  conflicts, which is worse than no dry run. You need BOTH: an in-memory `Set`
  for row-vs-row, and ONE up-front query for row-vs-stored. Mirror the index's
  own predicate — TonyAI's excludes `voided`, so a withdrawn figure does not
  hold its slot.
- **Key every segment in the DATABASE's spelling, and accept ONE spelling of an
  id.** A typed column accepts several spellings of one value and returns one;
  a JS `Set` compares text. Take the hyphenated shape in either case and
  lowercase it at the boundary, applied by the DTO and by the two readers of a
  RAW cell (the tenant check and the stored-slot query); refuse `{…}`,
  `urn:uuid:…` and the unhyphenated form as `invalid` on their own row. Do NOT
  fold them — that was tried (#113) and needed a hand-measured grammar table
  and a probe to keep it honest, for spellings nobody types. Two consequences:
  only a cell that IS an id goes into a tenant check or a Prisma `IN` list (a
  non-uuid there is a P2023, outside every catch), and a blank optional id
  stays blank. Test with ids containing hex LETTERS — seeded ids are all
  digits, so `toUpperCase()` is a no-op on them.
- **Parse strictly; never coerce.** `Number('')` is `0`, and a zero is a
  REPORTED quantity that enters the inventory. Refuse `''`, `'1,200'`
  (ambiguous across locales), `'1e3'` and `'0x10'`. A strict numeric regex also
  kills `=SUM(A1)` as a type error, with no allow-list and no false positives.
  Do **not** fix this with `@Type(() => Number)`: that repairs the CSV case by
  breaking the live HTTP one.
- **Formula handling is asymmetric.** On parse, flag the row in the report —
  never reject it, and never prefix on the way in: a stored apostrophe is
  re-neutralised on the next export and corrupts the value permanently, and a
  leading `-` is an ordinary variance reason. Neutralise on the way OUT. Both
  helpers live in `common/csv-cell.ts`; an ESLint rule names this case.
- **Validate through the resource's real DTO**, with `main.ts`'s pipe options
  (`whitelist`, `forbidNonWhitelisted`) reproduced by hand — the global
  `ValidationPipe` does not run inside a loop.
- **Tenant-check the whole file before writing anything.** A file naming an
  entity the caller cannot reach is the wrong file; importing the rows that
  happen to match is worse than refusing all of them. Name the offending ROW
  NUMBERS, not the ids.
- **A partial import must be enumerable.** No transaction spans the batch, so a
  lock landing mid-file leaves rows 1..N written. List accepted rows
  individually — a report that says only "failed" turns that into a
  data-integrity incident.
- **One audit row for the batch under its OWN verb**, plus the per-row rows the
  create path already writes: `bulk_import` / `bulk_submit` with
  `entityId: null` and a `diff.bulk` summary, never an existing verb with a
  null id, which made a refusal indistinguishable from a created record. The
  new verb is one member in `AUDIT_ACTIONS` plus one entry in the web audit
  page's exhaustive colour map — that compile error is the point of the map.
  Write the batch row on a dry run and on an apply, even when every row failed.
  Of the pre-flight refusals, audit only the ones that say something about the
  CALLER (a role that may not write, a file naming another tenant's entity),
  never a malformed file: that is a 400 that touched nothing, and auditing it
  fills an append-only table with caller-controlled text at the throttle's rate.
- **An applied import is a batch entity, not an audit row**, if users must come
  back to "the records from that file" after a refresh: a table
  (`import_batches`: owner organisation, uploader, the subsidiaries the file
  names, file name/format/size/sha256, storage key, status and counts), a
  nullable FK on the created records, and RLS by the `rls-for-table` skill.
  Create the batch row BEFORE the loop so each record carries its id — through
  a server-side argument to `create`, never a DTO field — and close it after
  (`completed`, or `failed` when the loop aborts; a leftover `processing` is an
  honest "interrupted"). Store the source file first and remove it if the row
  cannot be written. A dry run creates nothing. Scope a batch's readers by the
  subsidiaries the FILE names, not the rows accepted: the file holds refused
  rows too.
- **Cap rows and bytes explicitly.** Nest's 100 KB JSON body limit does **not**
  apply to a multipart upload. Derive the row cap from the per-row query budget
  and write the arithmetic down beside the constant.
- **The extension is the gate; the MIME type is advisory.** Windows browsers
  send `.csv` as `application/vnd.ms-excel`, so a MIME rule refuses an ordinary
  spreadsheet export. The declared type is client-controlled and buys no
  security: the extension picks the parser, and the parser refuses what is not
  a spreadsheet.
- **The file's bytes must be UTF-8, or the file is refused whole.** The decode
  is lossy and silent, so anything else reaches a free-text column as U+FFFD on
  a row nobody can edit. Guard the CSV buffer and each XLSX part; never
  transcode. See TRAPS.md — this one has a second door.
- **Strip the BOM** — belt and braces, since this product's own CSV export
  writes one (#91) and re-importing a TonyAI file is the first thing a user
  tries. Measure before claiming it is the mechanism: `trim()` already removes
  U+FEFF, so a header matcher that trims is protected either way.

## Steps

1. **Contract** — add `XxxUploadReportDTO`, a row-issue interface, a closed
   issue-code union, the column list, and the caps to
   `packages/shared-types/src/index.ts`; `pnpm --filter @tonyai/shared-types build`.
2. **Seam** — if the target service has no read-only half, extract one first,
   **in its own PR**: it changes a shipped write path and needs its own review.
3. **Parser** — `parse-rows.ts`: extension sniff → papaparse (CSV) /
   `readFirstWorksheet` (XLSX — never exceljs's reader, see the traps) →
   `Record<Column, string>` per row, carrying the file's own line
   number (header = 1, so it matches what Excel shows). Map headers by NAME,
   case- and space-insensitively; refuse unknown, missing and duplicated
   columns rather than dropping them.
4. **Service** — batch pre-flight (role FIRST, then file, parse, row cap,
   tenant — all inside the audited refusal), one query for
   stored keys, then the loop: flag → map → validate → dedupe → preview or
   create, catching per row and continuing.
5. **Controller** — `FileInterceptor('file', { limits, defParamCharset: 'utf8' })`
   and a route-scoped `ThrottlerGuard`; never a second `APP_GUARD`. The storage
   is the library's own and needs `@nestjs/throttler` >= 6.7.0 (earlier releases
   stopped every other key's hits from expiring when any one block ended);
   `common/throttler-storage.contract.spec.ts` pins that. No forked internals.
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

7. **Throw a class, branch on `instanceof`, never on a sentence.** If two
   failures would arrive as the same Nest exception, give each its own subclass
   in the THROWER's module (`activity-records/errors.ts`,
   `calculations/errors.ts`, `bulk-upload/errors.ts`) and let the mapper check
   the class. Keep the
   sentence as the class's default message — the web mirrors some of them —
   but never read it. Binding an exported message constant was the previous
   rule and it still left the coupling in the text; a spec that retypes the
   literal tests the matcher against a string the spec owns.

## The loop

```ts
for (const parsed of rows) {
  const rowWarnings = [];                           // published only with an accepted row
  try {
    if (isFormulaLead(cells.freeText)) rowWarnings.push(flag(row, 'formula_lead'));  // FLAG only
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
    warnings.push(...rowWarnings);                  // only now: the row exists, or would
  } catch (e) {
    if (e instanceof ForbiddenException) throw e;   // backstop: the role is refused in the audited pre-flight
    error(row, mapException(e));                    // continue — never abort
  }
}
```

## Traps this skill exists to record

They are in **[TRAPS.md](TRAPS.md)**, beside this file — fifteen of them, each a
measured incident: the lossy UTF-8 decode, exceljs's out-of-memory abort, how to
prove a defence (and the two ways of proving one that do not work), quoting the
file's own text, `dryRun` coercion, role-first, and batch logging.

Read it before writing the parser or any refusal sentence. It is a separate file
so that this one stays the recipe: the rules and the loop are what you follow
every time, the traps are what you check yourself against once.

## Verify

```bash
pnpm --filter @tonyai/shared-types build
pnpm --filter @tonyai/api typecheck && pnpm --filter @tonyai/api test
```
