import {
  isProvenanceSnapshot,
  REPORT_DATASET_SCHEMA_VERSION,
  REPORT_ISSUANCE_GAP_CODES,
  type InventoryBoundarySnapshot,
  type InventorySource,
  type ReportCoverageGap,
  type ReportDataset,
  type ReportIssuanceGap,
  type ReportIssuanceGapCode,
} from '@tonyai/shared-types';
import { assessDataset, type DatasetSelection } from '../report-datasets/dataset-assessments';
import { canonicalJson, reportDatasetFingerprint } from '../report-datasets/dataset-fingerprint';
import { referencedSubsidiaryIds } from '../report-datasets/dataset-reader';

/**
 * LP3-04 PR D — the final gate (README "The issuance"; Decisions 2026-10-21,
 * K2 and K4). Pure: everything is read from the retained dataset, which was
 * captured in one snapshot (V4) — nothing here reads the live database, the
 * factor library or a clock, and nothing is recalculated.
 *
 *  1. `readRetainedDataset` — the dataset's text, held to its row before it is
 *     trusted: the fingerprint recomputed from it, parsed and canonicalised;
 *     the referenced set recomputed; and the assessments recomputed from the
 *     retained facts and required equal to the retained ones (K2) — so a row
 *     written past the API, whose guard (TA016) binds only its header and
 *     declared subsidiaries (PR C follow-up (9)), cannot carry assessments its
 *     own facts do not support. A self-consistent forgery — statuses, locks
 *     or standings restated and everything recomputed — is beyond it: only
 *     the boundary is held to stored rows (`qa-auditor` P3-7); the database
 *     credential's custody holds that line.
 *  2. `boundaryMatchesVersion` — the retained boundary against the frozen
 *     version rebuilt from its stored rows, under the dataset's schemaVersion.
 *  3. `deriveIssuance` — status and gaps (D13): final only when nothing
 *     blocks it; otherwise partial, every gap named.
 *
 * A failure of 1 or 2 is a defect, never a refusal the caller can act on: the
 * service logs it and answers an internal error.
 */

/** The retained dataset disagrees with its row, its own assessments or its version. */
export class RetainedDatasetError extends Error {
  constructor(datasetId: string, problem: string) {
    super(`Retained report dataset ${datasetId}: ${problem}`);
    this.name = 'RetainedDatasetError';
  }
}

/** The retained row's columns the dataset's text is held to. */
export interface RetainedDatasetRow {
  id: string;
  organisationId: string;
  reportingYear: number;
  schemaVersion: number;
  canonicalization: string;
  fingerprintHex: string;
  referencedSubsidiaryIds: readonly string[];
  content: string;
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(byCodeUnits);
const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const left = sorted(a);
  const right = sorted(b);
  return left.length === a.length && right.length === b.length && left.length === right.length
    && left.every((id, i) => id === right[i]);
};

/** The selection a dataset's context names: its filters, without its year. */
export function selectionOfContext(context: ReportDataset['context']): DatasetSelection {
  const { year: _year, ...selection } = context;
  return selection;
}

/**
 * The retained dataset, parsed from its row's exact text and verified against
 * the row and itself; throws `RetainedDatasetError` otherwise.
 */
export function readRetainedDataset(row: RetainedDatasetRow): ReportDataset {
  const problem = (what: string): never => {
    throw new RetainedDatasetError(row.id, what);
  };
  let dataset: ReportDataset;
  try {
    dataset = JSON.parse(row.content) as ReportDataset;
  } catch {
    return problem('its content is not JSON');
  }
  if (dataset === null || typeof dataset !== 'object' || Array.isArray(dataset)) problem('its content is not an object');
  if (dataset.schemaVersion !== REPORT_DATASET_SCHEMA_VERSION || row.schemaVersion !== REPORT_DATASET_SCHEMA_VERSION) {
    problem(`schemaVersion ${String(dataset.schemaVersion)} is not one this gate reads`);
  }
  if (dataset.datasetId !== row.id || dataset.organisationId !== row.organisationId || dataset.context?.year !== row.reportingYear) {
    problem('its identity disagrees with its row');
  }
  let fingerprint: ReturnType<typeof reportDatasetFingerprint>;
  try {
    fingerprint = reportDatasetFingerprint(dataset);
  } catch (e) {
    return problem(`its content cannot be canonicalised (${(e as Error).message})`);
  }
  if (fingerprint.canonicalization !== row.canonicalization || fingerprint.hex !== row.fingerprintHex
    || dataset.fingerprint?.algorithm !== 'sha256'
    || dataset.fingerprint.canonicalization !== fingerprint.canonicalization
    || dataset.fingerprint.hex !== fingerprint.hex) {
    problem('its fingerprint does not recompute from its content');
  }
  if (!sameSet(referencedSubsidiaryIds(dataset), row.referencedSubsidiaryIds)) {
    problem('its referenced subsidiaries are not the ones its content names');
  }
  // K2: recomputed from the retained facts — the releases as the capture
  // found them standing — the assessments are the retained ones exactly.
  let same: boolean;
  try {
    const recomputed = assessDataset({
      boundary: dataset.boundary,
      selection: selectionOfContext(dataset.context),
      records: dataset.records,
      evidence: dataset.evidence,
      releases: new Map(dataset.provenance.releases.map((r) => [r.id, r])),
    });
    const retained = { review: dataset.review, coverage: dataset.coverage, provenance: dataset.provenance, scopes: dataset.scopes };
    same = canonicalJson(recomputed) === canonicalJson(retained);
  } catch (e) {
    return problem(`its assessments cannot be recomputed (${(e as Error).message})`);
  }
  if (!same) problem('its assessments do not recompute from its facts');
  return dataset;
}

/**
 * Whether the retained boundary is the frozen version as stored — every fact
 * of it: ids, names, months, cells, policies and source fields, its number,
 * decision and decider (PR C follow-up (9)). Compared under the dataset's
 * schemaVersion: version 1's boundary is what `buildBoundarySnapshot` builds
 * from a frozen version's rows (its frozen names, W7), compared whole. A later
 * schemaVersion that changes the builder adds its own comparison here, so a
 * historic dataset is never held to a newer shape.
 */
export function boundaryMatchesVersion(
  schemaVersion: number,
  retained: InventoryBoundarySnapshot,
  rebuilt: InventoryBoundarySnapshot | null,
): boolean {
  if (rebuilt === null) return false;
  switch (schemaVersion) {
    case 1:
      return canonicalJson(rebuilt) === canonicalJson(retained);
    default:
      return false;
  }
}

/** What the gate derives: final with no gap, or partial with at least one. */
export type IssuanceStatus =
  | { status: 'final'; gaps: readonly [] }
  | { status: 'partial'; gaps: readonly [ReportIssuanceGap, ...ReportIssuanceGap[]] };

const gap = (
  code: ReportIssuanceGapCode,
  ids: { sourceIds?: Iterable<string>; obligationIds?: Iterable<string>; recordIds?: Iterable<string> } = {},
): ReportIssuanceGap => ({
  code,
  sourceIds: sorted(ids.sourceIds ?? []),
  obligationIds: sorted(ids.obligationIds ?? []),
  recordIds: sorted(ids.recordIds ?? []),
});

/** A dataset coverage gap as an issuance gap: its own code, entity and category carried (keys absent, never undefined). */
const coverageGap = (g: ReportCoverageGap): ReportIssuanceGap => ({
  coverageCode: g.code,
  ...(g.entity === undefined ? {} : { entity: { subsidiaryId: g.entity.subsidiaryId, locationId: g.entity.locationId } }),
  ...(g.category === undefined ? {} : { category: g.category }),
  ...gap('coverage_gap', g),
});

type Included = InventorySource & { applicability: 'included' };

/**
 * The issuance's status and gaps from the retained dataset alone (D13; README
 * "The issuance"). Final requires, of the selection's included obligations:
 * the inventory, its boundary confirmed and without a coverage gap (missing
 * records or evidence, attribution, applicability, unmapped records — the
 * dataset's own coverage gaps); every satisfying record approved or locked;
 * every obligation's period locked, matched exactly on (subsidiaryId,
 * reportingYear, reportingPeriod, periodValue) — an annual obligation needs
 * the Annual lock, never twelve monthly ones; every counted record's
 * calculation authoritative; and one GWP set across the counted all-GHG
 * calculations — a null set beside a named one fails closed (K4, D09).
 * Anything else is partial, naming each gap; an extract is always partial.
 */
export function deriveIssuance(dataset: ReportDataset): IssuanceStatus {
  const gaps: ReportIssuanceGap[] = [];
  const year = dataset.boundary.reportingYear;

  if (dataset.selection === 'extract') gaps.push(gap('filtered_extract'));

  // One per coverage gap, carrying its own code, entity and category.
  for (const g of dataset.coverage.gaps) gaps.push(coverageGap(g));

  // The selection's included obligations, with the source that declares each.
  const sourceOf = new Map<string, Included>();
  for (const s of dataset.boundary.sources) {
    if (s.applicability !== 'included') continue;
    for (const o of s.obligations) sourceOf.set(o.id, s);
  }
  const obligationById = new Map(
    dataset.boundary.sources.flatMap((s) => (s.applicability === 'included' ? s.obligations : [])).map((o) => [o.id, o]),
  );

  const approved = new Set(dataset.review.approvedRecordIds);
  for (const o of dataset.coverage.obligations) {
    const unapproved = o.recordIds.filter((id) => !approved.has(id));
    if (unapproved.length === 0) continue;
    const source = sourceOf.get(o.obligationId);
    gaps.push(gap('unapproved_record', {
      sourceIds: source === undefined ? [] : [source.id],
      obligationIds: [o.obligationId],
      recordIds: unapproved,
    }));
  }

  // One gap per missing lock: the obligations (and their records) it holds back.
  const locked = new Set(dataset.periodLocks
    .filter((l) => l.reportingYear === year)
    .map((l) => JSON.stringify([l.subsidiaryId, l.reportingPeriod, l.periodValue])));
  const unlocked = new Map<string, { sourceIds: string[]; obligationIds: string[]; recordIds: string[] }>();
  for (const o of dataset.coverage.obligations) {
    const source = sourceOf.get(o.obligationId);
    const obligation = obligationById.get(o.obligationId);
    if (source === undefined || obligation === undefined) continue;
    const key = JSON.stringify([source.entity.subsidiaryId, obligation.reportingPeriod, obligation.periodValue]);
    if (locked.has(key)) continue;
    const held = unlocked.get(key) ?? { sourceIds: [], obligationIds: [], recordIds: [] };
    held.sourceIds.push(source.id);
    held.obligationIds.push(o.obligationId);
    held.recordIds.push(...o.recordIds);
    unlocked.set(key, held);
  }
  for (const held of unlocked.values()) gaps.push(gap('unlocked_period', held));

  // The counted records: their calculations are the report's figures.
  const counted = new Set(dataset.scopes.flatMap((s) => (s.scope === 3 ? [] : s.countedRecordIds)));
  const nonAuthoritative = dataset.provenance.records
    .filter((p) => counted.has(p.recordId) && p.standing !== 'authoritative')
    .map((p) => p.recordId);
  if (nonAuthoritative.length > 0) gaps.push(gap('non_authoritative_calculation', { recordIds: nonAuthoritative }));

  // D09: one GWP set across the counted all-GHG calculations. The capture's
  // provenance names the named sets that disagree; a null set beside a named
  // one fails closed here (K4 — the capture compares named sets only).
  const mismatched = new Set(dataset.provenance.records
    .filter((p) => counted.has(p.recordId) && p.issues.includes('gwp_set_mismatch'))
    .map((p) => p.recordId));
  const named: string[] = [];
  const unnamed: string[] = [];
  for (const r of dataset.records) {
    if (!counted.has(r.id) || !isProvenanceSnapshot(r.calculation) || r.calculation.gasCoverage !== 'all_ghg') continue;
    (r.calculation.factorRelease.gwpSet === null ? unnamed : named).push(r.id);
  }
  if (named.length > 0 && unnamed.length > 0) for (const id of [...named, ...unnamed]) mismatched.add(id);
  if (mismatched.size > 0) gaps.push(gap('gwp_set_mismatch', { recordIds: mismatched }));

  const ordered = sortIssuanceGaps(gaps);
  if (ordered.length === 0) return { status: 'final', gaps: [] };
  return { status: 'partial', gaps: ordered as [ReportIssuanceGap, ...ReportIssuanceGap[]] };
}

/** By the contract's code order, then by what each names — a stable list.
 * Nothing is folded: one issuance gap per coverage gap, per obligation not
 * approved, per missing lock (`qa-auditor` P3-1). */
function sortIssuanceGaps(gaps: ReportIssuanceGap[]): ReportIssuanceGap[] {
  const rank = (code: ReportIssuanceGapCode) => REPORT_ISSUANCE_GAP_CODES.indexOf(code);
  const keyOf = (g: ReportIssuanceGap) => JSON.stringify([
    g.coverageCode ?? '', g.entity?.subsidiaryId ?? '', g.entity?.locationId ?? '', g.category ?? '',
    g.sourceIds, g.obligationIds, g.recordIds,
  ]);
  return [...gaps].sort((a, b) => rank(a.code) - rank(b.code) || byCodeUnits(keyOf(a), keyOf(b)));
}
