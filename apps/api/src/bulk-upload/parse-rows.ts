import { BadRequestException } from '@nestjs/common';
import Papa from 'papaparse';
import {
  BULK_UPLOAD_ALLOWED_EXTENSIONS,
  BULK_UPLOAD_COLUMNS,
  BULK_UPLOAD_MAX_ROWS,
  BULK_UPLOAD_REQUIRED_COLUMNS,
  type BulkUploadColumn,
} from '@tonyai/shared-types';
import { sanitiseCallerText } from '../common/caller-text';
import { readFirstWorksheet, type MergedRange } from './xlsx-reader';

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
    // And cleaned, by the audit row's own rule, because the import panel
    // renders the response too: a U+202E in a header cell reverses everything
    // after it. Cleaning comes before the cut, so dropped characters cannot
    // use up a fragment's 40.
    const shown = unknown
      .slice(0, 5)
      .map((h) => sanitiseCallerText(h, 40, '…'));
    const more = unknown.length > 5 ? ` (+${unknown.length - 5} more)` : '';
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
  const kept: (ParsedRow & { unlabelled: number | null })[] = [];
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
      for (const { column, value } of cells) {
        const key = columns[column - 1] ?? null;
        if (key) mapped[key] = value;
        else if (unlabelled === null && value.trim() !== '') unlabelled = column;
      }
      kept.push({ row: rowNumber, cells: mapped, unlabelled });
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
  for (const { row, unlabelled } of kept) {
    if (unlabelled !== null) throw unlabelledValue(row, unlabelled);
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
