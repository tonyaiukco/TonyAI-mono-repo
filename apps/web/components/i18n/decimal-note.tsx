"use client";

import { useTranslations } from "use-intl";
import { formatDecimalInput, NUMBER_SEPARATORS, type DecimalCheck } from "@/lib/i18n/number";
import type { Locale } from "@/lib/types";

/**
 * The line under a quantity field (D15): why a value is refused, or how it was
 * read — with the other convention's reading named when the text has two, so a
 * 1000× misreading is visible before saving. Pair it with `useDecimalInput`
 * and give the input `aria-describedby={id}`.
 */
export function DecimalNote({
  id,
  check,
  otherReading,
  locale,
}: {
  id: string;
  check: DecimalCheck;
  otherReading: number | null;
  locale: Locale;
}) {
  const t = useTranslations("numbers");
  const example = `45000${NUMBER_SEPARATORS[locale].decimal}5`;
  let note: { text: string; refused: boolean } | null = null;
  if (check.ok) {
    if (otherReading !== null) {
      note = {
        text: t("readAsNot", {
          value: formatDecimalInput(check.value, locale),
          other: formatDecimalInput(otherReading, locale),
        }),
        refused: false,
      };
    } else if (check.grouped) {
      note = { text: t("readAs", { value: formatDecimalInput(check.value, locale) }), refused: false };
    }
  } else if (check.reason !== "empty") {
    note = {
      text:
        check.reason === "not_positive"
          ? t("notPositive")
          : check.reason === "negative"
            ? t("notNegative")
            : check.reason === "wrong_decimal_separator"
              ? t("wrongDecimalSeparator", { example })
              : t("invalid", { example }),
      refused: true,
    };
  }
  return (
    <p id={id} className="mt-1 min-h-4 text-xs" aria-live="polite">
      {note && <span className={note.refused ? "text-destructive" : "text-muted-foreground"}>{note.text}</span>}
    </p>
  );
}
