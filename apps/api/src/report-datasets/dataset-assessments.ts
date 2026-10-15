import {
  CATEGORY_SCOPE_MAP,
  COUNTED_STATUSES,
  isCalculated,
  isProvenanceSnapshot,
  type FactorReleaseSnapshot,
  type InventoryBoundarySnapshot,
  type InventoryObligation,
  type InventorySource,
  type ReportCoverageAssessment,
  type ReportCoverageGap,
  type ReportDataset,
  type ReportDatasetRecord,
  type ReportEvidenceReference,
  type ReportProvenanceAssessment,
  type ReportProvenanceIssueCode,
  type ReportReleaseStanding,
  type ReportReviewAssessment,
  type ReportingContext,
} from '@tonyai/shared-types';
import { boundaryGaps } from '../inventory-boundary/boundary-gaps';
import { periodsOf } from '../inventory-boundary/boundary-snapshot';

/**
 * A dataset's assessments from its captured facts (LP3-04 PR C; README
 * "Inventory coverage and report datasets"): review, coverage, provenance and
 * the scope disclosures. Pure — every input was read in the capture's one
 * snapshot, so the result is a function of that moment alone.
 *
 * A record counts only where it attaches to exactly one obligation of a
 * COUNTABLE source — included, mapped and named by no attribution conflict —
 * matched exactly on entity, category and activity type (null is null) and on
 * its period. Included mapped sources are unique on that key, so a record
 * matches one at most. Every other record that is not voided is an
 * `unmapped_record` and never summed — beside an `overlapping_periods` when it
 * holds another granularity's months of a countable source (Decisions
 * 2026-10-15 (ninth), V10).
 */

/** An extract's filters — a context without its year; none is an inventory. */
export type DatasetSelection = Omit<ReportingContext, 'year'>;

export interface CapturedFacts {
  boundary: InventoryBoundarySnapshot;
  selection: DatasetSelection;
  /** The selection's Scope 1/2 records of the year, every status. */
  records: readonly ReportDatasetRecord[];
  evidence: readonly ReportEvidenceReference[];
  /** Each release a non-voided record's snapshot names, as it stands now. */
  releases: ReadonlyMap<string, ReportReleaseStanding>;
}

export type DatasetAssessments = Pick<ReportDataset, 'review' | 'coverage' | 'provenance' | 'scopes'>;

const COUNTED: ReadonlySet<string> = new Set(COUNTED_STATUSES);
const APPROVED: ReadonlySet<string> = new Set(['approved', 'locked']);

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(byCodeUnits);

type Mapped = InventorySource & { mapping: { kind: 'mapped' } };
type Included = InventorySource & { applicability: 'included' };

const isMapped = (s: InventorySource): s is Mapped => s.mapping.kind === 'mapped';
const isIncluded = (s: InventorySource): s is Included => s.applicability === 'included';

/** The record identity a source claims: entity, category, activity type. */
const claimKey = (subsidiaryId: string, locationId: string | null, category: string, activityType: string | null) =>
  JSON.stringify([subsidiaryId, locationId, category, activityType]);
const sourceKey = (s: Mapped) =>
  claimKey(s.entity.subsidiaryId, s.entity.locationId, s.mapping.category, s.mapping.activityType);
const recordKey = (r: ReportDatasetRecord) => claimKey(r.subsidiaryId, r.locationId, r.category, r.activityType);

/** The months a record's period covers, or null for a value no cadence names. */
function monthsOf(r: ReportDatasetRecord): { first: number; last: number } | null {
  const period = periodsOf(r.reportingPeriod).find((p) => p.periodValue === r.periodValue);
  return period === undefined ? null : { first: period.firstMonth, last: period.lastMonth };
}

const overlaps = (a: { first: number; last: number }, first: number, last: number) =>
  a.first <= last && a.last >= first;

interface Attachment {
  source: Included & Mapped;
  obligation: InventoryObligation;
}

export function assessDataset(facts: CapturedFacts): DatasetAssessments {
  const { boundary, selection, records, evidence } = facts;
  const live = records.filter((r) => r.status !== 'voided');

  // --- Sources: countable, and every other one a record could name.
  const boundaryOwn = boundaryGaps(boundary);
  const conflicting = new Set(
    boundaryOwn.filter((g) => g.code === 'attribution_conflict').flatMap((g) => g.sourceIds),
  );
  const countable = new Map<string, Included & Mapped>();
  const uncountable = new Map<string, string[]>();
  for (const s of boundary.sources) {
    if (!isMapped(s)) continue;
    if (isIncluded(s) && !conflicting.has(s.id)) countable.set(sourceKey(s), s);
    else uncountable.set(sourceKey(s), [...(uncountable.get(sourceKey(s)) ?? []), s.id]);
  }
  const sourceById = new Map(boundary.sources.map((s) => [s.id, s]));

  // --- Records: attached, or a gap of their own.
  const attached = new Map<string, Attachment>();
  const recordGaps: ReportCoverageGap[] = [];
  for (const r of live) {
    const source = countable.get(recordKey(r));
    const at = { subsidiaryId: r.subsidiaryId, locationId: r.locationId };
    if (source !== undefined) {
      const obligation = source.obligations.find(
        (o) => o.reportingPeriod === r.reportingPeriod && o.periodValue === r.periodValue,
      );
      if (obligation !== undefined) {
        attached.set(r.id, { source, obligation });
        continue;
      }
      const months = monthsOf(r);
      const { firstMonth, lastMonth } = source.entity;
      if (months !== null && r.reportingPeriod !== source.reportingPeriod && overlaps(months, firstMonth, lastMonth)) {
        // Another granularity over months the source's obligations hold: a
        // conflict named beside the record's own gap, never a second count of
        // those months (V10).
        recordGaps.push({
          code: 'overlapping_periods', entity: at, category: r.category, sourceIds: [source.id],
          obligationIds: sorted(source.obligations.filter((o) => overlaps(months, o.firstMonth, o.lastMonth)).map((o) => o.id)),
          recordIds: [r.id],
        });
      }
      recordGaps.push({ code: 'unmapped_record', entity: at, category: r.category, sourceIds: [source.id], obligationIds: [], recordIds: [r.id] });
      continue;
    }
    recordGaps.push({
      code: 'unmapped_record', entity: at, category: r.category,
      sourceIds: sorted(uncountable.get(recordKey(r)) ?? []), obligationIds: [], recordIds: [r.id],
    });
  }

  // --- The boundary's own gaps, an attribution conflict naming its records.
  const recordsByKey = new Map<string, string[]>();
  for (const r of live) recordsByKey.set(recordKey(r), [...(recordsByKey.get(recordKey(r)) ?? []), r.id]);
  const boundaryCoverageGaps: ReportCoverageGap[] = boundaryOwn.map((g) => {
    const recordIds = g.code !== 'attribution_conflict' ? [] : sorted(g.sourceIds.flatMap((id) => {
      const s = sourceById.get(id);
      return s !== undefined && isMapped(s) ? recordsByKey.get(sourceKey(s)) ?? [] : [];
    }));
    return { ...g, sourceIds: [...g.sourceIds], obligationIds: [], recordIds };
  });

  // --- Obligations, in the selection.
  const inSelection = (s: InventorySource): boolean =>
    (selection.subsidiaryId === undefined || s.entity.subsidiaryId === selection.subsidiaryId) &&
    (selection.scope === undefined || s.scope === selection.scope) &&
    (selection.category === undefined || (isMapped(s) && s.mapping.category === selection.category));
  const selectedSources = boundary.sources.filter(inSelection);
  const evidenceByRecord = new Map<string, string[]>();
  for (const e of evidence) {
    for (const id of e.recordIds) evidenceByRecord.set(id, [...(evidenceByRecord.get(id) ?? []), e.id]);
  }
  const attachedTo = new Map<string, ReportDatasetRecord[]>();
  for (const r of live) {
    const a = attached.get(r.id);
    if (a !== undefined) attachedTo.set(a.obligation.id, [...(attachedTo.get(a.obligation.id) ?? []), r]);
  }
  const obligations: Array<ReportCoverageAssessment['obligations'][number]> = [];
  const obligationGaps: ReportCoverageGap[] = [];
  const satisfied = new Set<string>();
  for (const s of selectedSources) {
    if (!isIncluded(s)) continue;
    const entity = { subsidiaryId: s.entity.subsidiaryId, locationId: s.entity.locationId };
    const category = isMapped(s) ? { category: s.mapping.category } : {};
    for (const o of s.obligations) {
      const here = attachedTo.get(o.id) ?? [];
      const recordIds = sorted(here.filter((r) => COUNTED.has(r.status)).map((r) => r.id));
      const evidencePeriods = o.evidencePeriods.map((p) => {
        // W5's interim rule: a linked non-voided record's own period assigns
        // its evidence, so only an evidence period equal to that record's is met.
        const evidenceIds = sorted(here
          .filter((r) => r.reportingPeriod === p.reportingPeriod && r.periodValue === p.periodValue)
          .flatMap((r) => evidenceByRecord.get(r.id) ?? []));
        return { reportingPeriod: p.reportingPeriod, periodValue: p.periodValue, state: evidenceIds.length > 0 ? 'satisfied' as const : 'missing' as const, evidenceIds };
      });
      const state = recordIds.length > 0 ? 'satisfied' as const : 'missing' as const;
      if (state === 'satisfied') satisfied.add(o.id);
      obligations.push({ obligationId: o.id, state, recordIds, evidencePeriods });
      if (state === 'missing') {
        obligationGaps.push({ code: 'missing_record', entity, ...category, sourceIds: [s.id], obligationIds: [o.id], recordIds: [] });
      }
      if (evidencePeriods.some((p) => p.state === 'missing')) {
        obligationGaps.push({ code: 'missing_evidence', entity, ...category, sourceIds: [s.id], obligationIds: [o.id], recordIds: [] });
      }
    }
  }

  // --- Gaps, in the selection; the scopes each one holds back.
  const recordById = new Map(records.map((r) => [r.id, r]));
  const scopesOf = (g: ReportCoverageGap): Set<number> => {
    const scopes = new Set<number>();
    if (g.category !== undefined) scopes.add(CATEGORY_SCOPE_MAP[g.category]);
    for (const id of g.sourceIds) { const s = sourceById.get(id); if (s !== undefined) scopes.add(s.scope); }
    for (const id of g.recordIds) { const r = recordById.get(id); if (r !== undefined) scopes.add(r.scope); }
    return scopes;
  };
  const gapInSelection = (g: ReportCoverageGap): boolean => {
    if (g.sourceIds.length > 0) return g.sourceIds.some((id) => { const s = sourceById.get(id); return s !== undefined && inSelection(s); });
    if (g.recordIds.length > 0) return true; // the records are the selection's own
    if (selection.subsidiaryId !== undefined && g.entity !== undefined && g.entity.subsidiaryId !== selection.subsidiaryId) return false;
    if (g.category === undefined) return true;
    return (selection.scope === undefined || CATEGORY_SCOPE_MAP[g.category] === selection.scope) &&
      (selection.category === undefined || g.category === selection.category);
  };
  const gaps = sortGaps([
    ...(boundary.decision === 'unconfirmed'
      ? [{ code: 'boundary_unconfirmed' as const, sourceIds: [], obligationIds: [], recordIds: [] }]
      : []),
    ...boundaryCoverageGaps.filter(gapInSelection),
    ...obligationGaps,
    ...recordGaps,
  ]);

  // --- Review.
  const review: ReportReviewAssessment = {
    approvedRecordIds: sorted(records.filter((r) => APPROVED.has(r.status)).map((r) => r.id)),
    unapprovedRecordIds: sorted(records.filter((r) => r.status !== 'voided' && !APPROVED.has(r.status)).map((r) => r.id)),
    voidedRecordIds: sorted(records.filter((r) => r.status === 'voided').map((r) => r.id)),
  };

  // --- Counted records and provenance.
  const counted = live.filter((r) => attached.has(r.id) && COUNTED.has(r.status));
  const provenance = assessProvenance(live, counted, facts.releases);

  // --- Scopes.
  const disclose = <S extends 1 | 2>(scope: S) => {
    const selected = (selection.scope === undefined || selection.scope === scope) &&
      (selection.category === undefined || CATEGORY_SCOPE_MAP[selection.category] === scope);
    const mine = counted.filter((r) => r.scope === scope).sort((a, b) => byCodeUnits(a.id, b.id));
    if (!selected) return { scope, coverage: 'partial' as const, tCo2e: null, countedRecordIds: [] };
    const figures = mine.map((r) => r.calculation).filter(isCalculated).map((c) => c.tCo2e);
    const covered =
      selectedSources.every((s) => !isIncluded(s) || s.scope !== scope || s.obligations.every((o) => satisfied.has(o.id))) &&
      !gaps.some((g) => { const of = scopesOf(g); return of.size === 0 || of.has(scope); }) &&
      figures.length === mine.length;
    return {
      scope,
      coverage: covered ? 'covered' as const : 'partial' as const,
      tCo2e: figures.length === 0 ? null : figures.reduce((sum, t) => sum + t, 0),
      countedRecordIds: mine.map((r) => r.id),
    };
  };

  return {
    review,
    coverage: {
      obligations,
      excludedSourceIds: sorted(selectedSources.filter((s) => s.applicability === 'excluded').map((s) => s.id)),
      gaps,
    },
    provenance,
    scopes: [disclose(1), disclose(2), { scope: 3, coverage: 'not_covered' }],
  };
}

/** Each non-voided record's standing; D09 across the counted ones. */
function assessProvenance(
  live: readonly ReportDatasetRecord[],
  counted: readonly ReportDatasetRecord[],
  releasesNow: ReadonlyMap<string, ReportReleaseStanding>,
): ReportProvenanceAssessment {
  const releaseIds = new Set<string>();
  // D09 (V11): the GWP sets of the counted GHG calculations — a CO2-only
  // path weights no gas, so whatever set its release names brings no conflict.
  const gwpSets = new Map<string, string>();
  for (const r of counted) {
    const c = r.calculation;
    if (isProvenanceSnapshot(c) && c.gasCoverage === 'all_ghg' && c.factorRelease.gwpSet !== null) {
      gwpSets.set(r.id, c.factorRelease.gwpSet);
    }
  }
  const mismatch = new Set(gwpSets.values()).size > 1;
  // A release no longer in the library (a fixture can be deleted) stands
  // nowhere: read as withdrawn, fail closed, and left out of `releases`,
  // which describe the releases as they stand (V11).
  const standingOf = (snapshot: FactorReleaseSnapshot): string[] => {
    const now = releasesNow.get(snapshot.id);
    if (now === undefined) return [snapshot.status, 'withdrawn'];
    releaseIds.add(snapshot.id);
    return [snapshot.status, now.status];
  };
  const out = live.map((r) => {
    const c = r.calculation;
    if (!isCalculated(c)) return { recordId: r.id, standing: 'uncalculated' as const, issues: ['uncalculated' as const] };
    if (!isProvenanceSnapshot(c)) return { recordId: r.id, standing: 'legacy' as const, issues: ['legacy_snapshot' as const] };
    const statuses = [
      ...standingOf(c.factorRelease),
      ...(c.conversion === null ? [] : standingOf(c.conversion.release)),
    ];
    const issues = new Set<ReportProvenanceIssueCode>();
    if (statuses.includes('placeholder')) issues.add('placeholder_release');
    if (statuses.includes('fixture')) issues.add('fixture_release');
    if (statuses.includes('withdrawn')) issues.add('withdrawn_release');
    if (c.gasCoverage === 'co2_only') issues.add('partial_gas_coverage');
    if (c.yearPolicy === 'declared_fallback') issues.add('declared_year_fallback');
    if (mismatch && gwpSets.has(r.id)) issues.add('gwp_set_mismatch');
    return {
      recordId: r.id,
      standing: statuses.every((s) => s === 'authoritative') ? 'authoritative' as const : 'non_authoritative' as const,
      issues: [...issues].sort(byCodeUnits),
    };
  });
  return {
    records: out.sort((a, b) => byCodeUnits(a.recordId, b.recordId)),
    releases: sorted(releaseIds).map((id) => releasesNow.get(id)!),
  };
}

/** A stable order for display; the fingerprint sorts sets itself. */
function sortGaps(gaps: ReportCoverageGap[]): ReportCoverageGap[] {
  const keyOf = (g: ReportCoverageGap) => JSON.stringify([
    g.code, g.entity?.subsidiaryId ?? '', g.entity?.locationId ?? '', g.category ?? '',
    [...g.sourceIds], [...g.obligationIds], [...g.recordIds],
  ]);
  return gaps.map((g) => ({ ...g, sourceIds: sorted(g.sourceIds), obligationIds: sorted(g.obligationIds), recordIds: sorted(g.recordIds) }))
    .sort((a, b) => byCodeUnits(keyOf(a), keyOf(b)));
}
