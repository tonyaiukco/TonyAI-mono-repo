import { formatDistanceToNow } from "date-fns";
import { enUS, tr } from "date-fns/locale";
import type { Locale } from "@/lib/types";

/** date-fns' own wording per language. English stays `enUS`, the words the
 *  screens printed before they passed a locale ("about 2 hours ago"). */
const DATE_FNS_LOCALES = { en: enUS, tr } as const;

/** "3 days ago" / "3 gün önce" — `formatDistanceToNow` in the user's language. */
export function formatTimeAgo(date: Date | string, locale: Locale, addSuffix = true): string {
  return formatDistanceToNow(new Date(date), { addSuffix, locale: DATE_FNS_LOCALES[locale] });
}
