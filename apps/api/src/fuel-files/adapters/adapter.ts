import { createHash, createHmac } from 'node:crypto';
import type { FuelSource } from '@tonyai/shared-types';
import type { SheetCell } from '../../bulk-upload/xlsx-reader';

/**
 * One source's column map (inc28-fuel-bulk D4): the sheet it is read from, the
 * headers it needs, and how one file row becomes a draft row. Only the mapped
 * columns are ever looked at, and a draft row holds nothing the store does not
 * keep: no card number, station code or plate (C19, D5).
 */

/** A file row's fields as stored, before any account or state is known. */
interface FuelRowFields {
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
}

/**
 * A row as the adapter reads it. `keyHash` is `sha256(source | key)`, unkeyed:
 * it never leaves memory — only its keyed digest is stored or compared with
 * stored rows (D5, revised).
 */
export interface FuelReadRow extends FuelRowFields {
  keyHash: string;
}

/** A row as it will be stored: its key only as the organisation's keyed digest (D5, revised). */
export interface FuelDraftRow extends FuelRowFields {
  /** `HMAC-SHA256(organisation key, keyHash)`: the only trace of the key's card and station. */
  dedupeDigest: string;
}

/** A row the file holds but the column map refuses (B12): never stored. */
export type FuelRowRefusal =
  | 'fuel_key_missing'
  | 'fuel_cell_missing'
  | 'fuel_reference_too_long'
  | 'fuel_quantity_unreadable'
  | 'fuel_date_unreadable';

export type FuelRowReading = { row: FuelReadRow } | { refused: FuelRowRefusal };

export interface FuelAdapter {
  source: FuelSource;
  /** The sheet read by name; absent: the first sheet. */
  sheetName?: string;
  /** Every header the map needs, each exactly once, trimmed and matched exactly. */
  headers: readonly string[];
  /** The most a file of this source may hold, of what `quota` counts. */
  maxRows: number;
  /**
   * What `maxRows` counts (C18): a card file's data rows (`rows`), a tanker
   * file's deliveries — rows with a key, so its TOPLAM row is not one
   * (`keyed`; WP9 PR B reviews).
   */
  quota: 'rows' | 'keyed';
  /** One data row, its cells by header. */
  read(cells: ReadonlyMap<string, SheetCell>, fileRow: number): FuelRowReading;
}

/**
 * A row's key hash (D5): the source and its key's parts, JSON-encoded so no
 * part's text can run into the next, hashed. Unkeyed — a Shell key's card
 * number can be brute-forced from it — so it is never stored (`dedupeDigest`).
 */
export function keyHashOf(source: FuelSource, parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([source, ...parts])).digest('hex');
}

/**
 * The stored dedupe digest (D5, revised by the owner 2026-11-27): the key
 * hash under the organisation's HMAC key. Lowercase hex, 64 characters, as
 * the column holds. One file read by two organisations gives two digests.
 */
export function dedupeDigest(organisationKey: Buffer, keyHash: string): string {
  return createHmac('sha256', organisationKey).update(keyHash).digest('hex');
}
