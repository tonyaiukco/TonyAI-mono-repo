import { checkParserDeadline } from '../common/work-deadline';
import { isUtf8 } from 'node:buffer';
import { BadRequestException } from '@nestjs/common';
import Papa from 'papaparse';
import {
  BULK_UPLOAD_ALLOWED_EXTENSIONS,
  BULK_UPLOAD_COLUMNS,
  BULK_UPLOAD_MAX_ROWS,
  BULK_UPLOAD_REQUIRED_COLUMNS,
  type BulkUploadColumn,
} from '@tonyai/shared-types';
import { label, quoteCallerText } from '../common/caller-text';
import { readFirstWorksheet, type MergedRange } from './xlsx-reader';

/**
 * How many of a refused header's cells the sentence quotes. Each one is
 * bounded by `quoteCallerText`'s own two bounds, and delimited, which is what
 * keeps the longest possible refusal inside the code points an audit row
 * stores whole (`bulk-upload.service.spec.ts` pins that arithmetic).
 */
export const QUOTED_FRAGMENTS = 5;

/**
 * One data row as it came out of the file: every cell a string, keyed by the
 * canonical column name, plus the line number the user sees in their editor.
 *
 * Strings, deliberately — including the numeric columns. Parsing them here
 * would hide the one distinction that matters in an import: a cell that is not
 * a number at all. `''`, `'N/A'` and `'=SUM(A1)'` must reach the mapper as
 * themselves so they can be REFUSED, not silently become `0`. That is also why
 * `@Type(() => Number)` is not added to `CreateActivityRecordDto`: it would fix
 * the CSV case by breaking the live HTTP one, where `''` would become `0`.
 */
export interface ParsedRow {
  /** 1-based line in the file, header included — what Excel shows. */
  row: number;
  cells: Record<BulkUploadColumn, string>;
}

const COLUMN_BY_LOWER = new Map<string, BulkUploadColumn>(
  BULK_UPLOAD_COLUMNS.map((c) => [c.toLowerCase(), c]),
);

/** `.csv` / `.xlsx` off the filename, lowercased. Unknown → null. */
export function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  return fileName.slice(dot).toLowerCase();
}

/**
 * Map the file's header row onto the canonical columns, POSITION BY POSITION.
 *
 * Tolerant of case and surrounding whitespace, because a spreadsheet round-trip
 * changes both. Intolerant of anything else: an unrecognised header is a
 * REFUSAL, not a column quietly dropped — the same stance the global
 * `ValidationPipe` takes with `forbidNonWhitelisted`, and for the same reason.
 * A file whose `activity_value` column was ignored imports every row with a
 * missing value and looks like a data problem rather than a header problem.
 *
 * The result is aligned with the header: entry `i` is the column the file's
 * `i`-th cell belongs to, or `null` where the header cell is blank. It used to
 * be a compacted list while cells are read by position, so one blank header
 * cell (`…,activityUnit,,varianceReason`) shifted every later column one place
 * to the left — the unlabelled column's text was stored as the variance reason
 * and the real reason was dropped, with no error at all.
 */
function mapHeader(header: readonly string[]): (BulkUploadColumn | null)[] {
  const positions: (BulkUploadColumn | null)[] = [];
  const unknown: string[] = [];
  for (const raw of header) {
    const trimmed = raw.trim();
    const key = COLUMN_BY_LOWER.get(trimmed.toLowerCase());
    positions.push(key ?? null);
    if (!key && trimmed !== '') unknown.push(trimmed);
  }
  if (unknown.length > 0) {
    // Bounded, because this sentence is echoed into the response AND into the
    // audit row's `reason`: a 2 MiB header row was stored there whole (a
    // 1,960,160-character reason, measured) in a table with no delete path.
    // And quoted by the audit row's own rule, because the import panel renders
    // the response too: a U+202E in a header cell reverses everything after
    // it. The lookup above runs on the cell as written (trimmed), so the quote
    // NAMES each character it cannot show — `category<U+200B>` — instead of
    // reading as a column the file got right, and a run of them is one marker,
    // so padding cannot use up a fragment's units. The row refusals quote
    // cells by the same rule.
    //
    // Each cell is DELIMITED as well as quoted, because the sentence has
    // syntax of its own: undelimited, a header cell reading
    // `activityValue, category` made the refusal name two columns the file had
    // got right, and that sentence is stored as evidence in an append-only
    // table. `quoteCallerText` names the delimiter, so a cell cannot close one.
    const shown = unknown
      .slice(0, QUOTED_FRAGMENTS)
      .map((h) => `"${quoteCallerText(h)}"`);
    const more =
      unknown.length > QUOTED_FRAGMENTS
        ? ` (+${unknown.length - QUOTED_FRAGMENTS} more)`
        : '';
    throw new BadRequestException(
      `Unrecognised column(s): ${shown.join(', ')}${more}. Expected: ${BULK_UPLOAD_COLUMNS.join(', ')}.`,
    );
  }
  const mapped = positions.filter((c): c is BulkUploadColumn => c !== null);
  const missing = BULK_UPLOAD_REQUIRED_COLUMNS.filter(
    (c) => !mapped.includes(c),
  );
  if (missing.length > 0) {
    throw new BadRequestException(
      `Missing required column(s): ${missing.join(', ')}.`,
    );
  }
  const seen = new Set<BulkUploadColumn>();
  for (const c of mapped) {
    if (seen.has(c)) {
      throw new BadRequestException(`Column "${c}" appears more than once.`);
    }
    seen.add(c);
  }
  return positions;
}

/**
 * Refuse a value that no header names.
 *
 * A cell under a blank header, or past the header's last cell, cannot be
 * imported — and dropping it would lose something the user typed without
 * saying so. The same stance as an unrecognised header, one row lower.
 */
/**
 * The first code unit in `text` that Postgres cannot store, or null.
 *
 * There are exactly two, and both arrive the same way: SpreadsheetML's
 * `_xHHHH_` escape, which `decodeEscapes` turns into a code UNIT. Neither
 * needs an invalid byte, so the UTF-8 guards — on the CSV buffer and on each
 * XML part — cannot see them; a well-formed workbook can spell one. (That
 * those guards hold is what makes the refusal's "written as an escape"
 * sentence true: relax them and a raw byte becomes another way in.)
 *
 *   - **U+0000.** Measured against this repo's Postgres: a text value carrying
 *     one is refused (`invalid Unicode escape value` as a literal, SQLSTATE
 *     22021 as a bound parameter). NOT, to be clear, what keeps
 *     `bulk-upload.service.ts`'s NUL-joined slot key safe — none of that key's
 *     six segments is free text, which is what keeps it safe, and this guard
 *     never runs on the key.
 *   - **An UNPAIRED surrogate.** Refused the same way. A PAIR is a different
 *     thing and must keep working: `_xD83D__xDE00_` is how a workbook spells
 *     an emoji, it stores fine (measured, three code points), and refusing it
 *     would refuse ordinary text.
 *
 * Nothing else. Measured: U+FFFE and the other C0 controls store without
 * complaint, so this refuses exactly what Postgres refuses.
 *
 * Only DATA cells are checked. A header cell carrying one is already refused
 * by `mapHeader`, in a sentence that NAMES the character — better than a
 * generic refusal, and `caller-text.ts` owns that naming.
 */
function unstorableUnit(text: string): number | null {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit === 0) return unit;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      // NaN past the end, which fails this test and refuses the high half.
      if (low >= 0xdc00 && low <= 0xdfff) {
        i += 1;
        continue;
      }
      return unit;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return unit;
  }
  return null;
}

/**
 * Whole file, and NOT by the reason its neighbours give.
 *
 * `requireUtf8`, `unlabelledValue`, `mergedCells` and `tooManyRows` all refuse
 * the file for its SHAPE or its encoding; a content fault is row-level here by
 * design, and qa-auditor was right that the consistency argument does not
 * transfer. The reason that does: no editor produces `_x0000_` from typing —
 * Excel strips control characters on paste — so a file carrying one was
 * GENERATED, and a generated file with an unstorable character in it is not
 * the file the user thinks they are uploading. Importing its other 999 rows
 * and mentioning the odd one is the wrong default for a compliance product.
 *
 * The cost, measured and accepted: `_x0000_` in `activityValue` used to be a
 * row-level "is not a number" with the rest of the file imported. It is now a
 * refusal. If that trade ever looks wrong, `BulkUploadRowIssue.column` already
 * allows a row issue to name its column — the change is a channel on
 * `ParsedRow`, not a redesign.
 */
function unstorableCell(
  row: number,
  column: BulkUploadColumn,
  unit: number,
): BadRequestException {
  const named = label(unit);
  return new BadRequestException(
    `Row ${row} has a character in its ${column} cell that cannot be stored (${named}). ` +
      'A spreadsheet writes it as an escape rather than a typed character — clear the cell and enter the value again.',
  );
}

function unlabelledValue(row: number, column: number): BadRequestException {
  return new BadRequestException(
    `Row ${row} has a value in column ${column}, which has no header. Name the column or clear it.`,
  );
}

function emptyCells(): Record<BulkUploadColumn, string> {
  return Object.fromEntries(BULK_UPLOAD_COLUMNS.map((c) => [c, ''])) as Record<
    BulkUploadColumn,
    string
  >;
}

/** The row-cap refusal, naming the POPULATED rows — a count the user can check. */
function tooManyRows(count: number): BadRequestException {
  return new BadRequestException(
    `The file has ${count} rows; the limit is ${BULK_UPLOAD_MAX_ROWS}. Split it and upload the parts.`,
  );
}

/**
 * Refusal sentence for a CSV whose bytes are not UTF-8 text.
 *
 * Exported so the specs pin the refusal by the thing it refuses rather than by
 * its wording.
 */
export const FILE_NOT_UTF8 =
  'The file is not UTF-8 text. In Excel, save it as "CSV UTF-8 (Comma delimited)" and upload it again.';

/**
 * A CSV that is not UTF-8 is REFUSED, not decoded as best it can be.
 *
 * `Buffer#toString('utf8')` is lossy and never throws: an invalid byte becomes
 * U+FFFD. On a Turkish Windows, Excel's plain "CSV" export writes cp1254, so
 * this is the likely file rather than the exotic one — and `varianceReason` is
 * free text that no vocabulary check can catch, so the mojibake would be
 * stored on a record that can never be edited. Detecting the encoding and
 * transcoding would be worse: once the row is written a wrong guess is
 * indistinguishable from a right one, and this is a compliance product.
 *
 * Whole file, not per row. An encoding is a property of the file, and a
 * half-imported batch is the one outcome worse than a refused one.
 *
 * A NUL byte is refused alongside, because `isUtf8` accepts one (U+0000 is
 * valid UTF-8) and UTF-16LE ASCII is mostly NULs — which is what Excel's
 * "Unicode Text" export writes. No CSV a spreadsheet saves contains a NUL, and
 * the remedy is the same sentence, so it is the same refusal.
 */
function requireUtf8(buffer: Buffer): void {
  if (!isUtf8(buffer) || buffer.includes(0)) throw new BadRequestException(FILE_NOT_UTF8);
}

function parseCsv(buffer: Buffer): ParsedRow[] {
  // `header: false` on purpose: papaparse's header mode silently merges
  // duplicate headers and loses the physical line number, and both of those
  // are things this importer has to report on rather than absorb.
  // Strip the BOM. This product's own CSV export writes one (#91, so Excel
  // opens Turkish characters correctly), so re-importing a file TonyAI
  // generated is the first thing a user tries.
  //
  // Belt and braces, NOT the mechanism: `mapHeader` lowercases a trimmed
  // header, and `String.prototype.trim()` already strips U+FEFF — a fact this
  // repo measured and wrote down in `common/csv-cell.ts`. Deleting this line
  // changes no observable behaviour today. It is here so the header matcher
  // and the BOM are not silently coupled: a future matcher that stops trimming
  // would otherwise refuse a file for a column it visibly contains.
  requireUtf8(buffer);
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: false,
  });
  const table = parsed.data;
  if (table.length === 0) throw new BadRequestException('The file is empty.');

  const columns = mapHeader(table[0] ?? []);
  // Capped here as well as in the service: the service's check runs AFTER this
  // function returns, so a parser that builds the whole table first has
  // already paid the cost the cap exists to refuse.
  //
  // POPULATED rows are counted, not lines. Every CSV writer ends a file with a
  // newline, which papaparse returns as one more, empty, row — so counting
  // `table.length` refused a file of exactly 1,000 rows saved from Excel as
  // "1001 rows", at the one size the cap advertises. The XLSX path already
  // counts populated rows; this now agrees with it.
  //
  // And a blank line is dropped BEFORE anything is built for it. 2 MiB of bare
  // newlines is ~2.1M lines, and building a cells object for each one held the
  // event loop for ~1.3 s before the file was refused as empty (measured) —
  // five times a minute, for any user who may import.
  const populated: number[] = [];
  for (let i = 1; i < table.length; i += 1) {
    checkParserDeadline();
    if (table[i]?.some((cell) => (cell ?? '').trim() !== '')) populated.push(i);
  }
  if (populated.length > BULK_UPLOAD_MAX_ROWS) throw tooManyRows(populated.length);
  return populated.map((i) => {
    const cells = emptyCells();
    (table[i] ?? []).forEach((value, index) => {
      const column = columns[index] ?? null;
      if (column) cells[column] = value ?? '';
      else if ((value ?? '').trim() !== '') throw unlabelledValue(i + 1, index + 1);
    });
    return { row: i + 1, cells };
  });
}

/**
 * The first worksheet — read by `readFirstWorksheet`, which says why that is no
 * longer exceljs — as the same rows the CSV path returns.
 *
 * The cap counts POPULATED rows, as the CSV path does. Rows past it are counted
 * and never kept, so the refusal names the real count while the parser holds
 * no more than the cap. (exceljs's `sheet.rowCount` was the highest row INDEX:
 * walking it over one row at 1,048,576 allocated 2,348 MB from a 6.6 KB file.
 * A streamed sheet has no index to walk.)
 *
 * A merged range is refused when it COVERS — rather than starts at — a cell
 * the import reads: the header, or an imported column on a kept row. On screen
 * the corner's value fills the whole range; in the file only the corner holds
 * it. exceljs's loader copied the corner's value into every covered cell, and a
 * reader that ignores merges leaves them blank, so a merged `locationId` would
 * import as "whole company". Neither can be assumed to be what the user meant.
 * A merge that covers only blank rows or unimported columns changes nothing,
 * and passes.
 */
async function parseXlsx(buffer: Buffer): Promise<ParsedRow[]> {
  const progress: {
    columns: (BulkUploadColumn | null)[] | null;
    imported: ImportedColumn[] | null;
    populated: number;
  } = { columns: null, imported: null, populated: 0 };
  // Kept as the import will read them: the imported cells, plus the column of
  // the first value no header names. A row then costs nine strings however
  // wide it is — keeping every cell let a 40 KB upload of blank-looking cells
  // grow the heap by over 100 MB (qa-auditor, measured).
  const kept: (ParsedRow & {
    unlabelled: number | null;
    unstorable: { column: BulkUploadColumn; unit: number } | null;
  })[] = [];
  // A sheet with no header row reads as an empty header, which `mapHeader`
  // refuses by naming every required column as missing.
  const header = () => (progress.columns ??= mapHeader([]));

  await readFirstWorksheet(buffer, {
    row(rowNumber, cells) {
      if (rowNumber === 1) {
        const names: string[] = [];
        for (const cell of cells) names[cell.column - 1] = cell.value;
        progress.columns = mapHeader(Array.from(names, (name) => name ?? ''));
        return;
      }
      const columns = header();
      if (!cells.some((cell) => cell.value.trim() !== '')) return;
      progress.populated += 1;
      if (progress.populated > BULK_UPLOAD_MAX_ROWS) return;
      const mapped = emptyCells();
      let unlabelled: number | null = null;
      let unstorable: { column: BulkUploadColumn; unit: number } | null = null;
      for (const { column, value } of cells) {
        const key = columns[column - 1] ?? null;
        if (key) {
          // RECORDED, not thrown. Throwing from inside the stream jumped the
          // row cap and the unlabelled-value ordering below — a 5,000-row file
          // with one bad cell reported the character and left the user to
          // discover the cap on the next upload (qa-auditor, measured). The
          // refusals are ordered once, after the stream, like the others.
          if (unstorable === null) {
            const unit = unstorableUnit(value);
            if (unit !== null) unstorable = { column: key, unit };
          }
          mapped[key] = value;
        } else if (unlabelled === null && value.trim() !== '') unlabelled = column;
      }
      kept.push({ row: rowNumber, cells: mapped, unlabelled, unstorable });
    },
    merge(range) {
      // Over the cap the whole file is refused, so its merges do not matter.
      if (progress.columns === null || progress.populated > BULK_UPLOAD_MAX_ROWS) {
        return;
      }
      progress.imported ??= importedColumns(progress.columns);
      const covered = coveredImportCell(range, progress.imported, kept);
      if (covered) throw mergedCells(range, covered.row, covered.column);
    },
  });

  header();
  if (progress.populated > BULK_UPLOAD_MAX_ROWS) {
    throw tooManyRows(progress.populated);
  }
  // In row order, so the refusal names the first such row. A kept row with no
  // unlabelled value holds a non-blank imported one, so none of them is blank.
  // Shape before content, and each family in row order: a value no header
  // names says the file is not the shape the import reads, which is worth
  // knowing before a character in one of its cells.
  for (const { row, unlabelled, unstorable } of kept) {
    if (unlabelled !== null) throw unlabelledValue(row, unlabelled);
    if (unstorable) throw unstorableCell(row, unstorable.column, unstorable.unit);
  }
  return kept.map(({ row, cells }) => ({ row, cells }));
}

interface ImportedColumn {
  column: number;
  key: BulkUploadColumn;
}

/** Where the header's imported columns sit — nine at most. */
function importedColumns(
  columns: readonly (BulkUploadColumn | null)[],
): ImportedColumn[] {
  return columns.flatMap((key, index) => (key ? [{ column: index + 1, key }] : []));
}

/**
 * The first cell the import reads that a merged range covers without being its
 * corner, or null. Only the imported columns are visited and kept rows are
 * found by binary search, so no range is ever walked cell by cell.
 */
function coveredImportCell(
  range: MergedRange,
  imported: readonly ImportedColumn[],
  kept: readonly { row: number }[],
): { row: number; column: BulkUploadColumn } | null {
  for (const { column, key } of imported) {
    if (column < range.left || column > range.right) continue;
    // In the corner's own column the range covers the rows below the corner;
    // in every other column, all of its rows.
    const firstCovered = column === range.left ? range.top + 1 : range.top;
    if (firstCovered === 1) return { row: 1, column: key };
    const row = firstRowFrom(kept, firstCovered);
    if (row !== undefined && row <= range.bottom) return { row, column: key };
  }
  return null;
}

function firstRowFrom(
  rows: readonly { row: number }[],
  from: number,
): number | undefined {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((rows[middle]?.row ?? Number.POSITIVE_INFINITY) < from) low = middle + 1;
    else high = middle;
  }
  return rows[low]?.row;
}

function mergedCells(
  range: MergedRange,
  row: number,
  column: BulkUploadColumn,
): BadRequestException {
  return new BadRequestException(
    `Row ${row} is inside the merged cells ${range.ref}, which cover its ${column} cell. Unmerge the cells and fill in each row.`,
  );
}

/**
 * Read a bulk file into rows. The EXTENSION picks the parser, not the MIME
 * type — browsers disagree about `.csv` (Windows sends
 * `application/vnd.ms-excel`), so trusting the declared type here would route
 * an ordinary spreadsheet export to the wrong reader.
 */
export async function parseRows(
  buffer: Buffer,
  fileName: string,
): Promise<ParsedRow[]> {
  checkParserDeadline();
  const extension = extensionOf(fileName);
  if (extension === '.xlsx') return parseXlsx(buffer);
  if (extension === '.csv') return parseCsv(buffer);
  throw new BadRequestException(
    `Unsupported file type. Accepted: ${BULK_UPLOAD_ALLOWED_EXTENSIONS.join(', ')}.`,
  );
}

/**
 * A number, or `null` when the cell is not one.
 *
 * Strict on purpose, and each refusal is a real import defect:
 * - `''` must not become `0` — a blank consumption cell is a missing figure,
 *   and zero is a reported quantity that would enter the inventory.
 * - `'1,200'` is ambiguous across locales (1200 or 1.2?), so it is refused
 *   rather than guessed. Guessing wrong misstates an emissions figure.
 * - `'=SUM(A1)'` and `'12kWh'` fail as types, which is the cheapest possible
 *   formula defence: no allow-list to maintain, no false positives.
 */
export function strictNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
