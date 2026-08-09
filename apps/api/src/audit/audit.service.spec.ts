import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AuditService } from './audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';

function createPrismaMock() {
  return {
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    profile: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

let rowSeq = 0;
function makeRow(overrides: Record<string, unknown> = {}) {
  rowSeq += 1;
  return {
    id: `audit-${rowSeq}`,
    userId: 'user-1',
    role: 'super_admin',
    organisationId: 'org-1',
    action: 'create',
    entity: 'subsidiary',
    entityId: 'sub-1',
    diff: { after: { id: 'sub-1' } },
    createdAt: new Date('2026-07-30T10:00:00.000Z'),
    ...overrides,
  };
}

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-1',
    email: 'admin@tonyai.local',
    role: 'super_admin',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1'],
    ...overrides,
  };
}

describe('AuditService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: AuditService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new AuditService(prisma as unknown as PrismaService);
  });

  it('stamps the actor id, role and organisation on every row', async () => {
    await service.record(makeUser(), {
      action: 'create',
      entity: 'subsidiary',
      entityId: 'sub-9',
      diff: { after: { id: 'sub-9' } },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      userId: 'user-1',
      role: 'super_admin',
      organisationId: 'org-1',
      action: 'create',
      entity: 'subsidiary',
      entityId: 'sub-9',
    });
  });

  it('records the role the actor held AT THE TIME, not a lookup', async () => {
    // Roles change; an audit trail that re-derived the role at read time would
    // misstate who was allowed to do what.
    await service.record(makeUser({ role: 'consultant' }), {
      action: 'reject',
      entity: 'activity_record',
      entityId: 'rec-1',
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data.role).toBe('consultant');
  });

  it('accepts a null entityId (report generation has no persisted row)', async () => {
    await service.record(makeUser(), {
      action: 'generate',
      entity: 'report',
      entityId: null,
      diff: { template: 'executive_summary' },
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      entity: 'report',
      entityId: null,
    });
  });

  it('writes through the transaction client when one is passed', async () => {
    // Auditing inside the mutation's transaction is what stops a crash between
    // the two from losing the audit row.
    const tx = { auditLog: { create: vi.fn().mockResolvedValue({}) } };
    await service.record(
      makeUser(),
      { action: 'lock', entity: 'period_lock', entityId: 'pl-1' },
      tx as never,
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('carries a null organisation through rather than inventing one', async () => {
    // A privileged profile with no organisation is already default-denied by the
    // guard; the audit row must not fabricate a tenant to make it readable.
    await service.record(makeUser({ organisationId: null }), {
      action: 'delete',
      entity: 'target',
      entityId: 't-1',
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data.organisationId).toBeNull();
  });

  it('normalises a missing diff to null instead of undefined', async () => {
    await service.record(makeUser(), {
      action: 'unlock',
      entity: 'period_lock',
      entityId: 'pl-2',
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data.diff).toBeNull();
  });

  it('no code anywhere mutates or deletes audit rows (append-only)', () => {
    // The earlier version of this test asserted the prototype's method list,
    // which caught nothing real and broke the moment a legitimate read method
    // was added — the classic rotting guard. The actual vector is any service
    // calling Prisma directly: the API connects as the table owner, so RLS
    // does not stop it. Scan the source instead.
    // Scan the API *and* packages/db: the most plausible future regression is a
    // "reset the demo tenant" seed helper calling auditLog.deleteMany(), which
    // an apps/api-only scan would wave straight through.
    const roots = [resolve(__dirname, '..'), resolve(__dirname, '../../../../packages/db')];
    const offenders: string[] = [];
    const rawSql: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // `generated` holds the Prisma client, whose own JSDoc demonstrates
        // auditLog.delete/update — generated code is not our code.
        if (['node_modules', 'dist', 'generated'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.spec.ts') &&
          !entry.name.endsWith('.d.ts')
        ) {
          const src = readFileSync(full, 'utf8');
          if (/auditLog\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/.test(src)) {
            offenders.push(full);
          }
          // Raw SQL bypasses the Prisma-shaped check entirely.
          if (/\$(execute|query)Raw/.test(src) && /audit_log/.test(src)) {
            rawSql.push(full);
          }
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
    expect(rawSql).toEqual([]);
  });

  describe('list — reading the trail', () => {
    it('refuses any role other than super_admin', async () => {
      for (const role of ['consultant', 'data_entry', 'executive_viewer'] as const) {
        await expect(service.list(makeUser({ role }), {})).rejects.toThrow(
          /Only a super_admin/,
        );
      }
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    it('scopes every query to the caller\'s organisation', async () => {
      await service.list(makeUser({ organisationId: 'org-7' }), {});
      expect(prisma.auditLog.findMany.mock.calls[0][0].where).toMatchObject({
        organisationId: 'org-7',
      });
      expect(prisma.auditLog.count.mock.calls[0][0].where).toMatchObject({
        organisationId: 'org-7',
      });
    });

    it('returns nothing for a super_admin with no organisation, without querying', async () => {
      // A null tenant would otherwise widen the filter to every row ever written.
      const page = await service.list(makeUser({ organisationId: null }), {});
      expect(page).toMatchObject({ items: [], total: 0 });
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    it('renders the role STORED on the row, not the actor\'s current role', async () => {
      // The actor is a super_admin today; the row says they were a consultant
      // when they acted. The trail must show what was true then.
      prisma.auditLog.findMany.mockResolvedValue([
        makeRow({ role: 'consultant', action: 'reject', entity: 'activity_record' }),
      ]);
      prisma.profile.findMany.mockResolvedValue([
        { id: 'user-1', email: 'a@x', fullName: 'Ada' },
      ]);

      const page = await service.list(makeUser(), {});
      expect(page.items[0]).toMatchObject({
        role: 'consultant',
        action: 'reject',
        userEmail: 'a@x',
        userFullName: 'Ada',
      });
    });

    it('keeps a row whose actor profile no longer exists', async () => {
      // audit_log.user_id has no FK on purpose — the trail outlives the actor.
      prisma.auditLog.findMany.mockResolvedValue([makeRow()]);
      prisma.profile.findMany.mockResolvedValue([]);

      const page = await service.list(makeUser(), {});
      expect(page.items[0]).toMatchObject({
        userId: 'user-1',
        userEmail: null,
        userFullName: null,
      });
    });

    it('carries a null role through for pre-WP7 rows', async () => {
      prisma.auditLog.findMany.mockResolvedValue([makeRow({ role: null })]);
      const page = await service.list(makeUser(), {});
      expect(page.items[0].role).toBeNull();
    });

    it('resolves actors in ONE query for the whole page, not per row', async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        makeRow({ userId: 'u1' }),
        makeRow({ userId: 'u2' }),
        makeRow({ userId: 'u1' }),
      ]);
      await service.list(makeUser(), {});
      expect(prisma.profile.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.profile.findMany.mock.calls[0][0].where.id.in.sort()).toEqual(['u1', 'u2']);
    });

    it('applies the filters it is given', async () => {
      await service.list(makeUser(), {
        entity: 'activity_record',
        action: 'approve',
        entityId: 'rec-1',
        userId: 'user-9',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      });
      expect(prisma.auditLog.findMany.mock.calls[0][0].where).toMatchObject({
        entity: 'activity_record',
        action: 'approve',
        entityId: 'rec-1',
        userId: 'user-9',
        createdAt: { gte: new Date('2026-01-01T00:00:00.000Z'), lt: new Date('2026-02-01T00:00:00.000Z') },
      });
    });

    it('breaks ties on id so a page cannot repeat or skip a row', async () => {
      // created_at is TIMESTAMP(3) defaulting to the TRANSACTION start time, so
      // every row written in one transaction ties exactly. Postgres gives no
      // stable order among ties, and with OFFSET paging that means a row can
      // appear twice or vanish — unacceptable on an append-only trail.
      await service.list(makeUser(), {});
      expect(prisma.auditLog.findMany.mock.calls[0][0].orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
    });

    it('orders newest first and paginates', async () => {
      prisma.auditLog.count.mockResolvedValue(137);
      const page = await service.list(makeUser(), { limit: 25, offset: 50 });
      const args = prisma.auditLog.findMany.mock.calls[0][0];
      expect(args.orderBy[0]).toEqual({ createdAt: 'desc' });
      expect(args.take).toBe(25);
      expect(args.skip).toBe(50);
      expect(page).toMatchObject({ total: 137, limit: 25, offset: 50 });
    });

    it('defaults to a bounded page rather than the whole trail', async () => {
      await service.list(makeUser(), {});
      expect(prisma.auditLog.findMany.mock.calls[0][0].take).toBe(50);
    });
  });
});
