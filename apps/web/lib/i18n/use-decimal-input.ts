import { useCallback, useState } from "react";
import { useLocale } from "use-intl";
import type { Locale } from "@/lib/types";
import {
  alternativeReading,
  endsWithPendingSeparator,
  parseLocaleDecimal,
  retypeForLocale,
  typedText,
  typedValue,
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
  /** The user left the field: a held-back refusal shows now. Wire to `onBlur`. */
  blur: () => void;
  /**
   * `text` is a number still being typed (`178,`): refused by `parsed`, but the
   * field shows no refusal until `blur` (QA BUG-06). Gate `aria-invalid` and
   * `DecimalNote` on it; saving still reads `parsed`.
   */
  typing: boolean;
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
  // True between a keystroke and leaving the field: only then may a pending
  // separator (`178,`) wait to be refused (QA BUG-06).
  const [editing, setEditing] = useState(false);
  const setText = useCallback((text: string) => {
    setEditing(true);
    setTyped(typedText(text, locale));
  }, [locale]);
  const setValue = useCallback((value: number | null) => {
    setEditing(false);
    setTyped(typedValue(value, locale));
  }, [locale]);
  const blur = useCallback(() => setEditing(false), []);
  const parsed = parseLocaleDecimal(current.text, current.locale);
  return {
    text: current.text,
    locale: current.locale,
    setText,
    setValue,
    blur,
    parsed,
    otherReading: parsed.ok ? alternativeReading(current.text, current.locale) : null,
    typing: editing && !parsed.ok && endsWithPendingSeparator(current.text, current.locale),
  };
}
