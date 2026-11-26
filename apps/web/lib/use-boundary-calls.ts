import { useMemo } from "react";
import { api } from "@/lib/api";
import { newestFirst } from "@/lib/inventory-boundary-view";
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
   * The wizard's write (D10), into the version the editor was opened on — never
   * one chosen again at save time (owner review of WP8, P1): a version
   * confirmed meanwhile answers `boundary_frozen`. When the year had no
   * version, this first saved declaration opens one; a version opened by
   * someone else meanwhile answers the API's own refusal.
   */
  declare(
    versionId: string | null,
    reportingYear: number,
    subsidiaryId: string,
    request: PutInventoryBoundarySubsidiaryRequest,
    /** The version this call opened, told before the write: a write that then fails is retried into it (owner's second review, P2). */
    onOpened?: (opened: InventoryBoundaryVersionDTO) => void,
  ): Promise<InventoryBoundaryVersionDTO>;
}

export const boundaryCalls: BoundaryCalls = {
  listYear: async (reportingYear) => newestFirst(await api.listInventoryBoundaries(reportingYear)),
  open: (id) => api.getInventoryBoundary(id),
  openNew: (reportingYear, copyOf) => api.createInventoryBoundary(copyOf ? { reportingYear, copyOf } : { reportingYear }),
  writeDeclaration: (versionId, subsidiaryId, request) => api.putInventoryBoundarySubsidiary(versionId, subsidiaryId, request),
  confirm: (versionId) => api.confirmInventoryBoundary(versionId),
  sitesOf: async (subsidiaryId) =>
    (await api.listLocations(subsidiaryId)).filter((l) => l.subsidiaryId === subsidiaryId).map((l) => ({ id: l.id, name: l.name })),
  declare: async (versionId, reportingYear, subsidiaryId, request, onOpened) => {
    if (versionId !== null) return boundaryCalls.writeDeclaration(versionId, subsidiaryId, request);
    const opened = await boundaryCalls.openNew(reportingYear);
    onOpened?.(opened);
    return boundaryCalls.writeDeclaration(opened.id, subsidiaryId, request);
  },
};

/** The calls, for a component. */
export function useBoundaryCalls(): BoundaryCalls {
  return useMemo(() => boundaryCalls, []);
}
