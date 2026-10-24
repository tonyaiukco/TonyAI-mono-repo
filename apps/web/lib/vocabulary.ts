import type { ViewTranslator } from "@/lib/i18n/view-translator";
import { GEOGRAPHY_CODES, type GeographyCode } from "@/lib/types";

/**
 * Canonical values a screen shows by name (LP4-04, M2). The value stays what
 * is stored and sent; only its name comes from the catalogue.
 */

function isGeographyCode(code: string): code is GeographyCode {
  return (GEOGRAPHY_CODES as readonly string[]).includes(code);
}

/** `Türkiye` — a known geography's name, else the code as stored. */
export function geographyName(code: string, t: ViewTranslator<GeographyCode>): string {
  return isGeographyCode(code) ? t(code) : code;
}

/** `Türkiye (TR)` — the name for the reader, the code so it stays greppable
 *  (shared-types' `geographyLabel`, in the user's language). */
export function geographyLabel(code: string, t: ViewTranslator<GeographyCode>): string {
  return isGeographyCode(code) ? `${t(code)} (${code})` : code;
}

/** The words a record's canonical values are shown by — status, period value
 *  and category — in the user's language (`useRecordWords`). */
export interface RecordWords {
  status: (status: string) => string;
  period: (periodValue: string) => string;
  category: (category: string) => string;
}

/** The slice of a root translator `recordWordsOf` needs. */
export interface RootTranslator {
  (key: string): string;
  has(key: string): boolean;
}

/**
 * Record words from a root translator — the one implementation `useRecordWords`
 * and the specs share. A value the catalogue does not hold as its OWN key is
 * shown as stored: use-intl's lookup walks the prototype chain, so
 * `categories.constructor` would otherwise "exist" and render as a key path.
 */
export function recordWordsOf(t: RootTranslator, messages: Record<string, unknown>): RecordWords {
  const owns = (path: string[]) => {
    let node: unknown = messages;
    for (const part of path) {
      if (typeof node !== "object" || node === null || !Object.prototype.hasOwnProperty.call(node, part)) return false;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === "string";
  };
  const word = (path: string[], fallback: string) => (owns(path) ? t(path.join(".")) : fallback);
  return {
    status: (status) => word(["recordStatus", "inline", status], status.replace(/_/g, " ")),
    period: (value) => word(["periods", "values", value], value),
    category: (category) => word(["categories", category], category),
  };
}
