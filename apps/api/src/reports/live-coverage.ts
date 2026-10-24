import { CATEGORY_SCOPE_MAP, type ReportCoverageGapCode, type ReportLiveCoverage } from '@tonyai/shared-types';
import { QueryTooBroadError } from '../common/api-error';
import { CaptureSnapshot } from '../common/capture-snapshot';
import { readInventoryBoundary } from '../inventory-boundary/boundary-reader';
import { assessDataset, type DatasetSelection } from '../report-datasets/dataset-assessments';
import { readCaptureFacts, type CaptureLimits } from '../report-datasets/dataset-reader';

/**
 * What the year's inventory boundary says about a live report's selection
 * (LP4-03 K3; README "Live reports and issued reports"): the NEWEST version of
 * the year — open, frozen or confirmed — read whole and assessed by the
 * capture's rule (`assessDataset`) over the records, evidence and releases as
 * they stand in the caller's snapshot. Nothing is retained.
 *
 * The records assessed are the REPORT's: its subsidiaries (`reportSubsidiaryIds`
 * — the caller's accessible ones, or an extract's one), not the version's
 * declared set as a capture's (V3). A live total counts every committed Scope
 * 1/2 record of the selection, so a subsidiary the boundary leaves out must
 * show here — its records are `unmapped_record` gaps — or "no coverage gap"
 * would print beside a total that holds it (`architect` P1-1).
 *
 * The boundary's read rule holds (`readInventoryBoundary`): a version that
 * declares a subsidiary outside the caller's current access is `not_readable`
 * and nothing of it is disclosed. A Scope 3 selection reads no boundary; one
 * past the report budgets is `too_broad` — its figures stand.
 */
export async function readLiveCoverage(
  snapshot: CaptureSnapshot,
  query: {
    organisationId: string;
    accessibleSubsidiaryIds: readonly string[];
    /** The live report's own subsidiaries, each in `accessibleSubsidiaryIds`. */
    reportSubsidiaryIds: readonly string[];
    reportingYear: number;
    selection: DatasetSelection;
  },
  limits: CaptureLimits,
): Promise<ReportLiveCoverage> {
  const db = CaptureSnapshot.txOf(snapshot);
  const { selection } = query;
  // Records are read for the report's subsidiaries alone, by id: each must be
  // the caller's to read, or nothing is read.
  const access = new Set(query.accessibleSubsidiaryIds);
  if (query.reportSubsidiaryIds.length === 0 || query.reportSubsidiaryIds.some((id) => !access.has(id))
    || (selection.subsidiaryId !== undefined && !access.has(selection.subsidiaryId))) {
    return { state: 'not_readable' };
  }
  // A Scope 3 category with no scope (`?category=Water`) is a Scope 3 selection too (`architect` re-review P2-1).
  const scopes = ([1, 2] as const).filter((s) => (selection.scope === undefined || selection.scope === s)
    && (selection.category === undefined || CATEGORY_SCOPE_MAP[selection.category] === s));
  if (scopes.length === 0) return { state: 'not_covered' };
  const newest = await db.inventoryBoundary.findFirst({
    where: { organisationId: query.organisationId, reportingYear: query.reportingYear },
    orderBy: { version: 'desc' },
    select: { id: true, frozenAt: true },
  });
  if (newest === null) return { state: 'no_boundary' };
  const boundary = await readInventoryBoundary(snapshot, {
    boundaryId: newest.id,
    organisationId: query.organisationId,
    accessibleSubsidiaryIds: query.accessibleSubsidiaryIds,
  });
  if (boundary === null) return { state: 'not_readable' };

  let facts: Awaited<ReturnType<typeof readCaptureFacts>>;
  try {
    facts = await readCaptureFacts(
      snapshot,
      {
        organisationId: query.organisationId,
        reportingYear: query.reportingYear,
        resolvedSubsidiaryIds: query.reportSubsidiaryIds,
        scopes,
        ...(selection.category === undefined ? {} : { category: selection.category }),
      },
      limits,
    );
  } catch (e) {
    // Every status counts here, drafts included: a selection whose figures fit
    // the ledger's budget can still pass this one — coverage unknown, never a 422.
    if (e instanceof QueryTooBroadError) return { state: 'too_broad' };
    throw e;
  }
  const { coverage } = assessDataset({
    boundary,
    selection,
    records: facts.records,
    evidence: facts.evidence,
    releases: facts.releases,
  });
  const gapCounts: Partial<Record<ReportCoverageGapCode, number>> = {};
  for (const g of coverage.gaps) gapCounts[g.code] = (gapCounts[g.code] ?? 0) + 1;
  const extract = selection.subsidiaryId !== undefined || selection.scope !== undefined || selection.category !== undefined;
  return {
    state: 'assessed',
    boundary: { id: boundary.id, version: boundary.version, decision: boundary.decision, frozen: newest.frozenAt !== null },
    selection: extract ? 'extract' : 'inventory',
    obligationCount: coverage.obligations.length,
    satisfiedObligationCount: coverage.obligations.filter((o) => o.state === 'satisfied').length,
    excludedSourceCount: coverage.excludedSourceIds.length,
    gapCounts,
    reading: selection.subsidiaryId !== undefined && !boundary.subsidiaryIds.includes(selection.subsidiaryId)
      ? 'outside_boundary'
      : coverage.gaps.length > 0 ? 'gaps' : coverage.obligations.length > 0 ? 'complete' : 'nothing_included',
  };
}
