/**
 * Everything the reader knows about a fuel invoice's layout, in one file
 * (inc29-evidence-assistant, design D2). The anchors are the documents' own
 * words: `Fatura No` with a number of the `OZK` or `DAU` series, the column
 * `Miktar (lt)`, the salutation `Sayın`, `VKN`, a period printed as two dates
 * (INC-2.9 §4.2 and §5, INC-2.8 §7).
 *
 * **Under K1 = B this is an assumption about the real text layer** (owner,
 * Decisions 2026-11-28): no real invoice was read to write it. A difference QA
 * finds on the real invoices is a change to this file and a new
 * `READER_VERSION`, which makes every file attached before it read again once
 * at its next comparison (D4).
 */
import { EVIDENCE_INVOICE_SERIES, type EvidenceInvoiceSeries, type FuelSource } from '@tonyai/shared-types';

/**
 * The reader's version, stored with every reading. Change it with any change to
 * this file or to `read-invoices.ts`, or with a new `pdfjs-dist`.
 */
export const READER_VERSION = 'inc29.2/pdfjs-6.5.438';

export const INVOICE_SERIES = EVIDENCE_INVOICE_SERIES;

/** The fuel source each known series invoices (C10). */
export const SERIES_SOURCE: Readonly<Record<EvidenceInvoiceSeries, FuelSource>> = Object.freeze({
  OZK: 'petrol_ofisi',
  DAU: 'shell',
});

export function isInvoiceSeries(value: string): value is EvidenceInvoiceSeries {
  return (INVOICE_SERIES as readonly string[]).includes(value);
}

/**
 * An e-invoice number as GİB numbers it: three characters (the series), the
 * year and nine digits — `OZK2025000011923`, INC-2.9 §7's example.
 */
export const INVOICE_NUMBER = /^([A-Z0-9]{3})(\d{13})$/;

/**
 * Turkish letters folded to their plain lower-case letter, one character for
 * one, by this table and never by the process locale (`'I'.toLowerCase()` is
 * `i` here and `ı` under `tr`). A combining mark folds to nothing.
 */
const FOLD: Readonly<Record<string, string>> = Object.freeze({
  İ: 'i', I: 'i', ı: 'i', Ş: 's', ş: 's', Ğ: 'g', ğ: 'g', Ü: 'u', ü: 'u', Ö: 'o', ö: 'o', Ç: 'c', ç: 'c',
  Â: 'a', â: 'a', Î: 'i', î: 'i', Û: 'u', û: 'u',
});

/** One character folded; `''` for a combining mark. */
export function foldChar(ch: string): string {
  const mapped = FOLD[ch];
  if (mapped !== undefined) return mapped;
  const code = ch.charCodeAt(0);
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code + 32);
  if (code >= 0x300 && code <= 0x36f) return '';
  return ch;
}

export function fold(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) out += foldChar(ch);
  return out;
}

/**
 * The labels, matched on folded text. Each starts at a word's start; the
 * period's and the tax number's may be followed by a colon.
 */
export const LABELS = Object.freeze({
  invoiceNo: /(?:^|[^a-z0-9])fatura\s*no(?![a-z0-9])\s*[:.]?/,
  period: /(?:^|[^a-z0-9])donem(?![a-z0-9])\s*:?/,
  buyer: /(?:^|[^a-z0-9])sayin(?![a-z0-9])/,
  taxId: /(?:^|[^a-z0-9])vkn(?![a-z0-9])\s*:?/,
  quantity: /miktar\s*\(\s*lt\s*\)/,
  /** `Sayfa 2/3`: a numberless page continues the invoice before it only with this evidence. */
  page: /(?:^|[^a-z0-9])sayfa\s*(\d{1,3})\s*\/\s*(\d{1,3})/,
});

/** A row whose product text starts with one of these ends the table: a total is never a fuel row. */
export const TABLE_END = /^(?:genel\s+|ara\s+|odenecek\s+)?toplam(?![a-z0-9])/;

/** A tax number after `VKN` (10 digits) or a person's (11). */
export const TAX_ID = /^\s*(\d{10,11})(?!\d)/;

/** How many rows below `Sayın` the buyer's `VKN` may stand (the seller's is printed elsewhere). */
export const TAX_ID_ROWS_BELOW_BUYER = 6;

/** A period printed as two dates: `01.02.2025 - 15.02.2025` (B14). */
export const PERIOD_RANGE = /^(\d{2})\.(\d{2})\.(\d{4})\s*[-–]\s*(\d{2})\.(\d{2})\.(\d{4})$/;
