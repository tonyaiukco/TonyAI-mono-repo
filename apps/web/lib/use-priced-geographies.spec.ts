import { describe, expect, it } from "vitest";
import { pricedChoices, pricedDefault } from "./use-priced-geographies";

/** The geography pickers (inc26-group-tree, D10; owner review of WP7, P2). */
describe("pricedChoices", () => {
  it("offers only the priced geographies to a new record", () => {
    expect(pricedChoices(["TR"])).toEqual(["TR"]);
    expect(pricedChoices(["TR"])).not.toContain("UK");
  });

  it("keeps the value an existing record already holds, priced or not", () => {
    expect(pricedChoices(["TR"], "UK")).toEqual(["TR", "UK"]);
    expect(pricedChoices(["TR"], "TR")).toEqual(["TR"]);
  });

  it("offers nothing new while coverage is unread or after a failed read — never the whole list", () => {
    expect(pricedChoices(null)).toEqual([]);
    expect(pricedChoices(null, "UK")).toEqual(["UK"]);
  });

  it("offers a priced code outside the selectable list only as a parent's, or as the record's own", () => {
    expect(pricedChoices(["TR", "EU"])).toEqual(["TR"]);
    expect(pricedChoices(["TR", "EU"], null, "EU")).toEqual(["TR", "EU"]);
    expect(pricedChoices(["TR"], null, "UK")).toEqual(["TR"]);
    expect(pricedChoices(["TR", "EU"], "EU")).toEqual(["TR", "EU"]);
  });
});

describe("pricedDefault", () => {
  it("takes the parent's geography only when it is priced, else the first priced one", () => {
    expect(pricedDefault(["TR"], "TR")).toBe("TR");
    expect(pricedDefault(["TR"], "UK")).toBe("TR");
    expect(pricedDefault(["UK", "TR"], null)).toBe("UK");
    expect(pricedDefault(["TR", "EU"], "EU")).toBe("EU");
  });

  it("is none while coverage is unread", () => {
    expect(pricedDefault(null, "UK")).toBe("");
  });
});
