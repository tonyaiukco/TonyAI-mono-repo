/**
 * The slice of a use-intl translator a view module needs: one namespace's
 * keys, simple `{arguments}` only. A component passes
 * `useTranslations("<namespace>")`; a spec passes `createTranslator` over the
 * English or Turkish catalogue. View modules return sentences built through it
 * rather than English literals, so the copy stays in the catalogues
 * (LP4-04, M2) and the module stays testable without React.
 */
export type ViewTranslator<K extends string> = (key: K, values?: Record<string, string | number>) => string;

/** A view module's copy: its translator and the language numbers are written in.
 *  A simple ICU argument prints a number as `String(n)`, never grouped, so a
 *  count is formatted with `formatNumber(n, locale)` before it is passed. */
export interface ViewCopy<K extends string> {
  t: ViewTranslator<K>;
  locale: import("@/lib/types").Locale;
}
