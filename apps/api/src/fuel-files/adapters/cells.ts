import { REPORTING_YEAR_MAX, REPORTING_YEAR_MIN, type FuelLocalDate } from '@tonyai/shared-types';
import type { SheetCell } from '../../bulk-upload/xlsx-reader';

/**
 * How a fuel file's cells are read (inc28-fuel-bulk D4, fuel-file-upload
 * spec): a code as written, a quantity by its cell type, a transaction date as
 * the file writes it with no time-zone shift. Pure functions over one cell; the
 * adapters decide which column each is.
 */

/**
 * A code (account, card, station, document) as written, trimmed: a text cell's
 * text with its leading zeros, a numeric cell's digits. A date cell is not a
 * code read as written (`Dönem`'s lesson: a code that looks like a date is not
 * one), and neither is a boolean or an error, so each reads as no code at all.
 */
export function readCode(cell: SheetCell | undefined): string | null {
  if (cell === undefined) return null;
  if (cell.kind === 'text') {
    const text = cell.value.trim();
    return text.length === 0 ? null : text;
  }
  if (cell.kind === 'number') {
    const value = Number(cell.value);
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  return null;
}

/** A display text (an account's name, a product name), trimmed; null when empty. */
export function readText(cell: SheetCell | undefined): string | null {
  // A name typed as a number is still the name the file shows.
  if (cell === undefined || (cell.kind !== 'text' && cell.kind !== 'number')) return null;
  const text = cell.value.trim();
  return text.length === 0 ? null : text;
}

/** `[-]digits[.digits]e[±]digits`, as `String(number)` writes a very large or small one. */
const EXPONENT = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i;
const PLAIN = /^(-?)(\d+)(?:\.(\d+))?$/;
/** Turkish format: a dot grouping thousands (optional) and a comma before the decimals. */
const TURKISH = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?$/;

/** `[sign, integer digits, fraction digits]` of a number written in plain decimals. */
type Digits = { negative: boolean; integer: string; fraction: string };

function plainDigits(text: string): Digits | null {
  const plain = PLAIN.exec(text);
  if (plain) return { negative: plain[1] === '-', integer: plain[2]!, fraction: plain[3] ?? '' };
  const exponent = EXPONENT.exec(text);
  if (!exponent) return null;
  const digits = `${exponent[2]}${exponent[3] ?? ''}`;
  const point = exponent[2]!.length + Number(exponent[4]);
  if (!Number.isSafeInteger(point) || Math.abs(point) > 400) return null;
  if (point <= 0) return { negative: exponent[1] === '-', integer: '0', fraction: '0'.repeat(-point) + digits };
  if (point >= digits.length) {
    return { negative: exponent[1] === '-', integer: digits + '0'.repeat(point - digits.length), fraction: '' };
  }
  return { negative: exponent[1] === '-', integer: digits.slice(0, point), fraction: digits.slice(point) };
}

function decimalText({ integer, fraction }: Digits): string {
  const whole = integer.replace(/^0+(?=\d)/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

/**
 * A quantity of litres, as decimal text with the precision the file gives
 * (`1.168,00` → `1168.00`), or null when the cell is not a positive number: a
 * numeric cell is its number; a text cell is Turkish format only, so `1168.5`
 * typed as text is refused rather than read as 11,685 or as 1,168.5. A date,
 * a boolean or an error is no quantity.
 */
export function readQuantity(cell: SheetCell | undefined): string | null {
  if (cell === undefined) return null;
  let digits: Digits | null = null;
  if (cell.kind === 'number') {
    digits = plainDigits(cell.value);
  } else if (cell.kind === 'text') {
    const turkish = TURKISH.exec(cell.value.trim());
    if (turkish) {
      digits = { negative: false, integer: turkish[1]!.replace(/\./g, ''), fraction: turkish[2] ?? '' };
    }
  }
  if (digits === null || digits.negative) return null;
  if (!/[1-9]/.test(digits.integer + digits.fraction)) return null;
  return decimalText(digits);
}

/**
 * The quantity as the dedupe key reads it (D5): no trailing zeros after the
 * point, so 31.86 typed as a number and `31,860` as text are one key.
 */
export function canonicalQuantity(litres: string): string {
  if (!litres.includes('.')) return litres;
  return litres.replace(/0+$/, '').replace(/\.$/, '');
}

/** A transaction date and time as the file writes it, no zone (D4). */
export interface LocalDateTime extends FuelLocalDate {
  hour: number;
  minute: number;
  second: number;
}

const TEXT_DATE = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const ISO_FIELDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
/** An ISO date cell as written: date, optional time to the second (a fraction ignored), optional zone (ignored). */
const WRITTEN_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function validDate(year: number, month: number, day: number): boolean {
  if (year < REPORTING_YEAR_MIN || year > REPORTING_YEAR_MAX || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * A transaction date: a date-time cell, or a `dd.MM.yyyy[ HH:mm[:ss]]` text.
 * The reader writes a date cell as the ISO text of its own fields (Excel stores
 * no zone), so its fields are the ones the file shows; a time is rounded to the
 * second Excel shows. Anything else — a plain number, a text in another shape,
 * a day the calendar does not have — is null.
 */
export function readDateTime(cell: SheetCell | undefined): LocalDateTime | null {
  if (cell === undefined) return null;
  if (cell.kind === 'date' && cell.written !== undefined) {
    // An ISO date cell: its fields as written, the zone ignored, and a day the
    // calendar does not have (2025-02-30) refused rather than rolled over.
    const written = WRITTEN_ISO.exec(cell.written);
    if (!written) return null;
    const [year, month, day] = [Number(written[1]), Number(written[2]), Number(written[3])];
    const [hour, minute, second] = [Number(written[4] ?? 0), Number(written[5] ?? 0), Number(written[6] ?? 0)];
    if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
    return { year, month, day, hour, minute, second };
  }
  if (cell.kind === 'date') {
    const iso = ISO_FIELDS.exec(cell.value);
    if (!iso) return null;
    // Excel's serials carry float noise; round to the second it displays.
    const rounded = new Date(Math.round(Date.parse(cell.value) / 1000) * 1000);
    if (Number.isNaN(rounded.getTime())) return null;
    const fields = {
      year: rounded.getUTCFullYear(),
      month: rounded.getUTCMonth() + 1,
      day: rounded.getUTCDate(),
      hour: rounded.getUTCHours(),
      minute: rounded.getUTCMinutes(),
      second: rounded.getUTCSeconds(),
    };
    return validDate(fields.year, fields.month, fields.day) ? fields : null;
  }
  if (cell.kind !== 'text') return null;
  const text = TEXT_DATE.exec(cell.value.trim());
  if (!text) return null;
  const [day, month, year] = [Number(text[1]), Number(text[2]), Number(text[3])];
  const [hour, minute, second] = [Number(text[4] ?? 0), Number(text[5] ?? 0), Number(text[6] ?? 0)];
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  return { year, month, day, hour, minute, second };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `2025-03-31T23:50:00`: what `fuel_rows.transaction_at` stores, with no zone. */
export function localDateTimeText(at: LocalDateTime): string {
  return `${pad(at.year, 4)}-${pad(at.month)}-${pad(at.day)}T${pad(at.hour)}:${pad(at.minute)}:${pad(at.second)}`;
}
