import type {
  InventoryBoundaryGapCode,
  InventoryBoundaryVersionDTO,
  InventoryBoundaryVersionSummary,
  InventoryCategory,
  SubsidiaryDTO,
  UserRole,
} from "./types";

/**
 * What the boundary editor (LP4-03 PR C) may offer and shows, from the API's
 * answers alone. The API decides every write — super_admin's, on an open
 * version only — so this module only keeps the screen from offering what it
 * would refuse; a refusal it did not foresee is still toasted and reloaded.
 */

export type VersionState = "open" | "confirmed" | "frozenUnconfirmed";

/** Open until frozen; frozen by its confirmation, or unconfirmed by a capture into a dataset. */
export function versionState(v: Pick<InventoryBoundaryVersionSummary, "decision" | "frozenAt">): VersionState {
  if (v.frozenAt === null) return "open";
  return v.decision === "confirmed" ? "confirmed" : "frozenUnconfirmed";
}

/** Newest first, as the API lists them — sorted again so the screen never depends on it. */
export const newestFirst = <T extends Pick<InventoryBoundaryVersionSummary, "version">>(versions: readonly T[]): T[] =>
  [...versions].sort((a, b) => b.version - a.version);

export type ConfirmBlock = "empty" | "gaps" | null;

export interface BoundaryActions {
  /** A new version may be started: the year has no open version (`boundary_draft_open`). */
  create: boolean;
  /** The selected version takes writes: declare, edit, remove, confirm, delete. */
  edit: boolean;
  /** Why confirming the selected version would be refused (`boundary_incomplete`), when it would. */
  confirmBlock: ConfirmBlock;
}

/** Only super_admin writes (`BoundaryWriterGuard`); only the year's open version takes a write. */
export function boundaryActions(input: {
  role: UserRole | undefined;
  versions: readonly InventoryBoundaryVersionSummary[];
  selected: InventoryBoundaryVersionDTO | null;
}): BoundaryActions {
  const writer = input.role === "super_admin";
  const open = input.versions.some((v) => v.frozenAt === null);
  const editable = writer && input.selected !== null && input.selected.frozenAt === null
    && input.selected.view === "organisation";
  return {
    create: writer && !open,
    edit: editable,
    confirmBlock: input.selected === null ? null : confirmBlock(input.selected),
  };
}

export function confirmBlock(v: Pick<InventoryBoundaryVersionDTO, "boundary" | "boundaryGaps">): ConfirmBlock {
  if (v.boundary.subsidiaryIds.length === 0) return "empty";
  return v.boundaryGaps.length > 0 ? "gaps" : null;
}

export interface SubsidiaryRow {
  id: string;
  name: string;
  declared: boolean;
  /** The subsidiary's months when declared. */
  months: { first: number; last: number } | null;
  sites: number;
  sources: number;
  gaps: number;
  /** Its reporting status as the subsidiaries list says; null when the caller cannot see it there. */
  status: SubsidiaryDTO["reportingStatus"] | null;
}

/** A subsidiary's name as a boundary names it (the API's `tradingName || legalName`). */
export const boundaryName = (s: Pick<SubsidiaryDTO, "tradingName" | "legalName">): string => s.tradingName || s.legalName;

/**
 * Every subsidiary the version declares and every one the caller sees that it
 * does not — declared first, each group by name. A declared one is named as
 * the version names it — live while open, the name it froze once frozen, the
 * name its reports carry; an undeclared one as the API would name it.
 */
export function subsidiaryRows(
  v: Pick<InventoryBoundaryVersionDTO, "boundary" | "boundaryGaps">,
  subsidiaries: readonly SubsidiaryDTO[],
): SubsidiaryRow[] {
  const listed = new Map(subsidiaries.map((s) => [s.id, s]));
  const declared = v.boundary.entities
    .filter((e) => e.locationId === null)
    .map((company): SubsidiaryRow => ({
      id: company.subsidiaryId,
      name: company.subsidiaryName,
      declared: true,
      months: { first: company.firstMonth, last: company.lastMonth },
      sites: v.boundary.entities.filter((e) => e.subsidiaryId === company.subsidiaryId && e.locationId !== null).length,
      sources: v.boundary.sources.filter((s) => s.entity.subsidiaryId === company.subsidiaryId).length,
      gaps: v.boundaryGaps.filter((g) => g.entity.subsidiaryId === company.subsidiaryId).length,
      status: listed.get(company.subsidiaryId)?.reportingStatus ?? null,
    }));
  const declaredIds = new Set(declared.map((r) => r.id));
  const undeclared = subsidiaries
    .filter((s) => !declaredIds.has(s.id))
    .map((s): SubsidiaryRow => ({
      id: s.id, name: boundaryName(s), declared: false, months: null, sites: 0, sources: 0, gaps: 0, status: s.reportingStatus,
    }));
  const byName = (a: SubsidiaryRow, b: SubsidiaryRow) => a.name.localeCompare(b.name);
  return [...declared.sort(byName), ...undeclared.sort(byName)];
}

export interface GapLine {
  code: InventoryBoundaryGapCode;
  /** The entity's site name; null: the company entity. */
  siteName: string | null;
  category: InventoryCategory | null;
  sourceNames: string[];
}

/** One subsidiary's gaps, each naming where it is and the sources it names. */
export function gapLines(v: Pick<InventoryBoundaryVersionDTO, "boundary" | "boundaryGaps">, subsidiaryId: string): GapLine[] {
  const siteNames = new Map(
    v.boundary.entities.filter((e) => e.subsidiaryId === subsidiaryId && e.locationId !== null)
      .map((e) => [e.locationId as string, e.locationName ?? e.locationId as string]),
  );
  const sourceNames = new Map(v.boundary.sources.map((s) => [s.id, s.name]));
  return v.boundaryGaps
    .filter((g) => g.entity.subsidiaryId === subsidiaryId)
    .map((g) => ({
      code: g.code,
      siteName: g.entity.locationId === null ? null : siteNames.get(g.entity.locationId) ?? g.entity.locationId,
      category: (g.category ?? null) as InventoryCategory | null,
      sourceNames: g.sourceIds.map((id) => sourceNames.get(id) ?? id),
    }));
}

/** The subsidiaries the caller sees that the version does not declare — a confirmation leaves them out. */
export function undeclaredSubsidiaries(
  v: Pick<InventoryBoundaryVersionDTO, "boundary">,
  subsidiaries: readonly SubsidiaryDTO[],
): SubsidiaryDTO[] {
  const declared = new Set(v.boundary.subsidiaryIds);
  return subsidiaries.filter((s) => !declared.has(s.id));
}
