import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryBoundaryVersionDTO } from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { errorCodeOf, toErrorBody } from '../common/api-error';
import type { PrismaService } from '../prisma/prisma.service';
import { makeAuditor, makeMasterkey, makeStandardUser, makeSuperAdmin } from '../../test/helpers';
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
    // The declaration writer re-read under the admin lock (owner review of
    // WP7): `$executeRaw` takes the lock, `profile.findUnique` reads the
    // account as it stands — by default as authenticated, a super_admin
    // holding SUB_ID.
    $executeRaw: vi.fn().mockResolvedValue(1),
    profile: { findUnique: vi.fn() },
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
  const ROLES: Record<string, string> = {
    'user-admin': 'masterkey', 'user-super-admin': 'super_admin', 'user-entry': 'standard_user', 'user-auditor': 'auditor',
  };
  tx.profile.findUnique.mockImplementation((async ({ where }: { where: { id: string } }) => ({
    role: ROLES[where.id] ?? 'masterkey', organisationId: 'org-1', disabledAt: null, organisation: { offboardedAt: null },
    subsidiaryAccess: ROLES[where.id] === 'super_admin' ? [{ subsidiaryId: SUB_ID }] : [],
  })) as never);
  // A header lock reads back the header; a company read FOR SHARE
  // (`lockCompanies`, inc26-group-tree) answers through `subsidiary.findFirst`,
  // this spec's knob for "the company as stored" (organisation org-1, a
  // controlled company unless the case says otherwise).
  tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) => {
    if (!sql.join('?').includes('FROM subsidiaries')) return [{ id: ID }];
    const row = (await tx.subsidiary.findFirst()) as Record<string, unknown> | null | undefined;
    return row ? [{ organisationId: 'org-1', nodeType: 'company', control: 'controlled', ...row }] : [];
  });
  const prisma = {
    ...tx,
    // The root client's own: a write made outside the transaction shows here.
    auditLog: { create: vi.fn() },
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

/** The code a client receives: the filter's, as `toErrorBody` answers it. */
const answered = (e: unknown) => (e instanceof HttpException ? toErrorBody(e.getStatus(), e.getResponse()).code : undefined);

const BODY = { firstMonth: 1, lastMonth: 12, sites: [], attribution: [], applicability: [], sources: [] } as const;

describe('InventoryBoundariesService', () => {
  let db: ReturnType<typeof mockDb>;
  let service: InventoryBoundariesService;
  const admin = makeMasterkey();

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
      ['an auditor', makeAuditor()],
      ['a standard_user', makeStandardUser()],
      ['a masterkey with no organisation', makeMasterkey({ organisationId: null })],
    ])('refuses %s every write, before reading anything', async (_who, user) => {
      for (const write of writes(user)) {
        await expect(write()).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(db.tx.auditLog.create).not.toHaveBeenCalled();
      expect(db.prisma.auditLog.create).not.toHaveBeenCalled();
      expect(db.prisma.$transaction).not.toHaveBeenCalled();
      expect(db.tx.$queryRaw).not.toHaveBeenCalled();
    });

    describe("a super_admin's own companies (inc26-group-tree, D7, ruling R6)", () => {
      const superAdmin = () => makeSuperAdmin({ accessibleSubsidiaryIds: [SUB_ID] });

      it('is refused the version lifecycle — open, confirm, delete — before anything is read', async () => {
        for (const write of [
          () => service.create(superAdmin(), { reportingYear: 2026 }),
          () => service.confirm(superAdmin(), ID),
          () => service.remove(superAdmin(), ID),
        ]) {
          await expect(write()).rejects.toBeInstanceOf(ForbiddenException);
        }
        expect(db.prisma.$transaction).not.toHaveBeenCalled();
      });

      it("answers another company's declaration as an unknown company, before anything is read", async () => {
        const other = makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
        for (const write of [() => service.putSubsidiary(other, ID, SUB_ID, BODY), () => service.deleteSubsidiary(other, ID, SUB_ID)]) {
          await expect(write()).rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
        }
        expect(db.prisma.$transaction).not.toHaveBeenCalled();
      });

      it('writes its granted company\'s declaration in the open version, audited as a masterkey\'s', async () => {
        db.tx.subsidiary.findFirst.mockResolvedValue({ id: SUB_ID, nodeType: 'company', control: 'controlled' });
        db.tx.inventoryBoundarySubsidiary.findUnique.mockResolvedValue(null);
        await service.putSubsidiary(superAdmin(), ID, SUB_ID, BODY).catch(() => undefined);
        expect(db.tx.inventoryBoundarySubsidiary.create).toHaveBeenCalled();
        expect(db.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
          data: expect.objectContaining({ entity: 'inventory_boundary', action: 'update', role: 'super_admin' }),
        }));
      });
    });

    it.each([
      ['an associate', { nodeType: 'company', control: 'associate' }],
      ['a sector group', { nodeType: 'sector_group', control: 'controlled' }],
    ])('refuses a declaration for %s as not reportable, the version unchanged (D6)', async (_what, node) => {
      db.tx.subsidiary.findFirst.mockResolvedValue({ id: SUB_ID, ...node });
      await expect(service.putSubsidiary(admin, ID, SUB_ID, BODY)).rejects.toMatchObject({
        response: { code: 'boundary_subsidiary_not_reportable', statusCode: 409 },
      });
      expect(db.tx.inventoryBoundarySubsidiary.deleteMany).not.toHaveBeenCalled();
      expect(db.tx.inventoryBoundarySubsidiary.create).not.toHaveBeenCalled();
      expect(db.tx.auditLog.create).not.toHaveBeenCalled();
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

  describe('closed nodes and frozen versions under the group tree (inc26-group-tree, WP7 reviews)', () => {
    it('a super_admin whose grant was withdrawn, or who was demoted, while the write waited writes nothing (owner review, P2)', async () => {
      const own = makeSuperAdmin({ accessibleSubsidiaryIds: [SUB_ID] });
      db.tx.subsidiary.findFirst.mockResolvedValue({ id: SUB_ID });
      db.tx.inventoryBoundarySubsidiary.findUnique.mockResolvedValue(null);
      const now = (over: Record<string, unknown>) => db.tx.profile.findUnique.mockResolvedValue({
        role: 'super_admin', organisationId: 'org-1', disabledAt: null, organisation: { offboardedAt: null }, subsidiaryAccess: [], ...over,
      });
      now({ subsidiaryAccess: [] });
      for (const write of [() => service.putSubsidiary(own, ID, SUB_ID, BODY), () => service.deleteSubsidiary(own, ID, SUB_ID)]) {
        await expect(write()).rejects.toSatisfy((e) => errorCodeOf(e) === 'subsidiary_not_found');
      }
      now({ role: 'standard_user', subsidiaryAccess: [{ subsidiaryId: SUB_ID }] });
      await expect(service.putSubsidiary(own, ID, SUB_ID, BODY)).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.tx.inventoryBoundarySubsidiary.create).not.toHaveBeenCalled();
      expect(db.tx.inventoryBoundarySubsidiary.delete).not.toHaveBeenCalled();
      expect(db.tx.auditLog.create).not.toHaveBeenCalled();
      // Refused before the version is even locked.
      expect(db.tx.$queryRaw).not.toHaveBeenCalled();
      // Still granted: the write goes through — re-read under the
      // organisation's admin lock, before the version is locked.
      now({ subsidiaryAccess: [{ subsidiaryId: SUB_ID }] });
      await service.putSubsidiary(own, ID, SUB_ID, BODY);
      expect(db.tx.inventoryBoundarySubsidiary.create).toHaveBeenCalled();
      const last = db.tx.$executeRaw.mock.calls.length - 1;
      expect((db.tx.$executeRaw.mock.calls[last] as unknown as string[][])[0].join('?')).toMatch(/pg_advisory_xact_lock/);
      expect(db.tx.$executeRaw.mock.invocationCallOrder[last]).toBeLessThan(db.tx.$queryRaw.mock.invocationCallOrder[0]);
    });

    it('refuses deleting the newest version when the one before it declares a company now an associate; allows it otherwise (owner reviews)', async () => {
      // The version before this one, and what it declares.
      db.tx.inventoryBoundary.findFirst.mockImplementation((async ({ where }: { where: { version?: unknown } }) =>
        where.version !== undefined ? { id: 'v-previous' } : header()) as never);
      db.tx.inventoryBoundarySubsidiary.findMany.mockResolvedValue([{ subsidiaryId: SUB_ID }]);
      db.tx.subsidiary.findFirst.mockResolvedValue({ id: SUB_ID, control: 'associate' });
      await expect(service.remove(admin, ID)).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_subsidiary_not_reportable');
      expect(db.tx.inventoryBoundary.delete).not.toHaveBeenCalled();
      expect(db.tx.inventoryBoundary.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { organisationId: 'org-1', reportingYear: 2026, version: { lt: 1 } },
      }));
      // Still a company that holds records: the version goes.
      db.tx.subsidiary.findFirst.mockResolvedValue({ id: SUB_ID, control: 'controlled' });
      await service.remove(admin, ID);
      expect(db.tx.inventoryBoundary.delete).toHaveBeenCalledTimes(1);
    });

    it('audits a declaration as the role that authorised it under the lock (owner\'s third review, P2)', async () => {
      // A masterkey made a super_admin of this company while the write waited.
      db.tx.profile.findUnique.mockResolvedValue({
        role: 'super_admin', organisationId: 'org-1', disabledAt: null, organisation: { offboardedAt: null }, subsidiaryAccess: [{ subsidiaryId: SUB_ID }],
      });
      db.tx.subsidiary.findFirst.mockResolvedValue({ id: SUB_ID });
      db.tx.inventoryBoundarySubsidiary.findUnique.mockResolvedValue(null);
      await service.putSubsidiary(admin, ID, SUB_ID, BODY).catch(() => undefined);
      expect(db.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ entity: 'inventory_boundary', role: 'super_admin' }),
      }));
    });

    it("answers with the writer's companies as re-read under the lock — a company withdrawn meanwhile is not in it (owner review, P1)", async () => {
      const OTHER = '5b000000-0000-4000-8000-000000000009';
      // Authenticated with both companies; B withdrawn while the write waited.
      const own = makeSuperAdmin({ accessibleSubsidiaryIds: [SUB_ID, OTHER] });
      db.tx.subsidiary.findFirst.mockResolvedValue({ id: SUB_ID });
      db.tx.inventoryBoundarySubsidiary.findUnique.mockResolvedValue(null);
      const declared = (subsidiaryId: string, legalName: string) => ({
        boundaryId: ID, organisationId: 'org-1', subsidiaryId, firstMonth: 1, lastMonth: 12, subsidiaryName: null, geographyCode: null,
        subsidiary: { legalName, tradingName: null, geographyCode: 'TR' },
      });
      db.tx.inventoryBoundarySubsidiary.findMany.mockResolvedValue([declared(SUB_ID, 'Alpha Ltd'), declared(OTHER, 'Withdrawn Co')]);
      for (const write of [() => service.putSubsidiary(own, ID, SUB_ID, BODY), () => service.deleteSubsidiary(own, ID, SUB_ID)]) {
        if (write === undefined) continue;
        db.tx.inventoryBoundarySubsidiary.findUnique.mockResolvedValue(null);
        const answer = (await write().catch((e: unknown) => e)) as InventoryBoundaryVersionDTO | Error;
        if (answer instanceof Error) {
          // The delete of an undeclared company answers as unknown; only the PUT answers a version.
          expect(errorCodeOf(answer)).toBe('subsidiary_not_found');
          continue;
        }
        expect(answer.view).toBe('granted_subsidiaries');
        expect(answer.boundary.subsidiaryIds).toContain(SUB_ID);
        expect(JSON.stringify(answer)).not.toContain(OTHER);
        expect(JSON.stringify(answer)).not.toContain('Withdrawn Co');
      }
    });

    it("another organisation's company, read FOR SHARE, answers as unknown", async () => {
      db.tx.subsidiary.findFirst.mockResolvedValue({ id: SUB_ID, organisationId: 'org-2' });
      await expect(service.putSubsidiary(admin, ID, SUB_ID, BODY)).rejects.toSatisfy((e) => errorCodeOf(e) === 'subsidiary_not_found');
      expect(db.tx.inventoryBoundarySubsidiary.create).not.toHaveBeenCalled();
    });

    it('a confirm with an associate still declared: boundary_subsidiary_not_reportable, nothing frozen', async () => {
      db.tx.inventoryBoundarySubsidiary.findMany.mockResolvedValue([{
        boundaryId: ID, organisationId: 'org-1', subsidiaryId: SUB_ID, firstMonth: 1, lastMonth: 12, subsidiaryName: null, geographyCode: null,
        subsidiary: { legalName: 'Alpha Ltd', tradingName: null, geographyCode: 'GB' },
      }]);
      db.tx.subsidiary.findFirst.mockResolvedValue({ id: SUB_ID, control: 'associate' });
      await expect(service.confirm(admin, ID)).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_subsidiary_not_reportable');
      expect(db.tx.inventoryBoundary.update).not.toHaveBeenCalled();
      expect(db.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('a copy leaves a company now closed out of every row, and its audit row names it', async () => {
      const CLOSED = '5b000000-0000-4000-8000-000000000002';
      const sub = (subsidiaryId: string) => ({ boundaryId: 'src', organisationId: 'org-1', subsidiaryId, firstMonth: 1, lastMonth: 12, subsidiaryName: 'n', geographyCode: 'TR' });
      db.tx.inventoryBoundarySubsidiary.findMany.mockResolvedValue([sub(SUB_ID), sub(CLOSED)]);
      db.tx.inventoryBoundarySite.findMany.mockResolvedValue([
        { boundaryId: 'src', subsidiaryId: SUB_ID, locationId: 'l1', firstMonth: 1, lastMonth: 12, locationName: 'a', geographyCode: 'TR' },
        { boundaryId: 'src', subsidiaryId: CLOSED, locationId: 'l2', firstMonth: 1, lastMonth: 12, locationName: 'b', geographyCode: 'TR' },
      ]);
      db.tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) =>
        sql.join('?').includes('FROM subsidiaries')
          ? [
              { id: SUB_ID, organisationId: 'org-1', nodeType: 'company', control: 'controlled' },
              { id: CLOSED, organisationId: 'org-1', nodeType: 'company', control: 'associate' },
            ]
          : [{ id: ID }]);
      db.tx.inventoryBoundary.findFirst.mockResolvedValue(null);
      db.tx.inventoryBoundary.create.mockResolvedValue(header({ id: 'new' }));
      await service.create(admin, { reportingYear: 2026, copyOf: ID }).catch(() => undefined);
      const inserted = [
        ...db.tx.inventoryBoundarySubsidiary.createMany.mock.calls,
        ...db.tx.inventoryBoundarySubsidiary.create.mock.calls,
        ...db.tx.inventoryBoundarySite.createMany.mock.calls,
        ...db.tx.inventoryBoundarySite.create.mock.calls,
      ];
      expect(inserted.length).toBeGreaterThan(0);
      expect(JSON.stringify(inserted)).toContain(SUB_ID);
      expect(JSON.stringify(inserted)).not.toContain(CLOSED);
      expect(db.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ entity: 'inventory_boundary', action: 'create', diff: expect.objectContaining({ leftOutClosedSubsidiaries: [CLOSED] }) }),
      }));
    });

    it("a frozen version declaring none of a super_admin's companies answers as unknown; one declaring them, as frozen", async () => {
      db.tx.inventoryBoundary.findUniqueOrThrow.mockResolvedValue(header({ frozenAt: new Date() }));
      const own = makeSuperAdmin({ accessibleSubsidiaryIds: [SUB_ID] });
      db.tx.inventoryBoundarySubsidiary.count.mockResolvedValue(0);
      for (const write of [() => service.putSubsidiary(own, ID, SUB_ID, BODY), () => service.deleteSubsidiary(own, ID, SUB_ID)]) {
        await expect(write()).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_not_found');
      }
      expect(db.tx.inventoryBoundarySubsidiary.count).toHaveBeenCalledWith({
        where: { boundaryId: ID, subsidiaryId: { in: [SUB_ID] } },
      });
      db.tx.inventoryBoundarySubsidiary.count.mockResolvedValue(1);
      await expect(service.putSubsidiary(own, ID, SUB_ID, BODY)).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_frozen');
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
        expect(answered(await service.putSubsidiary(admin, ID, SUB_ID, BODY).catch((e: unknown) => e))).toBe('conflict');
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

    it('a deadlock (40P01, Prisma P2034) is a lost race too: conflict, never a 500', async () => {
      putReaches();
      db.tx.inventoryBoundarySubsidiary.create.mockRejectedValueOnce(known('P2034', {}));
      expect(answered(await service.putSubsidiary(admin, ID, SUB_ID, BODY).catch((e: unknown) => e))).toBe('conflict');
      db.tx.inventoryBoundary.findUniqueOrThrow.mockResolvedValue(header());
      db.tx.inventoryBoundarySubsidiary.findMany.mockRejectedValueOnce(known('P2034', {}));
      await expect(service.confirm(admin, ID)).rejects.toBeInstanceOf(ConflictException);
    });

    it("two creates of a year's next version: the loser is told conflict — and only that key's failure is", async () => {
      db.tx.inventoryBoundary.findFirst.mockResolvedValue(null);
      db.tx.inventoryBoundary.create.mockRejectedValueOnce(known('P2002', { target: ['organisation_id', 'reporting_year', 'version'] }));
      expect(answered(await service.create(admin, { reportingYear: 2026 }).catch((e: unknown) => e))).toBe('conflict');
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

  describe("bound to the caller's organisation, its subsidiary and the transaction", () => {
    it("looks a PUT's subsidiary up in the caller's organisation, and its sites in that subsidiary", async () => {
      db.tx.subsidiary.findFirst.mockResolvedValue({ id: SUB_ID });
      db.tx.location.count.mockResolvedValue(0);
      const site = '1c000000-0000-4000-8000-000000000001';
      await expect(service.putSubsidiary(admin, ID, SUB_ID, { ...BODY, sites: [{ locationId: site, firstMonth: 1, lastMonth: 12 }] }))
        .rejects.toSatisfy((e) => errorCodeOf(e) === 'location_not_found');
      const read = db.tx.$queryRaw.mock.calls[1] as unknown[];
      expect((read[0] as TemplateStringsArray).join('?')).toMatch(/FROM subsidiaries WHERE id = ANY\(\?::uuid\[\]\) ORDER BY id FOR SHARE\s*$/);
      expect(read.slice(1)).toEqual([[SUB_ID]]);
      expect(db.tx.location.count).toHaveBeenCalledWith({ where: { id: { in: [site] }, subsidiaryId: SUB_ID } });
      expect((db.tx.$queryRaw.mock.calls[0] as unknown[]).slice(1)).toEqual([ID, 'org-1']);
    });

    it("reads a version in the caller's organisation only", async () => {
      db.tx.inventoryBoundary.findFirst.mockResolvedValue(null);
      await expect(service.get(admin, ID)).rejects.toThrow();
      expect(db.tx.inventoryBoundary.findFirst).toHaveBeenCalledWith({ where: { id: ID, organisationId: 'org-1' } });
    });

    it("writes each audit row through the write's own transaction, never the root client", async () => {
      db.tx.subsidiary.findFirst.mockResolvedValue({ id: SUB_ID });
      db.tx.inventoryBoundarySubsidiary.findUnique.mockResolvedValue(null);
      await service.putSubsidiary(admin, ID, SUB_ID, BODY);
      await service.confirm(admin, ID).catch(() => undefined);
      db.tx.inventoryBoundary.findFirst.mockResolvedValueOnce(null);
      db.tx.inventoryBoundary.create.mockResolvedValue(header());
      await service.create(admin, { reportingYear: 2026 });
      await service.remove(admin, ID);
      expect(db.tx.auditLog.create).toHaveBeenCalledTimes(3);
      expect(db.tx.auditLog.create.mock.calls.map(([arg]) => (arg as { data: { action: string } }).data.action)).toEqual(['update', 'create', 'delete']);
      expect(db.prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('reads', () => {
    it("lists a standard_user's versions declaring a granted subsidiary only", async () => {
      db.prisma.inventoryBoundary.findMany.mockResolvedValue([header()]);
      await service.list(makeStandardUser(), { reportingYear: 2026 });
      expect(db.prisma.inventoryBoundary.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          organisationId: 'org-1',
          reportingYear: 2026,
          OR: [{ subsidiaries: { some: { subsidiaryId: { in: ['sub-1', 'sub-2'] } } } }],
        },
        orderBy: { version: 'desc' },
      }));
    });

    it("lists a scoped super_admin's versions declaring a granted subsidiary, and the year's open version it declares in (D7)", async () => {
      db.prisma.inventoryBoundary.findMany.mockResolvedValue([header()]);
      await service.list(makeSuperAdmin(), { reportingYear: 2026 });
      expect(db.prisma.inventoryBoundary.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          organisationId: 'org-1',
          reportingYear: 2026,
          OR: [{ subsidiaries: { some: { subsidiaryId: { in: ['sub-1', 'sub-2'] } } } }, { frozenAt: null }],
        },
        orderBy: { version: 'desc' },
      }));
    });

    it("lists the organisation's versions to a masterkey and an auditor — and nothing with no organisation", async () => {
      db.prisma.inventoryBoundary.findMany.mockResolvedValue([header()]);
      for (const user of [admin, makeAuditor()]) {
        await service.list(user, { reportingYear: 2026 });
        expect(db.prisma.inventoryBoundary.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
          where: { organisationId: 'org-1', reportingYear: 2026 },
        }));
      }
      db.prisma.inventoryBoundary.findMany.mockClear();
      expect(await service.list(makeStandardUser({ organisationId: null }), { reportingYear: 2026 })).toEqual([]);
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
      await expect(service.get(makeMasterkey({ organisationId: null }), ID)).rejects.toSatisfy((e) => errorCodeOf(e) === 'boundary_not_found');
      expect(db.prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
