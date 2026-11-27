import { describe, expect, it } from "vitest";
import { MANUAL_FUELS, fuelRecordTarget, fuelUsagesFor } from "@/lib/types";
import {
  EMPTY_FUEL_PAIR,
  chooseFuel,
  filedAsStationary,
  fuelsOffered,
  missingChoice,
  pairOf,
  pairTarget,
  showsCardFuelNote,
  showsFuelPair,
  usagesOffered,
} from "./fuel-entry-view";

describe("the fuel and usage choices (D6)", () => {
  it("preselects nothing, and names the missing choice", () => {
    expect(EMPTY_FUEL_PAIR).toEqual({ fuel: "", usage: "" });
    expect(missingChoice(EMPTY_FUEL_PAIR)).toBe("fuel");
    expect(missingChoice(chooseFuel("diesel"))).toBe("usage");
    expect(pairTarget(chooseFuel("diesel"))).toBeNull();
    expect(missingChoice({ fuel: "diesel", usage: "on_road" })).toBeNull();
  });

  it("offers only priced pairs: LPG never off-road", () => {
    expect(usagesOffered("diesel", null)).toEqual(["on_road", "off_road", "stationary"]);
    expect(usagesOffered("petrol", null)).toEqual(["on_road", "off_road", "stationary"]);
    expect(usagesOffered("lpg", null)).toEqual(["on_road", "stationary"]);
    expect(usagesOffered("", null)).toEqual([]);
  });

  it("fixes marine gas oil's usage, in kg or tonnes, and saves it as before", () => {
    const mgo = chooseFuel("marine_gas_oil");
    expect(mgo).toEqual({ fuel: "marine_gas_oil", usage: "marine" });
    expect(pairTarget(mgo)).toMatchObject({ category: "Mobile Combustion", activityType: "marine_gas_oil", units: ["kg", "tonnes"] });
    expect(filedAsStationary(mgo)).toBe(false);
  });

  it("enters stationary LPG by mass and on-road LPG in litres, never converting", () => {
    expect(pairTarget({ fuel: "lpg", usage: "stationary" })).toMatchObject({ category: "Fuel", activityType: "lpg", units: ["kg"] });
    expect(pairTarget({ fuel: "lpg", usage: "on_road" })).toMatchObject({ category: "Mobile Combustion", units: ["litres"] });
  });

  it("files generator diesel under stationary combustion, as a Fuel record of diesel", () => {
    const generator = { fuel: "diesel", usage: "stationary" } as const;
    expect(filedAsStationary(generator)).toBe(true);
    expect(pairTarget(generator)).toMatchObject({ category: "Fuel", activityType: "diesel", units: ["litres"] });
    expect(pairTarget({ fuel: "diesel", usage: "on_road" })).toMatchObject({ category: "Mobile Combustion", activityType: "on_road_diesel" });
  });

  it("limits a standard user's usages to the categories its grant holds", () => {
    expect(usagesOffered("diesel", ["Mobile Combustion"])).toEqual(["on_road", "off_road"]);
    expect(usagesOffered("diesel", ["Fuel"])).toEqual(["stationary"]);
    expect(usagesOffered("marine_gas_oil", ["Fuel"])).toEqual([]);
    expect(fuelsOffered(["Fuel"])).toEqual(["diesel", "petrol", "lpg"]);
    expect(fuelsOffered(["Electricity"])).toEqual([]);
  });
});

describe("an opened record shows its pair", () => {
  it("reads every stored token D6's table produces back as its pair", () => {
    for (const fuel of MANUAL_FUELS) {
      for (const usage of fuelUsagesFor(fuel)) {
        const target = fuelRecordTarget(fuel, usage)!;
        expect(pairOf(target.category, target.activityType), `${fuel}/${usage}`).toEqual({ fuel, usage });
      }
    }
  });

  it("reads no pair for another category's or an older token, which the form shows as before", () => {
    expect(pairOf("Fuel", "natural_gas")).toBeNull();
    expect(pairOf("Mobile Combustion", "car_petrol")).toBeNull();
    expect(pairOf("Mobile Combustion", null)).toBeNull();
    // A Fuel record of diesel reads as the stationary pair; the same token under Mobile Combustion as none.
    expect(pairOf("Mobile Combustion", "diesel")).toBeNull();
  });

  it("shows the card-fuel note on the Mobile Combustion and Fuel entries only", () => {
    expect(showsCardFuelNote("Mobile Combustion")).toBe(true);
    expect(showsCardFuelNote("Fuel")).toBe(true);
    expect(showsCardFuelNote("Electricity")).toBe(false);
  });
});

describe("where the pair is shown", () => {
  it("leaves a company on another factor set's entry as it was", () => {
    expect(showsFuelPair({ category: "Mobile Combustion", trRules: false, pairOrigin: false, pairLegacy: false })).toBe(false);
    expect(showsFuelPair({ category: "Fuel", trRules: false, pairOrigin: true, pairLegacy: false })).toBe(false);
  });

  it("shows it on a TR Mobile Combustion entry, on the Fuel record a stationary pair made, and not on a plain Fuel entry", () => {
    expect(showsFuelPair({ category: "Mobile Combustion", trRules: true, pairOrigin: false, pairLegacy: false })).toBe(true);
    expect(showsFuelPair({ category: "Fuel", trRules: true, pairOrigin: true, pairLegacy: false })).toBe(true);
    expect(showsFuelPair({ category: "Fuel", trRules: true, pairOrigin: false, pairLegacy: false })).toBe(false);
    // An opened record whose type no pair produces keeps the earlier picker.
    expect(showsFuelPair({ category: "Mobile Combustion", trRules: true, pairOrigin: false, pairLegacy: true })).toBe(false);
  });
});
