import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/types";

/**
 * Which language a page renders in (LP3-01, decision K2).
 *
 * `profiles.language` is the truth; this cookie mirrors it so the very first
 * paint — and the sign-in page, before any profile is known — is already in
 * the right language. Order: the cookie, else the browser's Accept-Language,
 * else English. Once signed in, the profile wins (`LocaleSync`).
 *
 * Not a secret and not httpOnly: the switcher writes it from the browser.
 */
export const LOCALE_COOKIE = "tonyai-locale";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** The first supported language of an Accept-Language header, by weight. */
export function negotiateAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { primary: tag.trim().toLowerCase().split("-")[0], weight, index };
    })
    .filter((entry) => entry.primary && entry.primary !== "*" && Number.isFinite(entry.weight) && entry.weight > 0)
    // Highest weight first; equal weights keep the header's order.
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  return ranked.map((entry) => entry.primary).find(isLocale) ?? null;
}

/** The locale a request renders in: the cookie, else Accept-Language, else English. */
export function resolveLocale(cookieValue: string | null | undefined, acceptLanguage: string | null | undefined): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  return negotiateAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}

/** The `document.cookie` assignment that stores `locale` for a year. */
export function localeCookie(locale: Locale, secure: boolean): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure ? "; Secure" : ""}`;
}


