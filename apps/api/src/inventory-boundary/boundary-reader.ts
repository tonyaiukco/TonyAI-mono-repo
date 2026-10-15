import type { InventoryBoundarySnapshot } from '@tonyai/shared-types';
import { CaptureSnapshot, CaptureSnapshotError } from '../calculations/factor-lookup';
import { readBoundaryRows } from './boundary-rows';
import { buildBoundarySnapshot } from './boundary-snapshot';

/**
 * One inventory boundary version, read whole in a capture's snapshot (LP3-04
 * PR B, W1) — the reader LP3-04 PR C's dataset producer calls; the routes read
 * through their own (`boundary-version.ts`). Every table is read in the
 * caller's REPEATABLE READ or SERIALIZABLE transaction (`CaptureSnapshot`), so
 * the version, its rows and the names they are read with are one moment's —
 * as the records and the factor library the capture reads beside them.
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
  // On the snapshot's one connection.
  const rows = await readBoundaryRows(db, header);
  const accessible = new Set(query.accessibleSubsidiaryIds);
  if (rows.subsidiaries.length === 0 || rows.subsidiaries.some((s) => !accessible.has(s.subsidiaryId))) return null;
  return buildBoundarySnapshot(rows);
}
