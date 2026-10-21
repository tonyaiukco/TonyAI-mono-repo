import type {
  ActivityCalculationSnapshot, FactorReleaseSnapshot, InventoryBoundarySnapshot, PeriodLockDTO, ReportDataset,
  ReportDatasetRecord, ReportEvidenceReference, ReportReleaseStanding,
} from '@tonyai/shared-types';
import { assessDataset, type DatasetSelection } from '../src/report-datasets/dataset-assessments';
import { reportDatasetFingerprint } from '../src/report-datasets/dataset-fingerprint';
import { referencedSubsidiaryIds } from '../src/report-datasets/dataset-reader';
import type { RetainedDatasetRow } from '../src/report-issuances/issuance-gate';
import { buildBoundarySnapshot, type BoundaryRows } from '../src/inventory-boundary/boundary-snapshot';
import { complete, SITE_1, SITE_2, SUB } from './boundary-fixtures';

/**
 * Retained datasets for the issuance's DB-free specs (LP3-04 PR D): built as
 * a capture builds one — the boundary of `complete()` (Sub A's electricity
 * metered monthly at two sites, its gas quarterly at the company, the rest
 * excluded; Sub B all excluded), records, locks and releases, assessed by
 * `assessDataset` and fingerprinted — so each case changes one fact and the
 * gate meets a dataset the capture could have written.
 */

export const AT = '2026-10-15T00:00:00.000Z';
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const release = (
  id: string, status: FactorReleaseSnapshot['status'] = 'authoritative', gwpSet: FactorReleaseSnapshot['gwpSet'] = 'AR6',
): FactorReleaseSnapshot => ({
  id, publisher: 'DESNZ', title: 'Conversion factors', edition: '2026', ordinal: 1, status,
  sourceUrl: null, licence: null, publishedAt: '2026-06-01', gwpSet,
});

/** A provenance snapshot (schema 2) of `tCo2e`, priced by `factor`. */
export function priced(tCo2e: number, over: { factor?: FactorReleaseSnapshot; gasCoverage?: string } = {}): ActivityCalculationSnapshot {
  return {
    snapshotSchema: 2, category: 'Electricity', geographyCode: 'GB', reportingYear: 2026, scope: 2,
    inputValue: 1, inputUnit: 'kWh', normalizedValue: 1, normalizedUnit: 'kWh', conversionApplied: false,
    factorId: 'f-1', factorValue: 0.2, factorUnit: 'kgCO2e/kWh', methodology: 'location-based', source: 'DESNZ', version: '2026',
    tCo2e, activityType: 'grid_electricity', gas: 'CO2e', gasCoverage: over.gasCoverage ?? 'all_ghg', calorificBasis: 'not_applicable',
    scope2Method: 'location_based', dataYear: 2026, yearPolicy: 'exact',
    factorRelease: over.factor ?? release('rel-a'),
    conversion: null,
  } as unknown as ActivityCalculationSnapshot;
}

export const UNCALCULATED = {
  snapshotSchema: 1, reasonCode: 'no_emission_factor', reason: 'No factor', category: 'Electricity', geographyCode: 'GB',
} as unknown as ActivityCalculationSnapshot;

export function record(id: string, over: Partial<ReportDatasetRecord> = {}): ReportDatasetRecord {
  return {
    id, subsidiaryId: SUB, locationId: SITE_1, reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'January',
    category: 'Electricity', activityType: null, scope: 2, status: 'approved', activityValue: 100, activityUnit: 'kWh',
    calculation: priced(1), createdBy: 'actor-created', createdAt: AT, updatedAt: AT, reviewedBy: 'actor-reviewed', reviewedAt: AT,
    submittedAt: AT, voidedBy: null, voidedAt: null, voidReason: null, subsidiaryName: 'Company sub-a', locationName: 'Site site-1',
    ...over,
  };
}

export const site1Year = (status: ReportDatasetRecord['status'] = 'approved') =>
  MONTHS.map((m, i) => record(`r-${String(i + 1).padStart(2, '0')}`, { periodValue: m, status }));
export const site2Year = () =>
  MONTHS.map((m, i) => record(`s-${String(i + 1).padStart(2, '0')}`, { locationId: SITE_2, locationName: 'Site site-2', periodValue: m }));
export const gasYear = () => ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => record(`g-${q}`, {
  locationId: null, locationName: null, category: 'Natural Gas', scope: 1, reportingPeriod: 'quarterly', periodValue: q,
}));
/** Every obligation of `complete()` met by an approved, authoritative record. */
export const fullYear = () => [...site1Year(), ...site2Year(), ...gasYear()];

export const lock = (periodValue: string, reportingPeriod: PeriodLockDTO['reportingPeriod'], over: Partial<PeriodLockDTO> = {}): PeriodLockDTO => ({
  id: `lock-${reportingPeriod}-${periodValue}`, subsidiaryId: SUB, reportingYear: 2026, reportingPeriod, periodValue,
  lockedBy: 'actor-locked', createdAt: AT, ...over,
});
/** Sub A's monthly and quarterly locks — every obligation of `complete()` locked. */
export const allLocks = () => [
  ...MONTHS.map((m) => lock(m, 'monthly')),
  ...['Q1', 'Q2', 'Q3', 'Q4'].map((q) => lock(q, 'quarterly')),
];

export const standing = (r: FactorReleaseSnapshot, status = r.status): ReportReleaseStanding => {
  const { id, status: _s, ...publication } = r;
  return { id, status, withdrawnAt: status === 'withdrawn' ? AT : null, withdrawnBy: status === 'withdrawn' ? 'actor-withdrew' : null, withdrawalReason: null, publication };
};

/** `complete()` as a frozen version builds it: frozen names, decided as given. */
export function frozenBoundary(rows: BoundaryRows = complete(), decision: 'unconfirmed' | 'confirmed' = 'confirmed'): InventoryBoundarySnapshot {
  const frozenAt = new Date(AT);
  const decided = decision === 'confirmed';
  return buildBoundarySnapshot({
    ...rows,
    header: { ...rows.header, decision, decidedBy: decided ? 'actor-decided' : null, decidedAt: decided ? frozenAt : null, frozenAt },
    subsidiaries: rows.subsidiaries.map((s) => ({ ...s, frozenName: s.liveName, frozenGeographyCode: s.liveGeographyCode })),
    sites: rows.sites.map((s) => ({ ...s, frozenName: s.liveName, frozenGeographyCode: s.liveGeographyCode })),
  });
}

/** `complete()` with every category of Sub A excluded too — no included source,
 * no obligation: the only final the factor library allows today. */
export function allExcludedBoundary(decision: 'unconfirmed' | 'confirmed' = 'confirmed'): InventoryBoundarySnapshot {
  const rows = complete();
  return frozenBoundary({
    ...rows,
    cells: rows.cells.map((c) => (c.applicability === 'included' ? { ...c, applicability: 'excluded', reason: 'No operations' } : c)),
    sources: rows.sources.filter((s) => s.applicability !== 'included'),
  }, decision);
}

export interface DatasetFacts {
  boundary?: InventoryBoundarySnapshot;
  selection?: DatasetSelection;
  records?: ReportDatasetRecord[];
  evidence?: ReportEvidenceReference[];
  locks?: PeriodLockDTO[];
  releases?: ReportReleaseStanding[];
  datasetId?: string;
}

/** A retained dataset as a capture writes it. */
export function datasetOf(facts: DatasetFacts = {}): ReportDataset {
  const boundary = facts.boundary ?? frozenBoundary();
  const selection = facts.selection ?? {};
  const records = facts.records ?? fullYear();
  const evidence = facts.evidence ?? [];
  const releases = facts.releases ?? [standing(release('rel-a'))];
  const assessments = assessDataset({ boundary, selection, records, evidence, releases: new Map(releases.map((r) => [r.id, r])) });
  const content: Omit<ReportDataset, 'fingerprint'> = {
    schemaVersion: 1,
    datasetId: facts.datasetId ?? '0d5e0000-0000-4000-8000-000000000001',
    capturedAt: AT,
    organisationId: boundary.organisationId,
    organisationName: 'Org A',
    context: { year: boundary.reportingYear, ...selection },
    selection: Object.keys(selection).length === 0 ? 'inventory' : 'extract',
    resolvedSubsidiaryIds: selection.subsidiaryId !== undefined ? [selection.subsidiaryId] : [...boundary.subsidiaryIds].sort(),
    boundary,
    records,
    evidence,
    periodLocks: facts.locks ?? allLocks(),
    ...assessments,
  };
  return { ...content, fingerprint: reportDatasetFingerprint(content) };
}

/** The row a capture retains for `dataset`: its columns and its exact text. */
export function rowOf(dataset: ReportDataset, content = JSON.stringify(dataset)): RetainedDatasetRow & { boundaryId: string } {
  return {
    id: dataset.datasetId,
    organisationId: dataset.organisationId,
    boundaryId: dataset.boundary.id,
    reportingYear: dataset.context.year,
    schemaVersion: dataset.schemaVersion,
    canonicalization: dataset.fingerprint.canonicalization,
    fingerprintHex: dataset.fingerprint.hex,
    referencedSubsidiaryIds: referencedSubsidiaryIds(dataset),
    content,
  };
}

/** `dataset` with `change` applied and its fingerprint recomputed — a row
 * written past the API that is consistent with itself. */
export function refingerprinted(dataset: ReportDataset, change: (d: ReportDataset) => void): ReportDataset {
  const copy = JSON.parse(JSON.stringify(dataset)) as ReportDataset;
  change(copy);
  const { fingerprint: _f, ...content } = copy;
  return { ...content, fingerprint: reportDatasetFingerprint(content) };
}
