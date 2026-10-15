import type { InventoryBoundary } from '@tonyai/db';
import type {
  InventoryBoundaryGap,
  InventoryBoundarySnapshot,
  InventoryBoundaryVersionDTO,
  InventoryBoundaryVersionSummary,
  UserRole,
} from '@tonyai/shared-types';
import { ResourceNotFoundError } from '../common/api-error';
import { boundaryGaps } from './boundary-gaps';
import { readBoundaryRows, type BoundaryRowsReader } from './boundary-rows';
import { buildBoundarySnapshot, type BoundaryRows } from './boundary-snapshot';

/**
 * The routes' own reader (LP3-04's write path; contract follow-up (7)): a
 * version as `InventoryBoundaryVersionDTO`, on `buildBoundarySnapshot` — an
 * empty version and a data_entry user's part included, which the capture's
 * reader (`readInventoryBoundary`, whole or nothing) answers null for.
 */

/** A version's header and rows, read in one transaction. */
export interface LoadedVersion {
  header: InventoryBoundary;
  rows: BoundaryRows;
}

/** The organisation's version, or null — another organisation's reads as none. */
export async function loadBoundaryVersion(
  db: BoundaryRowsReader,
  id: string,
  organisationId: string,
): Promise<LoadedVersion | null> {
  const header = await db.inventoryBoundary.findFirst({ where: { id, organisationId } });
  if (header === null) return null;
  return { header, rows: await readBoundaryRows(db, header) };
}

export function versionSummary(header: InventoryBoundary): InventoryBoundaryVersionSummary {
  return {
    id: header.id,
    reportingYear: header.reportingYear,
    version: header.version,
    decision: header.decision as InventoryBoundaryVersionSummary['decision'],
    decidedBy: header.decidedBy,
    decidedAt: header.decidedAt?.toISOString() ?? null,
    frozenAt: header.frozenAt?.toISOString() ?? null,
    createdBy: header.createdBy,
    createdAt: header.createdAt.toISOString(),
  };
}

/** Who reads: the role decides the view, data_entry's grants its part. */
export interface BoundaryViewer {
  role: UserRole;
  accessibleSubsidiaryIds: readonly string[];
}

/**
 * The version as `viewer` reads it. Every reader but data_entry reads the
 * whole declared inventory (`organisation`). A data_entry user reads its
 * granted subsidiaries' part (`granted_subsidiaries`, W3) — as the boundary's
 * RLS shows it — and a version declaring none of them, an empty one included,
 * is `boundary_not_found`, the same body a missing version answers.
 */
export function versionDTO(loaded: LoadedVersion, viewer: BoundaryViewer): InventoryBoundaryVersionDTO {
  const boundary = buildBoundarySnapshot(loaded.rows);
  const gaps = boundaryGaps(boundary);
  const summary = versionSummary(loaded.header);
  if (viewer.role !== 'data_entry') return { ...summary, boundary, boundaryGaps: gaps, view: 'organisation' };
  const granted = new Set(viewer.accessibleSubsidiaryIds);
  if (!boundary.subsidiaryIds.some((id) => granted.has(id))) throw new ResourceNotFoundError('boundary_not_found');
  return { ...summary, ...grantedView(boundary, gaps, granted), view: 'granted_subsidiaries' };
}

/** A version's granted part: every collection and gap of the granted
 * subsidiaries, nothing of the others. The gaps are the whole version's,
 * filtered — the same a version of those subsidiaries alone has, since every
 * rule stays inside one subsidiary — and an included cell names only sources
 * at its own entity, so nothing left points outside the view. */
function grantedView(
  boundary: InventoryBoundarySnapshot,
  gaps: readonly InventoryBoundaryGap[],
  granted: ReadonlySet<string>,
): Pick<InventoryBoundaryVersionDTO, 'boundary' | 'boundaryGaps'> {
  const mine = (subsidiaryId: string) => granted.has(subsidiaryId);
  return {
    boundary: {
      ...boundary,
      subsidiaryIds: boundary.subsidiaryIds.filter(mine),
      entities: boundary.entities.filter((e) => mine(e.subsidiaryId)),
      applicability: boundary.applicability.filter((c) => mine(c.subsidiaryId)),
      attribution: boundary.attribution.filter((p) => mine(p.subsidiaryId)),
      sources: boundary.sources.filter((s) => mine(s.entity.subsidiaryId)),
    },
    boundaryGaps: gaps.filter((g) => mine(g.entity.subsidiaryId)),
  };
}
