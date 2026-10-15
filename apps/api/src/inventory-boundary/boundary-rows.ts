import type { Prisma } from '@tonyai/db';
import type { BoundaryHeaderRow, BoundaryRows } from './boundary-snapshot';

/** What a boundary's rows are read through: a transaction's client, or a
 * capture's snapshot (`CaptureSnapshot.txOf`). */
export type BoundaryRowsReader = Pick<
  Prisma.TransactionClient,
  | 'inventoryBoundary'
  | 'inventoryBoundarySubsidiary'
  | 'inventoryBoundarySite'
  | 'inventoryAttributionPolicy'
  | 'inventoryApplicabilityCell'
  | 'inventorySource'
>;

/**
 * A version's rows as `buildBoundarySnapshot` takes them — the one reading
 * both readers share: the capture's (`readInventoryBoundary`, whole or
 * nothing) and the routes' (`boundary-version.ts`, a data_entry user's part
 * included). Names and geography are read live beside the frozen copies, the
 * builder choosing by the version's freeze (W7). Sequential, so a caller's
 * one connection serves it.
 */
export async function readBoundaryRows(db: BoundaryRowsReader, header: BoundaryHeaderRow): Promise<BoundaryRows> {
  const where = { boundaryId: header.id };
  const subsidiaries = await db.inventoryBoundarySubsidiary.findMany({
    where,
    include: { subsidiary: { select: { legalName: true, tradingName: true, geographyCode: true } } },
  });
  const sites = await db.inventoryBoundarySite.findMany({
    where,
    include: { location: { select: { name: true, geographyCode: true } } },
  });
  const policies = await db.inventoryAttributionPolicy.findMany({ where });
  const cells = await db.inventoryApplicabilityCell.findMany({ where });
  const sources = await db.inventorySource.findMany({ where });

  return {
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
  };
}
