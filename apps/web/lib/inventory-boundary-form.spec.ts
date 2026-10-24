import { describe, expect, it } from "vitest";
import en from "../messages/en/boundary.json";
import tr from "../messages/tr/boundary.json";
import {
  addSite,
  DECLARATION_ISSUE_CODES,
  cellKey,
  declarationFingerprint,
  declarationIssues,
  draftFromSnapshot,
  emptyDraft,
  newSource,
  removeSite,
  requestFromDraft,
  storedDeclaration,
  versionFingerprint,
  withCategory,
  type DeclarationDraft,
} from "./inventory-boundary-form";
import type { InventoryBoundarySnapshot, InventoryEntitySnapshot, PutInventoryBoundarySubsidiaryRequest } from "./types";

const SUB = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const entity = (subsidiaryId: string, locationId: string | null, firstMonth = 1, lastMonth = 12): InventoryEntitySnapshot => ({
  subsidiaryId,
  subsidiaryName: subsidiaryId === SUB ? "Energy" : "Other",
  locationId,
  locationName: locationId === null ? null : locationId === SITE_A ? "Plant A" : "Depot B",
  geographyCode: "TR",
  firstMonth: firstMonth as InventoryEntitySnapshot["firstMonth"],
  lastMonth: lastMonth as InventoryEntitySnapshot["lastMonth"],
});

/** Every shape a stored declaration can take — what the API admits, never tidied. */
const SNAPSHOT: InventoryBoundarySnapshot = {
  id: "v1",
  version: 1,
  organisationId: "org",
  reportingYear: 2028,
  subsidiaryIds: [SUB, OTHER],
  decision: "unconfirmed",
  decidedBy: null,
  decidedAt: null,
  entities: [entity(SUB, null, 3, 11), entity(SUB, SITE_A, 3, 9), entity(SUB, SITE_B, 6, 11), entity(OTHER, null)],
  attribution: [
    { subsidiaryId: SUB, category: "Electricity", level: "sites", reportingPeriod: "monthly" },
    { subsidiaryId: SUB, category: "Fuel", level: "company", reportingPeriod: "annual" },
    { subsidiaryId: OTHER, category: "Electricity", level: "company", reportingPeriod: "annual" },
  ],
  applicability: [
    { subsidiaryId: SUB, locationId: SITE_A, category: "Electricity", applicability: "included", sourceIds: ["s1"] },
    { subsidiaryId: SUB, locationId: SITE_B, category: "Electricity", applicability: "excluded", reason: "Leased, landlord pays" },
    // At an entity its policy does not select: stored, shown, sent back.
    { subsidiaryId: SUB, locationId: null, category: "Electricity", applicability: "undetermined", reason: "Head office?" },
    { subsidiaryId: SUB, locationId: null, category: "Fuel", applicability: "included", sourceIds: ["s3"] },
    { subsidiaryId: OTHER, locationId: null, category: "Electricity", applicability: "excluded", reason: "No operations" },
  ],
  sources: [
    {
      id: "s1", name: "Meter A1", entity: entity(SUB, SITE_A, 3, 9), scope: 2,
      mapping: { kind: "mapped", category: "Electricity", activityType: null },
      applicability: "included", reportingPeriod: "monthly", evidenceReportingPeriod: null, obligations: [],
    },
    {
      id: "s2", name: "Old meter A0", entity: entity(SUB, SITE_A, 3, 9), scope: 2,
      mapping: { kind: "mapped", category: "Electricity", activityType: null },
      applicability: "excluded", reason: "Decommissioned in 2027",
    },
    {
      id: "s3", name: "Generator diesel", entity: entity(SUB, null, 3, 11), scope: 1,
      mapping: { kind: "mapped", category: "Fuel", activityType: "diesel" },
      applicability: "included", reportingPeriod: "annual", evidenceReportingPeriod: "quarterly", obligations: [],
    },
    {
      id: "s4", name: "Steam purchase", entity: entity(SUB, null, 3, 11), scope: 2,
      mapping: { kind: "unsupported", reason: "No steam factor" },
      applicability: "included", reportingPeriod: "quarterly", evidenceReportingPeriod: "quarterly", obligations: [],
    },
    {
      id: "s5", name: "Welding gas", entity: entity(SUB, SITE_B, 6, 11), scope: 1,
      mapping: { kind: "unsupported", reason: "Not in the library" },
      applicability: "excluded", reason: "Below materiality",
    },
    {
      id: "s6", name: "Forklift LPG", entity: entity(SUB, null, 3, 11), scope: 1,
      mapping: { kind: "mapped", category: "Mobile Combustion", activityType: "lpg" },
      applicability: "undetermined", reason: "Ask the site manager",
    },
    {
      id: "s7", name: "Other meter", entity: entity(OTHER, null), scope: 2,
      mapping: { kind: "mapped", category: "Electricity", activityType: null },
      applicability: "excluded", reason: "Elsewhere",
    },
  ],
};

/** The body the API stored that snapshot from, for SUB. */
const EXPECTED: PutInventoryBoundarySubsidiaryRequest = {
  // Divested at the end of November: a re-save never stretches it to December.
  firstMonth: 3,
  lastMonth: 11,
  sites: [
    { locationId: SITE_A, firstMonth: 3, lastMonth: 9 },
    { locationId: SITE_B, firstMonth: 6, lastMonth: 11 },
  ],
  attribution: [
    { category: "Electricity", level: "sites", reportingPeriod: "monthly" },
    { category: "Fuel", level: "company", reportingPeriod: "annual" },
  ],
  applicability: [
    { locationId: SITE_A, category: "Electricity", applicability: "included" },
    { locationId: SITE_B, category: "Electricity", applicability: "excluded", reason: "Leased, landlord pays" },
    { locationId: null, category: "Electricity", applicability: "undetermined", reason: "Head office?" },
    { locationId: null, category: "Fuel", applicability: "included" },
  ],
  sources: [
    { locationId: SITE_A, name: "Meter A1", mapping: { kind: "mapped", category: "Electricity", activityType: null }, applicability: "included", evidenceReportingPeriod: null },
    { locationId: SITE_A, name: "Old meter A0", mapping: { kind: "mapped", category: "Electricity", activityType: null }, applicability: "excluded", reason: "Decommissioned in 2027" },
    { locationId: null, name: "Generator diesel", mapping: { kind: "mapped", category: "Fuel", activityType: "diesel" }, applicability: "included", evidenceReportingPeriod: "quarterly" },
    { locationId: null, name: "Steam purchase", mapping: { kind: "unsupported", reason: "No steam factor" }, scope: 2, reportingPeriod: "quarterly", applicability: "included", evidenceReportingPeriod: "quarterly" },
    { locationId: SITE_B, name: "Welding gas", mapping: { kind: "unsupported", reason: "Not in the library" }, scope: 1, applicability: "excluded", reason: "Below materiality" },
    { locationId: null, name: "Forklift LPG", mapping: { kind: "mapped", category: "Mobile Combustion", activityType: "lpg" }, applicability: "undetermined", reason: "Ask the site manager" },
  ],
};

const draft = () => draftFromSnapshot(SNAPSHOT, SUB) as DeclarationDraft;

describe("draftFromSnapshot → requestFromDraft", () => {
  it("rebuilds exactly the body the API stored — every field, nothing added or tidied", () => {
    expect(requestFromDraft(draft())).toStrictEqual(EXPECTED);
  });

  it("is a fixed point: the body read back again is the same body", () => {
    expect(declarationFingerprint(requestFromDraft(draft()))).toBe(declarationFingerprint(EXPECTED));
  });

  it("sends a mapped source no scope and no cadence, an excluded one no evidence cadence", () => {
    const body = requestFromDraft(draft());
    const mapped = body.sources.filter((s) => s.mapping.kind === "mapped");
    for (const s of mapped) {
      expect(s).not.toHaveProperty("scope");
      expect(s).not.toHaveProperty("reportingPeriod");
    }
    for (const s of body.sources.filter((x) => x.applicability !== "included")) {
      expect(s).not.toHaveProperty("evidenceReportingPeriod");
    }
    for (const c of body.applicability.filter((x) => x.applicability === "included")) expect(c).not.toHaveProperty("reason");
  });

  it("reads only its own subsidiary, and null for one the version does not declare", () => {
    expect(draftFromSnapshot(SNAPSHOT, OTHER)?.sources.map((s) => s.name)).toEqual(["Other meter"]);
    expect(draftFromSnapshot(SNAPSHOT, "33333333-3333-4333-8333-333333333333")).toBeNull();
  });

  it("sends free text trimmed and in NFC", () => {
    const d = draft();
    d.sources[1] = { ...d.sources[1], name: `  Cafe${String.fromCharCode(0x301)} meter `, reason: " Gone " };
    const sent = requestFromDraft(d).sources[1];
    expect(sent.name).toBe(`Caf${String.fromCharCode(0xe9)} meter`);
    expect(sent).toMatchObject({ reason: "Gone" });
  });

  it("sends every free text trimmed — a cell's reason and an unsupported source's reason too", () => {
    const d = draft();
    d.cells[cellKey(SITE_B, "Electricity")] = { applicability: "excluded", reason: " Leased " };
    d.sources[3] = { ...d.sources[3], unsupportedReason: " No steam factor " };
    const body = requestFromDraft(d);
    expect(body.applicability.find((c) => c.locationId === SITE_B)).toMatchObject({ reason: "Leased" });
    expect(body.sources[3].mapping).toEqual({ kind: "unsupported", reason: "No steam factor" });
  });

  it("an untyped category's source names no activity type, whatever the draft holds", () => {
    const d = draft();
    d.sources[0] = { ...d.sources[0], activityType: "grid_electricity" };
    expect(requestFromDraft(d).sources[0].mapping).toEqual({ kind: "mapped", category: "Electricity", activityType: null });
  });

  it("an included source keeps its stored evidence choice; one not included has none to keep", () => {
    const d = draft();
    expect(d.sources[0].evidenceReportingPeriod).toBeNull();
    expect(d.sources[2].evidenceReportingPeriod).toBe("quarterly");
    expect(d.sources[1].evidenceReportingPeriod).toBeUndefined();
  });

  it("an empty draft is the whole year with nothing else declared", () => {
    expect(requestFromDraft(emptyDraft())).toStrictEqual({
      firstMonth: 1, lastMonth: 12, sites: [], attribution: [], applicability: [], sources: [],
    });
  });
});

describe("storedDeclaration — what a save compares (D4)", () => {
  it("does not move when only row order, source ids or live names do", () => {
    const shuffled: InventoryBoundarySnapshot = {
      ...SNAPSHOT,
      entities: [...SNAPSHOT.entities].reverse().map((e) => ({ ...e, subsidiaryName: "Renamed", locationName: e.locationName && `${e.locationName}!` })),
      applicability: [...SNAPSHOT.applicability].reverse(),
      attribution: [...SNAPSHOT.attribution].reverse(),
      sources: [...SNAPSHOT.sources].reverse().map((s) => ({ ...s, id: `${s.id}-new` })),
    };
    expect(storedDeclaration(shuffled, SUB)).toBe(storedDeclaration(SNAPSHOT, SUB));
  });

  it("moves when any declared fact does", () => {
    const base = storedDeclaration(SNAPSHOT, SUB);
    const changed: InventoryBoundarySnapshot = {
      ...SNAPSHOT,
      applicability: SNAPSHOT.applicability.map((c) =>
        c.locationId === SITE_B && c.applicability !== "included" ? { ...c, reason: "Leased; the landlord pays" } : c),
    };
    expect(storedDeclaration(changed, SUB)).not.toBe(base);
    const removed: InventoryBoundarySnapshot = { ...SNAPSHOT, sources: SNAPSHOT.sources.filter((s) => s.id !== "s5") };
    expect(storedDeclaration(removed, SUB)).not.toBe(base);
    // Another subsidiary's change is not this one's.
    const elsewhere: InventoryBoundarySnapshot = { ...SNAPSHOT, sources: SNAPSHOT.sources.filter((s) => s.id !== "s7") };
    expect(storedDeclaration(elsewhere, SUB)).toBe(base);
  });

  it("tells declared from not declared", () => {
    expect(storedDeclaration(SNAPSHOT, "33333333-3333-4333-8333-333333333333")).toBe("null");
    expect(storedDeclaration(SNAPSHOT, SUB)).not.toBe("null");
  });
});

describe("versionFingerprint — what a confirmation compares", () => {
  it("moves with any subsidiary's declaration and with the names it would freeze, not with order or ids", () => {
    const base = versionFingerprint(SNAPSHOT);
    expect(versionFingerprint({
      ...SNAPSHOT,
      subsidiaryIds: [...SNAPSHOT.subsidiaryIds].reverse(),
      entities: [...SNAPSHOT.entities].reverse(),
      sources: [...SNAPSHOT.sources].reverse().map((s) => ({ ...s, id: `${s.id}-new` })),
    })).toBe(base);
    const renamed = { ...SNAPSHOT, entities: SNAPSHOT.entities.map((e) => (e.locationId === SITE_A ? { ...e, locationName: "Plant A2" } : e)) };
    expect(versionFingerprint(renamed)).not.toBe(base);
    // A save does not conflict on a rename.
    expect(storedDeclaration(renamed, SUB)).toBe(storedDeclaration(SNAPSHOT, SUB));
    expect(versionFingerprint({ ...SNAPSHOT, entities: SNAPSHOT.entities.map((e) => ({ ...e, geographyCode: "UK" })) })).not.toBe(base);
    expect(versionFingerprint({ ...SNAPSHOT, entities: SNAPSHOT.entities.map((e) => ({ ...e, subsidiaryName: `${e.subsidiaryName} Ltd` })) }))
      .not.toBe(base);
    expect(versionFingerprint({ ...SNAPSHOT, sources: SNAPSHOT.sources.filter((s) => s.id !== "s7") })).not.toBe(base);
    expect(versionFingerprint({
      ...SNAPSHOT,
      subsidiaryIds: [SUB],
      entities: SNAPSHOT.entities.filter((e) => e.subsidiaryId === SUB),
      applicability: SNAPSHOT.applicability.filter((c) => c.subsidiaryId === SUB),
      attribution: SNAPSHOT.attribution.filter((a) => a.subsidiaryId === SUB),
      sources: SNAPSHOT.sources.filter((s) => s.entity.subsidiaryId === SUB),
    })).not.toBe(base);
  });
});

describe("edits", () => {
  it("removing a site removes its cells and sources, and nothing else", () => {
    const d = removeSite(draft(), SITE_A);
    expect(d.sites.map((s) => s.locationId)).toEqual([SITE_B]);
    expect(Object.keys(d.cells)).not.toContain(cellKey(SITE_A, "Electricity"));
    expect(Object.keys(d.cells)).toContain(cellKey(SITE_B, "Electricity"));
    expect(d.sources.map((s) => s.name)).not.toContain("Meter A1");
    expect(d.sources.map((s) => s.name)).toContain("Welding gas");
    expect(declarationIssues(d)).toEqual([]);
  });

  it("a new site takes the subsidiary's months, and is added once", () => {
    const d = addSite({ ...emptyDraft(), firstMonth: 4, lastMonth: 8 }, SITE_A);
    expect(d.sites).toEqual([{ locationId: SITE_A, firstMonth: 4, lastMonth: 8 }]);
    expect(addSite(d, SITE_A)).toBe(d);
  });

  it("a category keeps a matching activity type and clears the rest; an implicit one names none", () => {
    const s = { ...newSource(), category: "Fuel" as const, activityType: "diesel" };
    expect(withCategory(s, "Fuel").activityType).toBe("diesel");
    // Electricity and Natural Gas are implicit: a record names no activity type.
    expect(withCategory(s, "Electricity").activityType).toBeNull();
    expect(withCategory(s, "Refrigerants").activityType).toBeNull();
  });

  it("new sources have distinct keys", () => {
    expect(newSource().key).not.toBe(newSource().key);
  });
});

describe("declarationIssues — the API's refusals, on their fields", () => {
  const codes = (d: DeclarationDraft) => declarationIssues(d).map((i) => `${i.field}:${i.code}`);

  it("admits every stored shape", () => {
    expect(declarationIssues(draft())).toEqual([]);
  });

  it("every issue code has its sentence in both catalogues", () => {
    for (const code of DECLARATION_ISSUE_CODES) {
      expect(en.editor.issues, code).toHaveProperty(code);
      expect(tr.editor.issues, code).toHaveProperty(code);
    }
    expect(Object.keys(en.editor.issues).sort()).toEqual([...DECLARATION_ISSUE_CODES].sort());
  });

  it("months: order, a site's order, a site outside the subsidiary's", () => {
    expect(codes({ ...emptyDraft(), firstMonth: 6, lastMonth: 5 })).toEqual(["months:monthsOrder"]);
    // One month is a year's inventory too.
    expect(codes({ ...emptyDraft(), firstMonth: 5, lastMonth: 5 })).toEqual([]);
    const d = draft();
    d.sites = [{ locationId: SITE_A, firstMonth: 9, lastMonth: 3 }, { locationId: SITE_B, firstMonth: 1, lastMonth: 12 }];
    expect(codes(d)).toEqual([`site:${SITE_A}:siteMonthsOrder`, `site:${SITE_B}:siteOutsideMonths`]);
    // At the edges, inside.
    d.sites = [{ locationId: SITE_A, firstMonth: 3, lastMonth: 11 }, { locationId: SITE_B, firstMonth: 3, lastMonth: 3 }];
    expect(codes(d)).toEqual([]);
    d.sites = [{ locationId: SITE_A, firstMonth: 3, lastMonth: 12 }, { locationId: SITE_B, firstMonth: 3, lastMonth: 3 }];
    expect(codes(d)).toEqual([`site:${SITE_A}:siteOutsideMonths`]);
  });

  it("a cell's reason: required when not included, at most 500, no invisible character", () => {
    const key = cellKey(null, "Natural Gas");
    const withCell = (reason: string, applicability: "excluded" | "undetermined" | "included" = "excluded") =>
      codes({ ...emptyDraft(), cells: { [key]: { applicability, reason } } });
    expect(withCell("   ")).toEqual([`cell:${key}:textRequired`]);
    expect(withCell("x".repeat(501))).toEqual([`cell:${key}:textTooLong`]);
    expect(withCell(` ${"x".repeat(500)} `)).toEqual([]);
    expect(withCell(`a${String.fromCharCode(0x200b)}b`, "undetermined")).toEqual([`cell:${key}:textInvalid`]);
    expect(withCell("", "included")).toEqual([]);
  });

  it("a row at a site the body does not declare", () => {
    const d = { ...emptyDraft(), cells: { [cellKey(SITE_A, "Fuel")]: { applicability: "included" as const, reason: "" } } };
    expect(codes(d)).toEqual([`cell:${cellKey(SITE_A, "Fuel")}:siteNotDeclared`]);
    const s = { ...newSource(SITE_A), name: "X", kind: "unsupported" as const, unsupportedReason: "R", scope: 1 as const, applicability: "excluded" as const, reason: "R" };
    expect(codes({ ...emptyDraft(), sources: [s] })).toEqual([`source:${s.key}:location:siteNotDeclared`]);
  });

  it("an included source's evidence is chosen, never defaulted — none is a choice too", () => {
    const s = { ...newSource(), name: "Boiler", category: "Natural Gas" as const, applicability: "excluded" as const, reason: "R" };
    const withPolicy = { ...emptyDraft(), attribution: { "Natural Gas": { level: "company" as const, reportingPeriod: "annual" as const } } };
    expect(newSource().evidenceReportingPeriod).toBeUndefined();
    expect(codes({ ...withPolicy, sources: [{ ...s, applicability: "included" }] })).toEqual([`source:${s.key}:evidence:evidenceRequired`]);
    expect(codes({ ...withPolicy, sources: [{ ...s, applicability: "included", evidenceReportingPeriod: null }] })).toEqual([]);
    expect(codes({ ...withPolicy, sources: [{ ...s, applicability: "included", evidenceReportingPeriod: "monthly" }] })).toEqual([]);
  });

  it("free-text caps: a source's name 200, every reason 500", () => {
    const s = { ...newSource(), kind: "unsupported" as const, scope: 1 as const, applicability: "excluded" as const };
    const at = (patch: Partial<typeof s>) => codes({ ...emptyDraft(), sources: [{ ...s, name: "N", unsupportedReason: "U", reason: "R", ...patch }] });
    expect(at({ name: "x".repeat(200) })).toEqual([]);
    expect(at({ name: "x".repeat(201) })).toEqual([`source:${s.key}:name:textTooLong`]);
    expect(at({ reason: "x".repeat(500), unsupportedReason: "x".repeat(500) })).toEqual([]);
    expect(at({ reason: "x".repeat(501) })).toEqual([`source:${s.key}:reason:textTooLong`]);
    expect(at({ unsupportedReason: "x".repeat(501) })).toEqual([`source:${s.key}:unsupportedReason:textTooLong`]);
  });

  it("a mapped source: its name, category, activity type, and — included — its category's policy", () => {
    const s = { ...newSource(), evidenceReportingPeriod: null };
    expect(codes({ ...emptyDraft(), sources: [s] })).toEqual([`source:${s.key}:name:textRequired`, `source:${s.key}:category:categoryRequired`]);
    const fuel = { ...s, name: "Tank", category: "Fuel" as const };
    expect(codes({ ...emptyDraft(), sources: [fuel] })).toEqual([
      `source:${s.key}:activityType:activityTypeRequired`, `source:${s.key}:category:policyRequired`,
    ]);
    expect(declarationIssues({ ...emptyDraft(), sources: [{ ...fuel, activityType: "diesel" }] })[0].values).toEqual({ category: "Fuel" });
    const withPolicy = { ...emptyDraft(), attribution: { Fuel: { level: "company" as const, reportingPeriod: "annual" as const } } };
    expect(codes({ ...withPolicy, sources: [{ ...fuel, activityType: "diesel" }] })).toEqual([]);
    // A type of another category is not one of this category's.
    expect(codes({ ...withPolicy, sources: [{ ...fuel, activityType: "grid_electricity" }] }))
      .toEqual([`source:${s.key}:activityType:activityTypeRequired`]);
    // Not included: no policy needed, a reason is.
    expect(codes({ ...emptyDraft(), sources: [{ ...fuel, activityType: "diesel", applicability: "excluded" }] }))
      .toEqual([`source:${s.key}:reason:textRequired`]);
    // An untyped category names no activity type.
    expect(codes({ ...emptyDraft(), sources: [{ ...s, name: "Boiler", category: "Natural Gas", applicability: "excluded", reason: "R" }] }))
      .toEqual([]);
  });

  it("two included mapped sources on one entity, category and activity type", () => {
    const withPolicy = { ...emptyDraft(), attribution: { Fuel: { level: "company" as const, reportingPeriod: "annual" as const } } };
    const a = { ...newSource(), name: "Tank 1", category: "Fuel" as const, activityType: "diesel", evidenceReportingPeriod: null };
    const b = { ...newSource(), name: "Tank 2", category: "Fuel" as const, activityType: "diesel", evidenceReportingPeriod: null };
    expect(codes({ ...withPolicy, sources: [a, b] })).toEqual([`source:${b.key}:activityType:duplicateIncluded`]);
    // A named exclusion beside its meter is admitted, and so is another type.
    expect(codes({ ...withPolicy, sources: [a, { ...b, applicability: "excluded", reason: "Spare" }] })).toEqual([]);
    expect(codes({ ...withPolicy, sources: [a, { ...b, activityType: "gas_oil" }] })).toEqual([]);
    // The same type at another entity is another key.
    const withSite = addSite(withPolicy, SITE_A);
    expect(codes({ ...withSite, sources: [a, { ...b, locationId: SITE_A }] })).toEqual([]);
    // An untyped category has no activity-type field: the issue sits on the category.
    const elec = { ...withPolicy, attribution: { Electricity: { level: "company" as const, reportingPeriod: "monthly" as const } } };
    const m1 = { ...a, category: "Electricity" as const, activityType: null };
    const m2 = { ...b, category: "Electricity" as const, activityType: null };
    expect(codes({ ...elec, sources: [m1, m2] })).toEqual([`source:${b.key}:category:duplicateIncluded`]);
  });

  it("an unsupported source: its reason, its scope, and — included — its cadence", () => {
    const s = { ...newSource(), name: "Steam", kind: "unsupported" as const, evidenceReportingPeriod: null };
    expect(codes({ ...emptyDraft(), sources: [s] })).toEqual([
      `source:${s.key}:unsupportedReason:textRequired`, `source:${s.key}:scope:scopeRequired`, `source:${s.key}:reportingPeriod:cadenceRequired`,
    ]);
    expect(codes({ ...emptyDraft(), sources: [{ ...s, unsupportedReason: "No factor", scope: 2, reportingPeriod: "annual" }] })).toEqual([]);
  });

  it("a policy names its cadence: never defaulted", () => {
    expect(codes({ ...emptyDraft(), attribution: { Electricity: { level: "company", reportingPeriod: null } } }))
      .toEqual(["policy:Electricity:cadenceRequired"]);
  });
});
