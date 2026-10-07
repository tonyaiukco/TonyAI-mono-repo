"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { IntlProvider, useLocale, type IntlError } from "use-intl";
import { localeCookie } from "@/lib/i18n/locale";
import { useAuthStore } from "@/lib/store";
import { isLocale, type Locale } from "@/lib/types";
import type { Messages } from "@/messages";

/**
 * The language a client component renders in (LP3-01). The root layout picks
 * the locale on the server — cookie, then Accept-Language, then English — and
 * passes only that locale's catalogue down.
 *
 * No `timeZone`: dates show in the viewer's own time zone, and every date on
 * these pages is formatted after a client-side fetch, never during the server
 * render, so the two cannot disagree.
 */
export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: ReactNode;
}) {
  return (
    <IntlProvider locale={locale} messages={messages} onError={ignoreIntlError}>
      <LocaleSync />
      {children}
    </IntlProvider>
  );
}

/**
 * Silent on purpose. The viewer's time zone is the rule (see above), not a
 * fallback (`ENVIRONMENT_FALLBACK`); and a missing key renders as its path,
 * which messages.spec.ts keeps from shipping — use-intl's default would log
 * both to the console on every render.
 */
function ignoreIntlError(error: IntlError) {
  void error;
}

/**
 * The profile's language wins once the user is known: `profiles.language` is
 * the truth (decision K2) and the cookie only its mirror, so a sign-in on a new
 * device — or a change made on another one — lands in the user's language.
 *
 * One attempt per user and language: if the browser refuses the cookie, the
 * page keeps rendering in the cookie's language instead of refreshing forever.
 */
function LocaleSync() {
  const locale = useLocale();
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    // `isLocale`: the value goes into document.cookie, so nothing but a known
    // locale may reach it, whatever /me answers (`security-rls` P3-3).
    if (!user || user.language === locale || !isLocale(user.language)) return;
    const key = `${user.id}:${user.language}`;
    if (attempted.current === key) return;
    attempted.current = key;
    document.cookie = localeCookie(user.language, window.location.protocol === "https:");
    router.refresh();
  }, [user, locale, router]);

  return null;
}
