import {
  REPORT_COVERAGE_GAP_CODES,
  REPORT_ISSUANCE_GAP_CODES,
  type ReportCoverageGapCode,
  type ReportIssuanceGapCode,
  type ReportLiveCoverage,
  type ReportScope3Disclosure,
  type ReportStatus,
} from "@/lib/types";

/**
 * What a live report's preview says about its review status, its Scope 3
 * records and the boundary's coverage (LP4-03 PR B; K3, K4, K8) — as message
 * keys of the `reports` catalogue with their arguments, so the screen and its
 * tests read one mapping. Pure: no React, no locale.
 */

export interface Line {
  key: string;
  values?: Record<string, string | number>;
}

/** The review badge: what the selection's records' review says — never "the inventory is complete". */
export const STATUS_KEY: Record<ReportStatus, string> = {
  approved: "status.approved",
  draft: "status.draft",
  contains_incomplete_data: "status.incomplete",
};

/** The coverage gap codes, in the contract's order, as their catalogue keys. */
export const COVERAGE_GAP_KEY: Record<ReportCoverageGapCode, string> = Object.fromEntries(
  REPORT_COVERAGE_GAP_CODES.map((code) => [code, `coverageGap.${code}`]),
) as Record<ReportCoverageGapCode, string>;

/**
 * The coverage card's lines: a headline, then — for an assessed boundary — what
 * its reading means and the gaps by code. `tone` is how the card is drawn:
 * `complete` only for the one reading that is (still never a certification).
 */
export function coverageLines(coverage: ReportLiveCoverage, year: number): {
  tone: "complete" | "gaps" | "unknown";
  lines: Line[];
  gaps: Array<{ code: ReportCoverageGapCode; count: number }>;
} {
  switch (coverage.state) {
    case "no_boundary":
      return { tone: "unknown", lines: [{ key: "coverage.noBoundary", values: { year } }], gaps: [] };
    case "not_readable":
      return { tone: "unknown", lines: [{ key: "coverage.notReadable", values: { year } }], gaps: [] };
    case "not_covered":
      return { tone: "unknown", lines: [{ key: "coverage.notCovered" }], gaps: [] };
    case "too_broad":
      return { tone: "unknown", lines: [{ key: "coverage.tooBroad" }], gaps: [] };
    case "assessed": {
      const decision = coverage.boundary.decision === "confirmed"
        ? "coverage.decisionConfirmed"
        : coverage.boundary.frozen ? "coverage.decisionFrozen" : "coverage.decisionOpen";
      const head: Line = {
        key: coverage.selection === "extract" ? "coverage.assessedExtract" : "coverage.assessed",
        values: {
          version: coverage.boundary.version,
          decision,
          satisfied: coverage.satisfiedObligationCount,
          total: coverage.obligationCount,
          excluded: coverage.excludedSourceCount,
        },
      };
      const gaps = REPORT_COVERAGE_GAP_CODES
        .filter((code) => (coverage.gapCounts[code] ?? 0) > 0)
        .map((code) => ({ code, count: coverage.gapCounts[code] ?? 0 }));
      const reading: Line = {
        complete: { key: "coverage.complete" },
        gaps: { key: "coverage.gaps" },
        nothing_included: { key: "coverage.nothingIncluded" },
        outside_boundary: { key: "coverage.outsideBoundary", values: { year } },
      }[coverage.reading];
      return { tone: coverage.reading === "complete" ? "complete" : "gaps", lines: [head, reading], gaps };
    }
  }
}

/**
 * The Scope 3 disclosure: not covered, and — when there are any — its committed
 * records, never summed. A calculated sum is read with how many records carry
 * no figure: "5 records (0 tCO₂e)" alone would hide that none was calculated.
 */
export function scope3Lines(scope3: ReportScope3Disclosure): Line[] {
  if (scope3.recordCount === 0) return [{ key: "scope3.notCovered" }];
  const lines: Line[] = [
    { key: "scope3.notCovered" },
    { key: "scope3.recorded", values: { count: scope3.recordCount, tonnes: scope3.calculatedTCo2e } },
  ];
  if (scope3.uncalculatedRecordCount > 0) {
    lines.push({ key: "scope3.uncalculated", values: { count: scope3.uncalculatedRecordCount } });
  }
  return lines;
}

/**
 * An issuance preview's gaps, one line per code with its count, in the
 * contract's code order: what blocks a final, named — never only a total.
 */
export function issuanceGapCounts(gaps: readonly { code: ReportIssuanceGapCode }[]): { code: ReportIssuanceGapCode; count: number }[] {
  return REPORT_ISSUANCE_GAP_CODES.map((code) => ({ code, count: gaps.filter((g) => g.code === code).length })).filter((g) => g.count > 0);
}

/** Does a selection read Scope 3 alone — `scope=3`, or a Scope 3 category with no scope? Its tiles read "Not covered". */
export function selectsScope3Only(
  context: { scope?: number; category?: string },
  scopeOf: (category: string) => number | undefined,
): boolean {
  return context.scope === 3 || (context.category !== undefined && scopeOf(context.category) === 3);
}
