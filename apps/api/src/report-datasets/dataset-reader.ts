import type { Prisma } from '@tonyai/db';
import type {
  ActivityCalculationSnapshot,
  ActivityRecordStatus,
  Category,
  PeriodLockDTO,
  ReportDataset,
  ReportDatasetRecord,
  ReportEvidenceReference,
  ReportingPeriod,
  ReportReleaseStanding,
} from '@tonyai/shared-types';
import { isProvenanceSnapshot } from '@tonyai/shared-types';
import { RELEASE_SNAPSHOT_SELECT, releaseSnapshot } from '../calculations/release-snapshot';
import { QueryTooBroadError } from '../common/api-error';
import { CaptureSnapshot } from '../common/capture-snapshot';

/**
 * What a capture reads (LP3-04 PR C), every statement in its one REPEATABLE
 * READ snapshot (`CaptureSnapshot`) — so the records, their evidence, the
 * locks and the releases' standing are one moment's, as the boundary read
 * beside them. Mapped here, by explicit field, into the contract's shapes:
 * nothing reaches the dataset that a mapper did not name (contract follow-up
 * (7)), every timestamp spelled by `toISOString()` and every release as the
 * engine's own snapshot spells it.
 */

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const iso = (at: Date): string => at.toISOString();
const isoOrNull = (at: Date | null): string | null => (at === null ? null : at.toISOString());

/** The reports' choice of a name: trading, else legal (as the freeze copies a subsidiary's). */
export const reportedNameOf = (s: { legalName: string; tradingName: string | null }): string =>
  s.tradingName !== null && s.tradingName !== '' ? s.tradingName : s.legalName;

export const RECORD_SELECT = {
  id: true,
  subsidiaryId: true,
  locationId: true,
  reportingYear: true,
  reportingPeriod: true,
  periodValue: true,
  category: true,
  activityType: true,
  scope: true,
  status: true,
  activityValue: true,
  activityUnit: true,
  calculation: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  reviewedBy: true,
  reviewedAt: true,
  submittedAt: true,
  voidedBy: true,
  voidedAt: true,
  voidReason: true,
  subsidiary: { select: { legalName: true, tradingName: true } },
  location: { select: { name: true } },
} as const satisfies Prisma.ActivityRecordSelect;
export type RecordRow = Prisma.ActivityRecordGetPayload<{ select: typeof RECORD_SELECT }>;

/** A record as a dataset retains it: opaque actors, its calculation unchanged. */
export function datasetRecord(row: RecordRow): ReportDatasetRecord {
  if (row.scope !== 1 && row.scope !== 2) {
    throw new Error(`Record ${row.id} is Scope ${row.scope}: a dataset holds Scope 1/2 records only.`);
  }
  return {
    id: row.id,
    subsidiaryId: row.subsidiaryId,
    locationId: row.locationId,
    reportingYear: row.reportingYear,
    reportingPeriod: row.reportingPeriod as ReportingPeriod,
    periodValue: row.periodValue,
    category: row.category as Category,
    activityType: row.activityType,
    scope: row.scope,
    status: row.status as ActivityRecordStatus,
    activityValue: row.activityValue,
    activityUnit: row.activityUnit,
    calculation: row.calculation as unknown as ActivityCalculationSnapshot,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    reviewedBy: row.reviewedBy,
    reviewedAt: isoOrNull(row.reviewedAt),
    submittedAt: isoOrNull(row.submittedAt),
    voidedBy: row.voidedBy,
    voidedAt: isoOrNull(row.voidedAt),
    voidReason: row.voidReason,
    subsidiaryName: reportedNameOf(row.subsidiary),
    locationName: row.location?.name ?? null,
  };
}

const EVIDENCE_SELECT = {
  id: true, subsidiaryId: true, fileName: true, mimeType: true, sizeBytes: true, sha256: true, createdAt: true,
} as const satisfies Prisma.EvidenceSelect;
type EvidenceRow = Prisma.EvidenceGetPayload<{ select: typeof EVIDENCE_SELECT }>;

/** A file the captured records link: its content identity, null when unknown (before LP1-02). */
export function evidenceReference(row: EvidenceRow, recordIds: readonly string[]): ReportEvidenceReference {
  return {
    id: row.id,
    subsidiaryId: row.subsidiaryId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: iso(row.createdAt),
    contentFingerprint: row.sha256 === null ? null : { algorithm: 'sha256', hex: row.sha256 },
    recordIds: [...new Set(recordIds)].sort(byCodeUnits),
  };
}

const LOCK_SELECT = {
  id: true, subsidiaryId: true, reportingYear: true, reportingPeriod: true, periodValue: true, lockedBy: true, createdAt: true,
} as const satisfies Prisma.PeriodLockSelect;
type LockRow = Prisma.PeriodLockGetPayload<{ select: typeof LOCK_SELECT }>;

export function periodLock(row: LockRow): PeriodLockDTO {
  return {
    id: row.id,
    subsidiaryId: row.subsidiaryId,
    reportingYear: row.reportingYear,
    reportingPeriod: row.reportingPeriod as ReportingPeriod,
    periodValue: row.periodValue,
    lockedBy: row.lockedBy,
    createdAt: iso(row.createdAt),
  };
}

const RELEASE_STANDING_SELECT = {
  ...RELEASE_SNAPSHOT_SELECT, withdrawnAt: true, withdrawnBy: true, withdrawalReason: true,
} as const satisfies Prisma.FactorReleaseSelect;
type ReleaseRow = Prisma.FactorReleaseGetPayload<{ select: typeof RELEASE_STANDING_SELECT }>;

/** A release's standing now, its publication spelled as the engine's snapshot spells it. */
export function releaseStanding(row: ReleaseRow): ReportReleaseStanding {
  const { id, status, ...publication } = releaseSnapshot(row);
  return {
    id,
    status,
    withdrawnAt: isoOrNull(row.withdrawnAt),
    withdrawnBy: row.withdrawnBy,
    withdrawalReason: row.withdrawalReason,
    publication,
  };
}

/** Every release a live record's calculation names — its factor's and its conversion's. */
export function namedReleaseIds(records: readonly ReportDatasetRecord[]): string[] {
  const ids = new Set<string>();
  for (const r of records) {
    if (r.status === 'voided' || !isProvenanceSnapshot(r.calculation)) continue;
    ids.add(r.calculation.factorRelease.id);
    if (r.calculation.conversion !== null) ids.add(r.calculation.conversion.release.id);
  }
  return [...ids].sort(byCodeUnits);
}

export interface CaptureQuery {
  organisationId: string;
  reportingYear: number;
  resolvedSubsidiaryIds: readonly string[];
  /** The scopes whose records are captured — none for a Scope 3 selection. */
  scopes: ReadonlyArray<1 | 2>;
  category?: Category;
}

export interface CaptureLimits {
  records: number;
  evidenceLinks: number;
}

export interface CapturedFactsRead {
  capturedAt: string;
  organisationName: string;
  /** The caller's access as this snapshot sees it: the guard's, still in the organisation. */
  currentAccess: string[];
  records: ReportDatasetRecord[];
  evidence: ReportEvidenceReference[];
  periodLocks: PeriodLockDTO[];
  releases: Map<string, ReportReleaseStanding>;
}

/** The capture's clock and the caller's access, read first. */
export async function readCaptureContext(
  snapshot: CaptureSnapshot,
  organisationId: string,
  accessibleSubsidiaryIds: readonly string[],
): Promise<{ capturedAt: string; organisationName: string; currentAccess: string[] } | null> {
  const db = CaptureSnapshot.txOf(snapshot);
  // The transaction's start, to the millisecond — the guard compares this
  // spelling with the stored column.
  const [clock] = await db.$queryRaw<Array<{ at: string }>>`
    SELECT pg_catalog.to_char(pg_catalog.transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
  const organisation = await db.organisation.findUnique({
    where: { id: organisationId },
    select: { legalName: true, tradingName: true },
  });
  if (clock === undefined || organisation === null) return null;
  const access = await db.subsidiary.findMany({
    where: { organisationId, id: { in: [...accessibleSubsidiaryIds] } },
    select: { id: true },
  });
  return {
    capturedAt: clock.at,
    organisationName: reportedNameOf(organisation),
    currentAccess: access.map((s) => s.id).sort(byCodeUnits),
  };
}

/** The selection's records, their evidence, the year's locks and the named releases. */
export async function readCaptureFacts(
  snapshot: CaptureSnapshot,
  query: CaptureQuery,
  limits: CaptureLimits,
): Promise<Pick<CapturedFactsRead, 'records' | 'evidence' | 'periodLocks' | 'releases'>> {
  const db = CaptureSnapshot.txOf(snapshot);
  const subsidiaryIds = [...query.resolvedSubsidiaryIds];
  const rows = query.scopes.length === 0 ? [] : await db.activityRecord.findMany({
    where: {
      subsidiaryId: { in: subsidiaryIds },
      reportingYear: query.reportingYear,
      scope: { in: [...query.scopes] },
      ...(query.category === undefined ? {} : { category: query.category }),
    },
    select: RECORD_SELECT,
    orderBy: { id: 'asc' },
    take: limits.records + 1,
  });
  if (rows.length > limits.records) throw new QueryTooBroadError();
  const records = rows.map(datasetRecord);

  const recordIds = records.map((r) => r.id);
  const links = recordIds.length === 0 ? [] : await db.activityRecordEvidence.findMany({
    where: { activityRecordId: { in: recordIds } },
    select: { activityRecordId: true, evidenceId: true },
    orderBy: [{ evidenceId: 'asc' }, { activityRecordId: 'asc' }],
    take: limits.evidenceLinks + 1,
  });
  if (links.length > limits.evidenceLinks) throw new QueryTooBroadError();
  const linked = new Map<string, string[]>();
  for (const l of links) linked.set(l.evidenceId, [...(linked.get(l.evidenceId) ?? []), l.activityRecordId]);
  const files = linked.size === 0 ? [] : await db.evidence.findMany({
    where: { id: { in: [...linked.keys()] } },
    select: EVIDENCE_SELECT,
    orderBy: { id: 'asc' },
  });
  const evidence = files.map((f) => evidenceReference(f, linked.get(f.id) ?? []));

  const locks = await db.periodLock.findMany({
    where: { subsidiaryId: { in: subsidiaryIds }, reportingYear: query.reportingYear },
    select: LOCK_SELECT,
    orderBy: { id: 'asc' },
  });

  const releaseIds = namedReleaseIds(records);
  const releaseRows = releaseIds.length === 0 ? [] : await db.factorRelease.findMany({
    where: { id: { in: releaseIds } },
    select: RELEASE_STANDING_SELECT,
  });
  const releases = new Map(releaseRows.map((r) => [r.id, releaseStanding(r)]));

  return { records, evidence, periodLocks: locks.map(periodLock), releases };
}

/**
 * Every subsidiary a dataset references (README: the read rule's set) — each
 * `subsidiaryId` it holds at any depth, the boundary's declared subsidiaries
 * and the resolved ones — sorted. The same rule as the table's guard, which
 * recomputes it from the stored content (`lax $.**.subsidiaryId`), so a
 * collection added later is covered without naming it here.
 */
export function referencedSubsidiaryIds(dataset: Omit<ReportDataset, 'fingerprint'> | ReportDataset): string[] {
  const ids = new Set<string>([...dataset.boundary.subsidiaryIds, ...dataset.resolvedSubsidiaryIds]);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, member] of Object.entries(value)) {
      if (key === 'subsidiaryId' && typeof member === 'string') ids.add(member);
      walk(member);
    }
  };
  walk(dataset);
  return [...ids].sort(byCodeUnits);
}
