import { describe, expect, it } from 'vitest';
import {
  admitsChild,
  allowedChildTypes,
  CONSOLIDATION_APPROACHES,
  CONTROL_KINDS,
  CONTROLLABLE_NODE_TYPES,
  ghgBasis,
  holdsRecords,
  LOCATION_TYPES,
  mayBeAssociate,
  NODE_TYPES,
  rollUp,
  UPCOMING_CONSOLIDATION_APPROACHES,
  type NodeType,
  type RollUpNode,
  type ScopeFigures,
} from './index';

describe('the tree vocabularies (INC-2.6 §2, §3)', () => {
  it('lists the five company node types', () => {
    expect([...NODE_TYPES]).toEqual(['holding', 'sub_holding', 'sector_group', 'company', 'child_company']);
  });
  it('lists the two control kinds', () => {
    expect([...CONTROL_KINDS]).toEqual(['controlled', 'associate']);
  });
  it('stores two approaches and announces equity share', () => {
    expect([...CONSOLIDATION_APPROACHES]).toEqual(['operational_control', 'financial_control']);
    expect([...UPCOMING_CONSOLIDATION_APPROACHES]).toEqual(['equity_share']);
  });
  it('lists the ten facility types', () => {
    expect([...LOCATION_TYPES]).toEqual([
      'warehouse', 'office', 'factory', 'plant', 'refinery', 'retail_shop', 'mall', 'building', 'apartment',
      'rms_station',
    ]);
  });
});

// The placement matrix, row = parent, column = child. A changed cell fails by name.
const MATRIX: Record<NodeType, string> = {
  //            holding sub_holding sector_group company child_company
  holding:      '.YYY.',
  sub_holding:  '.YYY.',
  sector_group: '...Y.',
  company:      '....Y',
  child_company: '....Y',
};

describe('allowedChildTypes — the placement matrix (RD7)', () => {
  for (const parent of NODE_TYPES) {
    NODE_TYPES.forEach((child, i) => {
      const expected = MATRIX[parent][i] === 'Y';
      it(`${child} under ${parent} → ${expected}`, () => {
        expect(allowedChildTypes(parent).includes(child)).toBe(expected);
      });
    });
  }

  it('refuses a child company directly under the holding', () => {
    expect(allowedChildTypes('holding')).not.toContain('child_company');
  });

  it('never admits a holding as a child', () => {
    for (const parent of NODE_TYPES) expect(allowedChildTypes(parent)).not.toContain('holding');
  });

  it('admits nothing under an associate, whatever its type', () => {
    expect(admitsChild({ nodeType: 'company', control: 'associate' }, 'child_company')).toBe(false);
    expect(admitsChild({ nodeType: 'company', control: 'controlled' }, 'child_company')).toBe(true);
    expect(admitsChild({ nodeType: 'holding', control: 'controlled' }, 'child_company')).toBe(false);
  });
});

describe('control and the records a node holds', () => {
  it('lets only a company or child company be an associate', () => {
    expect([...CONTROLLABLE_NODE_TYPES]).toEqual(['company', 'child_company']);
    expect(NODE_TYPES.filter(mayBeAssociate)).toEqual(['company', 'child_company']);
  });

  for (const nodeType of NODE_TYPES) {
    for (const control of CONTROL_KINDS) {
      const expected = nodeType !== 'sector_group' && control === 'controlled';
      it(`holdsRecords(${nodeType}, ${control}) → ${expected}`, () => {
        expect(holdsRecords({ nodeType, control })).toBe(expected);
      });
    }
  }
});

describe('ghgBasis — derived, never chosen (§3)', () => {
  for (const approach of CONSOLIDATION_APPROACHES) {
    it(`a controlled node under ${approach} counts 100 % under it`, () => {
      expect(ghgBasis('controlled', approach)).toEqual({ basis: approach, percent: 100, inScope12: true });
    });
    it(`an associate under ${approach} is equity, outside Scope 1 and 2`, () => {
      expect(ghgBasis('associate', approach)).toEqual({ basis: 'equity', percent: 0, inScope12: false });
    });
  }
});

const t = (scope1: number, scope2 = 0, nonAuthoritativeRecordCount = 0): ScopeFigures => ({ scope1, scope2, total: scope1 + scope2, nonAuthoritativeRecordCount });
const node = (id: string, parentId: string | null, nodeType: NodeType, control: 'controlled' | 'associate' = 'controlled'): RollUpNode =>
  ({ id, parentId, nodeType, control });

describe('rollUp — own plus the children (§5.2)', () => {
  it('sums the not-authoritative count up the tree with the tonnes; an associate adds none (owner review of WP7, P1)', () => {
    const r = rollUp(
      [
        { id: 'H', parentId: null, nodeType: 'holding', control: 'controlled' },
        { id: 'A', parentId: 'H', nodeType: 'company', control: 'controlled' },
        { id: 'X', parentId: 'H', nodeType: 'company', control: 'associate' },
      ],
      new Map([['H', t(1, 0, 0)], ['A', t(2, 0, 2)], ['X', t(9, 0, 5)]]),
    );
    expect(r.get('H')?.rollUp).toEqual(t(3, 0, 2));
    expect(r.get('A')?.rollUp?.nonAuthoritativeRecordCount).toBe(2);
  });

  it('reads the spec example: 5 / 10 / 3 → 18', () => {
    const nodes = [node('H', null, 'holding'), node('A', 'H', 'company'), node('B', 'A', 'child_company')];
    const r = rollUp(nodes, new Map([['H', t(5)], ['A', t(10)], ['B', t(3)]]));
    expect(r.get('B')).toEqual({ own: t(3), rollUp: t(3) });
    expect(r.get('A')).toEqual({ own: t(10), rollUp: t(13) });
    expect(r.get('H')).toEqual({ own: t(5), rollUp: t(18) });
  });

  it('accepts own totals as a plain record too, and splits the scopes', () => {
    const r = rollUp([node('H', null, 'holding'), node('A', 'H', 'company')], { H: t(1, 2), A: t(3, 4) });
    expect(r.get('H')?.rollUp).toEqual({ scope1: 4, scope2: 6, total: 10, nonAuthoritativeRecordCount: 0 });
  });

  it('gives a sector group no own figure and the sum of its children', () => {
    const nodes = [
      node('H', null, 'holding'), node('G', 'H', 'sector_group'),
      node('A', 'G', 'company'), node('B', 'A', 'child_company'), node('C', 'G', 'company'),
    ];
    // An own figure named for the sector group is ignored: it holds no records.
    const r = rollUp(nodes, new Map([['G', t(99)], ['A', t(10)], ['B', t(3)], ['C', t(7)]]));
    expect(r.get('G')).toEqual({ own: null, rollUp: t(20) });
    expect(r.get('H')).toEqual({ own: t(0), rollUp: t(20) });
  });

  it('gives an associate no figure and leaves its parent unchanged', () => {
    const without = rollUp([node('H', null, 'holding'), node('A', 'H', 'company')], new Map([['H', t(5)], ['A', t(10)]]));
    const withAssociate = rollUp(
      [node('H', null, 'holding'), node('A', 'H', 'company'), node('X', 'H', 'company', 'associate')],
      new Map([['H', t(5)], ['A', t(10)], ['X', t(40)]]),
    );
    expect(withAssociate.get('X')).toEqual({ own: null, rollUp: null });
    expect(withAssociate.get('H')).toEqual(without.get('H'));
  });

  it('makes a node whose parent is absent the top of its own fragment', () => {
    // A super_admin granted A and B, not the holding H.
    const r = rollUp([node('A', 'H', 'company'), node('B', 'A', 'child_company')], new Map([['A', t(10)], ['B', t(3)]]));
    expect(r.get('A')).toEqual({ own: t(10), rollUp: t(13) });
    expect(r.has('H')).toBe(false);
  });

  it('counts only the nodes given: a parent without its child', () => {
    const r = rollUp([node('A', 'H', 'company')], new Map([['A', t(10)], ['B', t(3)]]));
    expect(r.get('A')).toEqual({ own: t(10), rollUp: t(10) });
    expect([...r.keys()]).toEqual(['A']);
  });

  it('terminates on a malformed cycle and answers every node', () => {
    const r = rollUp(
      [node('A', 'B', 'company'), node('B', 'A', 'child_company'), node('C', 'C', 'company')],
      new Map([['A', t(1)], ['B', t(2)], ['C', t(4)]]),
    );
    expect([...r.keys()].sort()).toEqual(['A', 'B', 'C']);
    expect(r.get('C')).toEqual({ own: t(4), rollUp: t(4) });
  });
});
