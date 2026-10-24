import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryBoundarySnapshot, ReportDatasetRecord } from '@tonyai/shared-types';
import { SUB, SUB_B } from '../../test/boundary-fixtures';
import { allExcludedBoundary, frozenBoundary, fullYear, record, release, standing } from '../../test/issuance-fixtures';
import { QueryTooBroadError } from '../common/api-error';
import { CaptureSnapshot } from '../common/capture-snapshot';
import { readLiveCoverage } from './live-coverage';

/**
 * The live coverage (LP4-03 K3): the year's newest boundary version, assessed
 * by the capture's own rule over what the snapshot reads — so a one-record
 * partial year is never "complete" on a live screen or in a live export.
 */

const boundaryRead = vi.hoisted(() => ({ value: null as InventoryBoundarySnapshot | null }));
const factsRead = vi.hoisted(() => ({ records: [] as ReportDatasetRecord[], calls: [] as unknown[], fail: null as Error | null }));

vi.mock('../inventory-boundary/boundary-reader', () => ({
  readInventoryBoundary: vi.fn(async () => boundaryRead.value),
}));
vi.mock('../report-datasets/dataset-reader', () => ({
  readCaptureFacts: vi.fn(async (_snapshot: unknown, query: unknown) => {
    factsRead.calls.push(query);
    if (factsRead.fail) throw factsRead.fail;
    return { records: factsRead.records, evidence: [], periodLocks: [], releases: new Map([['rel-a', standing(release('rel-a'))]]) };
  }),
}));


function snapshotOf(newest: { id: string; frozenAt: Date | null } | null) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ isolation: 'repeatable read' }]),
    inventoryBoundary: { findFirst: vi.fn(async () => newest) },
  };
  return { tx, open: () => CaptureSnapshot.open(tx as never) };
}

const LIMITS = { records: 5_000, evidenceLinks: 10_000 };
const query = (over: Record<string, unknown> = {}) => ({
  organisationId: 'org-a', accessibleSubsidiaryIds: [SUB], reportSubsidiaryIds: [SUB], reportingYear: 2026, selection: {}, ...over,
});

beforeEach(() => {
  boundaryRead.value = null;
  factsRead.records = [];
  factsRead.calls = [];
  factsRead.fail = null;
});

describe('readLiveCoverage', () => {
  it('says no boundary is declared — unknown, never complete — and reads no record', async () => {
    const { tx, open } = snapshotOf(null);
    expect(await readLiveCoverage(await open(), query(), LIMITS)).toEqual({ state: 'no_boundary' });
    expect(tx.inventoryBoundary.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { organisationId: 'org-a', reportingYear: 2026 }, orderBy: { version: 'desc' },
    }));
    expect(factsRead.calls).toEqual([]);
  });

  it('discloses nothing of a version the caller may not read whole', async () => {
    const { open } = snapshotOf({ id: 'b-1', frozenAt: null });
    boundaryRead.value = null; // readInventoryBoundary's answer for a subsidiary outside access
    expect(await readLiveCoverage(await open(), query(), LIMITS)).toEqual({ state: 'not_readable' });
    expect(factsRead.calls).toEqual([]);
  });

  it('reads nothing at all for an extract of a subsidiary outside the caller\'s access', async () => {
    const { tx, open } = snapshotOf({ id: 'b-1', frozenAt: null });
    const answer = await readLiveCoverage(await open(), query({ selection: { subsidiaryId: 'foreign' } }), LIMITS);
    expect(answer).toEqual({ state: 'not_readable' });
    expect(tx.inventoryBoundary.findFirst).not.toHaveBeenCalled();
    expect(factsRead.calls).toEqual([]);
  });

  it('calls a confirmed boundary with every obligation met complete — and only then', async () => {
    const { open } = snapshotOf({ id: 'b-1', frozenAt: new Date() });
    boundaryRead.value = frozenBoundary();
    factsRead.records = fullYear();
    const answer = await readLiveCoverage(await open(), query(), LIMITS);
    expect(answer).toMatchObject({ state: 'assessed', selection: 'inventory', reading: 'complete', gapCounts: {} });
    if (answer.state !== 'assessed') throw new Error('unreachable');
    expect(answer.satisfiedObligationCount).toBe(answer.obligationCount);
    expect(answer.boundary).toMatchObject({ decision: 'confirmed', frozen: true });
  });

  it('never calls a one-record partial year complete: its missing months are gaps', async () => {
    const { open } = snapshotOf({ id: 'b-1', frozenAt: new Date() });
    boundaryRead.value = frozenBoundary();
    factsRead.records = [record('r-01')];
    const answer = await readLiveCoverage(await open(), query(), LIMITS);
    if (answer.state !== 'assessed') throw new Error('expected an assessment');
    expect(answer.reading).toBe('gaps');
    expect(answer.satisfiedObligationCount).toBe(1);
    expect(answer.obligationCount).toBeGreaterThan(1);
    expect(answer.gapCounts.missing_record).toBeGreaterThan(0);
  });

  it('never calls an unconfirmed version complete, though every obligation is met', async () => {
    const { open } = snapshotOf({ id: 'b-1', frozenAt: null });
    boundaryRead.value = frozenBoundary(undefined, 'unconfirmed');
    factsRead.records = fullYear();
    const answer = await readLiveCoverage(await open(), query(), LIMITS);
    expect(answer).toMatchObject({ state: 'assessed', reading: 'gaps', gapCounts: { boundary_unconfirmed: 1 } });
    expect(answer).toMatchObject({ boundary: { decision: 'unconfirmed', frozen: false } });
  });

  it('assesses an extract as a capture would: its one subsidiary, its scopes, its category', async () => {
    const { open } = snapshotOf({ id: 'b-1', frozenAt: new Date() });
    boundaryRead.value = frozenBoundary();
    factsRead.records = fullYear();
    const answer = await readLiveCoverage(await open(), query({ selection: { subsidiaryId: SUB, scope: 2 } }), LIMITS);
    expect(answer).toMatchObject({ state: 'assessed', selection: 'extract' });
    expect(factsRead.calls[0]).toMatchObject({ resolvedSubsidiaryIds: [SUB], scopes: [2], reportingYear: 2026 });
  });

  it('assesses the report\'s own subsidiaries: one the boundary leaves out is a gap, never "complete" beside its tonnes (architect P1-1)', async () => {
    const { open } = snapshotOf({ id: 'b-1', frozenAt: new Date() });
    boundaryRead.value = frozenBoundary();
    factsRead.records = [...fullYear(), record('x-01', { subsidiaryId: 'sub-elsewhere', locationId: null, subsidiaryName: 'Elsewhere', locationName: null })];
    const ids = [SUB, SUB_B, 'sub-elsewhere'];
    const answer = await readLiveCoverage(await open(), query({ accessibleSubsidiaryIds: ids, reportSubsidiaryIds: ids }), LIMITS);
    expect(factsRead.calls[0]).toMatchObject({ resolvedSubsidiaryIds: ids, scopes: [1, 2] });
    expect(answer).toMatchObject({ state: 'assessed', reading: 'gaps', gapCounts: { unmapped_record: 1 } });
    // Control: the same year without the outsider is complete.
    factsRead.records = fullYear();
    expect(await readLiveCoverage(await open(), query({ accessibleSubsidiaryIds: ids, reportSubsidiaryIds: [SUB, SUB_B] }), LIMITS))
      .toMatchObject({ reading: 'complete' });
  });

  it('reads nothing for a report subsidiary outside the caller\'s access', async () => {
    const { tx, open } = snapshotOf({ id: 'b-1', frozenAt: new Date() });
    expect(await readLiveCoverage(await open(), query({ reportSubsidiaryIds: [SUB, 'foreign'] }), LIMITS)).toEqual({ state: 'not_readable' });
    expect(await readLiveCoverage(await open(), query({ reportSubsidiaryIds: [] }), LIMITS)).toEqual({ state: 'not_readable' });
    expect(tx.inventoryBoundary.findFirst).not.toHaveBeenCalled();
  });

  it('says nothing is included when every category is excluded — no gap, no obligation, never "complete" (QA P2-2)', async () => {
    const { open } = snapshotOf({ id: 'b-1', frozenAt: new Date() });
    boundaryRead.value = allExcludedBoundary();
    const answer = await readLiveCoverage(await open(), query({ accessibleSubsidiaryIds: [SUB, SUB_B], reportSubsidiaryIds: [SUB, SUB_B] }), LIMITS);
    expect(answer).toMatchObject({ state: 'assessed', reading: 'nothing_included', obligationCount: 0, gapCounts: {} });
  });

  it('reads no boundary for a Scope 3 selection: not covered', async () => {
    const { tx, open } = snapshotOf({ id: 'b-1', frozenAt: new Date() });
    expect(await readLiveCoverage(await open(), query({ selection: { scope: 3 } }), LIMITS)).toEqual({ state: 'not_covered' });
    // A Scope 3 category alone is a Scope 3 selection too (architect re-review P2-1).
    expect(await readLiveCoverage(await open(), query({ selection: { category: 'Water' } }), LIMITS)).toEqual({ state: 'not_covered' });
    expect(tx.inventoryBoundary.findFirst).not.toHaveBeenCalled();
    expect(factsRead.calls).toEqual([]);
  });

  it('answers a selection past the report budgets as too broad — its figures stand, its coverage unknown', async () => {
    const { open } = snapshotOf({ id: 'b-1', frozenAt: new Date() });
    boundaryRead.value = frozenBoundary();
    factsRead.fail = new QueryTooBroadError();
    expect(await readLiveCoverage(await open(), query(), LIMITS)).toEqual({ state: 'too_broad' });
    factsRead.fail = new Error('a defect');
    await expect(readLiveCoverage(await open(), query(), LIMITS)).rejects.toThrow('a defect');
  });

  it('calls an extract of a subsidiary the version does not declare outside the boundary', async () => {
    const { open } = snapshotOf({ id: 'b-1', frozenAt: new Date() });
    boundaryRead.value = frozenBoundary();
    const answer = await readLiveCoverage(await open(), query({
      accessibleSubsidiaryIds: [SUB, 'sub-out'], reportSubsidiaryIds: ['sub-out'], selection: { subsidiaryId: 'sub-out' },
    }), LIMITS);
    expect(answer).toMatchObject({ state: 'assessed', selection: 'extract', reading: 'outside_boundary' });
  });
});
