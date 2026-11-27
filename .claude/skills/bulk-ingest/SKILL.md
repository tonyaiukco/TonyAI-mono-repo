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
attachment), use `supabase-storage` instead. A file of many thousands of rows
that must wait on a decision, or be reviewed as groups, follows the variant
below ("Variant: staged rows, and a batch as the lifecycle unit").

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
  lowercase it at the boundary — `canonicalUuid` beside `UUID_SHAPE`, applied
  by the DTO's `@Transform` + `@Matches` and called directly by the two readers
  of a RAW cell (the tenant check and the stored-slot query); key everything
  else off the validated DTO. Refuse `{…}`,
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
  A refusal the user can act on gets its own row code, not `invalid`: a comma
  figure is `wrong_decimal_separator` (`isCommaFigure`), and a DTO constraint
  declared with `codedConstraint` keeps its code on the row (`rowCodeOf` —
  `activity_value_too_large`). Add a new code's TR/EN label under
  `errors.bulkUploadIssues`.
- **Show what was read (D15).** The preview's accepted row carries the number
  and unit the write will store (`activityValue`, `storedUnit(activityUnit)`),
  taken from the validated DTO, never the cell's text — a dot-decimal file's
  `1.234` must be SEEN as 1.234 before anyone applies it.
  Do **not** fix this with `@Type(() => Number)`: that repairs the CSV case by
  breaking the live HTTP one.
- **Several file rows, one record: group before the duplicate check.** When a
  record holds a list (a refrigerant's equipment lines, LP4-02 PR4), one row
  per item is grouped into its record by the record's key — ids case-blind,
  the period canonical — before `duplicate_in_file` asks, and the stored-slot
  query reads the grouped records. Write the record whole or not at all: its
  one refusal sits on the line and column at fault and names every line's row,
  so `accepted + errors === totalRows` still counts records
  (`record-inputs.ts`). A derived quantity (the sum of the lines) is never also
  typed on the line: refuse a filled cell rather than reconcile two figures.
- **Formula handling is asymmetric.** On parse, flag the row in the report —
  never reject it, and never prefix on the way in: a stored apostrophe is
  re-neutralised on the next export and corrupts the value permanently, and a
  leading `-` is an ordinary variance reason. Neutralise on the way OUT. Both
  helpers — `isFormulaLead` in, `csvField` out — live in
  `apps/api/src/common/csv-cell.ts`. Import from there, **never from
  `reports/`**, which has a lookalike `csvField`; an ESLint rule forbids that,
  naming this case.
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
  new verb is one member in `AUDIT_ACTIONS` (shared-types) plus one entry in
  the web audit
  page's exhaustive colour map — that compile error is the point of the map.
  Write the batch row on a dry run and on an apply, even when every row failed.
  Of the pre-flight refusals, audit only the ones that say something about the
  CALLER (a role that may not write, a file naming another tenant's entity),
  never a malformed file (bad header, wrong extension, empty, oversized, too
  many rows, bytes that are not UTF-8): that is a 400 that touched nothing, and auditing it
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
  send `.csv` as `application/vnd.ms-excel` (and sometimes
  `application/octet-stream`), so a MIME rule — which is what `evidence` has —
  refuses an ordinary spreadsheet export. The declared type is client-controlled and buys no
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
    if (failures.length) { error(row, failures.length === 1 ? rowCodeOf(failures[0]) : 'invalid', failures[0]); continue; }

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
    else        { const r = await svc.create(user, dto);        accept(row, r.id, r); }   // value + unit from r (as stored)
    warnings.push(...rowWarnings);                  // only now: the row exists, or would
  } catch (e) {
    if (e instanceof ForbiddenException) throw e;   // backstop: the role is refused in the audited pre-flight
    error(row, mapException(e));                    // continue — never abort
  }
}
```

## Variant: staged rows, and a batch as the lifecycle unit

Use this shape instead of "one row → one record" when a file holds far more
rows than the records a screen can carry (a year of fuel card fills is ~45,000
rows; as records they would break every list's limit), when a row cannot become
a record until something outside the file is decided (whose company an account
is, which fuel a name means), or when review must act on a group, not a record.
The exemplar is `inc28-fuel-bulk`: `apps/api/src/fuel-files/` (read, stage,
uploads), `apps/api/src/fuel-accounts/` (the mapping rows wait on) and
`apps/api/src/fuel-batches/` (formation and the lifecycle). The rules above
still hold: every record is still written by the record service's own create
core. What changes is that **the file's rows are not records**.

1. **Rows are their own table, with states and a holder.** Store only the
   columns you need (no card numbers, plates or other identifiers), the import
   they came from (an `import_batches` row with its `source`; the file itself
   need not be kept), a `holder_id` (the uploader until a masterkey takes the
   rows over; only the holder forms batches, so the author and TA025's
   reporting company follow the holder), and a state decided by ONE pure
   function in shared-types (`fuelRowState`), in a fixed order: withdrawn, in a
   batch, waiting for an account, excluded, waiting for a fuel name, held (with
   its reason), ready. Every event re-states the rows it touches by that
   function, in the transaction that caused it (`restateAccountRows` after a
   mapping write). Nothing is deleted. Add the table's RLS with `rls-for-table`.
2. **Read, preview with a digest, then apply.** Read with the product's reader
   (`readWorksheet` in `bulk-upload/xlsx-reader.ts`: a sheet by name,
   asynchronous inflation, slices) through per-source adapters
   (`fuel-files/adapters/`: pure column maps, strict header refusal by name)
   under a parse deadline (`withParserDeadlineMs`) and an unpacked-size budget.
   Plan in a pure function over the reading, the stored reference rows and the
   stored live keys (`fuel-files/staging.ts`, `planStaging`). The preview runs
   the plan, stores nothing but its audit row, and answers the file's SHA-256.
   The apply sends that digest back (a different file is `fuel_file_changed`),
   then re-plans **inside one transaction** under the locks of what the plan
   reads, and stores the import, the reference rows first seen and the rows
   (chunked `INSERT … SELECT FROM jsonb_to_recordset`), with its audit row.
   Whole or nothing, so a retry is the same request; give it its own longer
   transaction timeout. This replaces the `dryRun` flag of the per-record loop.
3. **Dedupe with a digest in a partial unique index.** `dedupe_digest =
   sha256(source | key)`, unique per organisation, source and digest `WHERE
   state <> 'withdrawn'`. Insert with `ON CONFLICT … DO NOTHING RETURNING`, and
   count what did not come back as duplicates (a concurrent upload stored it).
   Report a stored key that waits in no batch under another holder apart
   (`fuel_duplicate_unbatched`), without naming the holder. A withdrawn key is
   free again; its new row names the one it replaces (`replaces_id`).
4. **A batch is the lifecycle unit; its records are sums per key.** Batches
   are formed by the holder in bounded steps (`FuelBatchFormationService`,
   stopping at a `WorkDeadline` of `BULK_DEADLINE_MS`), and each step answers
   `processableRows` so the page calls again only while it is above zero.
   **One group is one transaction:** an advisory lock on the group's natural
   key, the reference row `FOR SHARE`, the group's ready rows `FOR UPDATE`, the
   holder's open batch `FOR UPDATE` (or a new one with the next `sequence`),
   `declareFuelBatchStep`, `lockPeriodsShared` over every period the group
   writes (sorted, before any record row lock — a writer never waits on a
   period lock while holding a row lock), then each per-key sum through `previewCreate` +
   `createInTransaction` (+ `createRefusal`), the same gates a typed record
   meets, or `updateBatchQuantityLocked` for a key the batch already holds;
   link the rows; one audit row. On any refusal let the transaction roll back,
   then hold the group's ready rows with `holdReasonOf(error)` (by exception
   class) in a second, small statement. Held rows are tried again only on the
   holder's request (`retryHeld`), after a takeover or after a mapping write.
5. **Lifecycle steps act on the batch through the record cores.**
   `FuelBatchesService.step`: batch row `FOR UPDATE` → compare its status and
   submission with the caller's read → the step's gate → declare the batch →
   `lockPeriodsShared` over every record's period (sorted) → compare the live
   record set → each record by id through `lockSeenRecord` and the lifted core
   (`submitLocked`, `recallLocked`, `startReviewLocked`, `approveLocked`,
   `rejectLocked`) → the batch's status and one audit row. Take the periods of
   every record you will create, re-price or remove before any record row lock
   (the lifecycle protocol, `lifecycle-lock.ts`). Single-record paths refuse a
   batch's record (`assertNotInFuelBatch` → `RecordInBatchError`), and trigger
   TA029 refuses any write of one from a transaction that did not declare its
   batch, so an older image cannot act on it.
6. **Withdraw; never delete.** Withdrawing an open batch removes its records
   through the delete core (`removeLocked`) and keeps the batch and its rows
   `withdrawn` with who, when and why; unbatched rows are withdrawn the same
   way. Because the dedupe index covers live rows only, uploading the file
   again stores exactly the withdrawn rows again, as replacing rows, and they
   form a batch again.
7. **Files go on the group.** One file links to every live record of the batch
   under the batch row lock (`EvidenceService.uploadForFuelBatch`,
   `detachFromFuelBatch`); the evidence rule is still judged by the record
   cores at submit and approval.

Specs: DB-free for the reader and the writers (`read-fuel-file.spec.ts`,
`fuel-files.service.spec.ts`, `fuel-accounts.service.spec.ts`,
`fuel-batch-formation.service.spec.ts`, `fuel-batches.service.spec.ts`: joins,
further batches, refusals held with their reason, scope refusals, the step's
own refusals); the transactions, locks, races and the trigger against a real
database (`apps/api/test/int/fuel-*.int.spec.ts`), on synthetic fixtures
generated under `apps/api/test/fixtures/` (never a real provider file). State
the limits as provisional until a measurement sets them
(`fuel-files/limits.ts`).

## Traps this skill exists to record

They are in **[TRAPS.md](TRAPS.md)**, beside this file — fifteen of them, each a
measured incident: the lossy UTF-8 decode, exceljs's out-of-memory abort, how to
prove a defence (and the two ways of proving one that do not work), quoting the
file's own text, `dryRun` coercion, role-first, and batch logging.

Read it before writing the parser, the service loop, or any refusal sentence. It is a separate file
so that this one stays the recipe: the rules and the loop are what you follow
every time, the traps are what you check yourself against once.

## Verify

```bash
pnpm --filter @tonyai/shared-types build
pnpm --filter @tonyai/api typecheck && pnpm --filter @tonyai/api test
```
