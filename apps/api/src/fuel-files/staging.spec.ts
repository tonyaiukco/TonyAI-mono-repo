import { describe, expect, it } from 'vitest';
import type { FuelUsage } from '@tonyai/shared-types';
import { previewOutcome, type PlannedRow } from './staging';

/** DB-free: what a planned row means on the preview (D3), a tanker delivery not yet declared included. */

const COMPANY = '00000000-0000-4000-8000-000000000001';
const row = (over: Partial<PlannedRow> = {}): PlannedRow =>
  ({
    fileRow: 2, accountCode: 'X', accountName: 'X', rawFuel: null, litres: '10', transactionAt: null, year: 2025, month: 3,
    invoiceRef: 'D1', dedupeDigest: 'd', fuel: 'diesel', usage: 'on_road', state: 'ready', subsidiaryId: COMPANY, usageDeclared: true,
    ...over,
  }) as PlannedRow;

describe('previewOutcome — an undeclared tanker delivery (fourth review of the branch, P2)', () => {
  const only = (...usages: FuelUsage[]) => (_: string, usage: FuelUsage) => usages.includes(usage);

  it('says "depends on usage" when the reader’s batches take the company for some usages only', () => {
    // A reader holding Fuel only: stationary forms batches, on-road and off-road would be held.
    expect(previewOutcome(row({ usageDeclared: false }), only('stationary'))).toBe('depends_on_usage');
    expect(previewOutcome(row({ usageDeclared: false }), only('on_road', 'off_road'))).toBe('depends_on_usage');
  });

  it('is definite when every usage agrees, and a declared row is judged by its own usage', () => {
    expect(previewOutcome(row({ usageDeclared: false }), only('on_road', 'off_road', 'stationary'))).toBe('batches');
    expect(previewOutcome(row({ usageDeclared: false }), only())).toBe('outside_scope');
    expect(previewOutcome(row({ usage: 'stationary' }), only('stationary'))).toBe('batches');
    expect(previewOutcome(row({ usage: 'on_road' }), only('stationary'))).toBe('outside_scope');
  });
});
