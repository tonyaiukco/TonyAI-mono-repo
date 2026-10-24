import { describe, expect, it } from "vitest";
import {
  CATEGORY_SCOPE_MAP,
  REPORT_COVERAGE_GAP_CODES,
  REPORT_ISSUANCE_GAP_CODES,
  REPORT_TEMPLATES,
  SUPPORTED_LOCALES,
  type Category,
  type ReportLiveCoverage,
} from "@/lib/types";
import { MESSAGES } from "@/messages";
import { COVERAGE_GAP_KEY, coverageLines, issuanceGapCounts, scope3Lines, selectsScope3Only, STATUS_KEY } from "./report-coverage-view";

/**
 * The live preview's words for review status, Scope 3 and coverage (LP4-03
 * PR B): every state and reading has a line, a one-record year never reads
 * complete, and every key the mapping emits exists in both catalogues.
 */

const lookup = (locale: (typeof SUPPORTED_LOCALES)[number], key: string): unknown =>
  key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], MESSAGES[locale].reports);

const assessed = (over: Partial<Extract<ReportLiveCoverage, { state: "assessed" }>> = {}): ReportLiveCoverage => ({
  state: "assessed",
  boundary: { id: "b-1", version: 2, decision: "unconfirmed", frozen: false },
  selection: "inventory",
  obligationCount: 12,
  satisfiedObligationCount: 1,
  excludedSourceCount: 4,
  gapCounts: { missing_record: 11, boundary_unconfirmed: 1 },
  reading: "gaps",
  ...over,
});

const EVERY_COVERAGE: ReportLiveCoverage[] = [
  { state: "no_boundary" },
  { state: "not_readable" },
  { state: "not_covered" },
  { state: "too_broad" },
  assessed(),
  assessed({ reading: "complete", gapCounts: {}, satisfiedObligationCount: 12, boundary: { id: "b", version: 1, decision: "confirmed", frozen: true } }),
  assessed({ reading: "nothing_included", gapCounts: {}, obligationCount: 0, satisfiedObligationCount: 0 }),
  assessed({ reading: "outside_boundary", selection: "extract", gapCounts: { unmapped_record: 2 } }),
];

describe("coverageLines", () => {
  it("never calls a one-record year complete: its gaps are listed in the contract's order", () => {
    const view = coverageLines(assessed(), 2026);
    expect(view.tone).toBe("gaps");
    expect(view.lines.map((l) => l.key)).toEqual(["coverage.assessed", "coverage.gaps"]);
    expect(view.lines[0].values).toMatchObject({ version: 2, decision: "coverage.decisionOpen", satisfied: 1, total: 12, excluded: 4 });
    expect(view.gaps).toEqual([{ code: "boundary_unconfirmed", count: 1 }, { code: "missing_record", count: 11 }]);
  });

  it("draws complete only for the complete reading, and says it is still no certification", () => {
    expect(coverageLines(EVERY_COVERAGE[5], 2026)).toMatchObject({ tone: "complete", lines: [{ key: "coverage.assessed" }, { key: "coverage.complete" }] });
    for (const c of EVERY_COVERAGE.filter((x) => x !== EVERY_COVERAGE[5])) expect(coverageLines(c, 2026).tone).not.toBe("complete");
  });

  it("says what is unknown, and why, for every state without an assessment", () => {
    expect(coverageLines({ state: "no_boundary" }, 2026).lines).toEqual([{ key: "coverage.noBoundary", values: { year: 2026 } }]);
    expect(coverageLines({ state: "not_readable" }, 2026).lines).toEqual([{ key: "coverage.notReadable", values: { year: 2026 } }]);
    expect(coverageLines({ state: "not_covered" }, 2026).lines).toEqual([{ key: "coverage.notCovered" }]);
    expect(coverageLines({ state: "too_broad" }, 2026).lines).toEqual([{ key: "coverage.tooBroad" }]);
    // Unknown is its own tone: neither the green of complete nor the amber of a known gap.
    for (const state of ["no_boundary", "not_readable", "not_covered", "too_broad"] as const) {
      expect(coverageLines({ state }, 2026).tone, state).toBe("unknown");
    }
  });

  it("names the year a subsidiary is outside of", () => {
    const view = coverageLines(EVERY_COVERAGE[7], 2026);
    expect(view.lines[1]).toEqual({ key: "coverage.outsideBoundary", values: { year: 2026 } });
  });

  it("maps each review status to its own badge, worded as review — never as certification", () => {
    expect(STATUS_KEY).toEqual({ approved: "status.approved", draft: "status.draft", contains_incomplete_data: "status.incomplete" });
    expect(lookup("en", "status.approved")).toBe("All records approved");
    expect(lookup("en", "status.draft")).toBe("Draft — pending review");
    expect(lookup("en", "status.incomplete")).toBe("Contains incomplete data");
  });

  it("names an extract, a frozen version and a confirmed one apart", () => {
    expect(coverageLines(EVERY_COVERAGE[7], 2026).lines[0].key).toBe("coverage.assessedExtract");
    expect(coverageLines(assessed({ boundary: { id: "b", version: 1, decision: "unconfirmed", frozen: true } }), 2026).lines[0].values?.decision)
      .toBe("coverage.decisionFrozen");
    expect(coverageLines(EVERY_COVERAGE[5], 2026).lines[0].values?.decision).toBe("coverage.decisionConfirmed");
  });

  it.each(SUPPORTED_LOCALES)("%s: every key a state, a reading or a gap emits is in the catalogue", (locale) => {
    const keys = new Set<string>();
    for (const c of EVERY_COVERAGE) {
      for (const line of coverageLines(c, 2026).lines) {
        keys.add(line.key);
        if (typeof line.values?.decision === "string") keys.add(line.values.decision);
      }
    }
    for (const key of [...keys, ...Object.values(COVERAGE_GAP_KEY), ...Object.values(STATUS_KEY), "coverage.gapCount", "scope3.notCovered", "scope3.recorded", "scope3.uncalculated", "scope3.noInventoryFigures"]) {
      expect(typeof lookup(locale, key), `${locale} reports.${key}`).toBe("string");
    }
    for (const code of REPORT_ISSUANCE_GAP_CODES) expect(typeof lookup(locale, `issuanceGap.${code}`), code).toBe("string");
    // The Issued tab builds these at runtime too.
    for (const { id } of REPORT_TEMPLATES) expect(typeof lookup(locale, `templates.${id}`), id).toBe("string");
    for (const l of SUPPORTED_LOCALES) expect(typeof lookup(locale, `issued.languages.${l}`), l).toBe("string");
    expect(Object.keys(COVERAGE_GAP_KEY)).toEqual([...REPORT_COVERAGE_GAP_CODES]);
  });
});

describe("issuanceGapCounts", () => {
  it("names each blocking gap with its count, in the contract's order, and nothing for a final", () => {
    expect(issuanceGapCounts([])).toEqual([]);
    expect(
      issuanceGapCounts([{ code: "unlocked_period" }, { code: "coverage_gap" }, { code: "coverage_gap" }]),
    ).toEqual([
      { code: "coverage_gap", count: 2 },
      { code: "unlocked_period", count: 1 },
    ]);
  });
});

describe("scope3Lines and selectsScope3Only", () => {
  it("discloses Scope 3's committed records, never as a figure of the inventory", () => {
    expect(scope3Lines({ coverage: "not_covered", recordCount: 0, calculatedTCo2e: 0, uncalculatedRecordCount: 0 })).toEqual([{ key: "scope3.notCovered" }]);
    expect(scope3Lines({ coverage: "not_covered", recordCount: 3, calculatedTCo2e: 12.5, uncalculatedRecordCount: 0 }))
      .toEqual([{ key: "scope3.notCovered" }, { key: "scope3.recorded", values: { count: 3, tonnes: 12.5 } }]);
    // A 0 sum is read with its uncalculated count, never alone.
    expect(scope3Lines({ coverage: "not_covered", recordCount: 5, calculatedTCo2e: 0, uncalculatedRecordCount: 5 }))
      .toEqual([
        { key: "scope3.notCovered" },
        { key: "scope3.recorded", values: { count: 5, tonnes: 0 } },
        { key: "scope3.uncalculated", values: { count: 5 } },
      ]);
  });

  it("reads a Scope 3 category with no scope as a Scope 3 selection", () => {
    const scopeOf = (c: string) => CATEGORY_SCOPE_MAP[c as Category];
    expect(selectsScope3Only({ scope: 3 }, scopeOf)).toBe(true);
    expect(selectsScope3Only({ category: "Water" }, scopeOf)).toBe(true);
    expect(selectsScope3Only({ category: "Electricity" }, scopeOf)).toBe(false);
    expect(selectsScope3Only({ category: "Natural Gas" }, scopeOf)).toBe(false);
    expect(selectsScope3Only({ scope: 1 }, scopeOf)).toBe(false);
    expect(selectsScope3Only({}, scopeOf)).toBe(false);
  });
});
