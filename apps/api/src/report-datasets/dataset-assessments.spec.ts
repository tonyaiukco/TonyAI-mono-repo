import { describe, expect, it } from 'vitest';
import type {
  ActivityCalculationSnapshot, FactorReleaseSnapshot, InventoryBoundarySnapshot, ReportCoverageGap,
  ReportDatasetRecord, ReportEvidenceReference, ReportReleaseStanding,
} from '@tonyai/shared-types';
import { assessDataset, type CapturedFacts, type DatasetSelection } from './dataset-assessments';
import { buildBoundarySnapshot, type BoundaryRows } from '../inventory-boundary/boundary-snapshot';
import { cell, complete, SITE_1, SITE_2, source, SUB, SUB_B, without } from '../../test/boundary-fixtures';

/**
 * A dataset's assessments (LP3-04 PR C; README's acceptance table, V10, V11):
 * each case a boundary from `complete()` — Sub A's electricity metered monthly
 * at two sites (Scope 2), its gas quarterly at the company (Scope 1), the rest
 * excluded — and the records a capture would read beside it.
 */

const AT = '2026-10-15T00:00:00.000Z';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const release = (id: string, status: FactorReleaseSnapshot['status'] = 'authoritative', gwpSet: FactorReleaseSnapshot['gwpSet'] = 'AR6'): FactorReleaseSnapshot => ({
  id, publisher: 'DESNZ', title: 'Conversion factors', edition: '2026', ordinal: 1, status,
  sourceUrl: null, licence: null, publishedAt: '2026-06-01', gwpSet,
});

/** A provenance snapshot (schema 2) of `tCo2e`, priced by `factor` and, if given, a conversion. */
function priced(tCo2e: number, over: { factor?: FactorReleaseSnapshot; conversion?: FactorReleaseSnapshot; gasCoverage?: string; yearPolicy?: string } = {}): ActivityCalculationSnapshot {
  return {
    snapshotSchema: 2, category: 'Electricity', geographyCode: 'GB', reportingYear: 2026, scope: 2,
    inputValue: 1, inputUnit: 'kWh', normalizedValue: 1, normalizedUnit: 'kWh', conversionApplied: false,
    factorId: 'f-1', factorValue: 0.2, factorUnit: 'kgCO2e/kWh', methodology: 'location-based', source: 'DESNZ', version: '2026',
    tCo2e, activityType: 'grid_electricity', gas: 'CO2e', gasCoverage: over.gasCoverage ?? 'all_ghg', calorificBasis: 'not_applicable',
    scope2Method: 'location_based', dataYear: 2026, yearPolicy: over.yearPolicy ?? 'exact',
    factorRelease: over.factor ?? release('rel-a'),
    conversion: over.conversion === undefined ? null : {
      id: 'c-1', fromUnit: 'kWh', toUnit: 'kWh', multiplier: 1, calorificBasis: 'not_applicable', referenceConditions: null,
      basis: 'definitional', dataYear: 2026, release: over.conversion,
    },
  } as unknown as ActivityCalculationSnapshot;
}

const UNCALCULATED = { snapshotSchema: 1, reasonCode: 'no_emission_factor', reason: 'No factor', category: 'Electricity', geographyCode: 'GB' } as unknown as ActivityCalculationSnapshot;
const LEGACY = { factorId: 'old', tCo2e: 0.5, version: 'proto' } as unknown as ActivityCalculationSnapshot;

function record(id: string, over: Partial<ReportDatasetRecord> = {}): ReportDatasetRecord {
  return {
    id, subsidiaryId: SUB, locationId: SITE_1, reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'January',
    category: 'Electricity', activityType: null, scope: 2, status: 'approved', activityValue: 100, activityUnit: 'kWh',
    calculation: priced(1), createdBy: 'u-1', createdAt: AT, updatedAt: AT, reviewedBy: 'u-2', reviewedAt: AT,
    submittedAt: AT, voidedBy: null, voidedAt: null, voidReason: null, subsidiaryName: 'A', locationName: 'Site 1',
    ...over,
  };
}

/** Site 1's twelve months, approved and calculated at one tonne each. */
const site1Year = (status: ReportDatasetRecord['status'] = 'approved') =>
  MONTHS.map((m, i) => record(`r-${String(i + 1).padStart(2, '0')}`, { periodValue: m, status }));
const site2Year = () => MONTHS.map((m, i) => record(`s-${String(i + 1).padStart(2, '0')}`, { locationId: SITE_2, periodValue: m }));
const gasYear = () => ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => record(`g-${q}`, {
  locationId: null, category: 'Natural Gas', scope: 1, reportingPeriod: 'quarterly', periodValue: q,
}));
/** Every obligation of `complete()` met by an approved, calculated record. */
const fullYear = () => [...site1Year(), ...site2Year(), ...gasYear()];

const standing = (r: FactorReleaseSnapshot, status = r.status): ReportReleaseStanding => {
  const { id, status: _s, ...publication } = r;
  return { id, status, withdrawnAt: status === 'withdrawn' ? AT : null, withdrawnBy: null, withdrawalReason: null, publication };
};

function boundary(rows: BoundaryRows = complete(), decision: 'unconfirmed' | 'confirmed' = 'confirmed'): InventoryBoundarySnapshot {
  return { ...buildBoundarySnapshot(rows), decision };
}

function assess(over: Partial<CapturedFacts> = {}) {
  return assessDataset({
    boundary: boundary(),
    selection: {},
    records: [],
    evidence: [],
    releases: new Map([['rel-a', standing(release('rel-a'))]]),
    ...over,
  });
}

const codes = (gaps: readonly ReportCoverageGap[]) => gaps.map((g) => g.code);
const gapsOf = (gaps: readonly ReportCoverageGap[], code: ReportCoverageGap['code']) => gaps.filter((g) => g.code === code);
const obligation = (a: ReturnType<typeof assess>, id: string) => a.coverage.obligations.find((o) => o.obligationId === id)!;

describe('assessDataset — a complete, confirmed year', () => {
  it('covers both scopes, sums the calculated figures and has no gap', () => {
    const a = assess({ records: fullYear() });
    expect(a.coverage.gaps).toEqual([]);
    expect(a.coverage.obligations).toHaveLength(12 + 12 + 4);
    expect(a.coverage.obligations.every((o) => o.state === 'satisfied')).toBe(true);
    expect(a.scopes[0]).toEqual({ scope: 1, coverage: 'covered', tCo2e: 4, countedRecordIds: ['g-Q1', 'g-Q2', 'g-Q3', 'g-Q4'] });
    expect(a.scopes[1]).toMatchObject({ scope: 2, coverage: 'covered', tCo2e: 24 });
    expect(a.scopes[2]).toEqual({ scope: 3, coverage: 'not_covered' });
    expect(a.review.approvedRecordIds).toHaveLength(28);
    expect(a.provenance.records.every((r) => r.standing === 'authoritative' && r.issues.length === 0)).toBe(true);
    expect(a.provenance.releases.map((r) => r.id)).toEqual(['rel-a']);
  });

  it('discloses named exclusions — the excluded meter and the unsupported heat — never as gaps', () => {
    const a = assess({ records: fullYear() });
    expect(a.coverage.excludedSourceIds).toEqual(['g-2', 'u-1']);
    expect(codes(a.coverage.gaps)).not.toContain('unsupported_source');
  });

  it('holds every scope partial while the boundary is unconfirmed — a gap with no scope holds both (V10, (18))', () => {
    const a = assess({ boundary: boundary(complete(), 'unconfirmed'), records: fullYear() });
    expect(a.coverage.gaps).toEqual([{ code: 'boundary_unconfirmed', sourceIds: [], obligationIds: [], recordIds: [] }]);
    expect(a.scopes[0].coverage).toBe('partial');
    expect(a.scopes[1].coverage).toBe('partial');
    expect(a.scopes[1].tCo2e).toBe(24);
  });
});

describe("assessDataset — README's acceptance examples", () => {
  it('one approved January record, eleven missing months: missing_record each, partial', () => {
    const a = assess({ records: [record('r-01')] });
    expect(obligation(a, 'e-1:January')).toMatchObject({ state: 'satisfied', recordIds: ['r-01'] });
    expect(gapsOf(a.coverage.gaps, 'missing_record').filter((g) => g.sourceIds[0] === 'e-1')).toHaveLength(11);
    expect(a.scopes[1]).toMatchObject({ coverage: 'partial', tCo2e: 1, countedRecordIds: ['r-01'] });
  });

  it('Jan–Nov approved, December a calculated draft: December missing, the total Jan–Nov', () => {
    const records = [...site1Year().slice(0, 11), record('r-12', { periodValue: 'December', status: 'draft' }), ...site2Year(), ...gasYear()];
    const a = assess({ records });
    expect(obligation(a, 'e-1:December')).toMatchObject({ state: 'missing', recordIds: [] });
    expect(gapsOf(a.coverage.gaps, 'missing_record')).toEqual([
      { code: 'missing_record', entity: { subsidiaryId: SUB, locationId: SITE_1 }, category: 'Electricity', sourceIds: ['e-1'], obligationIds: ['e-1:December'], recordIds: [] },
    ]);
    expect(a.scopes[1]).toMatchObject({ coverage: 'partial', tCo2e: 23 });
    expect(a.scopes[1].countedRecordIds).not.toContain('r-12');
    expect(a.review.unapprovedRecordIds).toEqual(['r-12']);
  });

  it('an approved record voided, not re-entered: missing, the withdrawal disclosed, never counted', () => {
    const records = [...without(fullYear(), (r) => r.id === 'r-03'), record('r-03', { periodValue: 'March', status: 'voided', voidedBy: 'u-2', voidedAt: AT, voidReason: 'Wrong meter' })];
    const a = assess({ records });
    expect(obligation(a, 'e-1:March').state).toBe('missing');
    expect(a.review.voidedRecordIds).toEqual(['r-03']);
    expect(a.provenance.records.map((r) => r.recordId)).not.toContain('r-03');
    expect(a.scopes[1].countedRecordIds).not.toContain('r-03');
  });

  it('voided then re-entered and approved: satisfied by the replacement only', () => {
    const records = [...without(fullYear(), (r) => r.id === 'r-03'),
      record('r-03', { periodValue: 'March', status: 'voided' }), record('r-03b', { periodValue: 'March' })];
    const a = assess({ records });
    expect(obligation(a, 'e-1:March')).toMatchObject({ state: 'satisfied', recordIds: ['r-03b'] });
  });

  it('a confirmed boundary omitting a site cell: applicability_undetermined, partial', () => {
    const rows = complete();
    rows.cells = without(rows.cells, (c) => c.locationId === SITE_2);
    rows.sources = without(rows.sources, (s) => s.id === 'e-2');
    const a = assess({ boundary: boundary(rows), records: [...site1Year(), ...gasYear()] });
    expect(gapsOf(a.coverage.gaps, 'applicability_undetermined')).toEqual([
      { code: 'applicability_undetermined', entity: { subsidiaryId: SUB, locationId: SITE_2 }, category: 'Electricity', sourceIds: [], obligationIds: [], recordIds: [] },
    ]);
    expect(a.scopes[1].coverage).toBe('partial');
    expect(a.scopes[0].coverage).toBe('covered');
  });

  it('an included source under an excluded cell: attribution_conflict naming its records, each unmapped and uncounted', () => {
    const rows = complete();
    rows.cells = [...without(rows.cells, (c) => c.locationId === SITE_1), cell(SITE_1, 'Electricity', 'excluded')];
    const a = assess({ boundary: boundary(rows), records: fullYear() });
    const conflict = gapsOf(a.coverage.gaps, 'attribution_conflict');
    expect(conflict).toHaveLength(1);
    expect(conflict[0].sourceIds).toEqual(['e-1']);
    expect(conflict[0].recordIds).toEqual(site1Year().map((r) => r.id));
    expect(gapsOf(a.coverage.gaps, 'unmapped_record').map((g) => g.recordIds[0])).toEqual(site1Year().map((r) => r.id));
    // The source's obligations are still listed, each missing with its gap (V10).
    expect(obligation(a, 'e-1:January')).toMatchObject({ state: 'missing', recordIds: [] });
    expect(gapsOf(a.coverage.gaps, 'missing_record').filter((g) => g.sourceIds[0] === 'e-1').map((g) => g.obligationIds[0]))
      .toEqual(MONTHS.map((m) => `e-1:${m}`).sort());
    expect(a.scopes[1]).toMatchObject({ coverage: 'partial', tCo2e: 12 });
  });

  it('an excluded fleet with an approved diesel record: unmapped_record, never counted', () => {
    const diesel = record('fleet-1', { locationId: null, category: 'Mobile Combustion', activityType: 'diesel', scope: 1, reportingPeriod: 'annual', periodValue: 'Annual' });
    const a = assess({ records: [...fullYear(), diesel] });
    expect(gapsOf(a.coverage.gaps, 'unmapped_record')).toEqual([
      { code: 'unmapped_record', entity: { subsidiaryId: SUB, locationId: null }, category: 'Mobile Combustion', sourceIds: [], obligationIds: [], recordIds: ['fleet-1'] },
    ]);
    expect(a.scopes[0]).toMatchObject({ coverage: 'partial', tCo2e: 4 });
  });

  it('a site opening in July with an approved March record: July–December only, the March record unmapped', () => {
    const rows = complete();
    rows.sites = rows.sites.map((s) => (s.locationId === SITE_1 ? { ...s, firstMonth: 7 } : s));
    const a = assess({ boundary: boundary(rows), records: [...site1Year(), ...site2Year(), ...gasYear()] });
    expect(a.coverage.obligations.filter((o) => o.obligationId.startsWith('e-1:')).map((o) => o.obligationId))
      .toEqual(MONTHS.slice(6).map((m) => `e-1:${m}`));
    const unmapped = gapsOf(a.coverage.gaps, 'unmapped_record').map((g) => g.recordIds[0]);
    expect(unmapped).toEqual(['r-01', 'r-02', 'r-03', 'r-04', 'r-05', 'r-06']);
    expect(gapsOf(a.coverage.gaps, 'overlapping_periods')).toEqual([]);
    expect(a.scopes[1].tCo2e).toBe(18);
  });

  it('Scope 2 satisfied but one counted record uncalculated: partial, only calculated figures summed', () => {
    const records = [...without(fullYear(), (r) => r.id === 'r-05'), record('r-05', { periodValue: 'May', calculation: UNCALCULATED })];
    const a = assess({ records });
    expect(a.coverage.gaps).toEqual([]);
    expect(a.scopes[1]).toMatchObject({ coverage: 'partial', tCo2e: 23 });
    expect(a.scopes[1].countedRecordIds).toContain('r-05');
    expect(a.provenance.records.find((r) => r.recordId === 'r-05')).toEqual({ recordId: 'r-05', standing: 'uncalculated', issues: ['uncalculated'] });
  });

  it('every counted record uncalculated: tCo2e null, never zero', () => {
    const a = assess({ records: [record('r-01', { calculation: UNCALCULATED })] });
    expect(a.scopes[1].tCo2e).toBeNull();
  });

  it('an approved calculated zero is a measured zero', () => {
    const records = fullYear().map((r) => ({ ...r, calculation: priced(0) }));
    const a = assess({ records });
    expect(a.scopes[0]).toMatchObject({ coverage: 'covered', tCo2e: 0 });
  });

  it('an authoritative factor with a placeholder conversion: non-authoritative', () => {
    const records = [record('r-01', { calculation: priced(1, { conversion: release('rel-p', 'placeholder') }) })];
    const a = assess({ records, releases: new Map([['rel-a', standing(release('rel-a'))], ['rel-p', standing(release('rel-p', 'placeholder'))]]) });
    expect(a.provenance.records[0]).toEqual({ recordId: 'r-01', standing: 'non_authoritative', issues: ['placeholder_release'] });
    expect(a.provenance.releases.map((r) => r.id)).toEqual(['rel-a', 'rel-p']);
  });

  it('a release withdrawn since the calculation: its standing now is disclosed, the figure unchanged', () => {
    const a = assess({ records: [record('r-01')], releases: new Map([['rel-a', standing(release('rel-a'), 'withdrawn')]]) });
    expect(a.provenance.records[0]).toEqual({ recordId: 'r-01', standing: 'non_authoritative', issues: ['withdrawn_release'] });
    expect(a.provenance.releases[0]).toMatchObject({ id: 'rel-a', status: 'withdrawn', withdrawnAt: AT });
    expect(a.scopes[1].tCo2e).toBe(1);
  });

  it('an annual record against monthly invoices: the evidence gap stays', () => {
    const rows = complete();
    rows.policies = rows.policies.map((p) => (p.category === 'Natural Gas' && p.subsidiaryId === SUB ? { ...p, reportingPeriod: 'annual' } : p));
    rows.sources = rows.sources.map((s) => (s.id === 'g-1' ? { ...s, reportingPeriod: 'annual', evidenceReportingPeriod: 'monthly' } : s));
    const gas = record('g-y', { locationId: null, category: 'Natural Gas', scope: 1, reportingPeriod: 'annual', periodValue: 'Annual' });
    const evidence: ReportEvidenceReference[] = [{
      id: 'ev-1', subsidiaryId: SUB, fileName: 'gas.pdf', mimeType: 'application/pdf', sizeBytes: 1, createdAt: AT,
      contentFingerprint: null, recordIds: ['g-y'],
    }];
    const a = assess({ boundary: boundary(rows), records: [...site1Year(), ...site2Year(), gas], evidence });
    const o = obligation(a, 'g-1:Annual');
    expect(o.state).toBe('satisfied');
    expect(o.evidencePeriods).toHaveLength(12);
    expect(o.evidencePeriods.every((p) => p.state === 'missing' && p.evidenceIds.length === 0)).toBe(true);
    expect(gapsOf(a.coverage.gaps, 'missing_evidence')).toEqual([
      { code: 'missing_evidence', entity: { subsidiaryId: SUB, locationId: null }, category: 'Natural Gas', sourceIds: ['g-1'], obligationIds: ['g-1:Annual'], recordIds: [] },
    ]);
    expect(a.scopes[0].coverage).toBe('partial');
  });

  it('no fleet, excluded with a reason: no obligation and no amount', () => {
    const a = assess({ records: fullYear() });
    expect(a.coverage.obligations.some((o) => o.obligationId.startsWith('fleet'))).toBe(false);
    expect(a.scopes[0].countedRecordIds.every((id) => id.startsWith('g-'))).toBe(true);
  });

  it('a filtered subset of a complete inventory: an extract assessing the selection only', () => {
    const a = assess({ selection: { scope: 1 }, records: gasYear() });
    expect(a.coverage.obligations.map((o) => o.obligationId)).toEqual(['g-1:Q1', 'g-1:Q2', 'g-1:Q3', 'g-1:Q4']);
    expect(a.coverage.excludedSourceIds).toEqual(['g-2', 'u-1']);
    expect(a.scopes[0]).toMatchObject({ coverage: 'covered', tCo2e: 4 });
    // An unselected scope reads partial with no amount (contract follow-up (26)).
    expect(a.scopes[1]).toEqual({ scope: 2, coverage: 'partial', tCo2e: null, countedRecordIds: [] });
  });
});

describe('assessDataset — matching (V10)', () => {
  it('an annual row beside monthly obligations: overlapping_periods with the months it holds, and unmapped', () => {
    const annual = record('r-y', { reportingPeriod: 'annual', periodValue: 'Annual' });
    const a = assess({ records: [...fullYear(), annual] });
    expect(gapsOf(a.coverage.gaps, 'overlapping_periods')).toEqual([{
      code: 'overlapping_periods', entity: { subsidiaryId: SUB, locationId: SITE_1 }, category: 'Electricity',
      sourceIds: ['e-1'], obligationIds: MONTHS.map((m) => `e-1:${m}`).sort(), recordIds: ['r-y'],
    }]);
    expect(gapsOf(a.coverage.gaps, 'unmapped_record').map((g) => g.recordIds)).toEqual([['r-y']]);
    expect(a.scopes[1]).toMatchObject({ coverage: 'partial', tCo2e: 24 });
  });

  it("an annual row at a site opening in July overlaps only its operating months, and its unmapped gap names the meter", () => {
    const rows = complete();
    rows.sites = rows.sites.map((x) => (x.locationId === SITE_1 ? { ...x, firstMonth: 7 } : x));
    const annual = record('r-y', { reportingPeriod: 'annual', periodValue: 'Annual' });
    const a = assess({ boundary: boundary(rows), records: [annual] });
    expect(gapsOf(a.coverage.gaps, 'overlapping_periods')[0].obligationIds).toEqual(MONTHS.slice(6).map((m) => `e-1:${m}`).sort());
    expect(gapsOf(a.coverage.gaps, 'unmapped_record')[0].sourceIds).toEqual(['e-1']);
  });

  it('a Q1 row at a site opening in July overlaps nothing it operates — unmapped alone', () => {
    const rows = complete();
    rows.sites = rows.sites.map((x) => (x.locationId === SITE_1 ? { ...x, firstMonth: 7 } : x));
    const q1 = record('r-q1', { reportingPeriod: 'quarterly', periodValue: 'Q1' });
    expect(codes(assess({ boundary: boundary(rows), records: [q1] }).coverage.gaps.filter((g) => g.recordIds.includes('r-q1'))))
      .toEqual(['unmapped_record']);
  });

  it('a quarterly row overlaps only the months of its quarter', () => {
    const q2 = record('r-q2', { reportingPeriod: 'quarterly', periodValue: 'Q2' });
    expect(gapsOf(assess({ records: [q2] }).coverage.gaps, 'overlapping_periods')[0].obligationIds)
      .toEqual(['e-1:April', 'e-1:June', 'e-1:May']);
  });

  it('a site record under a company policy is unmapped (D11)', () => {
    const atSite = record('g-site', { locationId: SITE_1, category: 'Natural Gas', scope: 1, reportingPeriod: 'quarterly', periodValue: 'Q1' });
    const a = assess({ records: [...fullYear(), atSite] });
    expect(gapsOf(a.coverage.gaps, 'unmapped_record').map((g) => g.recordIds[0])).toEqual(['g-site']);
  });

  it('a record naming an activity type the null-typed source does not: unmapped ((21))', () => {
    const typed = record('r-t', { activityType: 'grid_electricity' });
    const a = assess({ records: [...fullYear(), typed] });
    expect(gapsOf(a.coverage.gaps, 'unmapped_record').map((g) => g.recordIds[0])).toEqual(['r-t']);
  });

  it('a record under a named exclusion names the excluded source', () => {
    const rows = complete();
    rows.sources = rows.sources.map((s) => (s.id === 'g-2' ? { ...s, activityType: 'x' } : s));
    const a = assess({ boundary: boundary(rows), records: [record('g-x', { locationId: null, category: 'Natural Gas', activityType: 'x', scope: 1, reportingPeriod: 'quarterly', periodValue: 'Q1' })] });
    expect(gapsOf(a.coverage.gaps, 'unmapped_record')[0]).toMatchObject({ sourceIds: ['g-2'], recordIds: ['g-x'] });
  });

  it('a record of a subsidiary outside the boundary is unmapped', () => {
    const a = assess({ selection: { subsidiaryId: 'sub-c' }, records: [record('c-1', { subsidiaryId: 'sub-c', locationId: null })] });
    expect(gapsOf(a.coverage.gaps, 'unmapped_record')[0]).toMatchObject({ entity: { subsidiaryId: 'sub-c', locationId: null }, sourceIds: [] });
    expect(a.coverage.obligations).toEqual([]);
  });

  it('only COUNTED_STATUSES satisfy activity; draft and rejected rows attach but count nothing', () => {
    const a = assess({ records: [record('r-01', { status: 'rejected' }), record('r-02', { periodValue: 'February', status: 'submitted' })] });
    expect(obligation(a, 'e-1:January').state).toBe('missing');
    expect(obligation(a, 'e-1:February')).toMatchObject({ state: 'satisfied', recordIds: ['r-02'] });
    expect(gapsOf(a.coverage.gaps, 'unmapped_record')).toEqual([]);
    expect(a.review).toEqual({ approvedRecordIds: [], unapprovedRecordIds: ['r-01', 'r-02'], voidedRecordIds: [] });
  });

  it("evidence is met by a linked live record's own period, any status — never a voided one's", () => {
    const rows = complete();
    rows.sources = rows.sources.map((s) => (s.id === 'e-1' ? { ...s, evidenceReportingPeriod: 'monthly' } : s));
    const ev = (id: string, recordIds: string[]): ReportEvidenceReference => ({
      id, subsidiaryId: SUB, fileName: `${id}.pdf`, mimeType: 'application/pdf', sizeBytes: 1, createdAt: AT, contentFingerprint: null, recordIds,
    });
    const records = [record('r-01', { status: 'draft' }), record('r-02', { periodValue: 'February', status: 'voided' })];
    const a = assess({ boundary: boundary(rows), records, evidence: [ev('ev-1', ['r-01']), ev('ev-2', ['r-02'])] });
    expect(obligation(a, 'e-1:January').evidencePeriods).toEqual([{ reportingPeriod: 'monthly', periodValue: 'January', state: 'satisfied', evidenceIds: ['ev-1'] }]);
    expect(obligation(a, 'e-1:February').evidencePeriods[0]).toMatchObject({ state: 'missing', evidenceIds: [] });
  });
});

describe('assessDataset — review sets and unmeetable obligations', () => {
  it('splits records into disjoint approved (approved and locked), unapproved and voided sets that exhaust them', () => {
    const records = [
      record('a-approved'), record('b-locked', { periodValue: 'February', status: 'locked' }),
      record('c-voided', { periodValue: 'March', status: 'voided' }), record('d-draft', { periodValue: 'April', status: 'draft' }),
      record('e-review', { periodValue: 'May', status: 'under_review' }), record('f-rejected', { periodValue: 'June', status: 'rejected' }),
    ];
    expect(assess({ records }).review).toEqual({
      approvedRecordIds: ['a-approved', 'b-locked'],
      unapprovedRecordIds: ['d-draft', 'e-review', 'f-rejected'],
      voidedRecordIds: ['c-voided'],
    });
    // A locked record still counts and satisfies its obligation.
    expect(obligation(assess({ records }), 'e-1:February')).toMatchObject({ state: 'satisfied', recordIds: ['b-locked'] });
  });

  it("an included unsupported Scope 1 source: its obligations missing, each gapped, holding back Scope 1 alone", () => {
    const rows = complete();
    rows.sources = [...rows.sources, source({ id: 'u-2', mapping: 'unsupported', category: null, unsupportedReason: 'District heat', scope: 1, reportingPeriod: 'annual' })];
    const a = assess({ boundary: boundary(rows), records: fullYear() });
    expect(obligation(a, 'u-2:Annual')).toMatchObject({ state: 'missing', recordIds: [] });
    expect(gapsOf(a.coverage.gaps, 'missing_record')).toEqual([
      { code: 'missing_record', entity: { subsidiaryId: SUB, locationId: null }, sourceIds: ['u-2'], obligationIds: ['u-2:Annual'], recordIds: [] },
    ]);
    expect(gapsOf(a.coverage.gaps, 'unsupported_source').map((g) => g.sourceIds)).toEqual([['u-2']]);
    // Its gaps carry no category: their source's scope holds back Scope 1, never Scope 2.
    expect(a.scopes[0].coverage).toBe('partial');
    expect(a.scopes[1].coverage).toBe('covered');
  });

  it('names excluded sources as exclusions, never undetermined ones', () => {
    const rows = complete();
    rows.sources = [...rows.sources, source({ id: 'g-3', applicability: 'undetermined', reason: 'Asking the landlord', reportingPeriod: null, activityType: 'y' })];
    const a = assess({ boundary: boundary(rows), records: fullYear() });
    expect(a.coverage.excludedSourceIds).toEqual(['g-2', 'u-1']);
    expect(gapsOf(a.coverage.gaps, 'applicability_undetermined').map((g) => g.sourceIds)).toEqual([['g-3']]);
  });
});

describe('assessDataset — provenance (V11)', () => {
  const at = (id: string, calculation: ActivityCalculationSnapshot, periodValue = 'January') => record(id, { periodValue, calculation });

  it('a legacy snapshot is legacy, and discloses it', () => {
    const a = assess({ records: [at('r-01', LEGACY)] });
    expect(a.provenance.records[0]).toEqual({ recordId: 'r-01', standing: 'legacy', issues: ['legacy_snapshot'] });
    expect(a.scopes[1].tCo2e).toBe(0.5);
  });

  it('discloses partial gas coverage and a declared-year fallback', () => {
    const a = assess({ records: [at('r-01', priced(1, { gasCoverage: 'co2_only', yearPolicy: 'declared_fallback' }))] });
    expect(a.provenance.records[0].issues).toEqual(['declared_year_fallback', 'partial_gas_coverage']);
    expect(a.provenance.records[0].standing).toBe('authoritative');
  });

  it('D09: two GWP sets among the counted records mark every record carrying one', () => {
    const ar5 = release('rel-5', 'authoritative', 'AR5');
    const a = assess({
      records: [at('r-01', priced(1)), at('r-02', priced(1, { factor: ar5 }), 'February'), at('r-03', priced(1, { factor: ar5, gasCoverage: 'co2_only' }), 'March')],
      releases: new Map([['rel-a', standing(release('rel-a'))], ['rel-5', standing(ar5)]]),
    });
    const issues = Object.fromEntries(a.provenance.records.map((r) => [r.recordId, r.issues]));
    expect(issues['r-01']).toEqual(['gwp_set_mismatch']);
    expect(issues['r-02']).toEqual(['gwp_set_mismatch']);
    // A CO2-only path weights no gas: its release's set brings no conflict.
    expect(issues['r-03']).toEqual(['partial_gas_coverage']);
  });

  it('D09: a CO2-only path beside one GWP set is no mismatch, and an uncounted record is not compared', () => {
    const ar5 = release('rel-5', 'authoritative', 'AR5');
    const a = assess({
      records: [at('r-01', priced(1)), at('r-02', priced(1, { factor: ar5, gasCoverage: 'co2_only' }), 'February'), record('r-03', { periodValue: 'March', status: 'draft', calculation: priced(1, { factor: ar5 }) })],
      releases: new Map([['rel-a', standing(release('rel-a'))], ['rel-5', standing(ar5)]]),
    });
    expect(a.provenance.records.flatMap((r) => r.issues)).not.toContain('gwp_set_mismatch');
  });

  it('a release no longer in the library reads withdrawn, fails closed, and is not described', () => {
    const fixture = release('rel-f', 'fixture');
    const a = assess({ records: [at('r-01', priced(1, { factor: fixture }))], releases: new Map() });
    expect(a.provenance.records[0]).toEqual({ recordId: 'r-01', standing: 'non_authoritative', issues: ['fixture_release', 'withdrawn_release'] });
    expect(a.provenance.releases).toEqual([]);
  });

  it('every live record appears once; voided ones never', () => {
    const a = assess({ records: [record('r-01'), record('r-02', { periodValue: 'February', status: 'voided' }), record('r-03', { periodValue: 'March', status: 'draft' })] });
    expect(a.provenance.records.map((r) => r.recordId)).toEqual(['r-01', 'r-03']);
  });
});

describe('assessDataset — selections', () => {
  it('a Scope 3 context: an empty partial extract', () => {
    const a = assess({ selection: { scope: 3 }, records: [] });
    expect(a.coverage.obligations).toEqual([]);
    expect(a.scopes.slice(0, 2)).toEqual([
      { scope: 1, coverage: 'partial', tCo2e: null, countedRecordIds: [] },
      { scope: 2, coverage: 'partial', tCo2e: null, countedRecordIds: [] },
    ]);
  });

  it("a subsidiary extract keeps that subsidiary's obligations and gaps alone", () => {
    const rows = complete();
    rows.cells = without(rows.cells, (c) => c.subsidiaryId === SUB_B && c.category === 'Fuel');
    const selection: DatasetSelection = { subsidiaryId: SUB };
    const a = assess({ boundary: boundary(rows), selection, records: fullYear() });
    expect(a.coverage.gaps).toEqual([]);
    expect(a.scopes[0].coverage).toBe('covered');
    const whole = assess({ boundary: boundary(rows), records: fullYear() });
    expect(codes(whole.coverage.gaps)).toEqual(['applicability_undetermined']);
  });

  it("an extract keeps the gaps of its scope and category, a gap with no scope, and drops the rest", () => {
    const rows = complete();
    // A Natural Gas cell missing (Scope 1) beside an Electricity site cell missing (Scope 2).
    rows.cells = without(rows.cells, (c) => (c.subsidiaryId === SUB && c.category === 'Natural Gas') || c.locationId === SITE_2);
    rows.sources = without(rows.sources, (x) => x.id === 'g-1' || x.id === 'e-2');
    const whole = assess({ boundary: boundary(rows, 'unconfirmed'), records: site1Year() });
    expect(gapsOf(whole.coverage.gaps, 'applicability_undetermined').map((g) => g.category).sort()).toEqual(['Electricity', 'Natural Gas']);
    for (const selection of [{ scope: 2 as const }, { category: 'Electricity' as const }]) {
      const a = assess({ boundary: boundary(rows, 'unconfirmed'), selection, records: site1Year() });
      expect(codes(a.coverage.gaps).sort(), JSON.stringify(selection)).toEqual(['applicability_undetermined', 'boundary_unconfirmed']);
      expect(gapsOf(a.coverage.gaps, 'applicability_undetermined')[0].category).toBe('Electricity');
    }
    const gas = assess({ boundary: boundary(rows, 'unconfirmed'), selection: { category: 'Natural Gas' }, records: [] });
    expect(gapsOf(gas.coverage.gaps, 'applicability_undetermined').map((g) => g.category)).toEqual(['Natural Gas']);
  });

  it("an extract keeps a source's gaps only when the source is in it", () => {
    const rows = complete();
    rows.sources = [
      ...rows.sources,
      source({ id: 'u-a', mapping: 'unsupported', category: null, unsupportedReason: 'Steam', scope: 1, reportingPeriod: 'annual' }),
      source({ id: 'u-b', subsidiaryId: SUB_B, mapping: 'unsupported', category: null, unsupportedReason: 'Steam', scope: 2, reportingPeriod: 'annual' }),
    ];
    const unsupported = (selection: DatasetSelection) =>
      gapsOf(assess({ boundary: boundary(rows), selection, records: [] }).coverage.gaps, 'unsupported_source').map((g) => g.sourceIds[0]);
    expect(unsupported({})).toEqual(['u-a', 'u-b']);
    expect(unsupported({ subsidiaryId: SUB })).toEqual(['u-a']);
    expect(unsupported({ scope: 2 })).toEqual(['u-b']);
    expect(unsupported({ category: 'Electricity' })).toEqual([]);
  });

  it('a category extract keeps that category', () => {
    const a = assess({ selection: { category: 'Natural Gas' }, records: gasYear() });
    expect(a.coverage.obligations.map((o) => o.obligationId)).toEqual(['g-1:Q1', 'g-1:Q2', 'g-1:Q3', 'g-1:Q4']);
    expect(a.coverage.excludedSourceIds).toEqual(['g-2']);
    expect(a.scopes[0].coverage).toBe('covered');
    expect(a.scopes[1].coverage).toBe('partial');
  });
});

describe('assessDataset — determinism', () => {
  it('answers the same for the same facts in any order', () => {
    const records = [...fullYear(), record('r-y', { reportingPeriod: 'annual', periodValue: 'Annual' })];
    expect(assess({ records: [...records].reverse() })).toEqual(assess({ records }));
  });

  it('sums in record-id order, whatever order the records arrive in', () => {
    // A sum of doubles depends on its order: 1e16 + 1 + 1 is 1e16, 1 + 1 + 1e16 is not.
    const records = [record('c', { periodValue: 'March', calculation: priced(1) }), record('b', { periodValue: 'February', calculation: priced(1) }), record('a', { calculation: priced(1e16) })];
    expect(assess({ records }).scopes[1].tCo2e).toBe(1e16);
    expect(assess({ records: [...records].reverse() }).scopes[1].tCo2e).toBe(1e16);
  });
});
