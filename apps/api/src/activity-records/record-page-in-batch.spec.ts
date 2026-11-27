import { describe, expect, it } from 'vitest';
import type { RequestUser } from '../auth/auth.types';
import { normaliseRecordFilters, recordFilterWhere } from './record-page';

/** inc28-fuel-bulk D10 (task 6.2): the review queue's Records list leaves fuel batches' records out. */

const masterkey: RequestUser = {
  id: 'u', email: 'u@tonyai.test', fullName: 'U', role: 'masterkey',
  organisationId: 'o', accessibleSubsidiaryIds: ['s1'], categoryGrants: {},
};

describe('the inBatch filter', () => {
  it('leaves batch records out on false, keeps only them on true, and is absent otherwise', () => {
    expect(recordFilterWhere(masterkey, normaliseRecordFilters({ inBatch: false }))).toMatchObject({ fuelBatchId: null });
    expect(recordFilterWhere(masterkey, normaliseRecordFilters({ inBatch: true }))).toMatchObject({ fuelBatchId: { not: null } });
    expect(recordFilterWhere(masterkey, normaliseRecordFilters({}))).not.toHaveProperty('fuelBatchId');
  });

  it('is part of the normalised filters, so a cursor binds to it', () => {
    expect(normaliseRecordFilters({ inBatch: false })).toMatchObject({ inBatch: false });
    expect(normaliseRecordFilters({})).not.toHaveProperty('inBatch', false);
  });
});
