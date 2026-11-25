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

function auditRow(i: number) {
  return {
    id: `audit-${String(i).padStart(4, '0')}`,
    action: i === 0 ? 'create' : 'update',
    userId: 'u-entry',
    role: 'data_entry',
    diff: {},
    createdAt: new Date(Date.UTC(2026, 10, 25, 0, 0, i)),
  };
}

function build({ rows = [auditRow(0)], get = vi.fn().mockResolvedValue(RECORD) } = {}) {
  const prisma = {
    // The service asks for the newest first; the mock answers in that order.
    auditLog: {
      findMany: vi.fn(({ take }: { take: number }) => Promise.resolve([...rows].reverse().slice(0, take))),
      create: vi.fn(),
      createMany: vi.fn(),
    },
    profile: { findMany: vi.fn().mockResolvedValue([{ id: 'u-entry', fullName: 'Entry User' }]) },
    location: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const records = { get };
  const service = new RecordAuditTrailService(
    prisma as unknown as PrismaService,
    records as unknown as ActivityRecordsService,
  );
  return { prisma, records, service };
}

describe('RecordAuditTrailService — who reads a record\'s trail (WP5, INC-2.6 §6)', () => {
  it.each(['super_admin', 'consultant', 'executive_viewer'] as const)(
    'a %s reads the trail of a record they can read',
    async (role) => {
      const { service } = build();
      const trail = await service.read(user(role), 'rec-1');
      expect(trail).toMatchObject({ recordId: 'rec-1', truncated: false });
      expect(trail.events).toHaveLength(1);
      expect(trail.events[0].actor).toEqual({ name: 'Entry User', role: 'data_entry' });
    },
  );

  it('a data_entry author reads their own record\'s trail', async () => {
    const { service } = build();
    const trail = await service.read(user('data_entry', 'u-entry'), 'rec-1');
    expect(trail.events.map((e) => e.kind)).toEqual(['created']);
  });

  it('a data_entry colleague is refused as forbidden, and no audit row is read', async () => {
    const { prisma, service } = build();
    await expect(service.read(user('data_entry', 'u-colleague'), 'rec-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('refuses an organisation-less caller before reading', async () => {
    const { prisma, service } = build();
    await expect(service.read(user('super_admin', 'u-x', null), 'rec-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('refuses a record the caller cannot read exactly as its read does', async () => {
    const notFound = new ResourceNotFoundError('record_not_found');
    const { prisma, service } = build({ get: vi.fn().mockRejectedValue(notFound) });
    await expect(service.read(user('super_admin'), 'rec-other-org')).rejects.toBe(notFound);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('keys the audit query by the record and the caller\'s organisation, newest first', async () => {
    const { prisma, service } = build();
    await service.read(user('consultant'), 'rec-1');
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
    const trail = await service.read(user('super_admin'), 'rec-1');
    expect(trail.truncated).toBe(true);
    expect(trail.events).toHaveLength(500);
    expect(trail.events[0].id).toBe('audit-0020');
    expect(trail.events.at(-1)!.id).toBe('audit-0519');
  });

  it('says nothing is left out at exactly the limit', async () => {
    const rows = Array.from({ length: RECORD_TRAIL_MAX_EVENTS }, (_, i) => auditRow(i));
    const { service } = build({ rows });
    const trail = await service.read(user('super_admin'), 'rec-1');
    expect(trail.truncated).toBe(false);
    expect(trail.events).toHaveLength(500);
    expect(RECORD_TRAIL_MAX_EVENTS).toBe(500);
  });

  it('says nothing is left out within the limit', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => auditRow(i));
    const { service } = build({ rows });
    const trail = await service.read(user('super_admin'), 'rec-1');
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
    const trail = await service.read(user('super_admin'), 'rec-1');
    expect(prisma.location.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['loc-a', 'loc-b'] }, subsidiaryId: 'sub-1' } }),
    );
    expect(trail.events[0].changes).toEqual([
      { field: 'location', before: 'Istanbul plant', after: 'Izmir depot' },
    ]);
  });

  it('writes nothing: the audit writer is never called', async () => {
    const { prisma, service } = build();
    await service.read(user('super_admin'), 'rec-1');
    await service.read(user('super_admin'), 'rec-1');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
  });
});
