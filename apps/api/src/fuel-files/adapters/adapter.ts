import { createHash } from 'node:crypto';
import type { FuelSource } from '@tonyai/shared-types';
import type { SheetCell } from '../../bulk-upload/xlsx-reader';

/**
 * One source's column map (inc28-fuel-bulk D4): the sheet it is read from, the
 * headers it needs, and how one file row becomes a draft row. Only the mapped
 * columns are ever looked at, and a draft row holds nothing the store does not
 * keep: no card number, station code or plate (C19, D5).
 */

/** A row of the file as the adapter will store it, before any account or state is known. */
export interface FuelDraftRow {
  /** The 1-based row of the sheet. */
  fileRow: number;
  /** `Müşteri Kodu`, `Filo Kod Adı`, or the tanker file's `AÇIKLAMA`; as written, trimmed. */
  accountCode: string;
  /** Display only (`Müşteri Adı`, `Filo`; the tanker file's `AÇIKLAMA`). */
  accountName: string;
  /** The product name as written; null for a tanker delivery (its fuel is declared). */
  rawFuel: string | null;
  /** Litres as decimal text, with the precision the file gives. */
  litres: string;
  /** `2025-03-31T23:50:00`, as written with no zone; null for a tanker delivery. */
  transactionAt: string | null;
  /** The transaction's calendar month; null for a tanker delivery (declared). */
  year: number | null;
  month: number | null;
  /** `Fatura Numarası`, the Shell half-month, or `EVRAK NO`. */
  invoiceRef: string;
  /** `sha256(source | key)` (D5): the only trace of the key's card and station. */
  dedupeDigest: string;
}

/** A row the file holds but the column map refuses (B12): never stored. */
export type FuelRowRefusal =
  | 'fuel_key_missing'
  | 'fuel_cell_missing'
  | 'fuel_reference_too_long'
  | 'fuel_quantity_unreadable'
  | 'fuel_date_unreadable';

export type FuelRowReading = { row: FuelDraftRow } | { refused: FuelRowRefusal };

export interface FuelAdapter {
  source: FuelSource;
  /** The sheet read by name; absent: the first sheet. */
  sheetName?: string;
  /** Every header the map needs, each exactly once, trimmed and matched exactly. */
  headers: readonly string[];
  /** The most data rows a file of this source may hold. */
  maxRows: number;
  /** One data row, its cells by header. */
  read(cells: ReadonlyMap<string, SheetCell>, fileRow: number): FuelRowReading;
}

/**
 * The dedupe digest (D5): the source and its key's parts, JSON-encoded so no
 * part's text can run into the next, hashed. Lowercase hex, as the column holds.
 */
export function dedupeDigest(source: FuelSource, parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([source, ...parts])).digest('hex');
}
