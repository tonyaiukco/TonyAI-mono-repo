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
- **Key every segment in the DATABASE's spelling, never the file's — and
  accept ONE spelling of an id.** A typed column accepts more than one spelling
  of one value and returns exactly one; a JS `Set` compares the text. For a
  `uuid` the boundary takes the hyphenated shape in either case and lowercases
  it (`canonicalUuid` beside `UUID_SHAPE`, applied by the resource DTO's
  `@Transform` + `@Matches` and to the file's id cells before the tenant check,
  the stored-slot query and the in-file key read them); `{…}`, `urn:uuid:…` and
  the unhyphenated form are refused as `invalid` on their own row. Do NOT fold
  them: that was tried (#113) and needed a hand-measured table of the driver's
  grammar, a probe to keep it honest and a rewrite of the caller's cells, for
  spellings nobody types — every id the system shows is hyphenated. Two
  consequences to keep: only a cell that IS an id goes into a tenant check or a
  Prisma `IN` list (a non-uuid there is a P2023, outside every catch), and a
  blank optional id stays blank. (Test with ids that contain hex LETTERS: every
  seeded id is decimal digits, so `toUpperCase()` is a no-op on them.)
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
- **One audit row for the batch under its OWN verb, plus the per-row rows the
  create path already writes.** `bulk_import` / `bulk_submit` with
  `entityId: null` and a `diff.bulk` summary — never an existing verb with a
  null id, which made a refusal indistinguishable from a record that was
  created. Adding the verb is one member in `AUDIT_ACTIONS` (shared-types)
  plus one entry in the web audit page's exhaustive colour map; that compile
  error is the point of the map. Write the batch row on a dry run and on an
  apply, even when every row failed. Of the pre-flight refusals, audit only
  the ones that say something about the CALLER — a role that may not write, a
  file naming another tenant's entity — not a malformed file (bad header,
  wrong extension, empty, oversized, too many rows): that is a 400 that
  touched nothing, and auditing it fills an append-only table with
  caller-controlled text at the throttle's rate.
- **Cap rows and bytes explicitly.** Nest's 100 KB JSON body limit does **not**
  apply to a multipart upload. Derive the row cap from the per-row query budget,
  and write the arithmetic down beside the constant.
- **The extension is the gate; the MIME type is advisory.** Windows browsers
  send `.csv` as `application/vnd.ms-excel` (and sometimes
  `application/octet-stream`), so a MIME rule (what `evidence` has) refuses an
  ordinary spreadsheet export. The declared type is client-controlled and buys
  no security: the extension picks the parser, and the parser refuses what is
  not a spreadsheet.
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
   and a route-scoped `ThrottlerGuard`; never a second `APP_GUARD`. The throttler's
   storage is `PerKeyThrottlerStorage`: `@nestjs/throttler` 6.5.0's own storage
   stops every other throttled key's hits from expiring when any one block ends. Do
   not swap it back while its tripwire test still passes.
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

- **Never read an untrusted XLSX with exceljs.** `workbook.xlsx.load` expands
  every range a file declares, cell by cell — a whole-column dropdown, a merge,
  a defined name, a `<col>` span — and a ~2 KB file killed the process with a
  V8 out-of-memory abort: no exception, no audit row, every tenant's in-flight
  request gone. A heap-capped worker did not contain it either. The streaming
  reader avoids those four and still inflates with no limit, caches every
  shared string before row 1 and spools the sheet to a temp file. Use
  `readFirstWorksheet` (`xlsx-reader.ts` over `zip-reader.ts`): ONE unpack
  budget enforced by zlib's `maxOutputLength` (never the archive's declared
  sizes), handler-side caps on XML nesting and attributes — saxes holds both in
  memory, and three million attributes on one tag aborted a 256 MB process —
  and ranges reported by their corners, never walked.
- **Prove those defences by what they are, not by what they say.** Heap delta,
  not elapsed time (a time budget loose enough for CI let a 2,348 MB walk
  through); and the unpack limit by the argument zlib receives, because a
  refusal reads the same whether inflation stopped at the limit or ran to the
  end first.
- **Text from the file gets linear code, run once.** A regex over it must be
  unambiguous — `\d+\.?\d*` backtracked for 582 ms over one 32,767-digit cell,
  and stripping `[...]` with a pattern took 1.8 s over 64 KB of `[` — and a
  value many things point at is judged where it is read, not once per
  reference: 65,536 cell formats sharing one number-format code held the event
  loop for 56 s from a 7 KB file. Cap the length of anything you evaluate.
- **Refuse a merged range that covers an imported cell.** On screen the
  corner's value fills the range; in the file only the corner holds it.
  Copying it down (exceljs's loader) and reading blanks (a merge-blind reader,
  where a merged `locationId` imports as whole-company) are both guesses. Check
  the imported columns against the kept rows by binary search; a merge that
  covers only blank rows or unimported columns changes nothing.
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
- **Quote the file's own text with `quoteCallerText` — bounding it is not
  enough, and neither is cleaning it.** "Unrecognised column(s): …" quotes
  header cells into the 400 the panel renders AND into the audit row's
  `reason`. Only the audit copy was cleaned, so a U+202E in a header cell
  reached the screen, where it reverses everything after it. One rule in
  `apps/api/src/common/caller-text.ts` decides what reaches neither: controls,
  unpaired surrogates, U+2028/U+2029, every format character except ZWJ, ZWNJ
  and the drawn prepended concatenation marks, and the code points reserved as
  invisible but unassigned. STORE with `sanitiseCallerText` (the audit row's
  `fileName` and `reason`). QUOTE with `quoteCallerText`, which NAMES every
  character it cannot show — including the invisible ones the rule KEEPS (a
  variation selector, ZWJ: quoted as they are, they reproduce the very
  confusion this trap is about), U+2800 (the blank people paste when they want
  an invisible character, which Unicode files as a symbol so nothing else
  catches it), and the characters the sentence's own syntax uses — writing each
  run as `<U+2063 x40>`. DELIMIT each quoted cell and name the delimiter: the
  sentence joins cells with `, `, so an undelimited cell reading
  `activityValue, category` made the refusal name two columns the file had got
  right, into an append-only row kept as evidence. Every layer of syntax you
  add is a layer a file can forge. Match the
  cell as written (trimmed), never the cleaned one: looked up cleaned,
  `category` + U+200B would import as `category`, and quoted cleaned, its
  refusal read "Unrecognised column(s): category. Expected: …, category, …".
  Bound a quote TWICE: in units, so padding cannot push a name out, and in code
  points, or the sentence outgrows the column that stores it and a marker is
  cut in half — a count of forty stored as four, in a table with no correction
  path. Pin that arithmetic in a test. To prove the quote on XLSX, write the
  NUL as `_x0000_`: exceljs's writer drops a literal one, so there would be no
  NUL to name.
- **Quote a value, never the whole cell, and bound the report as well.** One
  XLSX shared string can back a cell on every row, so a thousand refusals that
  each quoted their cell turned a 12,416-byte workbook into a 32,092,008-byte
  report. Quote through `quoteCallerText`, which NAMES what it cannot show rather
  than dropping it, bounded in units and in code points and marked `…`. A sentence the loop passes through from another service is
  caller text too. The record service's period refusal, `IsActivityUnit`'s
  message and the calc engine's unit sentences all quoted raw input, and the
  engine's are reachable with a KNOWN unit padded out, because `canonicalUnit`
  collapses whitespace. Fix them at the source (the single-record API gets the
  fix too), and cap the field on its DTO — not to pre-empt the vocabulary
  check, which runs anyway and accepts a padded spelling of any length, but
  because the value is stored, snapshotted and exported verbatim. A custom
  class-validator decorator has one more mouth: the framework replaces `$value`
  in the FINISHED message with the raw value, as a `String.replace` replacement
  string, so `$'` and `$&` expand too — a unit made of seven `$value` tokens
  put the whole of itself back seven times, and a 99,994-byte body returned an
  18,563,231-byte 400. Strip `$` from whatever such a message quotes. Keep
  the report's own bound, `BULK_UPLOAD_MESSAGE_MAX_LENGTH`, as the backstop,
  applied after `toIssue` has classified the failure by its RAW message. The
  issue count needs no cap: each row is accepted or refused once, so the row
  cap bounds it. Pin that with a test rather than trusting it.
- **`dryRun` must not coerce.** `Boolean('yes')` is `true` and `Boolean('0')` is
  `true`; a permissive flag imports a file the user asked to be told about, and
  every row is an audited write. Accept only recognised spellings of true/false
  and let anything else fail `@IsBoolean` — **the empty string included**. The
  WP8 exemplar shipped `'' → false`, so a blank `dryRun=` field imported the
  whole file while the docblock above it promised a refusal.
- **Check the role FIRST, inside the audited pre-flight.** Leaving it to the
  create service means the 403 is thrown from the loop, past the audited
  refusal and before the batch row — the attempt leaves no trace — and a file
  whose every row fails validation never reaches the check, so the caller gets
  a 200 report instead of a refusal. Keep the in-loop `ForbiddenException`
  rethrow as a backstop only.
- **Report warnings only for rows that are, or would be, imported.** Collect a
  row's warnings locally and publish them with the accepted row. Pushed eagerly,
  a refused row carried "needs an evidence file before it can be submitted",
  and the verdict told a user importing one row of ten that five needed
  attention.
- **Cap POPULATED rows, not lines.** Every CSV writer ends a file with a newline
  that the parser returns as one more empty row; counting lines refused exactly
  1,000 rows saved from Excel as "1001 rows".
- **Count distinct ROWS in every sentence that says "rows".** One row can carry
  several errors and several warnings; `errors.length` and `warnings.length`
  are issue counts.
- **Log the BATCH, never the row.** An unrecognised failure wants its error and
  its stack recorded — but once per row that is a flood the caller sizes: 50
  rows carrying a 2,001-character cell wrote 148,542 bytes of stderr (fifty
  Prisma stacks with code frames), so the 1,000-row cap puts one request near
  3 MB, five times a minute per user. The report stays small, so nothing in it
  shows the cost. Fold into `BatchFailureLog` (`apps/api/src/common/`) and emit
  one line: the count, the first ten refs plus a count of the rest, each class
  with its count, its first ref and a sample message, and ONE stack. Three
  things are easy to get wrong. The accumulator is a LOCAL of the batch method —
  these services are Nest singletons, and a field would mix two tenants' rows
  into one line. The flush belongs in a `finally`, because the loop's
  `ForbiddenException` backstop fires only while nothing has been accepted,
  which is exactly the state a run of failures leaves behind. And what the line
  quotes is caller text: a Prisma parse failure names the character it choked
  on, so the sample goes through `sanitiseCallerText` and the stack goes through
  it LINE BY LINE — that helper drops C0 controls, U+000A among them, and would
  otherwise fold thirty frames into one unreadable run.

## Verify

```bash
pnpm --filter @tonyai/shared-types build
pnpm --filter @tonyai/api typecheck && pnpm --filter @tonyai/api test
```
