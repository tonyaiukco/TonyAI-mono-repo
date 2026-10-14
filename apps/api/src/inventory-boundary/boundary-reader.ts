import type { InventoryBoundarySnapshot } from '@tonyai/shared-types';
import { CaptureSnapshot, CaptureSnapshotError } from '../calculations/factor-lookup';
import { buildBoundarySnapshot } from './boundary-snapshot';

/**
 * One inventory boundary version, read whole in a capture's snapshot (LP3-04
 * PR B, W1) — the reader LP3-04 PR C's dataset producer calls; no route serves
 * it. Every table is read in the caller's REPEATABLE READ or SERIALIZABLE
 * transaction (`CaptureSnapshot`), so the version, its rows and the names they
 * are read with are one moment's — as the records and the factor library the
 * capture reads beside them.
 *
 * Bound to the organisation it is asked under (follow-up (13)). Answers null —
 * not found, never "not yours" — unless every subsidiary it declares is in the
 * caller's CURRENT access (README: a dataset's referenced subsidiaries, no
 * bypass for the capturer, never redacted): a partially granted `data_entry`
 * user reads no version (W3), and a version declaring no subsidiary references
 * none, so it is no one's to read.
 */
export async function readInventoryBoundary(
  snapshot: CaptureSnapshot,
  query: { boundaryId: string; organisationId: string; accessibleSubsidiaryIds: readonly string[] },
): Promise<InventoryBoundarySnapshot | null> {
  if (!CaptureSnapshot.isOpened(snapshot)) {
    throw new CaptureSnapshotError('An inventory boundary is read in a snapshot opened by CaptureSnapshot.open only.');
  }
  const db = CaptureSnapshot.txOf(snapshot);
  const header = await db.inventoryBoundary.findFirst({
    where: { id: query.boundaryId, organisationId: query.organisationId },
  });
  if (header === null) return null;
  const where = { boundaryId: header.id };
  // Sequential, on the snapshot's one connection.
  const subsidiaries = await db.inventoryBoundarySubsidiary.findMany({
    where,
    include: { subsidiary: { select: { legalName: true, tradingName: true, geographyCode: true } } },
  });
  const accessible = new Set(query.accessibleSubsidiaryIds);
  if (subsidiaries.length === 0 || subsidiaries.some((s) => !accessible.has(s.subsidiaryId))) return null;
  const sites = await db.inventoryBoundarySite.findMany({
    where,
    include: { location: { select: { name: true, geographyCode: true } } },
  });
  const policies = await db.inventoryAttributionPolicy.findMany({ where });
  const cells = await db.inventoryApplicabilityCell.findMany({ where });
  const sources = await db.inventorySource.findMany({ where });

  return buildBoundarySnapshot({
    header,
    subsidiaries: subsidiaries.map((s) => ({
      subsidiaryId: s.subsidiaryId,
      firstMonth: s.firstMonth,
      lastMonth: s.lastMonth,
      frozenName: s.subsidiaryName,
      frozenGeographyCode: s.geographyCode,
      // The name reports use: trading, else legal — as the freeze copies it.
      liveName: s.subsidiary.tradingName || s.subsidiary.legalName,
      liveGeographyCode: s.subsidiary.geographyCode,
    })),
    sites: sites.map((s) => ({
      subsidiaryId: s.subsidiaryId,
      locationId: s.locationId,
      firstMonth: s.firstMonth,
      lastMonth: s.lastMonth,
      frozenName: s.locationName,
      frozenGeographyCode: s.geographyCode,
      liveName: s.location.name,
      liveGeographyCode: s.location.geographyCode,
    })),
    policies,
    cells,
    sources,
  });
}
