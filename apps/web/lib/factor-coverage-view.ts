import type { FactorCoverageDTO } from "@/lib/types";

/**
 * The Data Entry coverage legend's shape (UAT round 2, BUG-R2-09), read from
 * `GET /factors/coverage`. Pure and wordless: the legend's component holds the
 * copy. A year counts as authoritative when any release behind it is; one
 * resting only on placeholder or fixture releases is flagged, so the legend
 * labels it rather than presenting it as sourced.
 */

/** Consecutive years of one geography with the same standing. */
export interface CoverageRange {
  geographyCode: string;
  from: number;
  to: number;
  /** No authoritative release behind these years. */
  placeholder: boolean;
}

export type SelectedCoverage = "authoritative" | "placeholder" | "uncovered";

export interface CoverageView {
  ranges: CoverageRange[];
  /** The form's geography and year; null until both are known. */
  selected: SelectedCoverage | null;
}

export function coverageView(
  coverage: FactorCoverageDTO,
  geography: string | null,
  year: number | null,
): CoverageView {
  const entries = [...coverage.entries].sort(
    (a, b) => a.geographyCode.localeCompare(b.geographyCode, "en") || a.reportingYear - b.reportingYear,
  );
  const ranges: CoverageRange[] = [];
  for (const entry of entries) {
    const placeholder = !entry.statuses.includes("authoritative");
    const last = ranges[ranges.length - 1];
    if (last && last.geographyCode === entry.geographyCode && last.placeholder === placeholder && last.to + 1 === entry.reportingYear) {
      last.to = entry.reportingYear;
    } else {
      ranges.push({ geographyCode: entry.geographyCode, from: entry.reportingYear, to: entry.reportingYear, placeholder });
    }
  }

  let selected: SelectedCoverage | null = null;
  if (geography && year != null) {
    const hit = entries.find((e) => e.geographyCode === geography && e.reportingYear === year);
    selected = !hit ? "uncovered" : hit.statuses.includes("authoritative") ? "authoritative" : "placeholder";
  }
  return { ranges, selected };
}
