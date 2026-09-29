import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus } from '@tonyai/db';
import { ActivityRecordsService } from '../../src/activity-records/activity-records.service';
import { AuditService } from '../../src/audit/audit.service';
import { CalculationsService } from '../../src/calculations/calculations.service';
import type { EvidenceService } from '../../src/evidence/evidence.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  connect,
  createRecord,
  createTenant,
  holdBefore,
  settledOrBlocked,
  type Tenant,
} from './db';

/**
 * F03 (Part C): a late `startReview` can regress an approval.
 *
 * Both methods read the record, check its status in memory, then write on the
 * id alone (`transition()` puts the expected status in the WHERE only for a
 * void). So a consultant's `startReview` that read `submitted` and is then
 * overtaken by a super_admin's `approve` still writes `under_review` over the
 * approval — and the audit trail records two transitions out of `submitted`.
 *
 * The first test states the required behaviour and is an EXPECTED FAILURE on
 * current code. The second pins what current code actually does, so the first
 * cannot "pass" through a harness fault. LP1-01 fixes the race, deletes the
 * second test and turns the first into a plain `it`.
 */

function makeService(prisma: PrismaService): ActivityRecordsService {
  // startReview/approve/transition never touch evidence.
  return new ActivityRecordsService(
    prisma,
    new CalculationsService(prisma),
    new AuditService(prisma),
    {} as EvidenceService,
  );
}

let a: PrismaService;
let b: PrismaService;
let tenant: Tenant;

beforeAll(() => {
  a = connect();
  b = connect();
});

afterAll(async () => {
  await a.$disconnect();
  await b.$disconnect();
});

beforeEach(async () => {
  tenant = await createTenant(a);
});

afterEach(async () => {
  await tenant.cleanup();
});

interface Transition {
  from: string;
  to: string;
  userId: string | null;
}

async function transitionsOf(recordId: string): Promise<Transition[]> {
  const rows = await b.auditLog.findMany({
    where: { entity: 'activity_record', entityId: recordId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => {
    const t = (row.diff as { transition: { from: string; to: string } }).transition;
    return { from: t.from, to: t.to, userId: row.userId };
  });
}

/**
 * Consultant A reads a submitted record and is held just before its write;
 * super_admin B approves the record; then A is released. If B blocks on a lock
 * A holds (a row-locking fix), A is released as soon as that is observed.
 */
async function interleaveStartReviewWithApprove() {
  const record = await createRecord(a, tenant, {
    status: ActivityRecordStatus.submitted,
    submittedAt: new Date(),
  });
  const hold = holdBefore(a, 'ActivityRecord', 'update');

  const startReview = makeService(hold.client).startReview(tenant.users.consultant, record.id);
  const startReviewOutcome = startReview.then(
    () => 'ok' as const,
    (err: unknown) => err,
  );
  await hold.reached();

  const approve = makeService(b).approve(tenant.users.superAdmin, record.id);
  const approveOutcome = approve.then(
    () => 'ok' as const,
    (err: unknown) => err,
  );
  await settledOrBlocked(approve, b);
  hold.release();

  const outcomes = { startReview: await startReviewOutcome, approve: await approveOutcome };
  const final = await b.activityRecord.findUniqueOrThrow({ where: { id: record.id } });
  return { outcomes, finalStatus: final.status, transitions: await transitionsOf(record.id) };
}

describe('F03 — startReview racing approve', () => {
  it.fails('an overtaken startReview cannot regress an approval (expected failure until LP1-01)', async () => {
    const { outcomes, finalStatus, transitions } = await interleaveStartReviewWithApprove();

    // Every serial order of these two calls ends approved: review-then-approve,
    // or approve-then-(refused)-review.
    expect(outcomes.approve).toBe('ok');
    expect(finalStatus).toBe(ActivityRecordStatus.approved);

    // The trail is one chain from `submitted` to the final state: no
    // transition was written from a state the record had already left.
    expect(transitions[0]?.from).toBe(ActivityRecordStatus.submitted);
    for (let i = 1; i < transitions.length; i++) {
      expect(transitions[i].from).toBe(transitions[i - 1].to);
    }
    expect(transitions.at(-1)?.to).toBe(finalStatus);

    // One audit row per successful call, none for a refused one.
    const succeeded = Object.values(outcomes).filter((o) => o === 'ok').length;
    expect(transitions).toHaveLength(succeeded);
  });

  it('current code: the late startReview overwrites the approval (F03 reproduced — LP1-01 deletes this test)', async () => {
    const { outcomes, finalStatus, transitions } = await interleaveStartReviewWithApprove();

    expect(outcomes).toEqual({ startReview: 'ok', approve: 'ok' });
    expect(finalStatus).toBe(ActivityRecordStatus.under_review);
    expect(transitions).toEqual([
      { from: 'submitted', to: 'approved', userId: tenant.users.superAdmin.id },
      { from: 'submitted', to: 'under_review', userId: tenant.users.consultant.id },
    ]);
  });
});
