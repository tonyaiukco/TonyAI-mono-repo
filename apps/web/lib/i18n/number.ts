import { LOCALE_FORMAT_TAGS, type Locale } from "@/lib/types";

/**
 * Numbers typed into the UI and numbers shown by it (LP3-01, decision D15).
 *
 * A quantity is typed in the user's locale — Turkish `1.234,5`, English
 * `1,234.5` — and leaves the browser as a JSON number, which is canonical
 * dot-decimal whatever the locale. Bulk files never come through here: CSV
 * stays dot-only (the importer's `strictNumber`) and XLSX numeric cells are
 * taken as numbers.
 *
 * The grammar is strict on purpose. A misread quantity is the worst error this
 * product can make (a 1000× figure that looks plausible), so anything that is
 * not unambiguously a number in the user's locale is refused with a reason,
 * never guessed at:
 *   - digits, optionally with a leading `-`, optionally grouped in threes by
 *     the locale's group separator, optionally followed by the locale's
 *     decimal separator and at least one digit;
 *   - no spaces inside, no `+`, no exponent, no leading or trailing separator;
 *   - in a locale whose decimal separator is a comma, a dot that cannot be a
 *     thousands separator (`1234.5`, `1.23`) is refused as a wrong decimal
 *     separator — and the same for a comma in English (`1,5`).
 * A grouped input (`1.234` in Turkish is 1234) parses, and the screen says how
 * it was read, so a user who meant 1.234 sees it before saving.
 */

export interface NumberSeparators {
  decimal: string;
  group: string;
}

export const NUMBER_SEPARATORS: Readonly<Record<Locale, NumberSeparators>> = Object.freeze({
  en: { decimal: ".", group: "," },
  tr: { decimal: ",", group: "." },
});

export type DecimalParse =
  | { ok: true; value: number; grouped: boolean }
  | { ok: false; reason: "empty" | "invalid" | "wrong_decimal_separator" };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function grammar(locale: Locale) {
  const { decimal, group } = NUMBER_SEPARATORS[locale];
  const d = escape(decimal);
  const g = escape(group);
  return {
    plain: new RegExp(`^-?\\d+(?:${d}\\d+)?$`),
    grouped: new RegExp(`^-?\\d{1,3}(?:${g}\\d{3})+(?:${d}\\d+)?$`),
    // The other convention's decimal: one separator of the wrong kind, not in
    // a position a group separator could hold.
    foreignDecimal: new RegExp(`^-?\\d+${g}\\d+$`),
    groupChar: new RegExp(g, "g"),
    decimalChar: decimal,
  };
}

/** Reads `input` as a number in `locale`'s convention, or says why not. */
export function parseLocaleDecimal(input: string, locale: Locale): DecimalParse {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "empty" };
  const g = grammar(locale);
  const grouped = g.grouped.test(text);
  if (grouped || g.plain.test(text)) {
    const canonical = text.replace(g.groupChar, "").replace(g.decimalChar, ".");
    const value = Number(canonical);
    if (!Number.isFinite(value)) return { ok: false, reason: "invalid" };
    // `-0` is zero: a sign must never survive on a value that has none.
    return { ok: true, value: Object.is(value, -0) ? 0 : value, grouped };
  }
  if (g.foreignDecimal.test(text)) return { ok: false, reason: "wrong_decimal_separator" };
  return { ok: false, reason: "invalid" };
}

/**
 * `value` as an input field shows it in `locale`: no grouping, the locale's
 * decimal separator, every digit the number has — so reading it back gives the
 * same number (`parseLocaleDecimal(formatDecimalInput(n, l), l)` is `n`).
 */
export function formatDecimalInput(value: number, locale: Locale): string {
  if (!Number.isFinite(value)) return "";
  let text = String(value);
  if (/e/i.test(text)) {
    // Outside 1e-7…1e21 String() writes an exponent the grammar refuses.
    text = value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
  }
  return text.replace(".", NUMBER_SEPARATORS[locale].decimal);
}

/** Re-renders typed text for a new locale from the number it meant — never by
 *  re-reading the text under the new convention, which would turn Turkish
 *  `1.234` (1234) into English 1.234. Unparseable text is kept as typed. */
export function reformatDecimalInput(text: string, from: Locale, to: Locale): string {
  if (from === to) return text;
  const parsed = parseLocaleDecimal(text, from);
  return parsed.ok ? formatDecimalInput(parsed.value, to) : text;
}

const formatters = new Map<string, Intl.NumberFormat>();

/** `value` for display in `locale` (grouped, the locale's separators). */
export function formatNumber(value: number, locale: Locale, options: Intl.NumberFormatOptions = {}): string {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE_FORMAT_TAGS[locale], options);
    formatters.set(key, formatter);
  }
  return formatter.format(value);
}

export type ActivityValueCheck =
  | { ok: true; value: number; grouped: boolean }
  | { ok: false; reason: "empty" | "invalid" | "wrong_decimal_separator" | "not_positive" };

/** Data Entry's rule for an activity value: a number in the user's locale, above zero. */
export function checkActivityValue(input: string, locale: Locale): ActivityValueCheck {
  const parsed = parseLocaleDecimal(input, locale);
  if (!parsed.ok) return parsed;
  if (parsed.value <= 0) return { ok: false, reason: "not_positive" };
  return parsed;
}
