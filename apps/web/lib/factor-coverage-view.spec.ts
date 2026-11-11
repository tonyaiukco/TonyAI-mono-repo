import { describe, expect, it } from "vitest";
import type { FactorCoverageDTO, FactorCoverageEntry } from "@/lib/types";
import { coverageView } from "./factor-coverage-view";

const entry = (geographyCode: string, reportingYear: number, ...statuses: FactorCoverageEntry["statuses"]): FactorCoverageEntry => ({
  geographyCode,
  reportingYear,
  statuses,
});
const of = (...entries: FactorCoverageEntry[]): FactorCoverageDTO => ({ entries });

describe("coverageView (BUG-R2-09)", () => {
  it("collapses consecutive authoritative years into one range — the pilot library", () => {
    const view = coverageView(of(entry("TR", 2026, "authoritative"), entry("TR", 2024, "authoritative"), entry("TR", 2025, "authoritative")), "TR", 2025);
    expect(view.ranges).toEqual([{ geographyCode: "TR", from: 2024, to: 2026, placeholder: false }]);
    expect(view.selected).toBe("authoritative");
  });

  it("splits a range at a gap", () => {
    const view = coverageView(of(entry("TR", 2022, "authoritative"), entry("TR", 2024, "authoritative"), entry("TR", 2025, "authoritative")), null, null);
    expect(view.ranges).toEqual([
      { geographyCode: "TR", from: 2022, to: 2022, placeholder: false },
      { geographyCode: "TR", from: 2024, to: 2025, placeholder: false },
    ]);
  });

  it("flags years resting only on placeholder or fixture releases, and splits where the standing changes", () => {
    const view = coverageView(
      of(entry("UK", 2025, "placeholder"), entry("UK", 2026, "fixture"), entry("UK", 2027, "authoritative")),
      "UK",
      2026,
    );
    expect(view.ranges).toEqual([
      { geographyCode: "UK", from: 2025, to: 2026, placeholder: true },
      { geographyCode: "UK", from: 2027, to: 2027, placeholder: false },
    ]);
    expect(view.selected).toBe("placeholder");
  });

  it("counts a year with an authoritative release beside a fixture as authoritative", () => {
    const view = coverageView(of(entry("TR", 2025, "authoritative", "fixture")), "TR", 2025);
    expect(view.ranges[0].placeholder).toBe(false);
    expect(view.selected).toBe("authoritative");
  });

  it("reports a geography or a year outside the library as uncovered", () => {
    const pilot = of(entry("TR", 2024, "authoritative"), entry("TR", 2025, "authoritative"), entry("TR", 2026, "authoritative"));
    expect(coverageView(pilot, "UK", 2026).selected).toBe("uncovered");
    expect(coverageView(pilot, "TR", 2023).selected).toBe("uncovered");
  });

  it("has no selection until the form knows both geography and year", () => {
    const pilot = of(entry("TR", 2026, "authoritative"));
    expect(coverageView(pilot, null, 2026).selected).toBeNull();
    expect(coverageView(pilot, "TR", null).selected).toBeNull();
  });

  it("answers an empty library with no ranges and every pair uncovered", () => {
    expect(coverageView(of(), "TR", 2026)).toEqual({ ranges: [], selected: "uncovered" });
  });

  it("never joins two geographies into one range, even in consecutive years with the same standing", () => {
    const view = coverageView(of(entry("EU", 2025, "placeholder"), entry("UK", 2026, "placeholder")), null, null);
    expect(view.ranges).toEqual([
      { geographyCode: "EU", from: 2025, to: 2025, placeholder: true },
      { geographyCode: "UK", from: 2026, to: 2026, placeholder: true },
    ]);
  });

  it("reads standing from every status, not the first: an authoritative release listed second still counts", () => {
    const view = coverageView(of(entry("TR", 2025, "fixture", "authoritative")), "TR", 2025);
    expect(view.ranges[0].placeholder).toBe(false);
    expect(view.selected).toBe("authoritative");
  });

  it("orders geographies by code, then years", () => {
    const view = coverageView(of(entry("UK", 2026, "placeholder"), entry("EU", 2026, "placeholder"), entry("TR", 2026, "authoritative")), null, null);
    expect(view.ranges.map((r) => r.geographyCode)).toEqual(["EU", "TR", "UK"]);
  });
});
