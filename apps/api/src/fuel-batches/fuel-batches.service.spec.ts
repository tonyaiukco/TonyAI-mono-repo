import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { FuelBatch } from '@tonyai/db';
import type { RequestUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { ApiErrorCode } from '@tonyai/shared-types';
import { errorBody, errorCodeOf } from '../common/api-error';
import type { ActivityRecordsService } from '../activity-records/activity-records.service';
import type { EvidenceService } from '../evidence/evidence.service';
import type { PrismaService } from '../prisma/prisma.service';
import { FuelBatchesService } from './fuel-batches.service';
import { lockAuthorAccess } from '../central-reporting/record-entities';
import { deciderFor } from '../activity-records/record-approver';

// The author's standing re-read under lock is proven against the database
// (`test/int/fuel-batch-lifecycle.int.spec.ts`); here, only when it is asked.
vi.mock('../central-reporting/record-entities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../central-reporting/record-entities')>()),
  lockAuthorAccess: vi.fn(async () => null),
}));
// The decider as the record cores verify it: the request's user unless a test says otherwise.
vi.mock('../activity-records/record-approver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../activity-records/record-approver')>()),
  deciderFor: vi.fn(async (_tx: unknown, user: unknown) => user),
}));

/**
 * DB-free: the refusals the batch step owns (inc28-fuel-bulk D9; task 7.1) —
 * a batch no longer open, a submitter who is not its author, a decision
 * without the capability, a stale or missing submission, an empty return
 * reason, a batch or its record set changed since the read — and that a
 * refusal raised by a record's own core stops the step before the batch row
 * or its audit row is written. The record cores' own refusals (evidence,
 * variance reason, approver) are proven against the database in
 * `test/int/fuel-batch-lifecycle.int.spec.ts`.
 */

const ORG = '00000000-0000-4000-8000-0000000000aa';
const COMPANY = '00000000-0000-4000-8000-000000000001';
const BATCH = '00000000-0000-4000-8000-0000000000b1';
const AUTHOR = '00000000-0000-4000-8000-0000000000f1';
const SUBMITTED_AT = new Date('2026-11-20T10:00:00.000Z');

const user = (role: RequestUser['role'], id = AUTHOR): RequestUser => ({
  id,
  email: 'x@tonyai.test',
  fullName: 'X',
  role,
  organisationId: ORG,
  accessibleSubsidiaryIds: [COMPANY],
  categoryGrants: {},
});

const batchOf = (over: Partial<FuelBatch> = {}): FuelBatch =>
  ({
    id: BATCH,
    organisationId: ORG,
    subsidiaryId: COMPANY,
    category: 'Mobile Combustion',
    reportedBySubsidiaryId: null,
    status: 'draft',
    createdBy: AUTHOR,
    submittedAt: null,
    submissionCount: 0,
    reviewNote: null,
    ...over,
  }) as FuelBatch;

const record = (id: string) => ({
  id,
  subsidiaryId: COMPANY,
  reportingYear: 2025,
  reportingPeriod: 'monthly',
  periodValue: 'March',
  status: 'submitted',
  submittedAt: SUBMITTED_AT,
});

function harness(seen: FuelBatch, options: { locked?: FuelBatch; recordsNow?: string[]; recordRefusal?: Error; live?: string[] } = {}) {
  const seenRecords = (options.live ?? ['r1', 'r2']).map(record);
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: BATCH }]),
    $executeRaw: vi.fn(async () => 1),
    fuelBatch: {
      findUniqueOrThrow: vi.fn(async () => options.locked ?? seen),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...seen, ...data })),
    },
    activityRecord: {
      findMany: vi.fn(async () => (options.recordsNow ?? seenRecords.map((r) => r.id)).map((id) => ({ id }))),
    },
  };
  const prisma = {
    fuelBatch: { findFirst: vi.fn(async () => seen) },
    activityRecord: { findMany: vi.fn(async () => seenRecords) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const refuse = async () => {
    if (options.recordRefusal) throw options.recordRefusal;
  };
  const records = {
    lockSeenRecord: vi.fn(async (_tx: unknown, r: { id: string }) => ({ ...r, location: null })),
    recomputeFor: vi.fn(async () => ({})),
    submitLocked: vi.fn(refuse),
    recallLocked: vi.fn(refuse),
    startReviewLocked: vi.fn(refuse),
    approveLocked: vi.fn(refuse),
    rejectLocked: vi.fn(refuse),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new FuelBatchesService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    records as unknown as ActivityRecordsService,
    {} as EvidenceService,
  );
  vi.spyOn(service, 'detail').mockResolvedValue({ id: BATCH } as never);
  return { service, tx, prisma, records, audit };
}

const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => errorCodeOf(e) ?? (e as { getStatus?: () => number }).getStatus?.());

describe('FuelBatchesService — the step’s own refusals (task 7.1)', () => {
  it.each(['submitted', 'under_review', 'approved', 'withdrawn'])('refuses to submit a %s batch and writes nothing', async (status) => {
    const h = harness(batchOf({ status }));
    expect(await codeOf(h.service.submit(user('masterkey'), BATCH))).toBe('fuel_batch_not_open');
    expect(h.tx.fuelBatch.update).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
    expect(h.records.submitLocked).not.toHaveBeenCalled();
  });

  it('refuses a submit by anyone but the batch’s author, a masterkey included', async () => {
    const h = harness(batchOf());
    expect(await codeOf(h.service.submit(user('masterkey', '00000000-0000-4000-8000-0000000000f9'), BATCH))).toBe('record_submit_forbidden');
    expect(h.tx.fuelBatch.update).not.toHaveBeenCalled();
  });

  it('never moves a batch with no live record (every one voided), whatever the step', async () => {
    const approved = batchOf({ status: 'approved', submittedAt: SUBMITTED_AT, submissionCount: 1 });
    for (const step of [
      (h: ReturnType<typeof harness>) => h.service.startReview(user('super_admin', 'r'), BATCH, SUBMITTED_AT.toISOString()),
      (h: ReturnType<typeof harness>) => h.service.reject(user('super_admin', 'r'), BATCH, 'why', SUBMITTED_AT.toISOString()),
      (h: ReturnType<typeof harness>) => h.service.approve(user('super_admin', 'r'), BATCH, SUBMITTED_AT.toISOString()),
    ]) {
      const h = harness(approved, { live: [], recordsNow: [] });
      expect(await codeOf(step(h))).toBe('fuel_batch_not_open');
      expect(h.tx.fuelBatch.update).not.toHaveBeenCalled();
      expect(h.audit.record).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['review', 'approved'], ['review', 'under_review'], ['approve', 'approved'], ['reject', 'approved'], ['reject', 'draft'],
  ] as const)('refuses to %s a batch that is %s, before any record is touched', async (action, status) => {
    const h = harness(batchOf({ status, submittedAt: SUBMITTED_AT, submissionCount: 1 }));
    const reviewer = user('super_admin', 'r');
    const run = action === 'review'
      ? h.service.startReview(reviewer, BATCH, SUBMITTED_AT.toISOString())
      : action === 'approve'
        ? h.service.approve(reviewer, BATCH, SUBMITTED_AT.toISOString())
        : h.service.reject(reviewer, BATCH, 'why', SUBMITTED_AT.toISOString());
    expect(await codeOf(run)).toBe('record_changed');
    expect(h.records.startReviewLocked).not.toHaveBeenCalled();
    expect(h.records.approveLocked).not.toHaveBeenCalled();
    expect(h.records.rejectLocked).not.toHaveBeenCalled();
    expect(h.tx.fuelBatch.update).not.toHaveBeenCalled();
  });

  it('refuses a recall by anyone but the batch’s author, before any record is touched', async () => {
    const h = harness(batchOf({ status: 'submitted', submittedAt: SUBMITTED_AT, submissionCount: 1 }));
    expect(await codeOf(h.service.recall(user('masterkey', '00000000-0000-4000-8000-0000000000f9'), BATCH))).toBe('record_author_forbidden');
    expect(h.records.recallLocked).not.toHaveBeenCalled();
    expect(h.tx.fuelBatch.update).not.toHaveBeenCalled();
  });

  it.each(['standard_user', 'auditor'] as const)('refuses a %s any decision before reading the batch', async (role) => {
    const h = harness(batchOf({ status: 'submitted', submittedAt: SUBMITTED_AT }));
    for (const step of [
      h.service.startReview(user(role, 'f'), BATCH),
      h.service.approve(user(role, 'f'), BATCH, SUBMITTED_AT.toISOString()),
      h.service.reject(user(role, 'f'), BATCH, 'reason', SUBMITTED_AT.toISOString()),
    ]) {
      expect(await step.catch((e: unknown) => e)).toBeInstanceOf(ForbiddenException);
    }
    expect(h.prisma.fuelBatch.findFirst).not.toHaveBeenCalled();
  });

  it.each(['', '   ', '\n'])('refuses a return with the reason %j before reading the batch', async (reason) => {
    const h = harness(batchOf({ status: 'under_review', submittedAt: SUBMITTED_AT }));
    expect(await codeOf(h.service.reject(user('super_admin', 'r'), BATCH, reason, SUBMITTED_AT.toISOString()))).toBe('validation_failed');
    expect(h.prisma.fuelBatch.findFirst).not.toHaveBeenCalled();
  });

  it('refuses an approval or a return naming another submission, or none', async () => {
    const seen = batchOf({ status: 'under_review', submittedAt: SUBMITTED_AT, submissionCount: 1 });
    for (const stale of ['2026-11-19T10:00:00.000Z', null, undefined]) {
      const h = harness(seen);
      expect(await codeOf(h.service.approve(user('super_admin', 'r'), BATCH, stale))).toBe('record_changed');
      expect(await codeOf(h.service.reject(user('super_admin', 'r'), BATCH, 'why', stale))).toBe('record_changed');
      expect(h.tx.fuelBatch.update).not.toHaveBeenCalled();
      expect(h.records.approveLocked).not.toHaveBeenCalled();
    }
  });

  it('refuses a step when the batch moved between the read and the lock (recalled and resubmitted)', async () => {
    const seen = batchOf({ status: 'submitted', submittedAt: SUBMITTED_AT, submissionCount: 1 });
    const h = harness(seen, { locked: batchOf({ status: 'submitted', submittedAt: new Date(), submissionCount: 2 }) });
    expect(await codeOf(h.service.approve(user('super_admin', 'r'), BATCH, SUBMITTED_AT.toISOString()))).toBe('record_changed');
    expect(h.records.approveLocked).not.toHaveBeenCalled();
  });

  it('refuses a step when a record was added to or removed from the batch since the read', async () => {
    for (const now of [['r1'], ['r1', 'r2', 'r3']]) {
      const h = harness(batchOf(), { recordsNow: now });
      expect(await codeOf(h.service.submit(user('masterkey'), BATCH))).toBe('record_changed');
      expect(h.records.submitLocked).not.toHaveBeenCalled();
      expect(h.tx.fuelBatch.update).not.toHaveBeenCalled();
    }
  });

  it.each<[ApiErrorCode, number]>([
    ['not_record_approver', 403],
    ['evidence_required', 409],
    ['variance_reason_required', 422],
  ])('lets a record core’s %s stop the step before the batch row and its audit row', async (code, status) => {
    const refusal = Object.assign(new Error(code), { getResponse: () => errorBody(code, code), getStatus: () => status });
    const h = harness(batchOf({ status: 'submitted', submittedAt: SUBMITTED_AT, submissionCount: 1 }), { recordRefusal: refusal });
    expect(await h.service.approve(user('masterkey', 'm'), BATCH, SUBMITTED_AT.toISOString()).catch((e: unknown) => e)).toBe(refusal);
    expect(h.tx.fuelBatch.update).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('records a masterkey’s approval of a batch it formed as a self-approval, and another’s as an approval', async () => {
    const pending = batchOf({ status: 'submitted', submittedAt: SUBMITTED_AT, submissionCount: 1 });
    const own = harness(pending);
    await own.service.approve(user('masterkey', AUTHOR), BATCH, SUBMITTED_AT.toISOString());
    expect(own.audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'self_approve', entity: 'fuel_batch' }), own.tx);
    const other = harness(pending);
    await other.service.approve(user('super_admin', 'r'), BATCH, SUBMITTED_AT.toISOString());
    expect(other.audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'approve' }), other.tx);
  });
});

describe('FuelBatchesService — the author’s standing at the write (WP9 PR B review, P1)', () => {
  it('refuses an author since made an auditor before reading anything: submit, recall, declarations, withdraw', async () => {
    const h = harness(batchOf());
    const auditor = user('auditor');
    expect(await codeOf(h.service.submit(auditor, BATCH))).toBe('record_submit_forbidden');
    expect(await codeOf(h.service.recall(auditor, BATCH))).toBe(403);
    expect(await codeOf(h.service.changeDeclarations(auditor, BATCH, { usage: 'on_road' }))).toBe(403);
    expect(await codeOf(h.service.withdraw(auditor, BATCH, 'why'))).toBe(403);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.prisma.fuelBatch.findFirst).not.toHaveBeenCalled();
  });

  it('re-reads the author’s access to the batch’s company and category inside submit and recall, never inside a decision', async () => {
    vi.mocked(lockAuthorAccess).mockClear();
    const h = harness(batchOf());
    expect(await codeOf(h.service.submit(user('standard_user'), BATCH))).toBe('ok');
    expect(lockAuthorAccess).toHaveBeenCalledWith(h.tx, user('standard_user'), COMPANY, 'Mobile Combustion', 'edit');
    const submitted = batchOf({ status: 'submitted', submittedAt: SUBMITTED_AT, submissionCount: 1 });
    vi.mocked(lockAuthorAccess).mockClear();
    expect(await codeOf(harness(submitted).service.recall(user('standard_user'), BATCH))).toBe('ok');
    expect(lockAuthorAccess).toHaveBeenCalledTimes(1);
    vi.mocked(lockAuthorAccess).mockClear();
    expect(await codeOf(harness(submitted).service.startReview(user('super_admin', 'r'), BATCH, SUBMITTED_AT.toISOString()))).toBe('ok');
    expect(lockAuthorAccess).not.toHaveBeenCalled();
  });

  it('stops the step when the re-read refuses (a grant withdrawn since the request): no record, batch or audit row moves', async () => {
    vi.mocked(lockAuthorAccess).mockRejectedValueOnce(new ForbiddenException('Your role may not modify activity records'));
    const h = harness(batchOf());
    expect(await codeOf(h.service.submit(user('standard_user'), BATCH))).toBe(403);
    expect(h.records.submitLocked).not.toHaveBeenCalled();
    expect(h.tx.fuelBatch.update).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });
});

describe('taking a batch into review names the submission shown (WP9 PR B review, P2)', () => {
  it('refuses a review that names no submission, or another one, and moves nothing', async () => {
    const submitted = batchOf({ status: 'submitted', submittedAt: SUBMITTED_AT, submissionCount: 1 });
    for (const seen of [undefined, '2026-11-19T10:00:00.000Z']) {
      const h = harness(submitted);
      expect(await codeOf(h.service.startReview(user('super_admin', 'r'), BATCH, seen))).toBe('record_changed');
      expect(h.records.startReviewLocked).not.toHaveBeenCalled();
      expect(h.tx.fuelBatch.update).not.toHaveBeenCalled();
    }
  });
});

describe('a tanker declaration change is audited whole (WP9 PR B review, P2)', () => {
  it('names the fuel, usage, year and month before and after, the unchanged ones included', async () => {
    const h = harness(batchOf({ source: 'tanker', usage: 'stationary' } as Partial<FuelBatch>));
    (h.tx as Record<string, unknown>).$queryRaw = vi.fn(async (strings: unknown) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      return sql.includes('DISTINCT fuel') ? [{ fuel: 'diesel', year: 2025, month: 3 }] : [{ id: BATCH }];
    });
    (h.tx as Record<string, unknown>).fuelRow = { updateMany: vi.fn(async () => ({ count: 1 })) };
    vi.spyOn(h.service as unknown as { rebuild: () => Promise<unknown[]> }, 'rebuild').mockResolvedValue([]);
    await h.service.changeDeclarations(user('standard_user'), BATCH, { usage: 'stationary', month: 4 });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      {
        action: 'update',
        entity: 'fuel_batch',
        entityId: BATCH,
        diff: {
          declarations: {
            before: { usage: 'stationary', fuel: 'diesel', year: 2025, month: 3 },
            after: { usage: 'stationary', fuel: 'diesel', year: 2025, month: 4 },
          },
        },
      },
      h.tx,
    );
  });
});

describe('a batch decision’s audit row names the verified decider (second review of the branch, P2)', () => {
  it('stamps the role the record cores verified in the transaction, not the request’s', async () => {
    const submitted = batchOf({ status: 'submitted', submittedAt: SUBMITTED_AT, submissionCount: 1, createdBy: 'someone-else' });
    const h = harness(submitted);
    const requested = user('masterkey', 'r');
    vi.mocked(deciderFor).mockImplementationOnce(async (_tx, u) => ({ ...u, role: 'super_admin' }));
    await h.service.approve(requested, BATCH, SUBMITTED_AT.toISOString());
    expect(deciderFor).toHaveBeenCalledWith(h.tx, requested, { createdBy: 'someone-else', subsidiaryId: COMPANY }, 'approve');
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ role: 'super_admin' }), expect.objectContaining({ action: 'approve' }), h.tx);
  });
});

describe('a decision holds its decider’s profile for the whole step (third review of the branch, P2)', () => {
  const sqlOf = (call: unknown[]) => (Array.isArray(call[0]) ? (call[0] as string[]).join('?') : String(call[0]));
  it('locks the decider’s profile row before the records are decided, and an author’s step does not', async () => {
    const submitted = batchOf({ status: 'submitted', submittedAt: SUBMITTED_AT, submissionCount: 1, createdBy: 'someone-else' });
    const h = harness(submitted);
    await h.service.approve(user('super_admin', 'r'), BATCH, SUBMITTED_AT.toISOString());
    const calls = h.tx.$queryRaw.mock.calls.map((c) => sqlOf(c as unknown[]));
    const profileLock = calls.findIndex((sql) => /FROM profiles .*FOR SHARE/s.test(sql));
    expect(profileLock).toBeGreaterThan(-1);
    expect(h.records.lockSeenRecord.mock.invocationCallOrder[0]!).toBeGreaterThan(h.tx.$queryRaw.mock.invocationCallOrder[profileLock]!);
    const author = harness(batchOf());
    await author.service.submit(user('standard_user'), BATCH);
    expect(author.tx.$queryRaw.mock.calls.map((c) => sqlOf(c as unknown[])).some((sql) => /FROM profiles/.test(sql))).toBe(false);
  });
});

describe('a bulk submit takes its outcome from the step’s commit (fourth review of the branch, P2)', () => {
  it('reports a committed batch as submitted even when reading it afterwards would fail, and never reads it', async () => {
    const h = harness(batchOf());
    const detail = vi.spyOn(h.service, 'detail').mockRejectedValue(new Error('read failed'));
    const out = await h.service.bulkSubmit(user('standard_user'), [BATCH]);
    expect(out).toEqual({ submitted: [BATCH], failed: [] });
    expect(h.tx.fuelBatch.update).toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
  });
});
