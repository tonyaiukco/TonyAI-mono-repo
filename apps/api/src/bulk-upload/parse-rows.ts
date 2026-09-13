import { BadRequestException } from '@nestjs/common';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import {
  BULK_UPLOAD_ALLOWED_EXTENSIONS,
  BULK_UPLOAD_COLUMNS,
  BULK_UPLOAD_MAX_ROWS,
  BULK_UPLOAD_REQUIRED_COLUMNS,
  type BulkUploadColumn,
} from '@tonyai/shared-types';

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
    throw new BadRequestException(
      `Unrecognised column(s): ${unknown.join(', ')}. Expected: ${BULK_UPLOAD_COLUMNS.join(', ')}.`,
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

/**
 * An exceljs cell value as a string.
 *
 * Worth spelling out because a spreadsheet cell is not a string: it can be a
 * number, a Date, rich text (styled runs), a hyperlink object, or a formula
 * carrying its last computed result. Reading `.value` naively yields
 * `[object Object]` for three of those, which would then fail validation as a
 * mystery rather than as the value the user can see on their screen.
 *
 * A formula cell resolves to its cached RESULT. The alternative — refusing it —
 * would reject the most ordinary spreadsheet there is, one with a SUM column.
 */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const candidate = value as {
      result?: unknown;
      text?: unknown;
      richText?: { text?: string }[];
      error?: unknown;
    };
    if (Array.isArray(candidate.richText)) {
      return candidate.richText.map((r) => r?.text ?? '').join('');
    }
    // A formula that evaluated to an error (#REF!, #DIV/0!) has `error` and no
    // usable result. Return the error text so the row is refused naming what
    // the user sees, rather than refused as an empty cell.
    if (candidate.error !== undefined) return String(candidate.error);
    if ('result' in candidate) return cellToString(candidate.result);
    // `text` is a string on a plain hyperlink cell and a rich-text OBJECT on a
    // formatted one — recursing covers both. Returning '' for the second
    // silently dropped whatever the user had written in that cell.
    if (candidate.text !== undefined) return cellToString(candidate.text);
  }
  return '';
}

function isBlankRow(cells: Record<BulkUploadColumn, string>): boolean {
  return Object.values(cells).every((v) => v.trim() === '');
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
  if (populated.length > BULK_UPLOAD_MAX_ROWS) {
    throw new BadRequestException(
      `The file has ${populated.length} rows; the limit is ${BULK_UPLOAD_MAX_ROWS}. Split it and upload the parts.`,
    );
  }
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

async function parseXlsx(buffer: Buffer): Promise<ParsedRow[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException('The file could not be read as a workbook.');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new BadRequestException('The workbook has no sheets.');

  const headerRow = sheet.getRow(1);
  const header: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    header[colNumber - 1] = cellToString(cell.value);
  });
  const columns = mapHeader(Array.from(header, (h) => h ?? ''));

  // `actualRowCount` (populated rows), never `rowCount` (the highest row
  // INDEX). A 6.6 KB workbook whose single data row sits at Excel's maximum
  // row, 1,048,576, has `rowCount === 1048576` — and `getRow(r)` MATERIALISES
  // a Row, as does `getCell(i)`. Walking that range allocated ~9.4M objects
  // and killed the process with a V8 `FATAL ERROR: heap out of memory` in 1.7
  // seconds. That is not catchable: no exception, no filter, no audit row, no
  // Sentry event — the replica dies, taking every other tenant's in-flight
  // request with it, and the file sails through the 2 MiB size cap on its way
  // in. `eachRow({ includeEmpty: false })` visits the two real rows instead.
  if (sheet.actualRowCount - 1 > BULK_UPLOAD_MAX_ROWS) {
    throw new BadRequestException(
      `The file has ${sheet.actualRowCount - 1} rows; the limit is ${BULK_UPLOAD_MAX_ROWS}. Split it and upload the parts.`,
    );
  }

  const rows: ParsedRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (sheetRow, rowNumber) => {
    if (rowNumber === 1) return;
    const cells = emptyCells();
    // The cells that exist, and only those — for the same reason as above:
    // `getCell(n)` materialises one, and a stray value at column XFD would
    // otherwise cost 16,384 of them for its row.
    sheetRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const value = cellToString(cell.value);
      const column = columns[colNumber - 1] ?? null;
      if (column) cells[column] = value;
      else if (value.trim() !== '') throw unlabelledValue(rowNumber, colNumber);
    });
    if (isBlankRow(cells)) return;
    rows.push({ row: rowNumber, cells });
  });
  return rows;
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
