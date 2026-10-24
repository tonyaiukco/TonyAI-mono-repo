import { describe, expect, it } from "vitest";
import {
  boundaryActions,
  confirmBlock,
  gapLines,
  newestFirst,
  subsidiaryRows,
  undeclaredSubsidiaries,
  versionState,
} from "./inventory-boundary-view";
import type {
  InventoryBoundaryVersionDTO,
  InventoryBoundaryVersionSummary,
  SubsidiaryDTO,
  UserRole,
} from "./types";

const summary = (version: number, patch: Partial<InventoryBoundaryVersionSummary> = {}): InventoryBoundaryVersionSummary => ({
  id: `v${version}`,
  reportingYear: 2028,
  version,
  decision: "unconfirmed",
  decidedBy: null,
  decidedAt: null,
  frozenAt: null,
  createdBy: "p",
  createdAt: "2026-10-24T00:00:00.000Z",
  ...patch,
});

const CONFIRMED = { decision: "confirmed" as const, decidedBy: "p", decidedAt: "2026-10-24T01:00:00.000Z", frozenAt: "2026-10-24T01:00:00.000Z" };
const CAPTURED = { frozenAt: "2026-10-24T01:00:00.000Z" };

const entity = (subsidiaryId: string, subsidiaryName: string, locationId: string | null = null, locationName: string | null = null) => ({
  subsidiaryId, subsidiaryName, locationId, locationName, geographyCode: "TR", firstMonth: 1 as const, lastMonth: 12 as const,
});

function dto(patch: Partial<InventoryBoundaryVersionDTO> = {}, declared: string[] = ["energy", "gas"]): InventoryBoundaryVersionDTO {
  const s = summary(2, patch);
  return {
    ...s,
    view: "organisation",
    boundary: {
      id: s.id, version: s.version, organisationId: "org", reportingYear: 2028, subsidiaryIds: declared,
      decision: s.decision, decidedBy: s.decidedBy, decidedAt: s.decidedAt,
      // Not in name order: the rows sort them.
      entities: [
        ...(declared.includes("gas") ? [entity("gas", "Gas UK")] : []),
        ...(declared.includes("energy") ? [entity("energy", "Energy TR"), entity("energy", "Energy TR", "plant", "Plant A")] : []),
      ],
      applicability: [],
      attribution: [],
      sources: declared.includes("energy")
        ? [{
          id: "src", name: "Steam", entity: entity("energy", "Energy TR"), scope: 2 as const,
          mapping: { kind: "unsupported" as const, reason: "No factor" },
          applicability: "undetermined" as const, reason: "Ask",
        }]
        : [],
    },
    boundaryGaps: declared.includes("energy")
      ? [
        { code: "unsupported_source", entity: { subsidiaryId: "energy", locationId: null }, sourceIds: ["src"], obligationIds: [], recordIds: [] },
        { code: "applicability_undetermined", entity: { subsidiaryId: "energy", locationId: "plant" }, category: "Electricity", sourceIds: [], obligationIds: [], recordIds: [] },
      ]
      : [],
    ...patch,
  };
}

const subsidiary = (
  id: string, legalName: string, reportingStatus: SubsidiaryDTO["reportingStatus"] = "active", tradingName: string | null = null,
) => ({ id, legalName, tradingName, reportingStatus }) as SubsidiaryDTO;

describe("versionState", () => {
  it("open until frozen; frozen confirmed, or frozen unconfirmed by a capture", () => {
    expect(versionState(summary(1))).toBe("open");
    expect(versionState(summary(1, CONFIRMED))).toBe("confirmed");
    expect(versionState(summary(1, CAPTURED))).toBe("frozenUnconfirmed");
  });

  it("newestFirst sorts by version, whatever the order it is given", () => {
    expect(newestFirst([summary(1), summary(3), summary(2)]).map((v) => v.version)).toEqual([3, 2, 1]);
  });
});

describe("boundaryActions — only super_admin writes, only on the open version", () => {
  const ROLES: UserRole[] = ["consultant", "data_entry", "executive_viewer"];

  it.each(ROLES)("%s may not create, edit or confirm", (role) => {
    const a = boundaryActions({ role, versions: [summary(1, CONFIRMED)], selected: dto() });
    expect(a.create).toBe(false);
    expect(a.edit).toBe(false);
  });

  it("an unknown role (user not loaded) writes nothing", () => {
    expect(boundaryActions({ role: undefined, versions: [], selected: null })).toEqual({ create: false, edit: false, confirmBlock: null });
  });

  it("super_admin starts a version only when the year has no open one (boundary_draft_open)", () => {
    expect(boundaryActions({ role: "super_admin", versions: [], selected: null }).create).toBe(true);
    expect(boundaryActions({ role: "super_admin", versions: [summary(1, CONFIRMED)], selected: null }).create).toBe(true);
    expect(boundaryActions({ role: "super_admin", versions: [summary(2), summary(1, CONFIRMED)], selected: null }).create).toBe(false);
  });

  it("says why a confirmation would be refused, for whoever looks", () => {
    expect(boundaryActions({ role: "consultant", versions: [summary(2)], selected: dto() }).confirmBlock).toBe("gaps");
    expect(boundaryActions({ role: "super_admin", versions: [summary(2)], selected: dto({}, ["gas"]) }).confirmBlock).toBeNull();
  });

  it("super_admin edits the open version, never a frozen one (boundary_frozen)", () => {
    expect(boundaryActions({ role: "super_admin", versions: [summary(2)], selected: dto() }).edit).toBe(true);
    expect(boundaryActions({ role: "super_admin", versions: [summary(2, CONFIRMED)], selected: dto(CONFIRMED) }).edit).toBe(false);
    expect(boundaryActions({ role: "super_admin", versions: [summary(2, CAPTURED)], selected: dto(CAPTURED) }).edit).toBe(false);
  });

  it("a partial view is never edited — a whole-subsidiary PUT from it would be one", () => {
    expect(boundaryActions({ role: "super_admin", versions: [summary(2)], selected: dto({ view: "granted_subsidiaries" }) }).edit)
      .toBe(false);
  });
});

describe("confirmBlock — boundary_incomplete before the request", () => {
  it("empty: no subsidiary declared; gaps: any boundary gap; else none", () => {
    expect(confirmBlock(dto({}, []))).toBe("empty");
    expect(confirmBlock(dto())).toBe("gaps");
    expect(confirmBlock(dto({}, ["gas"]))).toBeNull();
  });
});

describe("subsidiaryRows", () => {
  it("declared first, each by name — the version's own name, an undeclared one's trading name else legal; counts per subsidiary", () => {
    const rows = subsidiaryRows(dto({}, ["gas", "energy"]), [
      subsidiary("trading", "Trading UK", "inactive"), subsidiary("gas", "Gas UK Ltd.", "active", "Gas UK Trading"),
      subsidiary("mfg", "Mfg EU GmbH", "active", "Mfg EU"), subsidiary("alpha", "Alpha Holdings"),
    ]);
    expect(rows.map((r) => [r.name, r.declared])).toEqual([
      // Declared first, though "Alpha" sorts before them.
      ["Energy TR", true], ["Gas UK", true], ["Alpha Holdings", false], ["Mfg EU", false], ["Trading UK", false],
    ]);
    expect(rows[0]).toMatchObject({ sites: 1, sources: 1, gaps: 2, months: { first: 1, last: 12 }, status: null });
    expect(rows[1]).toMatchObject({ sites: 0, sources: 0, gaps: 0, status: "active" });
    expect(rows[4]).toMatchObject({ status: "inactive", months: null });
  });
});

describe("gapLines", () => {
  it("names the site and the sources of one subsidiary's gaps, and no other's", () => {
    expect(gapLines(dto(), "energy")).toEqual([
      { code: "unsupported_source", siteName: null, category: null, sourceNames: ["Steam"] },
      { code: "applicability_undetermined", siteName: "Plant A", category: "Electricity", sourceNames: [] },
    ]);
    expect(gapLines(dto(), "gas")).toEqual([]);
  });
});

describe("undeclaredSubsidiaries", () => {
  it("the subsidiaries the caller sees that a confirmation would leave out", () => {
    expect(undeclaredSubsidiaries(dto(), [subsidiary("energy", "Energy TR"), subsidiary("mfg", "Mfg EU")]).map((s) => s.id))
      .toEqual(["mfg"]);
  });
});
