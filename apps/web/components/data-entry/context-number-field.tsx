"use client";

import { DecimalNote } from "@/components/i18n/decimal-note";
import { Input } from "@/components/ui/input";
import { storedContextNumber } from "@/lib/context-fields";
import { checkDecimal, parseLocaleDecimal, typedText, typedValue } from "@/lib/i18n/number";
import { useDecimalInput } from "@/lib/i18n/use-decimal-input";
import type { Locale } from "@/lib/types";
import { useLocale } from "use-intl";

/**
 * An "Additional context" number (LP4-04, M4). It was `<input type="number">`,
 * which lets the browser, not the user's language, decide how `1.234` reads;
 * it is now typed in the UI's language like every other quantity
 * (`useDecimalInput`), and what reaches the record is a JSON number, or ""
 * when the field is empty (the save leaves it out). A refused text refuses the
 * save, so a stored value is never dropped for a typo; the note under the
 * field says why.
 *
 * Mounted per record (the page keys it), so `stored` is read once, at mount:
 * a number saved before LP4-04 is dot-decimal text, and opens as the number it
 * meant; text that is not a number opens as typed, refused on the note.
 */
export function ContextNumberField({
  id,
  stored,
  placeholder,
  onChange,
}: {
  id: string;
  stored: unknown;
  placeholder?: string;
  /** The value to save — a JSON number, or "" when the field is empty —
   *  and whether the text is refused (the save is refused while it is). */
  onChange: (value: number | "", refused: boolean) => void;
}) {
  const locale = useLocale();
  const input = useDecimalInput(initialTyped(stored, locale));
  const check = checkDecimal(input.parsed, "non_negative");
  const noteId = `context-${id}-note`;
  return (
    <div>
      <Input
        type="text"
        inputMode="decimal"
        placeholder={placeholder}
        value={input.text}
        aria-describedby={noteId}
        onChange={(e) => {
          input.setText(e.target.value);
          const next = checkDecimal(parseLocaleDecimal(e.target.value, locale), "non_negative");
          onChange(next.ok ? next.value : "", !next.ok && next.reason !== "empty");
        }}
      />
      <DecimalNote id={noteId} check={check} otherReading={input.otherReading} locale={input.locale} />
    </div>
  );
}

function initialTyped(stored: unknown, locale: Locale) {
  const n = storedContextNumber(stored);
  if (n !== null) return typedValue(n, locale);
  return typedText(typeof stored === "string" ? stored : "", locale);
}

