# Traps — bulk ingest

Companion to [SKILL.md](SKILL.md). Every entry is a measured incident from the
WP8 bulk-import work. The RULE is the payload; the number is there only so you
can tell a real trap from a preference. The forensics live in the PR history
(`docs/roadmap_docs/project-status.md`, #94-#131) — do not re-import them here.

- **Take the file's bytes as UTF-8 or refuse them.** `Buffer#toString('utf8')`
  and `StringDecoder('utf8')` never throw — an invalid byte becomes U+FFFD and
  the import succeeds, silently, into whatever column no vocabulary checks. On
  a Turkish Windows, Excel's plain `CSV` export writes cp1254, so this is the
  ordinary file. Guard with `isUtf8` (plus a NUL check), refuse the WHOLE file,
  and never detect-and-transcode: once the row is written a wrong guess reads
  exactly like a right one. For XLSX the check goes on each XML PART, not the
  upload, which is a zip — saxes syntax-checks the declared encoding's NAME and
  then ignores it. `_xHHHH_` escapes are a separate door needing no bad byte,
  and closing that one naively breaks valid surrogate PAIRS.
- **Never read an untrusted XLSX with exceljs.** `workbook.xlsx.load` expands
  every range a file declares, and a ~2 KB file killed the process with a V8
  out-of-memory abort — no exception, no audit row, every tenant's in-flight
  request gone; a heap-capped worker did not contain it. Stream instead, with
  ONE unpack budget on zlib's `maxOutputLength` (never the archive's declared
  sizes), handler-side caps on XML nesting and attributes, and ranges read by
  their corners.
- **Prove a defence by what it IS, and measure before choosing.** Heap delta
  beats elapsed time where the defect allocates (a CI-safe time budget let a
  2,348 MB walk through) — but heap cannot separate a loop from a binary
  search, and a test-runner TIMEOUT cannot catch a synchronous stretch at all:
  a 31 s mutant passed with no assertion, because a timeout is a timer on the
  loop being held. Where time is the only observable, spend the effort on the
  MARGIN — scale the fixture, or budget the hot function directly instead of
  through the parse around it. Rebuild the exact defect first: a near-miss
  mutant clears a test a real regression would not.
- **Text from the file gets linear code, run once.** Regexes over it must be
  unambiguous (`\d+\.?\d*` backtracked 582 ms over one cell), and a value many
  things point at is judged where it is READ, not per reference (65,536 cell
  formats sharing one code held the loop 56 s from a 7 KB file). Cap the length
  of anything you evaluate — a cap cannot drift the way a budget can.
- **Refuse a merged range that covers an imported cell.** On screen the
  corner's value fills the range; in the file only the corner holds it, so
  copying it down and reading blanks are both guesses. Check imported columns
  against kept rows by binary search.
- **Join the slot key with `'\u0000'`**, which no cell can contain — then check
  whether a collision is actually constructible before claiming it in a
  comment, and do not test a state nothing can reach.
- **An anomalous row with no variance reason imports and can then never be
  submitted.** Warn in the report, or the user finds out a thousand rows later.
  Relatedly, drafts stay out of the anomaly baseline, so rows in one batch
  cannot shift each other's verdict — say so, because it explains why an
  import-time verdict can differ from the one `submit` re-derives.
- **Never echo an unexpected error's text into the report** — it can carry a
  query, a path or a column. Log it; report a refusal.
- **Quote the file's own text with `quoteCallerText`; bounding is not enough
  and neither is cleaning.** A refusal quotes cells into the 400 the panel
  renders AND the audit row, so cleaning only the audit copy put a U+202E on
  the screen, reversing everything after it. STORE with `sanitiseCallerText`,
  QUOTE with `quoteCallerText`, which NAMES what it cannot show. Four rules,
  one incident each: DELIMIT each quoted cell and name the delimiter (a cell
  reading `activityValue, category` made a refusal name two columns the file
  got right); match the cell AS WRITTEN, never cleaned (or its refusal reads
  "Unrecognised column(s): category. Expected: …, category, …"); bound TWICE,
  in units and in code points, or a marker is cut in half — a count of forty
  stored as four, in a table with no correction path; and quote a VALUE, never
  the whole cell, because one shared string backing every row turned a
  12,416-byte workbook into a 32,092,008-byte report. Pin the arithmetic.
- **A sentence passed through from another service is caller text too.** Fix it
  at the source so the single-record API gets the fix, and cap the field on its
  DTO — the value is stored, snapshotted and exported verbatim. Watch one more
  mouth: a class-validator decorator's `$value` is substituted into the
  FINISHED message as a `String.replace` replacement, so `$'` and `$&` expand —
  seven `$value` tokens returned an 18,563,231-byte 400.
- **`dryRun` must not coerce.** `Boolean('yes')` and `Boolean('0')` are both
  `true`, and every imported row is an audited write. Accept only recognised
  spellings — **the empty string included**: the WP8 exemplar shipped
  `'' → false`, so a blank `dryRun=` imported the whole file while the docblock
  above it promised a refusal.
- **Check the role FIRST, inside the audited pre-flight.** Left to the create
  service the 403 is thrown from the loop, past the audited refusal and before
  the batch row, so the attempt leaves no trace — and a file whose every row
  fails validation never reaches the check, so the caller gets a 200 report
  instead of a refusal.
- **Report warnings only for rows that are, or would be, imported.** Pushed
  eagerly, a refused row's warning told a user importing one row of ten that
  five needed attention.
- **Cap POPULATED rows, not lines** (a trailing newline refused exactly 1,000
  rows as "1001"), and **count distinct ROWS in any sentence that says "rows"**
  — one row can carry several issues, so `errors.length` is an issue count.
- **Log the BATCH, never the row.** Fifty rows carrying one oversized cell
  wrote 148,542 bytes of stderr, which the row cap scales to ~3 MB per request,
  five times a minute per user — and the report stays small, so nothing shows
  the cost. Emit one line: the count, the first ten refs, the FIRST failure and
  ONE stack. Three things are easy to get wrong: the accumulator must be a
  LOCAL (these services are Nest singletons, and a field mixes two tenants into
  one line); the flush belongs in a `finally`, because the role backstop fires
  only while nothing has been accepted — exactly what a run of failures leaves;
  and the line quotes caller text, so the stack goes through
  `sanitiseCallerText` LINE BY LINE, or that helper's C0 drop folds thirty
  frames into one unreadable run.
