/**
 * One CSV cell: spreadsheet-formula neutralisation, then RFC-4180 quoting.
 *
 * It lives here rather than in `reports/` because it is not a report concern.
 * A bulk IMPORT has to answer the same question on the way in — see
 * `isFormulaLead` — and a parser reaching into the report writer to ask it
 * would be a dependency pointing the wrong way.
 *
 * Three properties are load-bearing and none is obvious:
 *
 * ORDER. The formula prefix runs BEFORE the quote test, so a `'`-prefixed
 * string is then quoted only if it also contains a separator. Reversing them
 * yields `'"…"`.
 *
 * THE BARE `\r`. Most parsers end a record on it, so a withdrawal reason
 * containing one would split into a second row — a fabricated ledger line, in
 * the artifact a reader trusts, behind no database row and no audit entry. A
 * browser sends `\r\n`, so reaching this needs a deliberate API call; it is
 * still a forgery.
 *
 * NUMBERS ARE NOT NEUTRALISED. See `neutraliseCell`.
 *
 * None of it may move into a per-column renderer: one column could then opt
 * out, and the opt-out is a forged row.
 */

/** What a flat-export cell may hold before quoting. */
export type CellValue = string | number;

/**
 * Would a spreadsheet execute this text if it opened the file?
 *
 * The leading `\s*` is the whole point, and its absence was a real hole: the
 * first cut anchored `[=+\-@]` at index 0, so `"   =SUM(A1)"` matched nothing,
 * gained no prefix, and — carrying no separator either — shipped raw and
 * unquoted. Excel and Sheets skip leading whitespace before deciding a cell is
 * a formula, so the guard has to skip it too.
 *
 * WHAT `\s` IS, measured rather than recalled (swept U+0000-U+10FFFF): exactly
 * 25 codepoints — 0009 000A 000B 000C 000D 0020 00A0 1680 2000-200A 2028 2029
 * 202F 205F 3000 FEFF. That is byte-identical to `String.prototype.trim()`'s
 * set and a strict superset of Unicode `Zs`.
 *
 * WHAT IT IS NOT: every variant of the evasion. U+0085 NEL, U+200B ZWSP,
 * U+2060 WJ, U+180E, the U+200C-U+200F bidi/joiner family and U+001C-U+001F
 * are the same idea and are NOT covered — `csvField('\u200B=1+1')` ships
 * unprefixed. They are unaddressed deliberately: no spreadsheet is known to
 * skip them before parsing a formula, so widening the class would be
 * over-neutralisation guessed at rather than measured. The residual is
 * identical to the one shipped before this guard existed. Revisit if a
 * spreadsheet is ever shown to skip one.
 *
 * The premise itself — that a spreadsheet skips leading whitespace before
 * deciding a cell is a formula — is NOT tested in this repo. It is the
 * load-bearing assumption under the whole function.
 *
 * Exported as its own predicate because DETECTION and NEUTRALISATION are
 * different operations with opposite correct answers on an upload path. A
 * bulk import must never prefix on the way in: the apostrophe would be stored
 * in `activity_records`, re-neutralised on the next export, and the user's
 * value corrupted for good.
 *
 * FLAG, DO NOT REFUSE. There is no rendering context on ingest — `=SUM(A1)`
 * sitting in a Postgres text column is inert, and the security control is the
 * writer below, which now runs on every cell unconditionally. Rejecting a row
 * for leading `=` buys nothing and costs real values: a variance reason of
 * "-15% due to a line shutdown" leads with `-`. A row-level warning in the
 * validation report is the whole correct use of this predicate.
 *
 * The ingest controls that actually pay are type-shaped, not character-shaped:
 * a strict numeric parse for `activityValue` (kills `=SUM(A1)` as a type error
 * with no false positives), the existing `@IsIn` allow-lists — and length
 * caps, which `periodValue`, `legalName` and `tradingName` still lack.
 */
export function isFormulaLead(s: string): boolean {
  return /^\s*[=+\-@]/.test(s);
}

/**
 * Neutralise a cell's VALUE, without changing what it says.
 *
 * The prefix goes in front of the original string; the whitespace is not
 * trimmed. Silently rewriting a figure or a reason inside a compliance
 * artifact is the worse of the two failures — the apostrophe is visible and
 * honest, a trimmed cell is a quiet edit nobody consented to.
 *
 * A finite `number` returns unprefixed, and that branch exists for one
 * measured reason: `-` leads a formula AND leads every negative number, so
 * stringifying first turns `-12.5` into the text `'-12.5`, which Excel's SUM
 * skips — while the Excel export writes the same column as a real numeric
 * cell. That is the 429,815-unit class of defect: a total that disagrees with
 * itself across two files generated from one query. No negative reaches a CSV
 * cell today (`activityValue` is `@Min(0)`, every seeded factor is positive
 * and factors have no write endpoint), so this closes the branch before it
 * opens rather than after. `-Infinity` and `NaN` are NOT finite, fall through
 * to the string path, and are prefixed like any other hostile text.
 */
export function neutraliseCell(v: CellValue): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const s = String(v);
  return isFormulaLead(s) ? `'${s}` : s;
}

/** A cell, neutralised and then quoted — the last transform before the join. */
export function csvField(v: CellValue): string {
  const s = neutraliseCell(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
