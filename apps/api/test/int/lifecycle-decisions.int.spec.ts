import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ActivityRecordStatus } from '@tonyai/db';
import { SelfApprovalRefusedError, SubmitAuthorRefusedError } from '../../src/activity-records/errors';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { attachEvidence, connect, connectOwner, createRecord, createTenant, type Tenant } from './db';
import { lifecycleServices } from './services';

/**
 * The LP0-02 workflow decisions LP1-01 implements (Decisions log, 2026-09-29),
 * through the real services and the real database: D01 segregation of duties,
 * D02 only the author submits, D03 no lock over a rejected record, and D04 the
 * pilot correction procedure (unlock → void → re-entry).
 */

let prisma: PrismaService;
let tenant: Tenant;
let s: ReturnType<typeof lifecycleServices>;

beforeAll(() => {
  prisma = connect();
  s = lifecycleServices(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
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

describe('D01 — the approver is neither the creator nor the submitter', () => {
  it('a super_admin cannot approve a record they created and submitted', async () => {
    const record = await createRecord(prisma, tenant, { createdBy: tenant.users.superAdmin.id });
    await attachEvidence(prisma, tenant, [record.id]);
    await s.records.submit(tenant.users.superAdmin, record.id);

    await expect(s.records.approve(tenant.users.superAdmin, record.id)).rejects.toBeInstanceOf(
      SelfApprovalRefusedError,
    );
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.submitted);
  });

  it('another super_admin can', async () => {
    const record = await createRecord(prisma, tenant, { createdBy: tenant.users.superAdmin.id });
    await attachEvidence(prisma, tenant, [record.id]);
    await s.records.submit(tenant.users.superAdmin, record.id);
    // Profiles are the owner's to create (the runtime role reads them).
    const owner = connectOwner();
    const colleague = await owner.profile
      .create({
        data: {
          id: randomUUID(),
          email: `int-admin2-${record.id.slice(0, 8)}@tonyai.test`,
          fullName: 'Int admin two',
          role: 'super_admin',
          organisationId: tenant.organisationId,
        },
      })
      .finally(() => owner.$disconnect());
    tenant.profileIds.push(colleague.id);

    await s.records.approve({ ...tenant.users.superAdmin, id: colleague.id }, record.id);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.approved);
  });
});

describe('D02 — only the author submits', () => {
  it("a super_admin cannot submit a colleague's draft", async () => {
    const record = await createRecord(prisma, tenant);
    await attachEvidence(prisma, tenant, [record.id]);
    await expect(s.records.submit(tenant.users.superAdmin, record.id)).rejects.toBeInstanceOf(
      SubmitAuthorRefusedError,
    );
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.draft);
  });
});

describe('D03 — a period cannot be locked while it holds a rejected record', () => {
  it('the lock is refused, naming the rejected record; after the author resubmits and it is approved, it locks', async () => {
    const record = await createRecord(prisma, tenant, { status: ActivityRecordStatus.rejected });
    await attachEvidence(prisma, tenant, [record.id]);
    const lock = () =>
      s.periodLocks.lock(tenant.users.superAdmin, { subsidiaryId: tenant.subsidiaryId, ...january });

    const refused = await lock().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as Error).message).toMatch(/1 rejected record\(s\)/);
    expect(await prisma.periodLock.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(0);

    await s.records.submit(tenant.users.dataEntry, record.id);
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
    const locked = await s.periodLocks.lock(tenant.users.superAdmin, {
      subsidiaryId: tenant.subsidiaryId,
      ...january,
    });

    // While locked, the void is refused; the lock has to be lifted first.
    await expect(s.records.void(tenant.users.superAdmin, original.id, 'Wrong meter')).rejects.toThrow(
      /unlocked first/,
    );

    await s.periodLocks.unlock(tenant.users.superAdmin, locked.id);
    await s.records.void(tenant.users.superAdmin, original.id, 'Wrong meter');
    // The voided row leaves the uniqueness index, so the corrected figure
    // takes the same slot as a new record.
    const corrected = await s.records.create(tenant.users.dataEntry, {
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
