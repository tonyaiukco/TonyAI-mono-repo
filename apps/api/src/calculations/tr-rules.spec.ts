import { describe, it, expect } from 'vitest';
import { FactorLibraryConflictError } from './errors';
import { GROSS_TO_NET_RATIO_INPUT } from '@tonyai/shared-types';
import { naturalGasEnergyChain } from './tr-rules';

/**
 * The TR natural gas energy chain (ng-kwh-engine; Decisions 2026-11-20 D2,
 * D3). The engine's own spec prices it end to end; this one pins the chain's
 * three answers and its library-defect refusals.
 */

type Row = Parameters<typeof naturalGasEnergyChain>[1][number];

const row = (key: string, value: number): Row =>
  ({
    id: `row-${key}`, releaseId: 'release-1', key, subject: null, value, unit: 'kcal/Sm3', isDefault: true,
    source: 'fixture', release: { edition: 'E1' },
  }) as unknown as Row;

const REFERENCE = [row('reference_ncv', 8250), row('reference_gcv', 9155), row('billed_gcv_min', 8100)];

describe('naturalGasEnergyChain', () => {
  it('prices net as entered: no ratio, no input, no row read', () => {
    expect(naturalGasEnergyChain('net', [])).toEqual({ multiplier: 1, inputs: [], rowsUsed: [] });
  });

  it('reduces gross by the release\'s own reference_ncv / reference_gcv, derived, both rows cited', () => {
    const chain = naturalGasEnergyChain('gross', REFERENCE);
    expect(chain.multiplier).toBeCloseTo(8250 / 9155, 12);
    expect(chain.multiplier).toBeCloseTo(0.901147, 6);
    expect(chain.inputs).toEqual([{ name: GROSS_TO_NET_RATIO_INPUT, value: 8250 / 9155, origin: 'derived' }]);
    expect(chain.rowsUsed.map((r) => r.key)).toEqual(['reference_ncv', 'reference_gcv']);
  });

  it.each([
    ['reference_ncv', [row('reference_gcv', 9155)]],
    ['reference_gcv', [row('reference_ncv', 8250)]],
  ])('answers a release without %s as a library defect', (_missing, rows) => {
    expect(() => naturalGasEnergyChain('gross', rows)).toThrow(FactorLibraryConflictError);
  });

  it.each([
    ['net equal to gross', 9155, 9155],
    ['net above gross', 9500, 9155],
    ['a zero net', 0, 9155],
    ['a zero gross', 8250, 0],
  ])('refuses a ratio from %s, which would never reduce the bill', (_what, ncv, gcv) => {
    const rows = [row('reference_ncv', ncv), row('reference_gcv', gcv)];
    try {
      naturalGasEnergyChain('gross', rows);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FactorLibraryConflictError);
      expect((e as FactorLibraryConflictError).code).toBe('parameter_missing');
    }
  });

  it('reads only the default, unscoped rows', () => {
    const scoped = { ...row('reference_gcv', 1), subject: 'chiller' } as unknown as Row;
    const alternative = { ...row('reference_gcv', 2), isDefault: false } as unknown as Row;
    const chain = naturalGasEnergyChain('gross', [scoped, alternative, ...REFERENCE]);
    expect(chain.multiplier).toBeCloseTo(8250 / 9155, 12);
  });
});
