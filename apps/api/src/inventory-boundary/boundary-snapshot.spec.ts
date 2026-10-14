import { describe, it, expect } from 'vitest';
import {
  BoundaryRowsDefect,
  buildBoundarySnapshot,
  obligationsFor,
  type BoundaryRows,
  type BoundarySourceRow,
} from './boundary-snapshot';

/**
 * The boundary as the contract's `InventoryBoundarySnapshot` (LP3-04 PR B):
 * the README's examples — a site opening mid-year, a quarterly cadence clipped
 * to operating months, an excluded and an unsupported source, a missing cell,
 * a `sites` policy with no site — each with one expected outcome.
 */

const SUB = 'sub-a';
const SITE = 'site-1';
const months = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function source(over: Partial<BoundarySourceRow> & { id: string }): BoundarySourceRow {
  return {
    subsidiaryId: SUB, locationId: SITE, name: `Source ${over.id}`, scope: 2, mapping: 'mapped',
    category: 'Electricity', activityType: null, unsupportedReason: null, applicability: 'included', reason: null,
    reportingPeriod: 'monthly', evidenceReportingPeriod: 'monthly',
    ...over,
  };
}

function rows(over: Partial<BoundaryRows> = {}): BoundaryRows {
  return {
    header: {
      id: 'b-1', organisationId: 'org-a', reportingYear: 2026, version: 1, decision: 'unconfirmed',
      decidedBy: null, decidedAt: null, frozenAt: null,
    },
    subsidiaries: [{
      subsidiaryId: SUB, firstMonth: 1, lastMonth: 12,
      frozenName: null, frozenGeographyCode: null, liveName: 'Alpha Ltd', liveGeographyCode: 'GB',
    }],
    sites: [{
      subsidiaryId: SUB, locationId: SITE, firstMonth: 7, lastMonth: 12,
      frozenName: null, frozenGeographyCode: null, liveName: 'Leeds plant', liveGeographyCode: 'GB',
    }],
    policies: [{ subsidiaryId: SUB, category: 'Electricity', level: 'sites', reportingPeriod: 'monthly' }],
    cells: [{ subsidiaryId: SUB, locationId: SITE, category: 'Electricity', applicability: 'included', reason: null }],
    sources: [source({ id: 'meter-1' })],
    ...over,
  };
}

describe('obligationsFor', () => {
  it('a site opening in July owes July to December, each month once, each with its own invoice', () => {
    const obligations = obligationsFor('meter-1', 'monthly', 'monthly', 7, 12);
    expect(obligations.map((o) => o.periodValue)).toEqual(MONTHS.slice(6));
    expect(obligations.map((o) => [o.firstMonth, o.lastMonth])).toEqual(months(7, 12).map((m) => [m, m]));
    expect(obligations.map((o) => o.evidencePeriods)).toEqual(
      MONTHS.slice(6).map((m) => [{ reportingPeriod: 'monthly', periodValue: m }]),
    );
    expect(obligations[0].id).toBe('meter-1:July');
  });

  it('clips a quarterly cadence to the operating months, never past them', () => {
    const obligations = obligationsFor('s', 'quarterly', null, 2, 11);
    expect(obligations.map((o) => [o.periodValue, o.firstMonth, o.lastMonth])).toEqual([
      ['Q1', 2, 3], ['Q2', 4, 6], ['Q3', 7, 9], ['Q4', 10, 11],
    ]);
    expect(obligations.every((o) => o.evidencePeriods.length === 0)).toBe(true);
  });

  it('an annual record owes the evidence of every operating month — one annual figure does not satisfy twelve invoices', () => {
    const [annual, ...rest] = obligationsFor('s', 'annual', 'monthly', 7, 12);
    expect(rest).toEqual([]);
    expect([annual.id, annual.periodValue, annual.firstMonth, annual.lastMonth]).toEqual(['s:Annual', 'Annual', 7, 12]);
    expect(annual.evidencePeriods.map((e) => e.periodValue)).toEqual(MONTHS.slice(6));
  });

  it('a monthly obligation under an annual evidence cadence names the year it falls in', () => {
    const obligations = obligationsFor('s', 'monthly', 'annual', 11, 12);
    expect(obligations.map((o) => o.evidencePeriods)).toEqual([
      [{ reportingPeriod: 'annual', periodValue: 'Annual' }],
      [{ reportingPeriod: 'annual', periodValue: 'Annual' }],
    ]);
  });

  it('a one-month entity owes one period of every cadence', () => {
    for (const cadence of ['monthly', 'quarterly', 'annual'] as const) {
      const obligations = obligationsFor('s', cadence, null, 5, 5);
      expect(obligations.map((o) => [o.firstMonth, o.lastMonth])).toEqual([[5, 5]]);
    }
  });
});

describe('buildBoundarySnapshot', () => {
  it('declares the company entity and its site, each with its own months, and the site\'s source carries the site\'s', () => {
    const snapshot = buildBoundarySnapshot(rows());
    expect(snapshot.subsidiaryIds).toEqual([SUB]);
    expect(snapshot.entities).toEqual([
      { subsidiaryId: SUB, subsidiaryName: 'Alpha Ltd', locationId: null, locationName: null, geographyCode: 'GB', firstMonth: 1, lastMonth: 12 },
      { subsidiaryId: SUB, subsidiaryName: 'Alpha Ltd', locationId: SITE, locationName: 'Leeds plant', geographyCode: 'GB', firstMonth: 7, lastMonth: 12 },
    ]);
    const [meter] = snapshot.sources;
    expect(meter.entity).toEqual(snapshot.entities[1]);
    expect(meter.applicability === 'included' && meter.obligations.map((o) => o.periodValue)).toEqual(MONTHS.slice(6));
  });

  it('an included cell names every included mapped source at its entity and category, and no other', () => {
    const snapshot = buildBoundarySnapshot(rows({
      sources: [
        source({ id: 'meter-2' }),
        source({ id: 'meter-1' }),
        source({ id: 'meter-excluded', applicability: 'excluded', reason: 'Sub-metered by the landlord', reportingPeriod: null, evidenceReportingPeriod: null }),
        source({ id: 'company-meter', locationId: null }),
        source({ id: 'boiler', category: 'Natural Gas', scope: 1 }),
      ],
      subsidiaries: rows().subsidiaries,
    }));
    expect(snapshot.applicability).toEqual([
      { subsidiaryId: SUB, locationId: SITE, category: 'Electricity', applicability: 'included', sourceIds: ['meter-1', 'meter-2'] },
    ]);
  });

  it('an excluded source keeps its name and reason and owes nothing; an unsupported one keeps both reasons (D05)', () => {
    const snapshot = buildBoundarySnapshot(rows({
      sources: [
        source({ id: 'meter-x', applicability: 'excluded', reason: 'Below the materiality threshold', reportingPeriod: null, evidenceReportingPeriod: null }),
        source({
          id: 'district-heat', mapping: 'unsupported', category: null, scope: 2, unsupportedReason: 'District heat has no factor in the pilot',
          applicability: 'excluded', reason: 'Disclosed as an exclusion', reportingPeriod: null, evidenceReportingPeriod: null,
        }),
      ],
    }));
    const byId = Object.fromEntries(snapshot.sources.map((s) => [s.id, s]));
    expect(byId['meter-x']).toMatchObject({ applicability: 'excluded', reason: 'Below the materiality threshold', mapping: { kind: 'mapped', category: 'Electricity' } });
    expect(byId['meter-x']).not.toHaveProperty('obligations');
    expect(byId['district-heat']).toMatchObject({
      name: 'Source district-heat', scope: 2, applicability: 'excluded', reason: 'Disclosed as an exclusion',
      mapping: { kind: 'unsupported', reason: 'District heat has no factor in the pilot' },
    });
    expect(snapshot.sources.some((s) => 'tCo2e' in s)).toBe(false);
  });

  it('an included unsupported source declares its cadence and owes its obligations', () => {
    const snapshot = buildBoundarySnapshot(rows({
      sources: [source({ id: 'heat', mapping: 'unsupported', category: null, unsupportedReason: 'No factor', reportingPeriod: 'quarterly', evidenceReportingPeriod: null })],
    }));
    const [heat] = snapshot.sources;
    expect(heat.applicability === 'included' && heat.obligations.map((o) => o.periodValue)).toEqual(['Q3', 'Q4']);
  });

  it('reports a missing cell and a sites policy with no site as they are — the gaps are the coverage step\'s', () => {
    const snapshot = buildBoundarySnapshot(rows({
      sites: [],
      cells: [],
      sources: [],
      policies: [{ subsidiaryId: SUB, category: 'Natural Gas', level: 'sites', reportingPeriod: 'quarterly' }],
    }));
    expect(snapshot.applicability).toEqual([]);
    expect(snapshot.attribution).toEqual([{ subsidiaryId: SUB, category: 'Natural Gas', level: 'sites', reportingPeriod: 'quarterly' }]);
    expect(snapshot.entities.map((e) => e.locationId)).toEqual([null]);
  });

  it('an open version reads the names as they are now; a frozen one, its own copy (W7)', () => {
    const open = buildBoundarySnapshot(rows());
    expect(open.entities[1].locationName).toBe('Leeds plant');
    const frozenRows = rows({
      header: { ...rows().header, decision: 'confirmed', decidedBy: 'user-1', decidedAt: new Date('2027-01-15T09:00:00Z'), frozenAt: new Date('2027-01-15T09:00:00Z') },
      subsidiaries: [{ ...rows().subsidiaries[0], frozenName: 'Alpha Limited', frozenGeographyCode: 'GB' }],
      sites: [{ ...rows().sites[0], frozenName: 'Leeds (old name)', frozenGeographyCode: 'GB', liveName: 'Leeds renamed', liveGeographyCode: 'TR' }],
    });
    const frozen = buildBoundarySnapshot(frozenRows);
    expect(frozen.entities.map((e) => [e.subsidiaryName, e.locationName, e.geographyCode])).toEqual([
      ['Alpha Limited', null, 'GB'],
      ['Alpha Limited', 'Leeds (old name)', 'GB'],
    ]);
    expect([frozen.decision, frozen.decidedBy, frozen.decidedAt]).toEqual(['confirmed', 'user-1', '2027-01-15T09:00:00.000Z']);
  });

  it('is the same snapshot whatever order the rows were read in', () => {
    const base = rows({
      subsidiaries: [
        rows().subsidiaries[0],
        { subsidiaryId: 'sub-0', firstMonth: 1, lastMonth: 12, frozenName: null, frozenGeographyCode: null, liveName: 'Zero', liveGeographyCode: 'TR' },
      ],
      cells: [
        { subsidiaryId: SUB, locationId: SITE, category: 'Natural Gas', applicability: 'undetermined', reason: 'Awaiting the landlord' },
        rows().cells[0],
      ],
      sources: [source({ id: 'b' }), source({ id: 'a' }), source({ id: 'gas', category: 'Natural Gas', scope: 1 })],
    });
    const reversed = {
      ...base,
      subsidiaries: [...base.subsidiaries].reverse(),
      cells: [...base.cells].reverse(),
      sources: [...base.sources].reverse(),
    };
    expect(buildBoundarySnapshot(reversed)).toEqual(buildBoundarySnapshot(base));
    expect(buildBoundarySnapshot(base).subsidiaryIds).toEqual(['sub-0', SUB]);
  });

  it('refuses rows the tables should have refused, as a defect', () => {
    expect(() => buildBoundarySnapshot(rows({ sources: [source({ id: 'stray', locationId: 'elsewhere' })] }))).toThrow(BoundaryRowsDefect);
    expect(() => buildBoundarySnapshot(rows({ header: { ...rows().header, frozenAt: new Date() } }))).toThrow(BoundaryRowsDefect);
    expect(() => buildBoundarySnapshot(rows({ sources: [source({ id: 's', scope: 3 })] }))).toThrow(BoundaryRowsDefect);
  });
});
