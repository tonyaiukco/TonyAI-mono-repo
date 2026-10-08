import { useCallback } from "react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "use-intl";
import { describeApiError, type ErrorDescription, type ErrorTranslator } from "./errors";

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
