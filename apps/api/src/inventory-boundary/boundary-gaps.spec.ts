import { describe, expect, it } from 'vitest';
import type { InventoryBoundaryGap, InventoryBoundarySnapshot } from '@tonyai/shared-types';
import { boundaryGaps } from './boundary-gaps';
import { buildBoundarySnapshot, type BoundaryRows } from './boundary-snapshot';
import { cell, complete, policy, SITE_1, SITE_2, source, SUB, SUB_B, without } from '../../test/boundary-fixtures';

/**
 * The boundary's own gaps (LP3-04's write path; `InventoryBoundaryGap`): one
 * case per rule the contract enumerates, each a single change to a complete
 * boundary — which has none — so every case names exactly what that rule adds.
 */

const gapsOf = (rows: BoundaryRows) => boundaryGaps(buildBoundarySnapshot(rows));

const gap = (
  code: InventoryBoundaryGap['code'], subsidiaryId: string, locationId: string | null,
  category: string | undefined, sourceIds: string[] = [],
): InventoryBoundaryGap => ({
  code,
  entity: { subsidiaryId, locationId },
  ...(category === undefined ? {} : { category: category as InventoryBoundaryGap['category'] }),
  sourceIds,
  obligationIds: [],
  recordIds: [],
});

describe('boundaryGaps — every rule a boundary breaks before any record is read', () => {
  it('finds none in a complete boundary — named exclusions included', () => {
    expect(gapsOf(complete())).toEqual([]);
  });

  describe('applicability_undetermined', () => {
    it('a declared subsidiary × Scope 1/2 category with no policy — at the company entity', () => {
      const rows = complete();
      expect(gapsOf({ ...rows, policies: without(rows.policies, (p) => p.subsidiaryId === SUB && p.category === 'Fuel') }))
        .toEqual([gap('applicability_undetermined', SUB, null, 'Fuel')]);
    });

    it('a subsidiary with no policy at all owes one per category', () => {
      const rows = complete();
      expect(gapsOf({
        ...rows,
        policies: without(rows.policies, (p) => p.subsidiaryId === SUB_B),
        cells: without(rows.cells, (c) => c.subsidiaryId === SUB_B),
      })).toEqual(
        ['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants']
          .map((c) => gap('applicability_undetermined', SUB_B, null, c)),
      );
    });

    it('a sites policy whose subsidiary declares no site — at the company entity', () => {
      const rows = complete();
      expect(gapsOf({
        ...rows,
        policies: [...rows.policies, policy('Electricity', 'sites', 'monthly', SUB_B)]
          .filter((p) => !(p.subsidiaryId === SUB_B && p.category === 'Electricity' && p.level === 'company')),
        cells: without(rows.cells, (c) => c.subsidiaryId === SUB_B && c.category === 'Electricity'),
      })).toEqual([gap('applicability_undetermined', SUB_B, null, 'Electricity')]);
    });

    it('a selected entity × category with no cell — a site under a sites policy, the company under a company one', () => {
      const rows = complete();
      expect(gapsOf({
        ...rows,
        cells: without(rows.cells, (c) => c.locationId === SITE_2),
        sources: without(rows.sources, (s) => s.id === 'e-2'),
      })).toEqual([gap('applicability_undetermined', SUB, SITE_2, 'Electricity')]);
      expect(gapsOf({ ...rows, cells: without(rows.cells, (c) => c.subsidiaryId === SUB_B && c.category === 'Fuel') }))
        .toEqual([gap('applicability_undetermined', SUB_B, null, 'Fuel')]);
    });

    it('an undetermined cell at a selected entity', () => {
      const rows = complete();
      expect(gapsOf({
        ...rows,
        cells: rows.cells.map((c) => (c.locationId === SITE_2 ? cell(SITE_2, 'Electricity', 'undetermined') : c)),
        sources: without(rows.sources, (s) => s.id === 'e-2'),
      })).toEqual([gap('applicability_undetermined', SUB, SITE_2, 'Electricity')]);
    });

    it('a mapped source whose own decision is undetermined — naming it', () => {
      const rows = complete();
      expect(gapsOf({
        ...rows,
        sources: [...rows.sources, source({ id: 'g-3', applicability: 'undetermined', reason: 'Unclear meter', reportingPeriod: null })],
      })).toEqual([gap('applicability_undetermined', SUB, null, 'Natural Gas', ['g-3'])]);
    });

    it('is not raised for an undetermined or missing cell at an entity its policy does not select', () => {
      const rows = complete();
      expect(gapsOf({ ...rows, cells: [...rows.cells, cell(SITE_1, 'Fuel', 'undetermined')] })).toEqual([]);
    });
  });

  describe('unsupported_source', () => {
    it.each(['included', 'undetermined'] as const)('an unsupported source %s — at its entity, naming it, no category', (applicability) => {
      const rows = complete();
      const unsupported = source({
        id: 'u-2', locationId: SITE_1, mapping: 'unsupported', category: null, unsupportedReason: 'Steam', scope: 2,
        applicability,
        reason: applicability === 'included' ? null : 'Not yet known',
        reportingPeriod: applicability === 'included' ? 'annual' : null,
      });
      const gaps = gapsOf({ ...rows, sources: [...rows.sources, unsupported] });
      expect(gaps).toEqual([gap('unsupported_source', SUB, SITE_1, undefined, ['u-2'])]);
      expect(gaps[0]).not.toHaveProperty('category');
    });
  });

  describe('attribution_conflict', () => {
    it('an included cell with no included mapped source — never a covered zero', () => {
      const rows = complete();
      expect(gapsOf({ ...rows, sources: without(rows.sources, (s) => s.id === 'g-1') }))
        .toEqual([gap('attribution_conflict', SUB, null, 'Natural Gas')]);
    });

    it('an excluded source beside it does not cover an included cell', () => {
      const rows = complete();
      expect(gapsOf({ ...rows, sources: without(rows.sources, (s) => s.id === 'g-1') })
        .every((g) => g.sourceIds.length === 0)).toBe(true);
    });

    it('an included cell with no source at an entity its policy does not select (Decision 2A, the literal reading)', () => {
      const rows = complete();
      expect(gapsOf({ ...rows, cells: [...rows.cells, cell(null, 'Electricity')] }))
        .toEqual([gap('attribution_conflict', SUB, null, 'Electricity')]);
    });

    it('an included mapped source under an excluded cell — naming it', () => {
      const rows = complete();
      expect(gapsOf({ ...rows, sources: [...rows.sources, source({ id: 'f-1', category: 'Fuel', activityType: 'diesel', reportingPeriod: 'annual' })] }))
        .toEqual([gap('attribution_conflict', SUB, null, 'Fuel', ['f-1'])]);
    });

    it('an included mapped source under an undetermined cell — the cell and the source each a gap', () => {
      const rows = complete();
      expect(gapsOf({
        ...rows,
        cells: rows.cells.map((c) => (c.locationId === SITE_2 ? cell(SITE_2, 'Electricity', 'undetermined') : c)),
      })).toEqual([
        gap('applicability_undetermined', SUB, SITE_2, 'Electricity'),
        gap('attribution_conflict', SUB, SITE_2, 'Electricity', ['e-2']),
      ]);
    });

    it('an included mapped source with no cell at its entity — the cell missing and the source unheld', () => {
      const rows = complete();
      expect(gapsOf({ ...rows, cells: without(rows.cells, (c) => c.locationId === SITE_2) })).toEqual([
        gap('applicability_undetermined', SUB, SITE_2, 'Electricity'),
        gap('attribution_conflict', SUB, SITE_2, 'Electricity', ['e-2']),
      ]);
    });

    it('an included mapped source at an entity its policy does not select — even under an included cell there', () => {
      const rows = complete();
      expect(gapsOf({
        ...rows,
        cells: [...rows.cells, cell(SITE_1, 'Natural Gas')],
        sources: [...rows.sources, source({ id: 'g-9', locationId: SITE_1 })],
      })).toEqual([gap('attribution_conflict', SUB, SITE_1, 'Natural Gas', ['g-9'])]);
    });
  });

  it('orders gaps by subsidiary, entity (the company first), category, code and source — whatever order the rows came in', () => {
    const rows = complete();
    const broken: BoundaryRows = {
      ...rows,
      policies: without(rows.policies, (p) => p.category === 'Refrigerants'),
      cells: [
        ...rows.cells.map((c) => (c.locationId === SITE_1 ? cell(SITE_1, 'Electricity', 'undetermined') : c)),
        cell(null, 'Electricity', 'included', SUB),
      ],
      sources: [
        ...rows.sources,
        source({ id: 'u-9', mapping: 'unsupported', category: null, unsupportedReason: 'Steam', applicability: 'included', reportingPeriod: 'annual' }),
        source({ id: 'g-8', applicability: 'undetermined', reason: 'Unclear', reportingPeriod: null }),
      ],
    };
    const expected = [
      gap('attribution_conflict', SUB, null, 'Electricity'),
      gap('applicability_undetermined', SUB, null, 'Natural Gas', ['g-8']),
      gap('applicability_undetermined', SUB, null, 'Refrigerants'),
      gap('unsupported_source', SUB, null, undefined, ['u-9']),
      gap('applicability_undetermined', SUB, SITE_1, 'Electricity'),
      gap('attribution_conflict', SUB, SITE_1, 'Electricity', ['e-1']),
      gap('applicability_undetermined', SUB_B, null, 'Refrigerants'),
    ];
    expect(gapsOf(broken)).toEqual(expected);
    const reversed: BoundaryRows = {
      ...broken,
      subsidiaries: [...broken.subsidiaries].reverse(),
      sites: [...broken.sites].reverse(),
      policies: [...broken.policies].reverse(),
      cells: [...broken.cells].reverse(),
      sources: [...broken.sources].reverse(),
    };
    expect(gapsOf(reversed)).toEqual(expected);
  });

  it('reads its snapshot and changes nothing in it', () => {
    const rows = complete();
    const snapshot = buildBoundarySnapshot({ ...rows, policies: without(rows.policies, (p) => p.category === 'Refrigerants') });
    const deepFreeze = <T>(value: T): T => {
      if (typeof value === 'object' && value !== null) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
      }
      return value;
    };
    const frozen = deepFreeze(structuredClone(snapshot)) as InventoryBoundarySnapshot;
    expect(boundaryGaps(frozen)).toHaveLength(2);
    expect(frozen).toEqual(snapshot);
  });
});
