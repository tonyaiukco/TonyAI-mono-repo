import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { RECORD_TRAIL_MAX_EVENTS } from '@tonyai/shared-types';
import { ResourceNotFoundError } from '../common/api-error';
import { RecordAuditTrailService } from './record-audit-trail.service';
import type { RequestUser } from '../auth/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import type { ActivityRecordsService } from './activity-records.service';

const RECORD = { id: 'rec-1', subsidiaryId: 'sub-1', createdBy: 'u-entry' };

function user(role: RequestUser['role'], id = `u-${role}`, organisationId: string | null = 'org-1'): RequestUser {
  return { id, role, organisationId, email: `${id}@example.test`, fullName: id } as RequestUser;
}

/** A row as stored: its role is the actor's role WHEN it was written — here
 *  a retired name, which history shows as stored (design Decision 10). */
function auditRow(i: number, over: Partial<{ role: string; action: string; createdAt: Date }> = {}) {
  return {
    id: `audit-${String(i).padStart(4, '0')}`,
    action: i === 0 ? 'create' : 'update',
    userId: 'u-entry',
    role: 'data_entry',
    diff: {},
    createdAt: new Date(Date.UTC(2026, 10, 25, 0, 0, i)),
    ...over,
  };
}

function build({
  rows = [auditRow(0)],
  get = vi.fn().mockResolvedValue(RECORD),
  cutOver = null as Date | null,
} = {}) {
  const prisma = {
    // The service asks for the newest first; the mock answers in that order.
    auditLog: {
      findMany: vi.fn(({ take }: { take: number }) => Promise.resolve([...rows].reverse().slice(0, take))),
      create: vi.fn(),
      createMany: vi.fn(),
    },
    profile: { findMany: vi.fn().mockResolvedValue([{ id: 'u-entry', fullName: 'Entry User' }]) },
    location: { findMany: vi.fn().mockResolvedValue([]) },
    // The organisation's cut-over (`role_model_changed_at`), read once per trail.
    organisation: { findUnique: vi.fn().mockResolvedValue({ roleModelChangedAt: cutOver }) },
  };
  const records = { get };
  const service = new RecordAuditTrailService(
    prisma as unknown as PrismaService,
    records as unknown as ActivityRecordsService,
  );
  return { prisma, records, service };
}

describe('RecordAuditTrailService — who reads a record\'s trail (WP5, INC-2.6 §6)', () => {
  // "A trail is read within its reader's role and scope": a masterkey and an
  // auditor any record of the organisation; a super_admin any record its
  // scoped read returns (a granted company); each a record another created.
  it.each(['masterkey', 'auditor', 'super_admin'] as const)(
    'a %s reads the trail of a record another user created that they can read',
    async (role) => {
      const { records, service } = build();
      const trail = await service.read(user(role), 'rec-1');
      expect(trail).toMatchObject({ recordId: 'rec-1', truncated: false });
      expect(trail.events).toHaveLength(1);
      // A retired role passes through as stored.
      expect(trail.events[0].actor).toEqual({ name: 'Entry User', role: 'data_entry' });
      // Through the record's own scoped read, as the caller.
      expect(records.get).toHaveBeenCalledWith(expect.objectContaining({ role }), 'rec-1');
    },
  );

  it('a standard user author reads their own record\'s trail, with a return and its reason', async () => {
    const rows = [
      auditRow(0),
      { ...auditRow(1, { action: 'submit', role: 'standard_user' }), diff: { transition: { from: 'draft', to: 'submitted' } } },
      {
        ...auditRow(2, { action: 'reject', role: 'super_admin' }),
        userId: 'u-sa',
        diff: { transition: { from: 'submitted', to: 'rejected' }, reviewNote: 'Invoice missing' },
      },
    ];
    const { service } = build({ rows });
    const trail = await service.read(user('standard_user', 'u-entry'), 'rec-1');
    expect(trail.events.map((e) => e.kind)).toEqual(['created', 'submitted', 'returned']);
    expect(trail.events[2].reason).toBe('Invoice missing');
  });

  it('a standard user colleague in a shared company is refused as forbidden, and no audit row is read', async () => {
    const { prisma, service } = build();
    await expect(service.read(user('standard_user', 'u-colleague'), 'rec-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it.each(['standard_user', 'super_admin'] as const)(
    'a %s reading a record of a company they hold no grant for is refused exactly as the record read is',
    async (role) => {
      // The scoped read (`loadScoped` → `inRecordScope`) answers not found for
      // a company outside the grants; the trail repeats that answer verbatim.
      const notFound = new ResourceNotFoundError('record_not_found');
      const { prisma, service } = build({ get: vi.fn().mockRejectedValue(notFound) });
      await expect(service.read(user(role), 'rec-in-company-c')).rejects.toBe(notFound);
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
      expect(prisma.organisation.findUnique).not.toHaveBeenCalled();
    },
  );

  it('refuses an organisation-less caller before reading', async () => {
    const { prisma, service } = build();
    await expect(service.read(user('masterkey', 'u-x', null), 'rec-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('refuses a record of another organisation exactly as its read does, not saying whether it exists', async () => {
    const notFound = new ResourceNotFoundError('record_not_found');
    const { prisma, service } = build({ get: vi.fn().mockRejectedValue(notFound) });
    await expect(service.read(user('masterkey'), 'rec-other-org')).rejects.toBe(notFound);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('keys the audit query by the record and the caller\'s organisation, newest first', async () => {
    const { prisma, service } = build();
    await service.read(user('auditor'), 'rec-1');
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entity: 'activity_record',
          entityId: { equals: 'rec-1', mode: 'insensitive' },
          organisationId: 'org-1',
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: RECORD_TRAIL_MAX_EVENTS + 1,
      }),
    );
    expect(prisma.profile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['u-entry'] }, organisationId: 'org-1' } }),
    );
  });

  it('returns the newest 500 of 520 events, oldest first, and says earlier ones were left out', async () => {
    const rows = Array.from({ length: 520 }, (_, i) => auditRow(i));
    const { service } = build({ rows });
    const trail = await service.read(user('masterkey'), 'rec-1');
    expect(trail.truncated).toBe(true);
    expect(trail.events).toHaveLength(500);
    expect(trail.events[0].id).toBe('audit-0020');
    expect(trail.events.at(-1)!.id).toBe('audit-0519');
  });

  it('says nothing is left out at exactly the limit', async () => {
    const rows = Array.from({ length: RECORD_TRAIL_MAX_EVENTS }, (_, i) => auditRow(i));
    const { service } = build({ rows });
    const trail = await service.read(user('masterkey'), 'rec-1');
    expect(trail.truncated).toBe(false);
    expect(trail.events).toHaveLength(500);
    expect(RECORD_TRAIL_MAX_EVENTS).toBe(500);
  });

  it('says nothing is left out within the limit', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => auditRow(i));
    const { service } = build({ rows });
    const trail = await service.read(user('masterkey'), 'rec-1');
    expect(trail).toMatchObject({ truncated: false });
    expect(trail.events).toHaveLength(12);
  });

  it('resolves locations within the record\'s subsidiary only', async () => {
    const rows = [
      {
        ...auditRow(1),
        diff: { before: { locationId: 'loc-a' }, after: { locationId: 'loc-b' } },
      },
    ];
    const { prisma, service } = build({ rows });
    prisma.location.findMany.mockResolvedValue([
      { id: 'loc-a', name: 'Istanbul plant' },
      { id: 'loc-b', name: 'Izmir depot' },
    ]);
    const trail = await service.read(user('masterkey'), 'rec-1');
    expect(prisma.location.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['loc-a', 'loc-b'] }, subsidiaryId: 'sub-1' } }),
    );
    expect(trail.events[0].changes).toEqual([
      { field: 'location', before: 'Istanbul plant', after: 'Izmir depot' },
    ]);
  });

  it('writes nothing, and two reads answer the same events', async () => {
    const { prisma, service } = build({ rows: [auditRow(0), auditRow(1)] });
    const first = await service.read(user('masterkey'), 'rec-1');
    const second = await service.read(user('masterkey'), 'rec-1');
    expect(second).toEqual(first);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
  });
});

describe('RecordAuditTrailService — a stored role is shown under the role model it was written in (design Decision 10)', () => {
  const CUT_OVER = new Date('2026-11-25T12:00:00.000Z');
  const before = new Date('2026-11-25T11:59:59.999Z');
  const after = new Date('2026-11-25T12:00:00.001Z');
  const approval = (createdAt: Date, role: string) => ({
    ...auditRow(1, { action: 'approve', role, createdAt }),
    userId: 'u-entry',
    diff: { transition: { from: 'submitted', to: 'approved' } },
  });

  it('reads the organisation\'s cut-over once per trail, keyed by the caller\'s organisation', async () => {
    const rows = [auditRow(0), approval(before, 'super_admin'), approval(after, 'super_admin')];
    const { prisma, service } = build({ rows, cutOver: CUT_OVER });
    await service.read(user('auditor'), 'rec-1');
    expect(prisma.organisation.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.organisation.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      select: { roleModelChangedAt: true },
    });
  });

  it('shows a super_admin approval from before the cut-over as legacy_super_admin, one after it as super_admin', async () => {
    const rows = [approval(before, 'super_admin'), approval(after, 'super_admin')];
    const { service } = build({ rows, cutOver: CUT_OVER });
    const trail = await service.read(user('auditor'), 'rec-1');
    expect(trail.events.map((e) => e.actor?.role)).toEqual(['legacy_super_admin', 'super_admin']);
  });

  it('shows today\'s names for an organisation with no cut-over (created after the change)', async () => {
    const rows = [approval(before, 'super_admin'), approval(after, 'masterkey')];
    const { service } = build({ rows, cutOver: null });
    const trail = await service.read(user('auditor'), 'rec-1');
    expect(trail.events.map((e) => e.actor?.role)).toEqual(['super_admin', 'masterkey']);
  });

  it('shows a consultant\'s old review start as consultant', async () => {
    const rows = [{
      ...auditRow(1, { action: 'review', role: 'consultant', createdAt: before }),
      diff: { transition: { from: 'submitted', to: 'under_review' } },
    }];
    const { service } = build({ rows, cutOver: CUT_OVER });
    const trail = await service.read(user('auditor'), 'rec-1');
    expect(trail.events[0]).toMatchObject({ kind: 'review_started', actor: { role: 'consultant' } });
  });

  it('a missing organisation row reads as no cut-over', async () => {
    const rows = [approval(before, 'super_admin')];
    const { prisma, service } = build({ rows });
    prisma.organisation.findUnique.mockResolvedValue(null);
    const trail = await service.read(user('auditor'), 'rec-1');
    expect(trail.events[0].actor?.role).toBe('super_admin');
  });
});
