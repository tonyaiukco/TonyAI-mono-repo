"use client";

import { useTranslations } from "use-intl";
import type { FactorCoverageDTO } from "@/lib/types";
import { coverageView, type CoverageRange } from "@/lib/factor-coverage-view";
import { geographyLabel } from "@/lib/vocabulary";
import { cn } from "@/lib/utils";

/**
 * Which geographies and years the factor library prices (UAT round 2,
 * BUG-R2-09): read from `GET /factors/coverage`, so it is true in every
 * environment and under the API's placeholder policy. Advisory — absent when
 * the report could not be read, never a claim of coverage. Years are printed
 * as written: a grouped "2,024" is not a year.
 */
export function FactorCoverageLegend({
  coverage,
  geography,
  year,
}: {
  coverage: FactorCoverageDTO | null;
  geography: string | null;
  year: number | null;
}) {
  const t = useTranslations("dataEntry.factorCoverage");
  const tGeography = useTranslations("geography");
  if (!coverage) return null;

  const view = coverageView(coverage, geography, year);
  const years = (range: CoverageRange) =>
    range.from === range.to ? String(range.from) : t("yearRange", { from: String(range.from), to: String(range.to) });
  const ranges = view.ranges
    .map((range) => {
      const text = `${geographyLabel(range.geographyCode, tGeography)} ${years(range)}`;
      return range.placeholder ? `${text} (${t("placeholder")})` : text;
    })
    .join("; ");
  const named = geography ? geographyLabel(geography, tGeography) : "";
  const selectedYear = year == null ? "" : String(year);

  return (
    <div className="space-y-1 text-xs" data-testid="factor-coverage-legend">
      <p className={cn(view.ranges.length === 0 ? "text-amber-700" : "text-muted-foreground")}>
        {view.ranges.length === 0 ? t("none") : t("lead", { ranges })}
      </p>
      {view.selected === "uncovered" && view.ranges.length > 0 && (
        <p className="font-medium text-amber-700" role="status">
          {t("uncovered", { geography: named, year: selectedYear })}
        </p>
      )}
      {view.selected === "placeholder" && (
        <p className="font-medium text-amber-700" role="status">
          {t("placeholderSelected", { geography: named, year: selectedYear })}
        </p>
      )}
    </div>
  );
}
