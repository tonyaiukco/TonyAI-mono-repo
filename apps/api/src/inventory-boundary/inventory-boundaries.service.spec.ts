import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { errorCodeOf } from '../common/api-error';
import type { PrismaService } from '../prisma/prisma.service';
import { makeDataEntry, makeSuperAdmin } from '../../test/helpers';
import { InventoryBoundariesService } from './inventory-boundaries.service';

/**
 * The write path's service, DB-free (LP3-04; E2, E3, E7): who may write, in
 * which isolation, the order confirm refuses in, and which database errors are
 * a lost race (`conflict`) and which a defect — a TA014 above all, never shown
 * as frozen. What the database does is the integration suite's.
 */

const ID = '0b1d0000-0000-4000-8000-000000000001';
const SUB_ID = '5b000000-0000-4000-8000-000000000001';

const header = (over: Record<string, unknown> = {}) => ({
  id: ID, organisationId: 'org-1', reportingYear: 2026, version: 1, decision: 'unconfirmed',
  decidedBy: null, decidedAt: null, frozenAt: null, createdBy: 'user-admin', createdAt: new Date('2026-10-15T09:00:00Z'),
  ...over,
});

function mockDb() {
  const model = () => ({
    findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(), createMany: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn(),
  });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: ID }]),
    inventoryBoundary: model(),
    inventoryBoundarySubsidiary: model(),
    inventoryBoundarySite: model(),
    inventoryAttributionPolicy: model(),
    inventoryApplicabilityCell: model(),
    inventorySource: model(),
    subsidiary: model(),
    location: model(),
    auditLog: { create: vi.fn() },
  };
  tx.inventoryBoundary.findUniqueOrThrow.mockResolvedValue(header());
  tx.inventoryBoundary.findFirst.mockResolvedValue(header());
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  };
  return { prisma, tx };
}

const known = (code: string, meta: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('failed', { code, clientVersion: 'test', meta });
const guardRefusal = () => new Prisma.PrismaClientUnknownRequestError(
  'Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "TA014", message: "inventory boundary version is frozen", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
  { clientVersion: 'test' },
);

const BODY = { firstMonth: 1, lastMonth: 12, sites: [], attribution: [], applicability: [], sources: [] } as const;

describe('InventoryBoundariesService', () => {
  let db: ReturnType<typeof mockDb>;
  let service: InventoryBoundariesService;
  const admin = makeSuperAdmin();

  beforeEach(() => {
    db = mockDb();
    service = new InventoryBoundariesService(db.prisma as unknown as PrismaService, new AuditService(db.prisma as unknown as PrismaService));
  });

  const writes = (user: RequestUser) => [
    () => service.create(user, { reportingYear: 2026 }),
    () => service.putSubsidiary(user, ID, SUB_ID, BODY),
    () => service.deleteSubsidiary(user, ID, SUB_ID),
    () => service.confirm(user, ID),
    () => service.remove(user, ID),
  ];

  describe('who writes (E2)', () => {
    it.each([
      ['consultant', makeSuperAdmin({ role: 'consultant' })],
      ['executive_viewer', makeSuperAdmin({ role: 'executive_viewer' })],
      ['data_entry', makeDataEntry()],
      ['a super_admin with no organisation', makeSuperAdmin({ organisationId: null })],
    ])('refuses %s every write, before reading anything', async (_who, user) => {
      for (const write of writes(user)) {
        await expect(write()).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(db.prisma.$transaction).not.toHaveBeenCalled();
      expect(db.tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('writes in READ COMMITTED — the only isolation the guard admits a row write or a freeze in (TA014)', async () => {
      db.tx.inventoryBoundary.findFirst.mockResolvedValueOnce(null);
      db.tx.inventoryBoundary.create.mockResolvedValue(header());
      await service.create(admin, { reportingYear: 2026 });
      expect(db.prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
      );
    });

    it("locks the version's header first, before any other statement", async () => {
      db.tx.subsidiary.findFirst.mockResolvedValue(null);
      await expect(service.putSubsidiary(admin, ID, SUB_ID, BODY)).rejects.toThrow();
      const lock = db.tx.$queryRaw.mock.invocationCallOrder[0];
      for (const m of [db.tx.inventoryBoundary.findUniqueOrThrow, db.tx.subsidiary.findFirst]) {
        expect(m.mock.invocationCallOrder[0]).toBeGreaterThan(lock);
      }
      expect((db.tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?')).toMatch(/FOR UPDATE\s*$/);
    });
  });

  describe('confirm (E3)', () => {
    it('another organisation’s version, or none: boundary_not_found', async () => {
      db.tx.$queryRaw.mockResolvedValue([]);
      await expect(service.confirm(admin, ID)).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_not_found');
    });

    it('a confirmed version: boundary_frozen — before anything else is read', async () => {
      db.tx.inventoryBoundary.findUniqueOrThrow.mockResolvedValue(header({ decision: 'confirmed', decidedBy: 'u', decidedAt: new Date(), frozenAt: new Date() }));
      await expect(service.confirm(admin, ID)).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_frozen');
      expect(db.tx.inventoryBoundarySubsidiary.findMany).not.toHaveBeenCalled();
    });

    it('a version frozen unconfirmed by a capture: boundary_confirm_requires_copy', async () => {
      db.tx.inventoryBoundary.findUniqueOrThrow.mockResolvedValue(header({ frozenAt: new Date() }));
      await expect(service.confirm(admin, ID)).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_confirm_requires_copy');
    });

    it('a version declaring no subsidiary: boundary_incomplete, and nothing written', async () => {
      await expect(service.confirm(admin, ID)).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_incomplete');
      expect(db.tx.inventoryBoundary.update).not.toHaveBeenCalled();
      expect(db.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('a version with a gap: boundary_incomplete, and nothing written', async () => {
      db.tx.inventoryBoundarySubsidiary.findMany.mockResolvedValue([{
        boundaryId: ID, organisationId: 'org-1', subsidiaryId: SUB_ID, firstMonth: 1, lastMonth: 12, subsidiaryName: null, geographyCode: null,
        subsidiary: { legalName: 'Alpha Ltd', tradingName: null, geographyCode: 'GB' },
      }]);
      await expect(service.confirm(admin, ID)).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_incomplete');
      expect(db.tx.inventoryBoundary.update).not.toHaveBeenCalled();
    });
  });

  describe('every other write to a frozen version: boundary_frozen', () => {
    it.each(['confirmed', 'unconfirmed'])('%s', async (decision) => {
      db.tx.inventoryBoundary.findUniqueOrThrow.mockResolvedValue(header({ decision, frozenAt: new Date(), ...(decision === 'confirmed' ? { decidedBy: 'u', decidedAt: new Date() } : {}) }));
      for (const write of [
        () => service.putSubsidiary(admin, ID, SUB_ID, BODY),
        () => service.deleteSubsidiary(admin, ID, SUB_ID),
        () => service.remove(admin, ID),
      ]) {
        await expect(write()).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_frozen');
      }
      expect(db.tx.inventoryBoundarySubsidiary.deleteMany).not.toHaveBeenCalled();
      expect(db.tx.inventoryBoundary.delete).not.toHaveBeenCalled();
    });
  });

  describe('what the database answers (E7, E8)', () => {
    const putReaches = () => {
      db.tx.subsidiary.findFirst.mockResolvedValue({ id: SUB_ID });
      db.tx.inventoryBoundarySubsidiary.findUnique.mockResolvedValue(null);
    };

    it('a TA014 that still arrives is a defect: rethrown as it came — an internal error, logged — never boundary_frozen', async () => {
      putReaches();
      db.tx.inventoryBoundarySubsidiary.create.mockRejectedValue(guardRefusal());
      const logged = vi.spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error').mockImplementation(() => {});
      const failure = await service.putSubsidiary(admin, ID, SUB_ID, BODY).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
      expect(errorCodeOf(failure)).not.toBe('boundary_frozen');
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/guard refused/));
    });

    it('a site or the subsidiary deleted mid-write is a lost race: conflict', async () => {
      // Prisma 6 names the key in `meta.constraint` (measured on the real database).
      for (const [modelName, constraint] of [
        ['InventoryBoundarySite', 'inventory_boundary_sites_location_id_subsidiary_id_fkey'],
        ['InventoryBoundarySubsidiary', 'inventory_boundary_subsidiaries_subsidiary_id_organisation_fkey'],
      ]) {
        putReaches();
        db.tx.inventoryBoundarySubsidiary.create.mockRejectedValueOnce(known('P2003', { modelName, constraint }));
        await expect(service.putSubsidiary(admin, ID, SUB_ID, BODY)).rejects.toBeInstanceOf(ConflictException);
      }
    });

    it('any other key failure is a defect, not a race', async () => {
      putReaches();
      const other = known('P2003', { modelName: 'InventorySource', constraint: 'inventory_sources_boundary_id_subsidiary_id_category_repor_fkey' });
      db.tx.inventoryBoundarySubsidiary.create.mockRejectedValue(other);
      await expect(service.putSubsidiary(admin, ID, SUB_ID, BODY)).rejects.toBe(other);
      const duplicate = known('P2002', { target: ['boundary_id', 'location_id'] });
      db.tx.inventoryBoundarySubsidiary.create.mockRejectedValue(duplicate);
      await expect(service.putSubsidiary(admin, ID, SUB_ID, BODY)).rejects.toBe(duplicate);
    });

    it("two creates of a year's next version: the loser is told conflict — and only that key's failure is", async () => {
      db.tx.inventoryBoundary.findFirst.mockResolvedValue(null);
      db.tx.inventoryBoundary.create.mockRejectedValueOnce(known('P2002', { target: ['organisation_id', 'reporting_year', 'version'] }));
      await expect(service.create(admin, { reportingYear: 2026 })).rejects.toBeInstanceOf(ConflictException);
      const other = known('P2002', { target: ['id'] });
      db.tx.inventoryBoundary.create.mockRejectedValueOnce(other);
      await expect(service.create(admin, { reportingYear: 2026 })).rejects.toBe(other);
    });

    it("a create while the year's newest version is open: boundary_draft_open, nothing written", async () => {
      db.tx.inventoryBoundary.findFirst.mockResolvedValue({ version: 2, frozenAt: null });
      await expect(service.create(admin, { reportingYear: 2026 })).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_draft_open');
      expect(db.tx.inventoryBoundary.create).not.toHaveBeenCalled();
    });

    it("a copy of another organisation's version, or none: boundary_not_found — locked FOR SHARE", async () => {
      db.tx.$queryRaw.mockResolvedValue([]);
      await expect(service.create(admin, { reportingYear: 2026, copyOf: ID })).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_not_found');
      expect((db.tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?')).toMatch(/FOR SHARE\s*$/);
      expect(db.tx.inventoryBoundary.create).not.toHaveBeenCalled();
    });
  });

  describe('reads', () => {
    it("lists a data_entry user's versions declaring a granted subsidiary — and nothing with no organisation", async () => {
      db.prisma.inventoryBoundary.findMany.mockResolvedValue([header()]);
      await service.list(makeDataEntry(), { reportingYear: 2026 });
      expect(db.prisma.inventoryBoundary.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          organisationId: 'org-1',
          reportingYear: 2026,
          subsidiaries: { some: { subsidiaryId: { in: ['sub-1', 'sub-2'] } } },
        },
        orderBy: { version: 'desc' },
      }));
      await service.list(admin, { reportingYear: 2026 });
      expect(db.prisma.inventoryBoundary.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
        where: { organisationId: 'org-1', reportingYear: 2026 },
      }));
      db.prisma.inventoryBoundary.findMany.mockClear();
      expect(await service.list(makeDataEntry({ organisationId: null }), { reportingYear: 2026 })).toEqual([]);
      expect(db.prisma.inventoryBoundary.findMany).not.toHaveBeenCalled();
    });

    it('reads a version in one REPEATABLE READ snapshot; with no organisation, it is not found unread', async () => {
      db.tx.inventoryBoundary.findFirst.mockResolvedValue(null);
      await expect(service.get(admin, ID)).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_not_found');
      expect(db.prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }),
      );
      db.prisma.$transaction.mockClear();
      await expect(service.get(makeSuperAdmin({ organisationId: null }), ID)).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_not_found');
      expect(db.prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
