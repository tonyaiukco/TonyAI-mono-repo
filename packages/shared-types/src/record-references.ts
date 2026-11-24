/**
 * A record's invoice number and supplier (UAT round 4, BUG-16;
 * `uat4-quick-fixes`): two optional texts that let a reviewer match a record
 * to its evidence file. They live in the record's `input`, beside the other
 * Additional context values, are audited with it, and are never read by the
 * calculation.
 *
 * The key names are what records store, so they never change. They are in the
 * style of the ids `input` already holds, and chosen so that a later move to
 * columns is a straight copy.
 *
 * An Electricity record's supplier is its `utility_provider`: that field held
 * the supplier before this change, and a stored id is not renamed. Electricity
 * therefore takes no `supplier` key from the form, and its supplier is bounded
 * by the category (`electricitySupplierIssues`), not by the key alone.
 *
 * No imports from `index.ts` at runtime: it re-exports this module.
 */

/** The `input` key of a record's invoice number. */
export const RECORD_INVOICE_NO_KEY = 'invoice_no';

/** The `input` key of a record's supplier, for every category but Electricity. */
export const RECORD_SUPPLIER_KEY = 'supplier';

/** The `input` key an Electricity record names its supplier under. */
export const ELECTRICITY_SUPPLIER_KEY = 'utility_provider';

/** The longest invoice number a record stores, after trimming. */
export const RECORD_INVOICE_NO_MAX_LENGTH = 64;

/** The longest supplier name a record stores, after trimming. */
export const RECORD_SUPPLIER_MAX_LENGTH = 200;

/** The two keys this module bounds, each with its limit. */
export const RECORD_REFERENCE_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  [RECORD_INVOICE_NO_KEY]: RECORD_INVOICE_NO_MAX_LENGTH,
  [RECORD_SUPPLIER_KEY]: RECORD_SUPPLIER_MAX_LENGTH,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const heldText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
};

/**
 * What is wrong with the two keys in `input`, empty when nothing is. Each one,
 * when present and not null, must be text no longer than its limit once
 * trimmed. Every other key is left to the writer: this is not a schema for
 * `input`.
 */
export function recordReferenceIssues(input: unknown): string[] {
  if (!isPlainObject(input)) return [];
  const issues: string[] = [];
  for (const [key, max] of Object.entries(RECORD_REFERENCE_LIMITS)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string') {
      issues.push(`input.${key} must be text`);
      continue;
    }
    if (value.trim().length > max) issues.push(`input.${key} must be at most ${max} characters`);
  }
  return issues;
}

/**
 * `input` as it is stored: the two keys trimmed, and dropped when blank or
 * null, so "no invoice number" has one spelling. A value that is not text is
 * left for `recordReferenceIssues` to refuse. Every other key is returned as
 * given, and an `input` holding nothing afterwards is null, as an empty
 * Additional context always was.
 */
export function storableRecordReferences<T>(input: T): T | Record<string, unknown> | null {
  if (!isPlainObject(input)) return input;
  let out: Record<string, unknown> | null = null;
  for (const key of Object.keys(RECORD_REFERENCE_LIMITS)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (typeof value === 'string') {
      const text = value.trim();
      if (text === value && text !== '') continue;
      out ??= { ...input };
      if (text === '') delete out[key];
      else out[key] = text;
    } else if (value === null || value === undefined) {
      out ??= { ...input };
      delete out[key];
    }
  }
  if (out === null) return input;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * What is wrong with an Electricity record's supplier, its
 * `utility_provider`, empty when nothing is: text no longer than a supplier's
 * limit once trimmed, like any other record's `supplier`. The key is older
 * than the rule, so a value the stored record already holds is left alone
 * (`stored`, the record's `input` before the edit): an edit of another field
 * of an old record still saves, and only a new or changed supplier is held to
 * the bound. Any other category names no `utility_provider`, so it has no
 * issue here.
 */
export function electricitySupplierIssues(category: string, input: unknown, stored?: unknown): string[] {
  if (category !== 'Electricity' || !isPlainObject(input)) return [];
  if (!Object.prototype.hasOwnProperty.call(input, ELECTRICITY_SUPPLIER_KEY)) return [];
  const value = input[ELECTRICITY_SUPPLIER_KEY];
  if (value === null || value === undefined) return [];
  if (
    isPlainObject(stored) &&
    Object.prototype.hasOwnProperty.call(stored, ELECTRICITY_SUPPLIER_KEY) &&
    JSON.stringify(stored[ELECTRICITY_SUPPLIER_KEY]) === JSON.stringify(value)
  ) {
    return [];
  }
  if (typeof value !== 'string') return [`input.${ELECTRICITY_SUPPLIER_KEY} must be text`];
  return value.trim().length > RECORD_SUPPLIER_MAX_LENGTH
    ? [`input.${ELECTRICITY_SUPPLIER_KEY} must be at most ${RECORD_SUPPLIER_MAX_LENGTH} characters`]
    : [];
}

/** A record's invoice number, or null when it holds none. */
export function recordInvoiceNo(input: unknown): string | null {
  return isPlainObject(input) ? heldText(input[RECORD_INVOICE_NO_KEY]) : null;
}

/**
 * A record's supplier, or null when it holds none: an Electricity record's
 * utility provider, any other record's supplier. The category decides, never
 * the keys present, so a value left under the other key by a category change
 * is not shown as this record's supplier.
 */
export function recordSupplier(category: string, input: unknown): string | null {
  if (!isPlainObject(input)) return null;
  return heldText(input[category === 'Electricity' ? ELECTRICITY_SUPPLIER_KEY : RECORD_SUPPLIER_KEY]);
}
