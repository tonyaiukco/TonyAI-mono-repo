import { BadRequestException } from '@nestjs/common';
import { ActivityRecordStatus, type ActivityRecord } from '@tonyai/db';
import type { CalculationResultV3 } from '@tonyai/shared-types';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { CalculationsService } from '../calculations/calculations.service';
import legacy from '../calculations/refrigerant-sum-rule.fixtures.json';
import type { PrismaService } from '../prisma/prisma.service';
import { DraftRepriceService } from './draft-reprice.service';

const old = legacy.bothMasses as CalculationResultV3;
const fresh: CalculationResultV3 = {
  ...old, normalizedValue: 35, kgCo2e: 126000, tCo2e: 126,
  refrigerantTerms: old.refrigerantTerms?.map((term) => ({ ...term, pricedBy: 'refill' })) ?? [],
};
const parameters = {
  equipment: [{ equipmentType: 'fire_suppression_system', capacityKg: 50, refillKg: 35, leakRateChoice: 'default' }],
};

function row(id: string, status: ActivityRecordStatus = 'draft', calculation: unknown = old): ActivityRecord {
  return {
    id, status, calculation, parameters, category: 'Refrigerants', activityType: 'HFC-227ea',
    subsidiaryId: 'sub-1', locationId: null, reportingYear: 2025, reportingPeriod: 'annual',
    periodValue: 'Annual', activityValue: 50, activityUnit: 'kg', scope: 1,
  } as unknown as ActivityRecord;
}

function harness(rows: readonly ActivityRecord[] = [row('open')]) {
  const currently = new Map(rows.map((record) => [record.id, record]));
  const periodLock = { findFirst: vi.fn().mockResolvedValue(null) };
  const tx = {
    periodLock,
    $executeRaw: vi.fn().mockResolvedValue([]),
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
    activityRecord: {
      findUnique: vi.fn(async ({ where }) => {
        const record = currently.get(where.id);
        return record ? { ...record, subsidiary: { organisationId: 'org-1' } } : null;
      }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(async ({ where, data }) => {
        const record = { ...currently.get(where.id)!, ...data };
        currently.set(where.id, record);
        return record;
      }),
    },
  };
  const db = {
    periodLock,
    activityRecord: { findMany: vi.fn(async () => [...currently.values()]) },
    subsidiary: { findUnique: vi.fn().mockResolvedValue({ geographyCode: 'TR' }) },
    $transaction: vi.fn(async (fn) => fn(tx)),
  };
  const audit = { recordSystem: vi.fn().mockResolvedValue(undefined) };
  const engine = { compute: vi.fn().mockResolvedValue(fresh) };
  const service = new DraftRepriceService(
    db as unknown as PrismaService, engine as unknown as CalculationsService, audit as unknown as AuditService,
  );
  return { service, db, tx, audit, engine, currently };
}

describe('the operator draft reprice service', () => {
  it('uses a dry run to predict figures without locks, writes or audits', async () => {
    const h = harness();
    const report = await h.service.run(false);
    expect(report.records).toEqual([
      { id: 'open', status: 'draft', beforeTCo2e: 129.6, afterTCo2e: 126, outcome: 'would_reprice' },
    ]);
    expect(h.db.subsidiary.findUnique).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.tx.activityRecord.update).not.toHaveBeenCalled();
    expect(h.audit.recordSystem).not.toHaveBeenCalled();
  });

  it('writes only allowed columns and one tenant-scoped system audit per open or rejected record', async () => {
    const h = harness([row('open'), row('returned', 'rejected')]);
    const report = await h.service.run(true);
    expect(report.counts.repriced).toBe(2);
    expect(h.tx.activityRecord.update).toHaveBeenCalledWith({
      where: { id: 'returned', status: 'rejected' },
      data: { calculation: fresh, anomalyFlag: false, anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null },
    });
    expect(h.audit.recordSystem).toHaveBeenCalledWith({
      action: 'reprice', entity: 'activity_record', entityId: 'returned', organisationId: 'org-1',
      diff: { before: { tCo2e: 129.6 }, after: { tCo2e: 126 } },
    }, h.tx);
    expect(h.tx.activityRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ subsidiaryId: 'sub-1' }),
    }));
    expect((await h.service.run(true)).counts.up_to_date).toBe(2);
    expect(h.audit.recordSystem).toHaveBeenCalledTimes(2);
  });

  it('distinguishes legacy, new and unclassified review-queue records', async () => {
    const h = harness([
      row('legacy', 'submitted'), row('new', 'under_review', fresh), row('incomplete', 'under_review', {}),
      row('partial', 'under_review', { ...fresh, refrigerantTerms: [] }), row('committed', 'approved'),
    ]);
    const report = await h.service.run(true);
    expect(report.reviewQueue.sumRule.map((item) => item.id)).toEqual(['legacy']);
    expect(report.reviewQueue.unclassified.map((item) => item.id)).toEqual(['incomplete', 'partial']);
    expect(h.engine.compute).not.toHaveBeenCalled();
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it('reports locked periods and engine refusals without a write', async () => {
    const h = harness();
    h.db.periodLock.findFirst.mockResolvedValueOnce({ id: 'period' });
    expect((await h.service.run(true)).records[0]).toMatchObject({ outcome: 'skipped', reason: 'locked_period' });
    h.engine.compute.mockRejectedValueOnce(new BadRequestException({ code: 'record_parameters_invalid' }));
    expect((await h.service.run(true)).records[0]).toMatchObject({ outcome: 'refused', reason: 'record_parameters_invalid' });
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'submitted' }, 'skipped', 'no_longer_open'],
    [{ activityValue: 51 }, 'skipped', 'inputs_changed'],
    [{ calculation: { ...old, version: 'changed' } }, 'skipped', 'snapshot_changed'],
    [{ calculation: fresh }, 'up_to_date', undefined],
  ])('rechecks the locked record after %o', async (changed, outcome, reason) => {
    const h = harness();
    h.engine.compute.mockImplementationOnce(async () => {
      h.currently.set('open', { ...h.currently.get('open')!, ...changed } as ActivityRecord);
      return fresh;
    });
    const [item] = (await h.service.run(true)).records;
    expect(item.outcome).toBe(outcome);
    expect(item.reason).toBe(reason);
    expect(h.tx.activityRecord.update).not.toHaveBeenCalled();
    expect(h.audit.recordSystem).not.toHaveBeenCalled();
  });

  it('checks again after taking the period and row locks', async () => {
    const h = harness();
    h.db.periodLock.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'just-locked' });
    expect((await h.service.run(true)).records[0]).toMatchObject({ outcome: 'skipped', reason: 'locked_period' });
    expect(h.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(h.tx.$queryRaw.mock.invocationCallOrder[0]);
    expect(h.tx.activityRecord.update).not.toHaveBeenCalled();
  });
});
