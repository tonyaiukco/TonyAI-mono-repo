import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { ActivityRecordStatus, UserRole } from '@tonyai/db';
import {
  SelfApprovalRefusedError,
  SelfReviewRefusedError,
  SubmitAuthorRefusedError,
} from '../../src/activity-records/errors';
import type { RequestUser } from '../../src/auth/auth.types';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { addMember, attachEvidence, connect, connectOwner, createRecord, createTenant, type Tenant } from './db';
import { lifecycleServices, pdfFile } from './services';

/**
 * The LP0-02 workflow decisions LP1-01 implements (Decisions log, 2026-09-29),
 * through the real services and the real database: D01 segregation of duties,
 * D02 only the author submits, D03 no lock over a rejected record, and D04 the
 * pilot correction procedure (unlock → void → re-entry).
 */

let prisma: PrismaService;
/** Fixtures (profiles, grants, invitations) and audit reads are the owner's. */
let owner: PrismaService;
let tenant: Tenant;
let s: ReturnType<typeof lifecycleServices>;

beforeAll(() => {
  prisma = connect();
  owner = connectOwner();
  s = lifecycleServices(prisma);
});

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), owner.$disconnect()]);
});

beforeEach(async () => {
  tenant = await createTenant();
});

afterEach(async () => {
  await tenant.cleanup();
});

const january = { reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'January' } as const;

async function statusOf(id: string) {
  return (await prisma.activityRecord.findUniqueOrThrow({ where: { id } })).status;
}

const failure = (p: Promise<unknown>) => p.then(() => null, (err: unknown) => err);
const responseOf = (err: unknown) => (err instanceof HttpException ? err.getResponse() : err);

/** The decision rows of a record: [action, user, role]. */
async function decisionRows(recordId: string) {
  const rows = await owner.auditLog.findMany({
    where: { entityId: recordId, action: { in: ['review', 'reject', 'approve', 'self_approve'] } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => [r.action, r.userId, r.role]);
}

/**
 * A submitted, priced record with its invoice, by `author`, in `subsidiaryId`
 * (the tenant's granted company by default), and the submission it carries.
 */
async function pending(author: RequestUser, subsidiaryId = tenant.subsidiaryId, periodValue = 'January') {
  const company = { ...tenant, subsidiaryId };
  const record = await createRecord(
    prisma,
    company,
    { createdBy: author.id, periodValue, status: ActivityRecordStatus.submitted, submittedAt: new Date() },
    { priced: true },
  );
  await attachEvidence(prisma, company, [record.id]);
  return { record, seen: record.submittedAt!.toISOString() };
}

/**
 * A role change as `setRole` leaves it — the same id, the new role, every
 * grant withdrawn — and, for a granted role, the tenant's company granted
 * again (as the masterkey would). Returns the user as the guard now builds it.
 */
async function promote(user: RequestUser, role: UserRole): Promise<RequestUser> {
  await owner.$transaction([
    owner.userSubsidiaryAccess.deleteMany({ where: { userId: user.id } }),
    owner.profile.update({ where: { id: user.id }, data: { role } }),
  ]);
  const granted = role === UserRole.super_admin || role === UserRole.standard_user;
  if (granted) {
    await owner.userSubsidiaryAccess.create({
      data: { userId: user.id, subsidiaryId: tenant.subsidiaryId, organisationId: tenant.organisationId },
    });
  }
  return {
    ...user,
    role,
    accessibleSubsidiaryIds: granted ? [tenant.subsidiaryId] : [tenant.subsidiaryId, tenant.otherSubsidiaryId],
    categoryGrants: {},
  };
}

describe('D01 — the approver is neither the creator nor the submitter (INC-2.6: a masterkey\'s own record is a self-approval)', () => {
  // Rewritten (INC-2.6 ruling R1): a masterkey approving their own record was
  // refused; it is now a self-approval, its own audit action.
  it('a masterkey approves a record they created and submitted as a self-approval: one `self_approve` row', async () => {
    const record = await createRecord(prisma, tenant, { createdBy: tenant.users.masterkey.id }, { priced: true });
    await attachEvidence(prisma, tenant, [record.id]);
    const submitted = await s.records.submit(tenant.users.masterkey, record.id);

    const approved = await s.records.approve(tenant.users.masterkey, record.id, submitted.submittedAt);
    expect(approved.status).toBe(ActivityRecordStatus.approved);
    const stored = await prisma.activityRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect([stored.createdBy, stored.reviewedBy]).toEqual([tenant.users.masterkey.id, tenant.users.masterkey.id]);
    const decisions = await owner.auditLog.findMany({ where: { entityId: record.id, action: { in: ['approve', 'self_approve'] } } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: 'self_approve', userId: tenant.users.masterkey.id, role: 'masterkey',
      diff: { transition: { from: 'submitted', to: 'approved' } },
    });
  });

  // Rewritten (INC-2.6 §1.1): a second masterkey used to approve a
  // masterkey's record; the author alone decides it now.
  it("a second masterkey is refused a masterkey's record with not_record_approver naming the author", async () => {
    const record = await createRecord(prisma, tenant, { createdBy: tenant.users.masterkey.id }, { priced: true });
    await attachEvidence(prisma, tenant, [record.id]);
    const submitted = await s.records.submit(tenant.users.masterkey, record.id);
    const colleague = await addMember(owner, tenant, UserRole.masterkey);

    for (const decide of [
      () => s.records.startReview(colleague, record.id, submitted.submittedAt),
      () => s.records.approve(colleague, record.id, submitted.submittedAt),
      () => s.records.reject(colleague, record.id, 'Not yours to approve', submitted.submittedAt),
    ]) {
      expect(responseOf(await failure(decide()))).toMatchObject({ code: 'not_record_approver', params: { approver: 'author' } });
    }
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.submitted);
    expect(await decisionRows(record.id)).toEqual([]);
  });

  // K2 (Decisions 2026-11-12) moved to the company's super_admin (INC-2.6 §1.1).
  it("the company's super_admin approves a standard user's submission, audited with the role super_admin", async () => {
    const record = await createRecord(prisma, tenant, {}, { priced: true });
    await attachEvidence(prisma, tenant, [record.id]);
    const submitted = await s.records.submit(tenant.users.standardUser, record.id);

    await s.records.approve(tenant.users.superAdmin, record.id, submitted.submittedAt);

    const stored = await prisma.activityRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(stored.status).toBe(ActivityRecordStatus.approved);
    expect(stored.reviewedBy).toBe(tenant.users.superAdmin.id);
    const rows = await owner.auditLog.findMany({ where: { entityId: record.id, action: 'approve' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: tenant.users.superAdmin.id, role: 'super_admin' });
  });

  it('a former author, now a super_admin granted the company, cannot approve their own record', async () => {
    const record = await createRecord(prisma, tenant, {}, { priced: true });
    await attachEvidence(prisma, tenant, [record.id]);
    const submitted = await s.records.submit(tenant.users.standardUser, record.id);
    const formerAuthor = await promote(tenant.users.standardUser, UserRole.super_admin);

    await expect(s.records.approve(formerAuthor, record.id, submitted.submittedAt)).rejects.toBeInstanceOf(
      SelfApprovalRefusedError,
    );
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.submitted);
  });
});

describe('WP5 — a non-masterkey author does not take their own record into review', () => {
  // Rewritten (INC-2.6 §1.1): the refusal was a masterkey's; a masterkey now
  // decides their own record, and `self_review_forbidden` binds the super_admin.
  it('a super_admin is refused the start of review of their own record with 403 self_review_forbidden; it stays submitted and can still be recalled', async () => {
    const record = await createRecord(prisma, tenant, { createdBy: tenant.users.superAdmin.id }, { priced: true });
    await attachEvidence(prisma, tenant, [record.id]);
    const submitted = await s.records.submit(tenant.users.superAdmin, record.id);

    const refusal = await failure(s.records.startReview(tenant.users.superAdmin, record.id, submitted.submittedAt));
    expect(refusal).toBeInstanceOf(SelfReviewRefusedError);
    expect((refusal as SelfReviewRefusedError).getStatus()).toBe(403);
    expect((refusal as SelfReviewRefusedError).getResponse()).toMatchObject({ code: 'self_review_forbidden' });

    const row = await prisma.activityRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(row.status).toBe(ActivityRecordStatus.submitted);
    expect(row.reviewedBy).toBeNull();
    expect(await owner.auditLog.count({ where: { entityId: record.id, action: 'review' } })).toBe(0);

    await s.records.recall(tenant.users.superAdmin, record.id);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.draft);
  });

  it('a masterkey takes their own record into review', async () => {
    const record = await createRecord(prisma, tenant, { createdBy: tenant.users.masterkey.id }, { priced: true });
    await attachEvidence(prisma, tenant, [record.id]);
    const submitted = await s.records.submit(tenant.users.masterkey, record.id);
    const reviewed = await s.records.startReview(tenant.users.masterkey, record.id, submitted.submittedAt);
    expect([reviewed.status, reviewed.reviewedBy]).toEqual([ActivityRecordStatus.under_review, tenant.users.masterkey.id]);
  });

  it('a former author whose role changed to super_admin is refused too', async () => {
    const record = await createRecord(prisma, tenant, {}, { priced: true });
    await attachEvidence(prisma, tenant, [record.id]);
    const submitted = await s.records.submit(tenant.users.standardUser, record.id);
    const formerAuthor = await promote(tenant.users.standardUser, UserRole.super_admin);

    await expect(
      s.records.startReview(formerAuthor, record.id, submitted.submittedAt),
    ).rejects.toBeInstanceOf(SelfReviewRefusedError);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.submitted);
  });

  it("the company's super_admin takes a standard user's record into review", async () => {
    const record = await createRecord(prisma, tenant, {}, { priced: true });
    await attachEvidence(prisma, tenant, [record.id]);
    const submitted = await s.records.submit(tenant.users.standardUser, record.id);
    const reviewed = await s.records.startReview(tenant.users.superAdmin, record.id, submitted.submittedAt);
    expect(reviewed.status).toBe(ActivityRecordStatus.under_review);
    expect(reviewed.reviewedBy).toBe(tenant.users.superAdmin.id);
  });
});

describe("INC-2.6 §1.1 — a record's approver follows its author's role (task 7.6)", () => {
  it("a standard user's record: refused to the masterkey (not_record_approver naming super_admin) and to the non-deciding roles (forbidden); the super_admin approves", async () => {
    const { record, seen } = await pending(tenant.users.standardUser);
    expect(responseOf(await failure(s.records.approve(tenant.users.masterkey, record.id, seen))))
      .toMatchObject({ code: 'not_record_approver', params: { approver: 'super_admin' } });
    for (const user of [tenant.users.auditor, tenant.users.standardUser]) {
      const refusal = await failure(s.records.approve(user, record.id, seen));
      expect(refusal, user.role).toBeInstanceOf(ForbiddenException);
      expect((refusal as ForbiddenException).message).toMatch(/masterkey or a super_admin/);
    }
    expect(await decisionRows(record.id)).toEqual([]);
    await s.records.approve(tenant.users.superAdmin, record.id, seen);
    expect(await decisionRows(record.id)).toEqual([['approve', tenant.users.superAdmin.id, 'super_admin']]);
  });

  it("a super_admin's record: refused to a colleague super_admin of the company (naming masterkey); the masterkey approves", async () => {
    const { record, seen } = await pending(tenant.users.superAdmin);
    const colleague = await addMember(owner, tenant, UserRole.super_admin, { grants: [tenant.subsidiaryId] });
    expect(responseOf(await failure(s.records.approve(colleague, record.id, seen))))
      .toMatchObject({ code: 'not_record_approver', params: { approver: 'masterkey' } });
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.submitted);
    await s.records.approve(tenant.users.masterkey, record.id, seen);
    expect((await prisma.activityRecord.findUniqueOrThrow({ where: { id: record.id } })).reviewedBy).toBe(tenant.users.masterkey.id);
    expect(await decisionRows(record.id)).toEqual([['approve', tenant.users.masterkey.id, 'masterkey']]);
  });

  it('an author made a super_admin after submitting: the masterkey approves (the current role routes it)', async () => {
    const { record, seen } = await pending(tenant.users.standardUser);
    await promote(tenant.users.standardUser, UserRole.super_admin);
    expect(responseOf(await failure(s.records.approve(tenant.users.superAdmin, record.id, seen))))
      .toMatchObject({ code: 'not_record_approver', params: { approver: 'masterkey' } });
    await s.records.approve(tenant.users.masterkey, record.id, seen);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.approved);
  });

  it('an author made an auditor after submitting: the super_admin approves', async () => {
    const { record, seen } = await pending(tenant.users.standardUser);
    await promote(tenant.users.standardUser, UserRole.auditor);
    await s.records.approve(tenant.users.superAdmin, record.id, seen);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.approved);
  });

  it("a masterkey author's account disabled after submitting: the super_admin approves with the action `approve`", async () => {
    const { record, seen } = await pending(tenant.users.masterkey);
    await owner.profile.update({ where: { id: tenant.users.masterkey.id }, data: { disabledAt: new Date() } });
    expect(responseOf(await failure(s.records.approve(await addMember(owner, tenant, UserRole.masterkey), record.id, seen))))
      .toMatchObject({ code: 'not_record_approver', params: { approver: 'super_admin' } });
    await s.records.approve(tenant.users.superAdmin, record.id, seen);
    expect(await decisionRows(record.id)).toEqual([['approve', tenant.users.superAdmin.id, 'super_admin']]);
  });
});

describe('INC-2.6 ruling R3 — a company without an active super_admin falls back to the masterkey', () => {
  it('no super_admin granted: the masterkey approves, audited as masterkey; the super_admin of another company is answered as for an unknown record', async () => {
    const { record, seen } = await pending(tenant.users.standardUser, tenant.otherSubsidiaryId);
    const refusal = await failure(s.records.approve(tenant.users.superAdmin, record.id, seen));
    expect(refusal).toBeInstanceOf(NotFoundException);
    expect(responseOf(refusal)).toMatchObject({ code: 'record_not_found' });
    await s.records.approve(tenant.users.masterkey, record.id, seen);
    expect(await decisionRows(record.id)).toEqual([['approve', tenant.users.masterkey.id, 'masterkey']]);
  });

  it('the only super_admin disabled after the submission: the masterkey approves', async () => {
    const { record, seen } = await pending(tenant.users.standardUser);
    await owner.profile.update({ where: { id: tenant.users.superAdmin.id }, data: { disabledAt: new Date() } });
    await s.records.approve(tenant.users.masterkey, record.id, seen);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.approved);
  });

  it('the fallback holds while the appointed super_admin has not accepted, and ends at the decision once they have', async () => {
    const first = await pending(tenant.users.standardUser, tenant.otherSubsidiaryId, 'March');
    const second = await pending(tenant.users.standardUser, tenant.otherSubsidiaryId, 'April');
    const appointed = await addMember(owner, tenant, UserRole.super_admin, { grants: [tenant.otherSubsidiaryId], invitation: 'pending' });

    // Invited, not accepted: not active — the masterkey still decides, and
    // the appointee does not.
    expect(responseOf(await failure(s.records.approve(appointed, first.record.id, first.seen))))
      .toMatchObject({ code: 'not_record_approver', params: { approver: 'masterkey' } });
    await s.records.approve(tenant.users.masterkey, first.record.id, first.seen);
    expect(await statusOf(first.record.id)).toBe(ActivityRecordStatus.approved);

    // Accepted: the rule is read at the decision, not at the submission.
    await owner.invitation.update({ where: { profileId: appointed.id }, data: { status: 'accepted', acceptedAt: new Date() } });
    expect(responseOf(await failure(s.records.approve(tenant.users.masterkey, second.record.id, second.seen))))
      .toMatchObject({ code: 'not_record_approver', params: { approver: 'super_admin' } });
    expect(await statusOf(second.record.id)).toBe(ActivityRecordStatus.submitted);
    await s.records.approve(appointed, second.record.id, second.seen);
    expect(await decisionRows(second.record.id)).toEqual([['approve', appointed.id, 'super_admin']]);
  });
});

// Decisions 2026-11-12 (option A): evidence is author-only, masterkey
// included — otherwise a masterkey could re-file a colleague's draft and then
// approve it, which D01 (`createdBy` only) cannot see.
describe("D01's evidence side — only the author changes a record's evidence", () => {
  it("a masterkey cannot upload to a standard user's draft; nothing is stored", async () => {
    const record = await createRecord(prisma, tenant);
    const before = await prisma.activityRecordEvidence.count({ where: { activityRecordId: record.id } });

    await expect(s.evidence.upload(tenant.users.masterkey, record.id, pdfFile())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(await prisma.activityRecordEvidence.count({ where: { activityRecordId: record.id } })).toBe(before);
    expect(await prisma.evidence.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(0);
  });
});

describe('D02 — only the author submits', () => {
  it("a masterkey cannot submit a colleague's draft", async () => {
    const record = await createRecord(prisma, tenant);
    await attachEvidence(prisma, tenant, [record.id]);
    await expect(s.records.submit(tenant.users.masterkey, record.id)).rejects.toBeInstanceOf(
      SubmitAuthorRefusedError,
    );
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.draft);
  });
});

describe('D03 — a period cannot be locked while it holds a rejected record', () => {
  it('the lock is refused, naming the rejected record; after the author resubmits and it is approved, it locks', async () => {
    const record = await createRecord(prisma, tenant, { status: ActivityRecordStatus.rejected }, { priced: true });
    await attachEvidence(prisma, tenant, [record.id]);
    const lock = () =>
      s.periodLocks.lock(tenant.users.masterkey, { subsidiaryId: tenant.subsidiaryId, ...january });

    const refused = await lock().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as Error).message).toMatch(/1 returned record\(s\)/);
    expect(await prisma.periodLock.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(0);

    await s.records.submit(tenant.users.standardUser, record.id);
    await s.records.approve(tenant.users.superAdmin, record.id);
    await lock();
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.locked);
  });
});

describe('D04 — the correction procedure is unlock → void → re-entry, every step audited', () => {
  it('a locked figure is corrected without deleting anything', async () => {
    const original = await createRecord(prisma, tenant, {
      category: 'Water',
      activityUnit: 'cubic_metres',
      status: ActivityRecordStatus.approved,
    });
    const locked = await s.periodLocks.lock(tenant.users.masterkey, {
      subsidiaryId: tenant.subsidiaryId,
      ...january,
    });

    // While locked, the void is refused; the lock has to be lifted first.
    await expect(s.records.void(tenant.users.masterkey, original.id, 'Wrong meter')).rejects.toThrow(
      /unlocked first/,
    );

    await s.periodLocks.unlock(tenant.users.masterkey, locked.id);
    await s.records.void(tenant.users.masterkey, original.id, 'Wrong meter');
    // The voided row leaves the uniqueness index, so the corrected figure
    // takes the same slot as a new record.
    const corrected = await s.records.create(tenant.users.standardUser, {
      subsidiaryId: tenant.subsidiaryId,
      ...january,
      category: 'Water',
      activityValue: 42,
      activityUnit: 'cubic_metres',
    });

    expect(await statusOf(original.id)).toBe(ActivityRecordStatus.voided);
    expect(corrected.status).toBe(ActivityRecordStatus.draft);
    // As a set: `created_at` has millisecond precision, so two steps can tie.
    const trail = await prisma.auditLog.findMany({
      where: { userId: { in: tenant.profileIds } },
      select: { action: true, entityId: true },
    });
    expect(trail).toHaveLength(4);
    expect(trail).toEqual(
      expect.arrayContaining([
        { action: 'lock', entityId: locked.id },
        { action: 'unlock', entityId: locked.id },
        { action: 'void', entityId: original.id },
        { action: 'create', entityId: corrected.id },
      ]),
    );
  });
});
