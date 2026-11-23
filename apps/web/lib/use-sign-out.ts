"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { signOutHere } from "./sign-out";

/**
 * Every page's Sign out. Leaves with a full navigation, so the page's own
 * state and any request still in flight go with it; a sign-out that did not
 * go through stays on the page and says so.
 */
export function useSignOut(): () => Promise<void> {
  const t = useTranslations("common");
  return useCallback(async () => {
    if (await signOutHere()) window.location.assign("/login");
    else toast.error(t("signOutFailed"));
  }, [t]);
}
