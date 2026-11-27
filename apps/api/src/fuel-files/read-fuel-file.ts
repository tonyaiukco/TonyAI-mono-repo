import { BadRequestException } from '@nestjs/common';
import type { FuelRowIssueDTO, FuelSource } from '@tonyai/shared-types';
import { errorBody } from '../common/api-error';
import { readWorksheet, type SheetCell } from '../bulk-upload/xlsx-reader';
import { dedupeDigest, type FuelAdapter, type FuelDraftRow, type FuelReadRow } from './adapters/adapter';
import { petrolOfisiAdapter } from './adapters/petrol-ofisi';
import { shellAdapter } from './adapters/shell';
import { tankerAdapter } from './adapters/tanker';
import { FUEL_XLSX_MAX_UNPACKED_BYTES, FUEL_XLSX_SLICE_BYTES } from './limits';

/**
 * A fuel file read whole into draft rows (inc28-fuel-bulk D4, D5): the header
 * row found, every data row read by its source's column map, refused rows and
 * repeats of an earlier row reported by their file row. Nothing is stored here
 * and nothing about accounts or companies is known yet.
 */

export const FUEL_ADAPTERS: Readonly<Record<FuelSource, FuelAdapter>> = Object.freeze({
  shell: shellAdapter,
  petrol_ofisi: petrolOfisiAdapter,
  tanker: tankerAdapter,
});

/**
 * How far down the header row is looked for: a provider's export may put a
 * title and a blank row above it (the tanker file does); a header further
 * down is not a header this map knows.
 */
export const FUEL_HEADER_SEARCH_ROWS = 20;

/**
 * Rows with no key a file may hold beyond its source's quota — a total row,
 * notes, blank-keyed lines — before the read stops: the quota counts rows
 * with a key (C18: 1,000 tanker deliveries, a TOPLAM row apart), and this
 * bounds the work on the rest (WP9 PR B review, P2).
 */
export const FUEL_UNKEYED_ROWS_MAX = 1_000;

export interface FuelFileReading<Row = FuelReadRow> {
  /** Data rows below the header that hold a value. */
  rowsRead: number;
  rows: Row[];
  refused: FuelRowIssueDTO[];
  /** A row whose key appeared on an earlier row of the same file (D5). */
  duplicates: FuelRowIssueDTO[];
}

/** A reading whose rows carry the organisation's keyed digest, and no unkeyed hash: what is staged and stored. */
export type KeyedFuelReading = FuelFileReading<FuelDraftRow>;

/**
 * A reading keyed for its organisation (D5, revised): each row's key hash
 * replaced by its HMAC under the organisation's key. Within one file the
 * repeats were already found by the key hash; keying keeps them apart, since
 * an HMAC of two different hashes does not collide in practice.
 */
export function keyReading(reading: FuelFileReading, organisationKey: Buffer): KeyedFuelReading {
  return {
    ...reading,
    rows: reading.rows.map(({ keyHash, ...row }) => ({ ...row, dedupeDigest: dedupeDigest(organisationKey, keyHash) })),
  };
}

function columnsMissing(columns: readonly string[]): BadRequestException {
  const list = columns.join(', ');
  return new BadRequestException(
    errorBody('fuel_file_columns_missing', `The file lacks the columns this source needs: ${list}.`, {
      columns: list,
    }),
  );
}

function columnsAmbiguous(columns: readonly string[]): BadRequestException {
  const list = columns.join(', ');
  return new BadRequestException(
    errorBody('fuel_file_columns_ambiguous', `The file has more than one column headed ${list}.`, {
      columns: list,
    }),
  );
}

function tooManyRows(rows: number, max: number): BadRequestException {
  return new BadRequestException(
    errorBody('fuel_file_too_many_rows', `The file has ${rows} rows; a fuel file may hold ${max}.`, { rows, max }),
  );
}

/** Each required header's columns in one row; trimmed, exact. */
function headerColumns(adapter: FuelAdapter, cells: readonly SheetCell[]): Map<string, number[]> {
  const wanted = new Set(adapter.headers);
  const found = new Map<string, number[]>();
  for (const cell of cells) {
    if (cell.kind !== 'text') continue;
    const header = cell.value.trim();
    if (!wanted.has(header)) continue;
    found.set(header, [...(found.get(header) ?? []), cell.column]);
  }
  return found;
}

export async function readFuelFile(buffer: Buffer, source: FuelSource): Promise<FuelFileReading> {
  const adapter = FUEL_ADAPTERS[source];
  const reading: FuelFileReading = { rowsRead: 0, rows: [], refused: [], duplicates: [] };
  const seen = new Set<string>();
  /** Rows with a key so far: what the source's quota (`maxRows`) counts. */
  let keyed = 0;
  /** The header row's column of each mapped header, once found. */
  let columns: ReadonlyMap<string, number> | null = null;
  /** The leading row that held most of the headers: what a refusal names as missing. */
  let best: Map<string, number[]> = new Map();
  let leadingRows = 0;

  await readWorksheet(
    buffer,
    {
      row(rowNumber, cells) {
        if (columns === null) {
          leadingRows += 1;
          const found = headerColumns(adapter, cells);
          if (found.size === adapter.headers.length) {
            const twice = adapter.headers.filter((header) => (found.get(header)?.length ?? 0) > 1);
            if (twice.length > 0) throw columnsAmbiguous(twice);
            columns = new Map(adapter.headers.map((header) => [header, found.get(header)![0]!]));
            return;
          }
          if (found.size > best.size) best = found;
          if (leadingRows >= FUEL_HEADER_SEARCH_ROWS) {
            throw columnsMissing(adapter.headers.filter((header) => !best.has(header)));
          }
          return;
        }

        reading.rowsRead += 1;
        // Past the bound, rows are only counted, so the refusal names a count the user can check.
        if (keyed > adapter.maxRows || reading.rowsRead > adapter.maxRows + FUEL_UNKEYED_ROWS_MAX) return;
        const byColumn = new Map(cells.map((cell) => [cell.column, cell]));
        const mapped = new Map<string, SheetCell>();
        for (const [header, column] of columns) {
          const cell = byColumn.get(column);
          if (cell !== undefined) mapped.set(header, cell);
        }
        const result = adapter.read(mapped, rowNumber);
        // The source's quota counts rows with a key (deliveries, sales): a TOPLAM row has none (C18).
        if (!('refused' in result && result.refused === 'fuel_key_missing')) {
          keyed += 1;
          if (keyed > adapter.maxRows) return;
        }
        if ('refused' in result) {
          reading.refused.push({ row: rowNumber, code: result.refused });
        } else if (seen.has(result.row.keyHash)) {
          reading.duplicates.push({ row: rowNumber, code: 'fuel_duplicate' });
        } else {
          seen.add(result.row.keyHash);
          reading.rows.push(result.row);
        }
      },
      merge() {},
    },
    {
      ...(adapter.sheetName === undefined ? {} : { sheetName: adapter.sheetName }),
      maxUnpackedBytes: FUEL_XLSX_MAX_UNPACKED_BYTES,
      // A bad date cell is its row's refusal (`fuel_date_unreadable`), never the file's.
      keepUnreadableDates: true,
      asyncInflate: true,
      sliceBytes: FUEL_XLSX_SLICE_BYTES,
    },
  );

  if (columns === null) throw columnsMissing(adapter.headers.filter((header) => !best.has(header)));
  if (keyed > adapter.maxRows) throw tooManyRows(keyed, adapter.maxRows);
  if (reading.rowsRead > adapter.maxRows + FUEL_UNKEYED_ROWS_MAX) throw tooManyRows(reading.rowsRead, adapter.maxRows);
  return reading;
}
