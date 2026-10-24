import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useLocale, useMessages, useTranslations } from "use-intl";
import { describeApiError, type ErrorDescription, type ErrorTranslator } from "./errors";
import { recordWordsOf, type RecordWords, type RootTranslator } from "@/lib/vocabulary";
import type { CompletenessCopy } from "@/lib/completeness-view";
import type { EntityWords } from "@/lib/types";
import type { ActorWords } from "@/lib/record-actor";

/** `describeApiError` bound to the current language. */
export function useDescribeError(): (error: unknown) => ErrorDescription {
  const t = useTranslations();
  const locale = useLocale();
  return useCallback(
    // The root translator, untyped: error keys are built from a code at runtime,
    // and messages.spec.ts proves every one of them exists.
    (error: unknown) => describeApiError(error, t as unknown as ErrorTranslator, locale),
    [t, locale],
  );
}

/** An error already described (a view module's `…ErrorMessage`) as a toast:
 *  its sentence, and the server's English beneath it when it has one. */
export function showErrorToast({ title, description }: ErrorDescription): void {
  toast.error(title, description ? { description } : undefined);
}

/** Shows a failed call as an error toast, in the user's language. */
export function useErrorToast(): (error: unknown) => void {
  const describe = useDescribeError();
  return useCallback(
    (error: unknown) => {
      const { title, description } = describe(error);
      toast.error(title, description ? { description } : undefined);
    },
    [describe],
  );
}

/**
 * `useErrorToast` with a stable identity, for a load inside a `useCallback`
 * that an effect depends on: the plain hook's identity follows the language,
 * so a switch would re-create the callback and re-run the effect's load. The
 * toast still speaks the current language — the ref follows it.
 */
export function useStableErrorToast(): (error: unknown) => void {
  const show = useErrorToast();
  const latest = useRef(show);
  useEffect(() => {
    latest.current = show;
  }, [show]);
  return useCallback((error: unknown) => latest.current(error), []);
}

/** A record's status (inline), period value and category in the user's
 *  language; a value the catalogue does not know is shown as stored. */
export function useRecordWords(): RecordWords {
  const t = useTranslations();
  const messages = useMessages();
  return useMemo(
    () => recordWordsOf(t as unknown as RootTranslator, messages as unknown as Record<string, unknown>),
    [t, messages],
  );
}

/** The copy `lib/completeness-view.ts` words its sentences with. */
export function useCompletenessCopy(): CompletenessCopy {
  const t = useTranslations("completeness");
  const locale = useLocale();
  const words = useRecordWords();
  return useMemo(() => ({ t, locale, words }), [t, locale, words]);
}

/** The reporting entity's words when it is not a named site (`entityLabel`). */
export function useEntityWords(): EntityWords {
  const t = useTranslations("common");
  return useMemo(() => ({ wholeCompany: t("entity.wholeCompany"), unnamedSite: t("entity.unnamedSite") }), [t]);
}

/** How a gone or nameless actor is described (`recordActorLabel`). */
export function useActorWords(): ActorWords {
  const t = useTranslations("common");
  return useMemo(() => ({ deleted: t("actor.deleted"), unnamed: t("actor.unnamed") }), [t]);
}
