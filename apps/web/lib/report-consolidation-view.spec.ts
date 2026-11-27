import { describe, expect, it } from "vitest";
import type { ReportMetaDTO } from "@/lib/types";
import { previewConsolidation, showsCardFuelAttribution } from "./report-consolidation-view";

const meta = (over: Record<string, unknown>) => ({ status: "approved", organisationName: "Org", ...over }) as unknown as ReportMetaDTO;

describe("previewConsolidation", () => {
  it("reads the approach and the associates from the preview's own meta", () => {
    expect(previewConsolidation(meta({ consolidationApproach: "financial_control", excludedAssociates: ["Bosphorus"] }), false))
      .toEqual({ approach: "financial_control", associates: ["Bosphorus"] });
  });

  it("is loading before the read, failed after a failed read", () => {
    expect(previewConsolidation(null, false)).toBe("loading");
    expect(previewConsolidation(null, true)).toBe("failed");
  });

  it("says failed — never throws — when an earlier API answers without them (a rollback)", () => {
    expect(previewConsolidation(meta({}), false)).toBe("failed");
    expect(previewConsolidation(meta({ consolidationApproach: "financial_control" }), false)).toBe("failed");
    expect(previewConsolidation(meta({ consolidationApproach: "equity_share", excludedAssociates: [] }), false)).toBe("failed");
  });
});

describe("the card-fuel attribution in the preview (inc28-fuel-bulk D17)", () => {
  it("is stated only with the methodology note and the server's flag", () => {
    expect(showsCardFuelAttribution({ cardFuelAttribution: true }, true)).toBe(true);
    expect(showsCardFuelAttribution({ cardFuelAttribution: true }, false)).toBe(false);
    expect(showsCardFuelAttribution({ cardFuelAttribution: false }, true)).toBe(false);
    expect(showsCardFuelAttribution(null, true)).toBe(false);
    // An earlier API sends no flag.
    expect(showsCardFuelAttribution({} as never, true)).toBe(false);
  });
});
