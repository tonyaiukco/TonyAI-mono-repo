import { describe, expect, it } from 'vitest';
import type { PutInventoryBoundarySubsidiaryRequest } from '@tonyai/shared-types';
import { copiedRows, declarationOf, declarationRows, type StoredDeclaration } from './boundary-declaration';

/**
 * One subsidiary's declaration as the tables store it (LP3-04's write path):
 * what the API derives — the entity key, a mapped source's scope and cadence,
 * the included claim key — each at its CHECK's own rule, and the declaration
 * read back from those rows, as an audit row holds it.
 */

const NIL = '00000000-0000-0000-0000-000000000000';
const TARGET = { boundaryId: 'b-1', organisationId: 'org-a', subsidiaryId: 'sub-a' };
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

/** In the canonical order `declarationOf` reads back. */
const BODY: PutInventoryBoundarySubsidiaryRequest = {
  firstMonth: 3,
  lastMonth: 12,
  sites: [{ locationId: S1, firstMonth: 3, lastMonth: 12 }, { locationId: S2, firstMonth: 7, lastMonth: 9 }],
  attribution: [
    { category: 'Electricity', level: 'sites', reportingPeriod: 'monthly' },
    { category: 'Natural Gas', level: 'company', reportingPeriod: 'quarterly' },
    { category: 'Fuel', level: 'company', reportingPeriod: 'annual' },
  ],
  applicability: [
    { locationId: null, category: 'Natural Gas', applicability: 'included' },
    { locationId: null, category: 'Fuel', applicability: 'excluded', reason: 'No vehicles or plant' },
    { locationId: S1, category: 'Electricity', applicability: 'included' },
    { locationId: S2, category: 'Electricity', applicability: 'undetermined', reason: 'Landlord meter unclear' },
  ],
  sources: [
    { locationId: null, name: 'Gas meter', mapping: { kind: 'mapped', category: 'Natural Gas', activityType: null }, applicability: 'included', evidenceReportingPeriod: 'monthly' },
    { locationId: null, name: 'Generator', mapping: { kind: 'mapped', category: 'Fuel', activityType: 'diesel' }, applicability: 'excluded', reason: 'Decommissioned' },
    { locationId: null, name: 'District heat', mapping: { kind: 'unsupported', reason: 'No factor yet' }, scope: 2, reportingPeriod: 'annual', applicability: 'included', evidenceReportingPeriod: null },
    { locationId: null, name: 'Steam', mapping: { kind: 'unsupported', reason: 'No factor yet' }, scope: 1, applicability: 'undetermined', reason: 'Volume unknown' },
    { locationId: S1, name: 'Main meter', mapping: { kind: 'mapped', category: 'Electricity', activityType: null }, applicability: 'included', evidenceReportingPeriod: null },
  ],
};

const ids = () => {
  let n = 0;
  return () => `src-${++n}`;
};

describe('declarationRows', () => {
  const rows = declarationRows(TARGET, BODY, ids());

  it('writes the subsidiary and its sites with their months, and no frozen name (W7)', () => {
    expect(rows.subsidiary).toEqual({ ...TARGET, firstMonth: 3, lastMonth: 12 });
    expect(rows.sites).toEqual([
      { boundaryId: 'b-1', subsidiaryId: 'sub-a', locationId: S1, firstMonth: 3, lastMonth: 12 },
      { boundaryId: 'b-1', subsidiaryId: 'sub-a', locationId: S2, firstMonth: 7, lastMonth: 9 },
    ]);
  });

  it('writes each policy as sent', () => {
    expect(rows.policies).toEqual(BODY.attribution.map((p) => ({ boundaryId: 'b-1', subsidiaryId: 'sub-a', ...p })));
  });

  it("keys a cell by its site, or the nil uuid for the company entity; a reason exactly when it is not included", () => {
    expect(rows.cells.map((c) => [c.locationId, c.locationKey, c.applicability, c.reason])).toEqual([
      [null, NIL, 'included', null],
      [null, NIL, 'excluded', 'No vehicles or plant'],
      [S1, S1, 'included', null],
      [S2, S2, 'undetermined', 'Landlord meter unclear'],
    ]);
  });

  it("gives a mapped source its category's scope, an included one its policy's cadence and its claim key", () => {
    const [gas, generator, , , meter] = rows.sources;
    expect(gas).toMatchObject({
      id: 'src-1', locationKey: NIL, scope: 1, mapping: 'mapped', category: 'Natural Gas', activityType: null,
      includedActivityKey: '', unsupportedReason: null, applicability: 'included', reason: null,
      reportingPeriod: 'quarterly', evidenceReportingPeriod: 'monthly',
    });
    expect(meter).toMatchObject({
      id: 'src-5', locationId: S1, locationKey: S1, scope: 2, category: 'Electricity', includedActivityKey: '',
      reportingPeriod: 'monthly', evidenceReportingPeriod: null,
    });
    // Not included: no claim key, no cadence — a named exclusion beside its meter.
    expect(generator).toMatchObject({
      scope: 1, category: 'Fuel', activityType: 'diesel', includedActivityKey: null, applicability: 'excluded',
      reason: 'Decommissioned', reportingPeriod: null, evidenceReportingPeriod: null,
    });
  });

  it("keeps an unsupported source's declared scope, reason and — when included — cadence, and no category or claim", () => {
    const [, , heat, steam] = rows.sources;
    expect(heat).toMatchObject({
      scope: 2, mapping: 'unsupported', category: null, activityType: null, includedActivityKey: null,
      unsupportedReason: 'No factor yet', applicability: 'included', reason: null, reportingPeriod: 'annual', evidenceReportingPeriod: null,
    });
    expect(steam).toMatchObject({
      scope: 1, mapping: 'unsupported', category: null, includedActivityKey: null, unsupportedReason: 'No factor yet',
      applicability: 'undetermined', reason: 'Volume unknown', reportingPeriod: null, evidenceReportingPeriod: null,
    });
  });

  it('gives a typed included source its activity type as its claim', () => {
    const typed = declarationRows(TARGET, {
      ...BODY,
      sources: [{ locationId: null, name: 'Generator', mapping: { kind: 'mapped', category: 'Fuel', activityType: 'diesel' }, applicability: 'included', evidenceReportingPeriod: null }],
    }, ids());
    expect(typed.sources[0]).toMatchObject({ includedActivityKey: 'diesel', reportingPeriod: 'annual', scope: 1 });
  });

  it('gives every source a new id, every time — an open version’s source ids are not stable', () => {
    expect(rows.sources.map((s) => s.id)).toEqual(['src-1', 'src-2', 'src-3', 'src-4', 'src-5']);
    let n = 100;
    expect(declarationRows(TARGET, BODY, () => `x-${++n}`).sources.map((s) => s.id)).toEqual(['x-101', 'x-102', 'x-103', 'x-104', 'x-105']);
  });
});

describe('declarationOf', () => {
  it('reads back exactly what was declared, each source with its id — no derived column', () => {
    const rows = declarationRows(TARGET, BODY, ids());
    const expected: StoredDeclaration = { ...BODY, sources: BODY.sources.map((s, i) => ({ id: `src-${i + 1}`, ...s })) };
    expect(declarationOf(rows)).toEqual(expected);
  });

  it('reads rows in any order back in one order', () => {
    const rows = declarationRows(TARGET, BODY, ids());
    const shuffled = {
      ...rows,
      sites: [...rows.sites].reverse(),
      policies: [...rows.policies].reverse(),
      cells: [...rows.cells].reverse(),
      sources: [...rows.sources].reverse(),
    };
    expect(declarationOf(shuffled)).toEqual(declarationOf(rows));
  });
});

describe('copiedRows', () => {
  it("copies a version's rows as they are into another — names cleared until it freezes, every source a new id", () => {
    const frozen = {
      subsidiaries: [{ boundaryId: 'old', organisationId: 'org-a', subsidiaryId: 'sub-a', firstMonth: 7, lastMonth: 12, subsidiaryName: 'Alpha', geographyCode: 'GB' }],
      sites: [{ boundaryId: 'old', subsidiaryId: 'sub-a', locationId: S1, firstMonth: 7, lastMonth: 12, locationName: 'Leeds', geographyCode: 'GB' }],
      policies: [{ boundaryId: 'old', subsidiaryId: 'sub-a', category: 'Electricity', level: 'sites', reportingPeriod: 'monthly' }],
      cells: [{ boundaryId: 'old', subsidiaryId: 'sub-a', locationId: S1, locationKey: S1, category: 'Electricity', applicability: 'included', reason: null }],
      sources: [{
        id: 'old-src', boundaryId: 'old', subsidiaryId: 'sub-a', locationId: S1, locationKey: S1, name: 'Main meter', scope: 2,
        mapping: 'mapped', category: 'Electricity', activityType: null, includedActivityKey: '', unsupportedReason: null,
        applicability: 'included', reason: null, reportingPeriod: 'monthly', evidenceReportingPeriod: null,
      }],
    };
    const copy = copiedRows(frozen, 'new', () => 'new-src');
    expect(copy.subsidiaries).toEqual([{ ...frozen.subsidiaries[0], boundaryId: 'new', subsidiaryName: null, geographyCode: null }]);
    expect(copy.sites).toEqual([{ ...frozen.sites[0], boundaryId: 'new', locationName: null, geographyCode: null }]);
    expect(copy.policies).toEqual([{ ...frozen.policies[0], boundaryId: 'new' }]);
    expect(copy.cells).toEqual([{ ...frozen.cells[0], boundaryId: 'new' }]);
    expect(copy.sources).toEqual([{ ...frozen.sources[0], id: 'new-src', boundaryId: 'new' }]);
  });
});
