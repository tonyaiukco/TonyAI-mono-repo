import { describe, it, expect } from "vitest";
import { recordWordsFor } from "@/lib/i18n/testing";
import { categoryWithActivity } from "@/lib/vocabulary";
import en from "@/messages/en/dataEntry.json";
import tr from "@/messages/tr/dataEntry.json";
import enCategories from "@/messages/en/categories.json";
import trCategories from "@/messages/tr/categories.json";

/**
 * The record's activity type by name (uat2-review-shows-gas): the review queue
 * row and the review sheet read a record as "category (type)", so two records
 * of one site and period that differ only by gas or fuel read differently.
 */
describe("RecordWords.activity / categoryWithActivity", () => {
  const enWords = recordWordsFor("en");
  const trWords = recordWordsFor("tr");

  it("names a refrigerant gas beside its category", () => {
    expect(categoryWithActivity(enWords, { category: "Refrigerants", activityType: "R-410A" })).toBe(
      `${enCategories.Refrigerants} (${en.activityTypes["R-410A"]})`,
    );
    expect(categoryWithActivity(enWords, { category: "Refrigerants", activityType: "R-32" })).toBe(
      `${enCategories.Refrigerants} (${en.activityTypes["R-32"]})`,
    );
  });

  it("names every typed category's type, not only a gas — in English and Turkish", () => {
    expect(categoryWithActivity(enWords, { category: "Fuel", activityType: "diesel" })).toBe(
      `${enCategories.Fuel} (${en.activityTypes.diesel})`,
    );
    expect(categoryWithActivity(trWords, { category: "Fuel", activityType: "diesel" })).toBe(
      `${trCategories.Fuel} (${tr.activityTypes.diesel})`,
    );
    expect(categoryWithActivity(trWords, { category: "Refrigerants", activityType: "R-410A" })).toBe(
      `${trCategories.Refrigerants} (${tr.activityTypes["R-410A"]})`,
    );
  });

  it("shows the category alone when the record names no type", () => {
    for (const activityType of [null, undefined, ""]) {
      expect(enWords.activity("Fuel", activityType)).toBeNull();
      expect(categoryWithActivity(enWords, { category: "Fuel", activityType })).toBe(enCategories.Fuel);
    }
  });

  it("shows an implicit category (no types) alone", () => {
    expect(categoryWithActivity(trWords, { category: "Fugitive Gas", activityType: null })).toBe(
      trCategories["Fugitive Gas"],
    );
  });

  it("shows a value outside the category's list as stored, never hidden", () => {
    expect(enWords.activity("Refrigerants", "R-9999")).toBe("R-9999");
    // `diesel` is a Fuel type, not a gas: the flat catalogue must not name it here.
    expect(enWords.activity("Refrigerants", "diesel")).toBe("diesel");
    expect(categoryWithActivity(enWords, { category: "Refrigerants", activityType: "R-9999" })).toBe(
      `${enCategories.Refrigerants} (R-9999)`,
    );
  });

  it("shows a legacy `unspecified` type by Data Entry's wording, in both languages", () => {
    expect(enWords.activity("Fuel", "unspecified")).toBe(en.notSpecifiedLegacy);
    expect(trWords.activity("Fuel", "unspecified")).toBe(tr.notSpecifiedLegacy);
  });

  it("never renders a prototype key as a key path", () => {
    expect(enWords.activity("Fuel", "constructor")).toBe("constructor");
    expect(enWords.activity("constructor", "toString")).toBe("toString");
  });

  it("never leaves empty brackets", () => {
    for (const activityType of [null, "", "R-410A", "unknown"]) {
      expect(categoryWithActivity(enWords, { category: "Refrigerants", activityType })).not.toContain("()");
    }
  });
});
