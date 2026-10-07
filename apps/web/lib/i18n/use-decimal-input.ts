import { useCallback, useState } from "react";
import { useLocale } from "use-intl";
import type { Locale } from "@/lib/types";
import {
  alternativeReading,
  formatDecimalInput,
  parseLocaleDecimal,
  retypeForLocale,
  type DecimalParse,
  type TypedDecimal,
} from "./number";

export interface DecimalInput {
  /** What the field shows. */
  text: string;
  /** The locale `text` is written in — always the current one once rendered. */
  locale: Locale;
  /** The user typed `text`, in the current locale. */
  setText: (text: string) => void;
  /** Fill the field from a number (opening a record), or clear it with null. */
  setValue: (value: number | null) => void;
  /** `text` read under the locale it was typed in (D15). */
  parsed: DecimalParse;
  /** What the other convention would read, when that differs (shown on screen). */
  otherReading: number | null;
}

/**
 * A quantity field typed in the user's locale (LP3-01, D15) — every numeric
 * input a user types a quantity into goes through this, so no screen reads a
 * number differently from another.
 *
 * The text and the locale it was typed in are ONE state. A language switch
 * re-renders with that state; the text is re-written from the number it meant
 * (`retypeForLocale`) during render — not in an effect — so no committed render
 * and no event handler ever reads Turkish `1.234` (1234) under English rules
 * (1.234). `use-decimal-input.spec.ts` renders this with a stale locale and
 * fails if either half of that is removed.
 */
export function useDecimalInput(initial?: TypedDecimal): DecimalInput {
  const locale = useLocale();
  const [typed, setTyped] = useState<TypedDecimal>(() => initial ?? { text: "", locale });
  let current = typed;
  if (typed.locale !== locale) {
    current = retypeForLocale(typed, locale);
    setTyped(current);
  }
  const setText = useCallback((text: string) => setTyped({ text, locale }), [locale]);
  const setValue = useCallback(
    (value: number | null) => setTyped({ text: value === null ? "" : formatDecimalInput(value, locale), locale }),
    [locale],
  );
  const parsed = parseLocaleDecimal(current.text, current.locale);
  return {
    text: current.text,
    locale: current.locale,
    setText,
    setValue,
    parsed,
    otherReading: parsed.ok ? alternativeReading(current.text, current.locale) : null,
  };
}
