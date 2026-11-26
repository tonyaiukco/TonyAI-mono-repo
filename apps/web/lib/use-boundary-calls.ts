import { useMemo } from "react";
import { api } from "@/lib/api";
import { newestFirst, versionState } from "@/lib/inventory-boundary-view";
import type {
  InventoryBoundaryVersionDTO,
  InventoryBoundaryVersionSummary,
  PutInventoryBoundarySubsidiaryRequest,
} from "@/lib/types";

/**
 * The inventory boundary's calls (inc26-central-reporter-onboarding, task
 * 8.2), lifted from the boundary page so the setup wizard's step 5 writes a
 * declaration the same way: list a year's versions (newest first), open one,
 * open a new one, write a company's declaration, confirm, and a company's
 * sites. The boundary's own rules stay the API's.
 */
export interface BoundaryCalls {
  listYear(reportingYear: number): Promise<InventoryBoundaryVersionSummary[]>;
  open(id: string): Promise<InventoryBoundaryVersionDTO>;
  openNew(reportingYear: number, copyOf?: string): Promise<InventoryBoundaryVersionDTO>;
  writeDeclaration(versionId: string, subsidiaryId: string, request: PutInventoryBoundarySubsidiaryRequest): Promise<InventoryBoundaryVersionDTO>;
  confirm(versionId: string): Promise<InventoryBoundaryVersionDTO>;
  sitesOf(subsidiaryId: string): Promise<{ id: string; name: string }[]>;
  /**
   * The wizard's write: into the year's open version, or — when the year has
   * none open — a version opened by this first saved declaration (D10).
   */
  declareInYear(reportingYear: number, subsidiaryId: string, request: PutInventoryBoundarySubsidiaryRequest): Promise<InventoryBoundaryVersionDTO>;
}

export const boundaryCalls: BoundaryCalls = {
  listYear: async (reportingYear) => newestFirst(await api.listInventoryBoundaries(reportingYear)),
  open: (id) => api.getInventoryBoundary(id),
  openNew: (reportingYear, copyOf) => api.createInventoryBoundary(copyOf ? { reportingYear, copyOf } : { reportingYear }),
  writeDeclaration: (versionId, subsidiaryId, request) => api.putInventoryBoundarySubsidiary(versionId, subsidiaryId, request),
  confirm: (versionId) => api.confirmInventoryBoundary(versionId),
  sitesOf: async (subsidiaryId) =>
    (await api.listLocations(subsidiaryId)).filter((l) => l.subsidiaryId === subsidiaryId).map((l) => ({ id: l.id, name: l.name })),
  declareInYear: async (reportingYear, subsidiaryId, request) => {
    const newest = (await boundaryCalls.listYear(reportingYear))[0];
    const open = newest && versionState(newest) === "open" ? newest.id : (await boundaryCalls.openNew(reportingYear)).id;
    return boundaryCalls.writeDeclaration(open, subsidiaryId, request);
  },
};

/** The calls, for a component. */
export function useBoundaryCalls(): BoundaryCalls {
  return useMemo(() => boundaryCalls, []);
}
