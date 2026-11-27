import { describe, expect, it, vi } from "vitest";
import type { FormFuelBatchesResultDTO, FuelFilePreviewDTO } from "@/lib/types";
import {
  addDecimal,
  canApply,
  companyLabel,
  copyToAll,
  declarationsOf,
  formUntilDone,
  initialUsage,
  previewTotals,
} from "./fuel-upload-view";

const preview = (over: Partial<FuelFilePreviewDTO> = {}): FuelFilePreviewDTO => ({
  source: "tanker",
  fileName: "t.xlsx",
  fileSize: 10,
  fileSha256: "ab",
  usage: null,
  rowsRead: 3,
  refused: [],
  duplicates: [],
  accounts: [],
  unrecognisedNames: [],
  deliveries: [
    { documentNo: "IRS-1", receiving: "A", litres: "1168", row: 2, needs: "declaration" },
    { documentNo: "IRS-2", receiving: "A", litres: "500.5", row: 3, needs: "declaration" },
    { documentNo: "IRS-3", receiving: "A", litres: "10", row: 4, needs: "stored" },
  ],
  ...over,
});

const step = (over: Partial<FormFuelBatchesResultDTO>): FormFuelBatchesResultDTO => ({
  formedBatches: 0, joinedBatches: 0, processableRows: 0, held: [], waiting: [], ...over,
});

describe("the Upload tab's choices", () => {
  it("preselects on-road for a card file, and nothing for a tanker file", () => {
    expect(initialUsage("shell")).toBe("on_road");
    expect(initialUsage("petrol_ofisi")).toBe("on_road");
    expect(initialUsage("tanker")).toBeNull();
  });

  it("holds the apply while any delivery to declare lacks a field; a stored delivery needs none", () => {
    const p = preview();
    const full = { fuel: "diesel", usage: "stationary", year: 2025, month: 3 } as const;
    expect(canApply(p, null, {})).toBe(false);
    expect(canApply(p, null, { "IRS-1": full })).toBe(false);
    expect(canApply(p, null, { "IRS-1": full, "IRS-2": { ...full, month: undefined } })).toBe(false);
    expect(canApply(p, null, { "IRS-1": full, "IRS-2": { ...full, month: 13 } })).toBe(false);
    expect(canApply(p, null, { "IRS-1": full, "IRS-2": full })).toBe(true);
    expect(declarationsOf(p, { "IRS-1": full, "IRS-2": full })!.map((d) => d.documentNo)).toEqual(["IRS-1", "IRS-2"]);
  });

  it("copies one delivery's filled fields to every delivery to declare, keeping the others' own fields", () => {
    const p = preview();
    const out = copyToAll(p, { "IRS-2": { month: 4 } }, { fuel: "diesel", usage: "stationary", year: 2025 });
    expect(out["IRS-1"]).toEqual({ fuel: "diesel", usage: "stationary", year: 2025 });
    expect(out["IRS-2"]).toEqual({ fuel: "diesel", usage: "stationary", year: 2025, month: 4 });
    expect(out["IRS-3"]).toBeUndefined();
  });

  it("applies a card file once a usage is chosen, and nothing before a preview", () => {
    const card = preview({ source: "shell", usage: "on_road", deliveries: [] });
    expect(canApply(card, "on_road", {})).toBe(true);
    expect(canApply(card, null, {})).toBe(false);
    expect(canApply(null, "on_road", {})).toBe(false);
  });
});

describe("forming batches until nothing is processable", () => {
  it("stops at zero processable rows even with held rows left", async () => {
    const results = [step({ formedBatches: 200, processableRows: 360 }), step({ formedBatches: 200, processableRows: 160 }),
      step({ formedBatches: 160, processableRows: 0, held: [{ reason: "period_locked", rows: 4, litres: "40" }] })];
    const call = vi.fn(async () => results.shift()!);
    const out = await formUntilDone(call);
    expect(call).toHaveBeenCalledTimes(3);
    expect(out).toMatchObject({ formed: 560, steps: 3, last: { processableRows: 0 } });
  });

  it("stops when a step makes no progress, and at the cap", async () => {
    const stuck = vi.fn(async () => step({ processableRows: 5 }));
    expect((await formUntilDone(stuck)).steps).toBe(2);
    const slow = vi.fn(async () => step({ formedBatches: 1, processableRows: 5 }));
    expect((await formUntilDone(slow, undefined, 3)).steps).toBe(3);
  });
});

describe("totals and names", () => {
  it("adds litres as decimals, never as floats", () => {
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(addDecimal("1168", "69.38")).toBe("1237.38");
    expect(addDecimal("15973.75", "0.25")).toBe("15974");
  });

  it("sums a preview's outcomes across accounts, every outcome listed", () => {
    const totals = previewTotals(preview({
      accounts: [
        { accountId: null, code: "A", name: "A", subsidiaryId: null, subsidiaryName: null, proposed: false,
          outcomes: [{ outcome: "batches", rows: 3, litres: "300.5" }, { outcome: "waiting_fuel", rows: 1, litres: "20" }] },
        { accountId: "x", code: "B", name: "B", subsidiaryId: "s", subsidiaryName: "S", proposed: false,
          outcomes: [{ outcome: "batches", rows: 1, litres: "0.5" }] },
      ],
    }));
    expect(totals.batches).toEqual({ rows: 4, litres: "301" });
    expect(totals.waiting_fuel).toEqual({ rows: 1, litres: "20" });
    expect(totals.outside_scope).toEqual({ rows: 0, litres: "0" });
  });

  it("names no company the server did not name", () => {
    expect(companyLabel(null, "Outside your companies")).toBe("Outside your companies");
    expect(companyLabel("TonyAI Logistics", "Outside your companies")).toBe("TonyAI Logistics");
  });
});
