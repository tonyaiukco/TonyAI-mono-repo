import { createTranslator } from "use-intl/core";
import { MESSAGES, type Messages } from "@/messages";
import type { Locale } from "@/lib/types";
import { describeApiError, type ErrorTranslator } from "./errors";
import { recordWordsOf, type RecordWords, type RootTranslator } from "@/lib/vocabulary";

/**
 * Copy for a view module's spec: what a screen passes from `useTranslations`
 * and `useLocale`, built over the real catalogue so a spec asserting English
 * asserts the catalogue the screen shows. Not a spec itself; imported by them.
 */
/** A missing key or argument fails the spec rather than rendering a key path. */
function fail(error: Error): never {
  throw error;
}

export function copyFor(namespace: keyof Messages, locale: Locale = "en") {
  const t = createTranslator({ locale, messages: MESSAGES[locale], namespace, onError: fail });
  return { t: t as unknown as (key: string, values?: Record<string, string | number>) => string, locale };
}

/** `useDescribeError()` outside React. */
export function describeFor(locale: Locale = "en") {
  const t = createTranslator({ locale, messages: MESSAGES[locale], onError: fail });
  return (error: unknown) => describeApiError(error, t as unknown as ErrorTranslator, locale);
}

/** `useRecordWords()` outside React — the same `recordWordsOf`. */
export function recordWordsFor(locale: Locale = "en"): RecordWords {
  const t = createTranslator({ locale, messages: MESSAGES[locale], onError: fail });
  return recordWordsOf(t as unknown as RootTranslator, MESSAGES[locale] as unknown as Record<string, unknown>);
}
