import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { ActivityRecordsService } from '../activity-records/activity-records.service';
import { CategoryNotGrantedError } from '../activity-records/record-scope';
import {
  ActivityTypeSlotConflictError,
  EntityClosedToDataEntryError,
  PeriodLockedError,
} from '../activity-records/errors';
import { SingleEntryPeriodConflictError } from '../central-reporting/central-reporting-errors';
import { NoEmissionFactorError } from '../calculations/errors';
import type { FuelUploadsService } from '../fuel-files/fuel-uploads.service';
import type { PrismaService } from '../prisma/prisma.service';
import { FuelBatchFormationService, GroupHeld, holdReasonOf } from './fuel-batch-formation.service';

/**
 * DB-free: what one forming step builds per group (inc28-fuel-bulk D8, D13;
 * task 6.3) — a shared invoice split per account, a Shell half-month and a
 * tanker delivery each their own batch, one record per fuel and month whose
 * quantity is the rows' sum, the invoice number only where the source has
 * one — and that a refused record ends the group's transaction by throwing
 * (so nothing of it is kept) and holds its rows with the reason. The stored
 * side is `test/int/fuel-batch-formation.int.spec.ts`.
 */

const ORG = '00000000-0000-4000-8000-0000000000aa';
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const UPLOAD = '00000000-0000-4000-8000-0000000000c1';

const holder: RequestUser = {
  id: '00000000-0000-4000-8000-0000000000f1',
  email: 'x@tonyai.test',
  fullName: 'X',
  role: 'masterkey',
  organisationId: ORG,
  accessibleSubsidiaryIds: [A, B],
  categoryGrants: {},
};

interface Row { id: string; fuel: string; year: number; month: number; litres: string; subsidiary_id: string }
interface Group { account_id: string; invoice_ref: string; usage: string; company: string; rows: Row[] }

const sqlOf = (strings: TemplateStringsArray | unknown) => (Array.isArray(strings) ? (strings as string[]).join('?') : String(strings));

function harness(source: string, groups: Group[], options: { refuse?: Error; open?: boolean } = {}) {
  const created: Array<{ batch: Record<string, unknown>; records: Array<Record<string, unknown>> }> = [];
  const holds: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const audits: unknown[] = [];
  let current: Group;
  const tx = {
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => 1),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = sqlOf(strings);
      if (sql.includes('FROM fuel_accounts')) return [{ state: 'confirmed', subsidiary_id: current.company }];
      if (sql.includes('FROM fuel_rows') && sql.includes('FOR UPDATE')) return current.rows;
      if (sql.includes("status IN ('draft', 'rejected')")) return options.open ? [{ id: 'b-open', status: 'draft' }] : [];
      if (sql.includes('fuel_batch_id =') && sql.includes("state = 'assigned'")) return options.open ? [{ fuel: 'diesel', year: 2025, month: 3, litres: '100' }] : [];
      if (sql.includes('max(sequence)')) return [{ next: 1 }];
      return [];
    }),
    fuelBatch: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push({ batch: data, records: [] });
        return data;
      }),
    },
    activityRecord: {
      findMany: vi.fn(async () =>
        options.open ? [{ id: 'rec-1', activityType: 'on_road_diesel', reportingYear: 2025, periodValue: 'March', status: 'draft' }] : []),
    },
  };
  const prisma = {
    fuelRow: {
      count: vi.fn(async () => 1),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        holds.push(args);
        return { count: 1 };
      }),
    },
    $queryRaw: vi.fn(async () => groups.map(({ account_id, invoice_ref, usage }) => ({ account_id, invoice_ref, usage }))),
    // The hold after a refusal: one statement, the judged ids as one array.
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (sqlOf(strings).includes("state = 'held'")) {
        holds.push({
          where: { id: values[1], importBatchId: values[2], holderId: values[3], subsidiaryId: values[4] },
          data: { state: 'held', holdReason: values[0] },
        });
      }
      return 1;
    }),
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      current = groups[(prisma.$transaction.mock.calls.length - 1) % groups.length]!;
      return fn(tx);
    }),
  };
  const records = {
    previewCreate: vi.fn(async () => ({ prepared: true })),
    createInTransaction: vi.fn(async (_tx: unknown, _user: unknown, dto: Record<string, unknown>) => {
      if (options.refuse) throw options.refuse;
      (created.at(-1) ?? created[created.push({ batch: {}, records: [] }) - 1]!).records.push(dto);
    }),
    createRefusal: vi.fn((error: unknown) => error),
    lockSeenRecord: vi.fn(async (_tx: unknown, r: unknown) => r),
    updateBatchQuantityLocked: vi.fn(async () => undefined),
  };
  const uploads = {
    visibleUpload: vi.fn(async () => ({ id: UPLOAD, source })),
    detail: vi.fn(async () => ({
      processableRows: 0,
      held: [],
      rows: { waiting_account: { rows: 0, litres: '0' }, waiting_fuel: { rows: 0, litres: '0' } },
    })),
  };
  const audit = { record: vi.fn(async (...args: unknown[]) => void audits.push(args)) };
  const service = new FuelBatchFormationService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    records as unknown as ActivityRecordsService,
    uploads as unknown as FuelUploadsService,
  );
  return { service, created, holds, audits, tx, records };
}

const row = (id: string, fuel: string, month: number, litres: string, company = A): Row => ({ id, fuel, year: 2025, month, litres, subsidiary_id: company });

describe('FuelBatchFormationService — one group, one batch (task 6.3)', () => {
  it('splits a shared invoice per account: each batch owned by its account’s company, records by fuel and month', async () => {
    const h = harness('petrol_ofisi', [
      { account_id: 'acc-a', invoice_ref: 'OZK-1', usage: 'on_road', company: A, rows: [row('1', 'diesel', 3, '300.50'), row('2', 'diesel', 3, '299.50'), row('3', 'petrol', 3, '69.38')] },
      { account_id: 'acc-b', invoice_ref: 'OZK-1', usage: 'on_road', company: B, rows: [row('4', 'diesel', 3, '10.00', B)] },
    ]);
    expect(await h.service.formBatches(holder, UPLOAD)).toMatchObject({ formedBatches: 2, joinedBatches: 0 });
    expect(h.created.map((c) => [c.batch.fuelAccountId, c.batch.subsidiaryId, c.batch.invoiceRef, c.batch.sequence, c.batch.category])).toEqual([
      ['acc-a', A, 'OZK-1', 1, 'Mobile Combustion'],
      ['acc-b', B, 'OZK-1', 1, 'Mobile Combustion'],
    ]);
    expect(h.created[0]!.records.map((r) => [r.activityType, r.activityValue, r.periodValue, r.input])).toEqual([
      ['on_road_diesel', 600, 'March', { invoice_no: 'OZK-1' }],
      ['on_road_petrol', 69.38, 'March', { invoice_no: 'OZK-1' }],
    ]);
    expect(h.created[1]!.records.map((r) => [r.subsidiaryId, r.activityValue])).toEqual([[B, 10]]);
    expect(h.audits).toHaveLength(2);
  });

  it('forms a Shell half-month as its own batch, with no invoice number on its records', async () => {
    const h = harness('shell', [
      { account_id: 'acc-s', invoice_ref: '2025-03-H1', usage: 'on_road', company: A, rows: [row('1', 'diesel', 3, '50.00')] },
      { account_id: 'acc-s', invoice_ref: '2025-03-H2', usage: 'on_road', company: A, rows: [row('2', 'diesel', 3, '70.00')] },
    ]);
    expect(await h.service.formBatches(holder, UPLOAD)).toMatchObject({ formedBatches: 2 });
    expect(h.created.map((c) => c.batch.invoiceRef)).toEqual(['2025-03-H1', '2025-03-H2']);
    for (const c of h.created) expect(c.records.every((r) => r.input === undefined)).toBe(true);
  });

  it('forms a stationary tanker delivery as a Fuel batch whose record is the delivery’s fuel and month', async () => {
    const h = harness('tanker', [
      { account_id: 'acc-t', invoice_ref: 'IRS-7', usage: 'stationary', company: A, rows: [row('1', 'diesel', 4, '1168.00')] },
    ]);
    await h.service.formBatches(holder, UPLOAD);
    expect(h.created[0]!.batch).toMatchObject({ usage: 'stationary', category: 'Fuel', source: 'tanker' });
    expect(h.created[0]!.records.map((r) => [r.category, r.activityType, r.activityValue, r.periodValue])).toEqual([
      ['Fuel', 'diesel', 1168, 'April'],
    ]);
  });

  it('holds a group outside the holder’s scope without trying a record', async () => {
    const h = harness('petrol_ofisi', [
      { account_id: 'acc-b', invoice_ref: 'OZK-2', usage: 'on_road', company: B, rows: [row('1', 'diesel', 3, '10.00', B)] },
    ]);
    const result = await h.service.formBatches({ ...holder, accessibleSubsidiaryIds: [A] }, UPLOAD);
    expect(result.formedBatches).toBe(0);
    expect(h.records.createInTransaction).not.toHaveBeenCalled();
    expect(h.holds.map((x) => x.data)).toEqual([{ state: 'held', holdReason: 'fuel_out_of_scope' }]);
  });

  it('throws a refused record out of the group’s transaction — no row link, no audit — and holds its rows with the reason', async () => {
    const h = harness(
      'petrol_ofisi',
      [{ account_id: 'acc-a', invoice_ref: 'OZK-3', usage: 'on_road', company: A, rows: [row('1', 'diesel', 3, '10.00')] }],
      { refuse: Object.create(PeriodLockedError.prototype) as Error },
    );
    const result = await h.service.formBatches(holder, UPLOAD);
    expect(result.formedBatches).toBe(0);
    // The rows' link to the batch is the step's last write; it never ran, nor the audit row.
    expect(h.tx.$executeRaw.mock.calls.some(([s]) => sqlOf(s).includes('UPDATE fuel_rows'))).toBe(false);
    expect(h.audits).toHaveLength(0);
    expect(h.holds).toEqual([
      {
        // Only the rows the refused transaction judged, under the company it judged them under (fourth review, P2).
        where: { id: ['1'], importBatchId: UPLOAD, holderId: holder.id, subsidiaryId: A },
        data: { state: 'held', holdReason: 'period_locked' },
      },
    ]);
  });

  it('joins an open batch with every period locked shared before any record row is locked', async () => {
    const h = harness(
      'petrol_ofisi',
      [{ account_id: 'acc-a', invoice_ref: 'OZK-J', usage: 'on_road', company: A, rows: [row('1', 'diesel', 3, '50'), row('2', 'diesel', 4, '20')] }],
      { open: true },
    );
    const out = await h.service.formBatches(holder, UPLOAD);
    expect(h.holds).toEqual([]);
    expect(out).toMatchObject({ formedBatches: 0, joinedBatches: 1 });
    // March's record grows by the joining row; April's is new.
    expect(h.records.updateBatchQuantityLocked).toHaveBeenCalledWith(h.tx, holder, expect.objectContaining({ id: 'rec-1' }), 150);
    expect(h.records.createInTransaction).toHaveBeenCalledTimes(1);
    const periodLocks = h.tx.$executeRaw.mock.calls
      .map((call, i) => ({ sql: sqlOf(call[0]), order: h.tx.$executeRaw.mock.invocationCallOrder[i]! }))
      .filter((c) => c.sql.includes('pg_advisory_xact_lock_shared'));
    expect(periodLocks).toHaveLength(2);
    const firstRowLock = h.records.lockSeenRecord.mock.invocationCallOrder[0]!;
    expect(periodLocks.every((l) => l.order < firstRowLock)).toBe(true);
  });

  it('refuses a caller who holds none of the upload’s rows', async () => {
    const h = harness('petrol_ofisi', []);
    (h.service as unknown as { prisma: { fuelRow: { count: () => Promise<number> } } }).prisma.fuelRow.count = async () => 0;
    expect(await h.service.formBatches(holder, UPLOAD).catch((e: unknown) => e)).toBeInstanceOf(ForbiddenException);
  });
});

describe('holdReasonOf — a record refusal as the rows’ hold reason (D8 row 6)', () => {
  it.each([
    [new GroupHeld('fuel_out_of_scope'), 'fuel_out_of_scope'],
    [new NoEmissionFactorError('x' as never), 'no_factor'],
    [Object.create(PeriodLockedError.prototype), 'period_locked'],
    [Object.create(EntityClosedToDataEntryError.prototype), 'entity_closed_to_data_entry'],
    [Object.create(SingleEntryPeriodConflictError.prototype), 'single_entry_period_conflict'],
    [Object.create(CategoryNotGrantedError.prototype), 'category_not_granted'],
    [Object.create(ActivityTypeSlotConflictError.prototype), 'slot_holds_untyped'],
    [new NotFoundException(), 'fuel_out_of_scope'],
    [new ForbiddenException(), 'fuel_out_of_scope'],
    [new Error('boom'), 'unexpected'],
  ])('%#: answers %s', (error, reason) => {
    expect(holdReasonOf(error)).toBe(reason);
  });
});

describe('FuelBatchFormationService — a refusal before any row was read (fifth review of the branch, P2)', () => {
  it('holds nothing when the group failed before judging a row, so its rows stay ready', async () => {
    const h = harness('petrol_ofisi', [{ account_id: 'acc-a', invoice_ref: 'OZK-T', usage: 'on_road', company: A, rows: [row('1', 'diesel', 3, '10.00')] }]);
    // The advisory lock times out: nothing was read.
    h.tx.$executeRaw.mockRejectedValueOnce(new Error('lock timeout'));
    await h.service.formBatches(holder, UPLOAD);
    expect(h.holds).toEqual([]);
  });
});
