"use client";

import { useLocale, useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/i18n/number";
import { formatLitresText } from "@/lib/fuel-upload-view";
import type { FuelHoldReason, FuelRowCountDTO, Locale } from "@/lib/types";

/** Litres as the screens print them: the server's decimal, read in the user's locale (display only). */
export function formatLitres(litres: string, locale: Locale): string {
  // Every decimal the stored figure has, from its text (0.0004 L is not 0 L — WP9 PR B reviews).
  const separator = formatNumber(1.5, locale, { minimumFractionDigits: 1 }).replace(/\d/g, "");
  return formatLitresText(litres, (value) => formatNumber(value, locale, { maximumFractionDigits: 0 }), separator);
}

/** "12 rows · 1.234,5 L" in the reader's language. */
export function RowCount({ count }: { count: FuelRowCountDTO }) {
  const t = useTranslations("fuelFiles");
  const locale = useLocale() as Locale;
  return (
    <span className="tabular-nums">
      {t(count.rows === 1 ? "rowsOne" : "rowsMany", { count: formatNumber(count.rows, locale) })}
      {" · "}
      {t("litres", { litres: formatLitres(count.litres, locale) })}
    </span>
  );
}

/** Held rows, one line per reason, worded as the bulk import's row issues are. */
export function HeldRows({ held }: { held: ReadonlyArray<FuelRowCountDTO & { reason: FuelHoldReason | string }> }) {
  const tIssues = useTranslations("errors.bulkUploadIssues");
  if (held.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm">
      {held.map((h) => (
        <li key={h.reason} className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="border-amber-500/40 text-amber-700">
            {tIssues.has(h.reason as never) ? tIssues(h.reason as never) : h.reason}
          </Badge>
          <RowCount count={h} />
        </li>
      ))}
    </ul>
  );
}
