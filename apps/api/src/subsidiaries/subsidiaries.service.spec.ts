import { describe, it, expect, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SubsidiariesService } from './subsidiaries.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createPrismaMock,
  makeSubsidiary,
  makeSuperAdmin,
  makeDataEntry,
  type PrismaMock,
} from '../../test/helpers';

describe('SubsidiariesService', () => {
  let prisma: PrismaMock;
  let service: SubsidiariesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    // Direct instantiation with the mock — the service only depends on the
    // narrow PrismaService surface, so no Nest container / DB is needed.
    service = new SubsidiariesService(prisma as unknown as PrismaService);
  });

  describe('list — tenant isolation', () => {
    it('queries only the caller\'s accessible subsidiary ids', async () => {
      const user = makeDataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
      const rows = [
        makeSubsidiary({ id: 'sub-1' }),
        makeSubsidiary({ id: 'sub-2' }),
      ];
      prisma.subsidiary.findMany.mockResolvedValue(rows);

      const result = await service.list(user);

      expect(prisma.subsidiary.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.subsidiary.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['sub-1', 'sub-2'] } },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.id)).toEqual(['sub-1', 'sub-2']);
    });

    it('returns an empty list when the user has no accessible subsidiaries', async () => {
      const user = makeDataEntry({ accessibleSubsidiaryIds: [] });
      prisma.subsidiary.findMany.mockResolvedValue([]);

      const result = await service.list(user);

      expect(prisma.subsidiary.findMany).toHaveBeenCalledWith({
        where: { id: { in: [] } },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toEqual([]);
    });

    it('serialises Date fields to ISO strings in the DTO', async () => {
      const user = makeSuperAdmin();
      const created = new Date('2026-02-03T04:05:06.000Z');
      prisma.subsidiary.findMany.mockResolvedValue([
        makeSubsidiary({ id: 'sub-1', createdAt: created, updatedAt: created }),
      ]);

      const [dto] = await service.list(user);

      expect(dto.createdAt).toBe('2026-02-03T04:05:06.000Z');
      expect(dto.updatedAt).toBe('2026-02-03T04:05:06.000Z');
    });
  });

  describe('get — tenant isolation', () => {
    it('returns the subsidiary when the id is within the access set', async () => {
      const user = makeDataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));

      const dto = await service.get(user, 'sub-1');

      expect(dto.id).toBe('sub-1');
      expect(prisma.subsidiary.findUnique).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
    });

    it('throws NotFound for an id OUTSIDE the access set without ever hitting the DB', async () => {
      const user = makeDataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });

      await expect(service.get(user, 'sub-99')).rejects.toBeInstanceOf(NotFoundException);
      // Critical: tenant check short-circuits before any DB lookup so a
      // cross-tenant id cannot be probed via row existence.
      expect(prisma.subsidiary.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFound when the id is accessible but the row was deleted', async () => {
      const user = makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findUnique.mockResolvedValue(null);

      await expect(service.get(user, 'sub-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create — RBAC + audit', () => {
    const dto = { legalName: 'New Co', geographyCode: 'UK' as const };

    it('throws Forbidden for a non-super_admin and writes no data', async () => {
      const user = makeDataEntry();

      await expect(service.create(user, dto)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.subsidiary.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('throws Forbidden when a super_admin has no organisation context', async () => {
      const user = makeSuperAdmin({ organisationId: null });

      await expect(service.create(user, dto)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.subsidiary.create).not.toHaveBeenCalled();
    });

    it('creates and writes an audit log for super_admin', async () => {
      const user = makeSuperAdmin();
      const created = makeSubsidiary({ id: 'sub-new', legalName: 'New Co' });
      prisma.subsidiary.create.mockResolvedValue(created);
      prisma.auditLog.create.mockResolvedValue({});

      const result = await service.create(user, dto);

      expect(result.id).toBe('sub-new');
      expect(prisma.subsidiary.create).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const auditArg = prisma.auditLog.create.mock.calls[0][0];
      expect(auditArg.data).toMatchObject({
        userId: user.id,
        action: 'create',
        entity: 'subsidiary',
        entityId: 'sub-new',
      });
      expect(auditArg.data.diff).toHaveProperty('after');
    });

    it('applies documented defaults (pending status, scopes [1,2]) for optional fields', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.create.mockResolvedValue(makeSubsidiary({ id: 'sub-new' }));
      prisma.auditLog.create.mockResolvedValue({});

      await service.create(user, dto);

      const createArg = prisma.subsidiary.create.mock.calls[0][0];
      expect(createArg.data.reportingStatus).toBe('pending');
      expect(createArg.data.includedScopes).toEqual([1, 2]);
      expect(createArg.data.organisationId).toBe(user.organisationId);
    });
  });

  describe('update — RBAC + audit', () => {
    it('throws Forbidden for a non-super_admin and mutates nothing', async () => {
      const user = makeDataEntry();

      await expect(
        service.update(user, 'sub-1', { legalName: 'Renamed' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.subsidiary.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('throws NotFound when the row does not exist', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(null);

      await expect(
        service.update(user, 'missing', { legalName: 'Renamed' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.subsidiary.update).not.toHaveBeenCalled();
    });

    it('updates and audits with before/after diff for super_admin', async () => {
      const user = makeSuperAdmin();
      const before = makeSubsidiary({ id: 'sub-1', legalName: 'Old' });
      const after = makeSubsidiary({ id: 'sub-1', legalName: 'New' });
      prisma.subsidiary.findUnique.mockResolvedValue(before);
      prisma.subsidiary.update.mockResolvedValue(after);
      prisma.auditLog.create.mockResolvedValue({});

      const result = await service.update(user, 'sub-1', { legalName: 'New' });

      expect(result.legalName).toBe('New');
      expect(prisma.subsidiary.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: { legalName: 'New' },
      });
      const auditArg = prisma.auditLog.create.mock.calls[0][0];
      expect(auditArg.data.action).toBe('update');
      expect(auditArg.data.diff).toHaveProperty('before');
      expect(auditArg.data.diff).toHaveProperty('after');
    });

    it('only includes explicitly-provided fields in the update payload', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      prisma.subsidiary.update.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      prisma.auditLog.create.mockResolvedValue({});

      await service.update(user, 'sub-1', { reportingStatus: 'active' });

      const updateArg = prisma.subsidiary.update.mock.calls[0][0];
      expect(updateArg.data).toEqual({ reportingStatus: 'active' });
    });
  });

  describe('remove — RBAC + audit', () => {
    it('throws Forbidden for a non-super_admin and deletes nothing', async () => {
      const user = makeDataEntry();

      await expect(service.remove(user, 'sub-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.subsidiary.delete).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('throws NotFound when the row does not exist', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(null);

      await expect(service.remove(user, 'missing')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.subsidiary.delete).not.toHaveBeenCalled();
    });

    it('deletes and audits with the before snapshot for super_admin', async () => {
      const user = makeSuperAdmin();
      const before = makeSubsidiary({ id: 'sub-1' });
      prisma.subsidiary.findUnique.mockResolvedValue(before);
      prisma.subsidiary.delete.mockResolvedValue(before);
      prisma.auditLog.create.mockResolvedValue({});

      const result = await service.remove(user, 'sub-1');

      expect(result).toEqual({ id: 'sub-1', deleted: true });
      expect(prisma.subsidiary.delete).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
      const auditArg = prisma.auditLog.create.mock.calls[0][0];
      expect(auditArg.data.action).toBe('delete');
      expect(auditArg.data.diff).toHaveProperty('before');
    });
  });
});
