import { LOCALE_FORMAT_TAGS, SUPPORTED_LOCALES, type Locale } from "@/lib/types";

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
 * it was read — and, when the other convention would read the same text as a
 * different number (`1.234`, `1,234`), which one it was NOT — so a user who
 * meant the other sees it before saving (`alternativeReading`).
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
    // A first group of 0, 00 or 000 is never written: `0.500` is not five
    // hundred in any convention, so it must not parse as grouped (qa F1).
    grouped: new RegExp(`^-?[1-9]\\d{0,2}(?:${g}\\d{3})+(?:${d}\\d+)?$`),
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

/** `String(n)`'s exponent form (`1.5e-7`, `1e+21`) written out in plain digits —
 *  exactly, since it only moves the point of the shortest round-trip digits. */
function withoutExponent(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (!match) return text;
  const [, sign, int, frac = "", exp] = match;
  const digits = int + frac;
  const point = int.length + Number(exp);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`.replace(/\.?0+$/, "");
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * `value` as an input field shows it in `locale`: no grouping, the locale's
 * decimal separator, every digit the number has — so reading it back gives the
 * same number (`parseLocaleDecimal(formatDecimalInput(n, l), l)` is `n`).
 */
export function formatDecimalInput(value: number, locale: Locale): string {
  if (!Number.isFinite(value)) return "";
  // Outside 1e-7…1e21 String() writes an exponent the grammar refuses.
  return withoutExponent(String(value)).replace(".", NUMBER_SEPARATORS[locale].decimal);
}

/**
 * The number another supported locale would read `text` as, when that differs
 * from what `locale` reads — `1.234` is 1234 in Turkish and 1.234 in English.
 * The screen names it ("not 1,234"), so a user typing in the other convention
 * notices a 1000× difference before saving. Null when no other reading exists.
 */
export function alternativeReading(text: string, locale: Locale): number | null {
  const own = parseLocaleDecimal(text, locale);
  if (!own.ok) return null;
  for (const other of SUPPORTED_LOCALES) {
    if (other === locale) continue;
    const theirs = parseLocaleDecimal(text, other);
    if (theirs.ok && theirs.value !== own.value) return theirs.value;
  }
  return null;
}

/** A value typed into a field, with the locale it was typed in — kept together
 *  so the text is never read under another locale's rules. */
export interface TypedDecimal {
  text: string;
  locale: Locale;
}

/** The field after a language change: the same number, written the new way. */
export function retypeForLocale(typed: TypedDecimal, locale: Locale): TypedDecimal {
  return typed.locale === locale ? typed : { text: reformatDecimalInput(typed.text, typed.locale, locale), locale };
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

/** The range a field accepts, on top of the grammar. */
export type DecimalRule = "positive" | "non_negative";

export type DecimalCheck =
  | { ok: true; value: number; grouped: boolean }
  | { ok: false; reason: "empty" | "invalid" | "wrong_decimal_separator" | "not_positive" | "negative" };

/** A parsed field against its range: above zero, or zero and above. */
export function checkDecimal(parsed: DecimalParse, rule: DecimalRule): DecimalCheck {
  if (!parsed.ok) return parsed;
  if (rule === "positive" && parsed.value <= 0) return { ok: false, reason: "not_positive" };
  if (rule === "non_negative" && parsed.value < 0) return { ok: false, reason: "negative" };
  return parsed;
}

export type ActivityValueCheck = DecimalCheck;

/** Data Entry's rule for an activity value: a number in the user's locale, above zero. */
export function checkActivityValue(input: string, locale: Locale): ActivityValueCheck {
  return checkDecimal(parseLocaleDecimal(input, locale), "positive");
}

/** A four-digit year as typed: digits only, in every locale — a separator in a
 *  year is never a reading to guess at. */
export function parseYearInput(input: string): number | null {
  const text = input.trim();
  return /^\d{4}$/.test(text) ? Number(text) : null;
}
