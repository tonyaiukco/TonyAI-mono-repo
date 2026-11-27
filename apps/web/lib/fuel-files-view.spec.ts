import { describe, expect, it } from "vitest";
import type { FuelRowCountDTO, FuelRowState, FuelUploadDTO } from "@/lib/types";
import { uploadActions, withdrawChoices, withdrawRequest } from "./fuel-files-view";

const none: FuelRowCountDTO = { rows: 0, litres: "0" };
const upload = (rows: Partial<Record<FuelRowState, FuelRowCountDTO>>, over: Partial<FuelUploadDTO> = {}) =>
  ({
    id: "u1",
    readerIsHolder: true,
    processableRows: 0,
    held: [],
    rows: { assigned: none, ready: none, held: none, waiting_account: none, waiting_fuel: none, excluded: none, withdrawn: none, ...rows },
    ...over,
  }) as FuelUploadDTO;

describe("withdrawing an upload's rows in no batch (WP9 PR B review, P2)", () => {
  it("offers the withdrawal to a role that authors records while any row is in no batch, excluded ones included", () => {
    expect(uploadActions(upload({ excluded: { rows: 4, litres: "80" } }), "standard_user").withdraw).toBe(true);
    expect(uploadActions(upload({ waiting_fuel: { rows: 1, litres: "5" } }), "super_admin").withdraw).toBe(true);
    expect(uploadActions(upload({ assigned: { rows: 9, litres: "90" } }), "masterkey").withdraw).toBe(false);
    expect(uploadActions(upload({ excluded: { rows: 4, litres: "80" } }), "auditor").withdraw).toBe(false);
  });

  it("lists accounts, then waiting fuel names, and builds the one request the endpoint takes", () => {
    const choices = withdrawChoices({
      accounts: [{ accountId: "a1", code: "PO-9001", name: "Associate", rows: 4, litres: "80", excluded: 4 }],
      fuelNames: [{ rawName: "Otogaz LPG", rows: 1, litres: "10" }],
    });
    expect(choices.map((c) => c.value)).toEqual(["account:a1", "fuel:Otogaz LPG"]);
    expect(withdrawRequest(choices, "account:a1", "  now controlled ")).toEqual({ accountId: "a1", reason: "now controlled" });
    expect(withdrawRequest(choices, "fuel:Otogaz LPG", "not ours")).toEqual({ rawFuelName: "Otogaz LPG", reason: "not ours" });
    expect(withdrawRequest(choices, "account:a1", "   ")).toBeNull();
    expect(withdrawRequest(choices, "", "why")).toBeNull();
  });
});
