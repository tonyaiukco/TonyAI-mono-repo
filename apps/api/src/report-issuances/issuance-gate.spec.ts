import { describe, expect, it } from 'vitest';
import type { ReportIssuanceGap } from '@tonyai/shared-types';
import { complete, SITE_1, SUB, SUB_B, without } from '../../test/boundary-fixtures';
import {
  allLocks, datasetOf, frozenBoundary, fullYear, gasYear, lock, MONTHS, priced, record, refingerprinted, release, rowOf,
  site1Year, site2Year, standing, UNCALCULATED,
} from '../../test/issuance-fixtures';
import { boundaryMatchesVersion, deriveIssuance, readRetainedDataset, RetainedDatasetError } from './issuance-gate';

/**
 * The final gate (LP3-04 PR D; D13, K2, K4; README "The issuance" and its
 * acceptance table): status and gaps from the retained dataset alone, and the
 * retained text held to its row, its own assessments and its version.
 */

const codes = (gaps: readonly ReportIssuanceGap[]) => gaps.map((g) => g.code);
const only = (gaps: readonly ReportIssuanceGap[], code: ReportIssuanceGap['code']) => gaps.filter((g) => g.code === code);
const gapsOf = (result: ReturnType<typeof deriveIssuance>): readonly ReportIssuanceGap[] => result.gaps;

/** Sub A's gas billed annually instead: one Annual obligation, `g-1:Annual`. */
function annualGasRows() {
  const rows = complete();
  return {
    ...rows,
    policies: rows.policies.map((p) => (p.subsidiaryId === SUB && p.category === 'Natural Gas' ? { ...p, reportingPeriod: 'annual' } : p)),
    sources: rows.sources.map((s) => (s.id === 'g-1' ? { ...s, reportingPeriod: 'annual' } : s)),
  };
}
const annualGas = () => record('g-annual', {
  locationId: null, locationName: null, category: 'Natural Gas', scope: 1, reportingPeriod: 'annual', periodValue: 'Annual',
});

describe('deriveIssuance — final', () => {
  it('a confirmed inventory, every obligation recorded, approved, locked and authoritative: final, no gap', () => {
    expect(deriveIssuance(datasetOf())).toEqual({ status: 'final', gaps: [] });
  });

  it('an approved, calculated zero is a figure: final', () => {
    const records = fullYear().map((r) => (r.id === 'g-Q1' ? { ...r, calculation: priced(0) } : r));
    const dataset = datasetOf({ records });
    expect(dataset.scopes[0].tCo2e).toBe(3);
    expect(deriveIssuance(dataset).status).toBe('final');
  });

  it('an excluded meter and an unsupported source excluded with a reason do not block final', () => {
    const dataset = datasetOf();
    expect(dataset.coverage.excludedSourceIds).toEqual(['g-2', 'u-1']);
    expect(deriveIssuance(dataset).status).toBe('final');
  });

  it('locked records satisfy as approved ones do', () => {
    const dataset = datasetOf({ records: fullYear().map((r) => ({ ...r, status: 'locked' as const })) });
    expect(deriveIssuance(dataset).status).toBe('final');
  });
});

describe("deriveIssuance — partial, every gap named (README's acceptance table)", () => {
  it('one approved January record: partial — the missing months are coverage gaps', () => {
    const result = deriveIssuance(datasetOf({ records: [record('r-01')] }));
    expect(result.status).toBe('partial');
    expect(new Set(codes(result.gaps))).toEqual(new Set(['coverage_gap']));
    expect(gapsOf(result).find((g) => g.obligationIds.includes('e-1:February'))).toEqual({
      code: 'coverage_gap', coverageCode: 'missing_record', entity: { subsidiaryId: SUB, locationId: SITE_1 }, category: 'Electricity',
      sourceIds: ['e-1'], obligationIds: ['e-1:February'], recordIds: [],
    });
    expect(gapsOf(result).some((g) => g.obligationIds.includes('e-1:January'))).toBe(false);
  });

  it('an extract is never final, even fully approved and locked: filtered_extract', () => {
    const result = deriveIssuance(datasetOf({ selection: { subsidiaryId: SUB } }));
    expect(result).toEqual({ status: 'partial', gaps: [{ code: 'filtered_extract', sourceIds: [], obligationIds: [], recordIds: [] }] });
  });

  it('an unconfirmed boundary: its coverage gap blocks final', () => {
    const result = deriveIssuance(datasetOf({ boundary: frozenBoundary(complete(), 'unconfirmed') }));
    expect(result).toEqual({
      status: 'partial',
      gaps: [{ code: 'coverage_gap', coverageCode: 'boundary_unconfirmed', sourceIds: [], obligationIds: [], recordIds: [] }],
    });
  });

  it('carries each coverage gap on its own — id-less ones are never folded into one (architect P2)', () => {
    const rows = complete();
    // Two cells undecided, in two subsidiaries; the boundary unconfirmed too.
    const cells = without(rows.cells, (c) => (c.subsidiaryId === SUB_B && c.category === 'Electricity') || (c.subsidiaryId === SUB && c.category === 'Fuel'));
    const result = deriveIssuance(datasetOf({ boundary: frozenBoundary({ ...rows, cells }, 'unconfirmed') }));
    expect(gapsOf(result).filter((g) => g.code === 'coverage_gap').map((g) => [g.coverageCode, g.entity, g.category])).toEqual([
      ['applicability_undetermined', { subsidiaryId: SUB, locationId: null }, 'Fuel'],
      ['applicability_undetermined', { subsidiaryId: SUB_B, locationId: null }, 'Electricity'],
      ['boundary_unconfirmed', undefined, undefined],
    ]);
    // Absent, never undefined: the row's jsonb and the canonical form hold no undefined key.
    for (const g of gapsOf(result)) for (const v of Object.values(g)) expect(v).not.toBeUndefined();
  });

  it('a submitted record satisfies coverage but not final: unapproved_record, per obligation', () => {
    const records = fullYear().map((r) => (r.id === 'r-03' ? { ...r, status: 'submitted' as const } : r));
    const result = deriveIssuance(datasetOf({ records }));
    expect(result).toEqual({
      status: 'partial',
      gaps: [{ code: 'unapproved_record', sourceIds: ['e-1'], obligationIds: ['e-1:March'], recordIds: ['r-03'] }],
    });
  });

  it("a period not locked: unlocked_period, one gap per lock naming every obligation it holds back", () => {
    const result = deriveIssuance(datasetOf({ locks: allLocks().filter((l) => l.periodValue !== 'March') }));
    expect(result).toEqual({
      status: 'partial',
      gaps: [{ code: 'unlocked_period', sourceIds: ['e-1', 'e-2'], obligationIds: ['e-1:March', 'e-2:March'], recordIds: ['r-03', 's-03'] }],
    });
  });

  it('an annual obligation needs the Annual lock — twelve monthly locks do not hold it', () => {
    const boundary = frozenBoundary(annualGasRows());
    const records = [...site1Year(), ...site2Year(), annualGas()];
    const monthly = MONTHS.map((m) => lock(m, 'monthly'));
    const result = deriveIssuance(datasetOf({ boundary, records, locks: monthly }));
    expect(result).toEqual({
      status: 'partial',
      gaps: [{ code: 'unlocked_period', sourceIds: ['g-1'], obligationIds: ['g-1:Annual'], recordIds: ['g-annual'] }],
    });
    expect(deriveIssuance(datasetOf({ boundary, records, locks: [...monthly, lock('Annual', 'annual')] })).status).toBe('final');
  });

  it("matches a lock exactly: another subsidiary's, another year's or another cadence's never holds a period", () => {
    const locks = allLocks().map((l) => (l.periodValue === 'Q2' ? { ...l, subsidiaryId: 'sub-b' } : l))
      .map((l) => (l.periodValue === 'Q3' ? { ...l, reportingYear: 2025 } : l))
      .map((l) => (l.periodValue === 'Q4' ? { ...l, reportingPeriod: 'monthly' as const } : l));
    const result = deriveIssuance(datasetOf({ locks }));
    expect(only(result.gaps, 'unlocked_period').flatMap((g) => g.obligationIds)).toEqual(['g-1:Q2', 'g-1:Q3', 'g-1:Q4']);
  });

  it('a counted figure on a placeholder release, or none at all: non_authoritative_calculation', () => {
    const records = fullYear().map((r) => (r.id === 'r-01' ? { ...r, calculation: priced(1, { factor: release('rel-p', 'placeholder') }) } : r))
      .map((r) => (r.id === 'r-02' ? { ...r, calculation: UNCALCULATED } : r));
    const releases = [standing(release('rel-a')), standing(release('rel-p', 'placeholder'))];
    const result = deriveIssuance(datasetOf({ records, releases }));
    expect(only(result.gaps, 'non_authoritative_calculation')).toEqual([
      { code: 'non_authoritative_calculation', sourceIds: [], obligationIds: [], recordIds: ['r-01', 'r-02'] },
    ]);
  });

  it('an authoritative release withdrawn since the calculation blocks final', () => {
    const releases = [standing(release('rel-a'), 'withdrawn')];
    const result = deriveIssuance(datasetOf({ releases }));
    expect(only(result.gaps, 'non_authoritative_calculation')[0]!.recordIds).toHaveLength(28);
  });

  it('two named GWP sets among the counted calculations: gwp_set_mismatch (D09)', () => {
    const ar5 = release('rel-5', 'authoritative', 'AR5');
    const records = fullYear().map((r) => (r.id === 'g-Q1' ? { ...r, calculation: priced(1, { factor: ar5 }) } : r));
    const result = deriveIssuance(datasetOf({ records, releases: [standing(release('rel-a')), standing(ar5)] }));
    expect(codes(result.gaps)).toEqual(['gwp_set_mismatch']);
    expect(result.gaps[0]!.recordIds).toHaveLength(28);
  });

  it('K4: a null GWP set beside a named one fails closed — the capture alone does not flag it', () => {
    const unnamed = release('rel-n', 'authoritative', null);
    const records = fullYear().map((r) => (r.id === 'g-Q1' ? { ...r, calculation: priced(1, { factor: unnamed }) } : r));
    const dataset = datasetOf({ records, releases: [standing(release('rel-a')), standing(unnamed)] });
    expect(dataset.provenance.records.some((p) => p.issues.includes('gwp_set_mismatch'))).toBe(false);
    const result = deriveIssuance(dataset);
    expect(codes(result.gaps)).toEqual(['gwp_set_mismatch']);
    expect(result.gaps[0]!.recordIds).toContain('g-Q1');
    expect(result.gaps[0]!.recordIds).toHaveLength(28);
  });

  it('CO2-only calculations carry no GWP set and bring no conflict', () => {
    const co2 = release('rel-c', 'authoritative', null);
    const records = fullYear().map((r) => (r.id === 'g-Q1' ? { ...r, calculation: priced(1, { factor: co2, gasCoverage: 'co2_only' }) } : r));
    const result = deriveIssuance(datasetOf({ records, releases: [standing(release('rel-a')), standing(co2)] }));
    expect(codes(result.gaps)).not.toContain('gwp_set_mismatch');
  });

  it('a withdrawn record is disclosed, never counted or gapped; a draft replacement leaves its slot missing', () => {
    const records = fullYear().map((r) => (r.id === 'r-05' ? { ...r, status: 'voided' as const, voidReason: 'Duplicate invoice' } : r));
    const result = deriveIssuance(datasetOf({ records }));
    expect(result.status).toBe('partial');
    expect(gapsOf(result).every((g) => !g.recordIds.includes('r-05'))).toBe(true);
    expect(gapsOf(result).some((g) => g.code === 'coverage_gap' && g.obligationIds.includes('e-1:May'))).toBe(true);
  });

  it('orders gaps by the contract, each once, ids sorted', () => {
    const records = [...site1Year('submitted'), ...site2Year(), ...gasYear()];
    const result = deriveIssuance(datasetOf({ selection: { subsidiaryId: SUB }, records, locks: [] }));
    const order = codes(result.gaps);
    expect(order[0]).toBe('filtered_extract');
    expect(order.indexOf('unapproved_record')).toBeLessThan(order.indexOf('unlocked_period'));
    expect(new Set(gapsOf(result).map((g) => JSON.stringify(g))).size).toBe(result.gaps.length);
    for (const g of gapsOf(result)) expect([...g.recordIds]).toEqual([...g.recordIds].sort());
  });

  it('partial always names at least one gap; final none', () => {
    for (const dataset of [datasetOf(), datasetOf({ records: [] }), datasetOf({ locks: [] })]) {
      const result = deriveIssuance(dataset);
      expect(result.status === 'final' ? result.gaps.length === 0 : result.gaps.length > 0).toBe(true);
    }
  });
});

describe('readRetainedDataset — the text held to its row before it is trusted (K2)', () => {
  const dataset = datasetOf();

  it('parses a dataset whose fingerprint, referenced set and assessments recompute', () => {
    expect(readRetainedDataset(rowOf(dataset))).toEqual(dataset);
  });

  it('refuses text whose fingerprint does not recompute — a figure changed in place', () => {
    const tampered = JSON.parse(JSON.stringify(dataset));
    tampered.records[0].calculation.tCo2e = 0.001;
    expect(() => readRetainedDataset(rowOf(dataset, JSON.stringify(tampered)))).toThrow(/fingerprint does not recompute/);
  });

  it('refuses a row whose fingerprint is not its content\'s', () => {
    expect(() => readRetainedDataset({ ...rowOf(dataset), fingerprintHex: 'a'.repeat(64) })).toThrow(RetainedDatasetError);
  });

  it('refuses self-consistent text whose assessments do not recompute from its facts — a gap removed past the API', () => {
    const forged = refingerprinted(datasetOf({ records: [record('r-01')] }), (d) => {
      (d.coverage as unknown as { gaps: unknown[] }).gaps = [];
    });
    expect(() => readRetainedDataset(rowOf(forged))).toThrow(/assessments do not recompute/);
  });

  it('refuses a record approved past the API — the review recomputes from the records', () => {
    const forged = refingerprinted(datasetOf({ records: fullYear().map((r) => (r.id === 'r-01' ? { ...r, status: 'submitted' as const } : r)) }), (d) => {
      (d.review as unknown as { approvedRecordIds: string[] }).approvedRecordIds = [...d.review.approvedRecordIds, 'r-01'].sort();
      (d.review as unknown as { unapprovedRecordIds: string[] }).unapprovedRecordIds = [];
    });
    expect(() => readRetainedDataset(rowOf(forged))).toThrow(/assessments do not recompute/);
  });

  it('refuses a referenced set that is not the one its content names', () => {
    expect(() => readRetainedDataset({ ...rowOf(dataset), referencedSubsidiaryIds: ['sub-a'] })).toThrow(/referenced subsidiaries/);
    // A repeated id is not the same set (`qa-auditor` M31).
    const referenced = rowOf(dataset).referencedSubsidiaryIds;
    expect(() => readRetainedDataset({ ...rowOf(dataset), referencedSubsidiaryIds: [...referenced, referenced[0]!] })).toThrow(/referenced subsidiaries/);
  });

  it("refuses text that is not the row's dataset, not JSON, or of a schema it does not read", () => {
    expect(() => readRetainedDataset({ ...rowOf(dataset), id: 'another' })).toThrow(/identity/);
    expect(() => readRetainedDataset({ ...rowOf(dataset), organisationId: 'org-b' })).toThrow(/identity/);
    expect(() => readRetainedDataset({ ...rowOf(dataset), content: '{"schemaVersion":' })).toThrow(/not JSON/);
    expect(() => readRetainedDataset({ ...rowOf(dataset), schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => readRetainedDataset({ ...rowOf(dataset), content: 'null' })).toThrow(RetainedDatasetError);
  });
});

describe('the pinned assessments — K2 holds every retained dataset to them (architect P2)', () => {
  // The issuance recomputes a retained dataset's assessments and rebuilds its
  // boundary with TODAY's code, and refuses one that differs (K2). These
  // fingerprints pin `assessDataset`, `buildBoundarySnapshot` and the
  // canonical encoding on fixed fixtures: a change that moves either is a change
  // that makes every dataset retained before it un-issuable — bump
  // REPORT_DATASET_SCHEMA_VERSION and keep the old rules for the old version
  // ("LP3-04 PR D follow-ups"), then re-pin.
  it('a complete year', () => {
    expect(datasetOf().fingerprint.hex).toBe('244200c5f4ed453538f36487a8014ba67e1c49957fc2c4a672a37cd1f8ad946b');
  });

  it('one January record, nothing locked', () => {
    expect(datasetOf({ records: [record('r-01')], locks: [] }).fingerprint.hex)
      .toBe('319372f63039ad57edc2bd9a7afcf82299ecd21b20b7674186f18c4e15d417e5');
  });
});

describe('boundaryMatchesVersion — the retained boundary is the frozen version as stored (PR C follow-up (9))', () => {
  const retained = frozenBoundary();

  it('matches the version rebuilt from the same rows, in any order', () => {
    const rows = complete();
    const reordered = frozenBoundary({ ...rows, sources: [...rows.sources].reverse(), cells: [...rows.cells].reverse() });
    expect(boundaryMatchesVersion(1, retained, reordered)).toBe(true);
  });

  it.each([
    ['a renamed site', () => frozenBoundary({ ...complete(), sites: complete().sites.map((s) => (s.locationId === SITE_1 ? { ...s, liveName: 'Renamed' } : s)) })],
    ['a dropped exclusion', () => frozenBoundary({ ...complete(), sources: without(complete().sources, (s) => s.id === 'g-2') })],
    ['another decision', () => frozenBoundary(complete(), 'unconfirmed')],
    ['another month', () => frozenBoundary({ ...complete(), sites: complete().sites.map((s) => (s.locationId === SITE_1 ? { ...s, lastMonth: 11 } : s)) })],
  ])('does not match %s', (_what, rebuilt) => {
    expect(boundaryMatchesVersion(1, retained, rebuilt())).toBe(false);
  });

  it('fails closed on a version it cannot read, or a schema it has no comparison for', () => {
    expect(boundaryMatchesVersion(1, retained, null)).toBe(false);
    expect(boundaryMatchesVersion(2, retained, retained)).toBe(false);
  });
});
