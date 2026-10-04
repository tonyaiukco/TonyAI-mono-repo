import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ActivityRecordStatus } from '@tonyai/db';
import { RecordChangedError } from '../../src/activity-records/errors';
import { ActivityRecordsService } from '../../src/activity-records/activity-records.service';
import { AuditService } from '../../src/audit/audit.service';
import { CalculationsService } from '../../src/calculations/calculations.service';
import { INT_FACTOR_POLICY } from './services';
import type { EvidenceService } from '../../src/evidence/evidence.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  backendPid,
  connect,
  createRecord,
  createTenant,
  holdBefore,
  settledOrBlocked,
  type Tenant,
} from './db';

/**
 * F03 (Part C): a late `startReview` could regress an approval.
 *
 * Before LP1-01 both methods read the record, checked its status in memory,
 * then wrote on the id alone, so a consultant's `startReview` that read
 * `submitted` and was then overtaken by a super_admin's `approve` still wrote
 * `under_review` over the approval — and the audit trail recorded two
 * transitions out of `submitted` (reproduced in LP0-03, where this file held
 * the requirement as `it.fails` beside a pin of that behaviour).
 *
 * Under the lifecycle protocol the first writer holds the record's row lock,
 * so the second waits, then re-checks against what the first committed: the
 * approval goes ahead from `under_review`, and a startReview arriving after
 * an approval is refused as a lost race.
 */

function makeService(prisma: PrismaService): ActivityRecordsService {
  // startReview/approve never touch evidence.
  return new ActivityRecordsService(
    prisma,
    new CalculationsService(prisma, INT_FACTOR_POLICY),
    new AuditService(prisma),
    {} as EvidenceService,
  );
}

let a: PrismaService;
let b: PrismaService;
let observer: PrismaService;
let tenant: Tenant;

beforeAll(() => {
  a = connect();
  b = connect();
  observer = connect();
});

afterAll(async () => {
  await Promise.all([a, b, observer].map((c) => c.$disconnect()));
});

beforeEach(async () => {
  tenant = await createTenant();
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
  const rows = await observer.auditLog.findMany({
    where: { entity: 'activity_record', entityId: recordId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => {
    const t = (row.diff as { transition: { from: string; to: string } }).transition;
    return { from: t.from, to: t.to, userId: row.userId };
  });
}

/**
 * Follows the transitions from `start`, consuming each edge once. Returns the
 * end state, or null when an edge is left over or two edges leave one state —
 * i.e. when the trail is not a single chain.
 */
function chainEnd(transitions: Transition[], start: string): string | null {
  const remaining = [...transitions];
  let state = start;
  while (remaining.length > 0) {
    const next = remaining.filter((t) => t.from === state);
    if (next.length !== 1) return null;
    remaining.splice(remaining.indexOf(next[0]), 1);
    state = next[0].to;
  }
  return state;
}

/**
 * Consultant A reads a submitted record and is held just before its write;
 * super_admin B approves the record; then A is released. If B blocks on a lock
 * A holds, A is released as soon as that is observed.
 */
async function interleaveStartReviewWithApprove() {
  const record = await createRecord(a, tenant, {
    status: ActivityRecordStatus.submitted,
    submittedAt: new Date(),
  });
  // Both write shapes a fix might use: `update`, or `updateMany` with the
  // expected status in its WHERE.
  const hold = holdBefore(a, 'ActivityRecord', ['update', 'updateMany']);
  const pidB = await backendPid(b);

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
  const how = await settledOrBlocked(approve, pidB, observer);
  hold.release();

  const outcomes = { startReview: await startReviewOutcome, approve: await approveOutcome };
  const final = await observer.activityRecord.findUniqueOrThrow({ where: { id: record.id } });
  return { outcomes, how, finalStatus: final.status, transitions: await transitionsOf(record.id) };
}

/** The other order: super_admin A's approve is held before its write; consultant B starts review. */
async function interleaveApproveWithStartReview() {
  const record = await createRecord(a, tenant, {
    status: ActivityRecordStatus.submitted,
    submittedAt: new Date(),
  });
  const hold = holdBefore(a, 'ActivityRecord', ['update', 'updateMany']);
  const pidB = await backendPid(b);

  const approveOutcome = makeService(hold.client)
    .approve(tenant.users.superAdmin, record.id)
    .then(() => 'ok' as const, (err: unknown) => err);
  await hold.reached();

  const startReview = makeService(b).startReview(tenant.users.consultant, record.id);
  const startReviewOutcome = startReview.then(() => 'ok' as const, (err: unknown) => err);
  const how = await settledOrBlocked(startReview, pidB, observer);
  hold.release();

  const outcomes = { startReview: await startReviewOutcome, approve: await approveOutcome };
  const final = await observer.activityRecord.findUniqueOrThrow({ where: { id: record.id } });
  return { outcomes, how, finalStatus: final.status, transitions: await transitionsOf(record.id) };
}

describe('F03 — startReview racing approve', () => {
  it('an overtaken startReview cannot regress an approval', async () => {
    const { outcomes, how, finalStatus, transitions } = await interleaveStartReviewWithApprove();

    // The approve waited for the held startReview's row lock.
    expect(how).toBe('blocked');

    // Every serial order of these two calls ends approved: review-then-approve,
    // or approve-then-(refused)-review.
    expect(outcomes.approve).toBe('ok');
    expect(finalStatus).toBe(ActivityRecordStatus.approved);

    // The losing startReview, if refused, is refused as a client error (the
    // contract LP1-01 settles), never a raw database error surfacing as a 500.
    const review = outcomes.startReview;
    expect(
      review === 'ok' || review instanceof ConflictException || review instanceof BadRequestException,
    ).toBe(true);

    // The trail is one chain from `submitted` to the final state: no
    // transition was written from a state the record had already left.
    // Rebuilt from the edges, not from `created_at` order (millisecond
    // precision, so two rows can tie).
    expect(chainEnd(transitions, ActivityRecordStatus.submitted)).toBe(finalStatus);

    // One audit row per successful call, none for a refused one.
    const succeeded = Object.values(outcomes).filter((o) => o === 'ok').length;
    expect(transitions).toHaveLength(succeeded);
  });

  it('a startReview arriving after an approval is refused as a lost race', async () => {
    const { outcomes, how, finalStatus, transitions } = await interleaveApproveWithStartReview();

    expect(how).toBe('blocked');
    expect(outcomes.approve).toBe('ok');
    expect(outcomes.startReview).toBeInstanceOf(RecordChangedError);
    expect(finalStatus).toBe(ActivityRecordStatus.approved);
    expect(transitions).toEqual([
      { from: 'submitted', to: 'approved', userId: tenant.users.superAdmin.id },
    ]);
  });
});
