import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { LocationsService } from './locations.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createPrismaMock,
  makeLocation,
  makeSuperAdmin,
  makeDataEntry,
  type PrismaMock,
} from '../../test/helpers';

import { AuditService } from '../audit/audit.service';

/**
 * Audit writes go through the shared AuditService. A single shared spy lets the
 * specs assert WHAT was audited; the row shape it stamps (actor role +
 * organisation) is covered by audit.service.spec.ts.
 */
const audit = { record: vi.fn() };
const auditMock = () => audit as unknown as AuditService;

describe('LocationsService', () => {
  let prisma: PrismaMock;
  let service: LocationsService;

  beforeEach(() => {

    audit.record.mockClear();
    prisma = createPrismaMock();
    service = new LocationsService(prisma as unknown as PrismaService, auditMock());
  });

  describe('list', () => {
    it('scopes the query to the accessible subsidiary set', async () => {
      const user = makeDataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
      prisma.location.findMany.mockResolvedValue([]);

      await service.list(user);

      expect(prisma.location.findMany).toHaveBeenCalledWith({
        where: { subsidiaryId: { in: ['sub-1', 'sub-2'] } },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('returns empty for an inaccessible subsidiaryId filter without hitting the DB', async () => {
      const user = makeDataEntry({ accessibleSubsidiaryIds: ['sub-1'] });

      const rows = await service.list(user, 'sub-999');

      expect(rows).toEqual([]);
      expect(prisma.location.findMany).not.toHaveBeenCalled();
    });

    it('narrows to a single accessible subsidiary when requested', async () => {
      const user = makeDataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
      prisma.location.findMany.mockResolvedValue([
        makeLocation({ subsidiaryId: 'sub-2', name: 'Plant A' }),
      ]);

      const rows = await service.list(user, 'sub-2');

      expect(prisma.location.findMany).toHaveBeenCalledWith({
        where: { subsidiaryId: 'sub-2' },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows[0]).toMatchObject({ subsidiaryId: 'sub-2', name: 'Plant A' });
    });
  });

  describe('get', () => {
    it('treats a location under an inaccessible subsidiary as not found', async () => {
      const user = makeDataEntry({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.location.findUnique.mockResolvedValue(
        makeLocation({ subsidiaryId: 'sub-999' }),
      );

      await expect(service.get(user, 'loc-x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('rejects non-super_admin writes with 403', async () => {
      const user = makeDataEntry();

      await expect(
        service.create(user, { subsidiaryId: 'sub-1', name: 'HQ', geographyCode: 'TR' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.location.create).not.toHaveBeenCalled();
    });

    it('rejects attaching to an inaccessible subsidiary as not found', async () => {
      const user = makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-1'] });

      await expect(
        service.create(user, { subsidiaryId: 'sub-999', name: 'HQ', geographyCode: 'TR' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.location.create).not.toHaveBeenCalled();
    });

    it('creates and writes an audit row', async () => {
      const user = makeSuperAdmin();
      const created = makeLocation({ subsidiaryId: 'sub-1', name: 'HQ' });
      prisma.location.create.mockResolvedValue(created);

      const dto = await service.create(user, { subsidiaryId: 'sub-1', name: 'HQ', geographyCode: 'TR' });

      expect(dto).toMatchObject({ subsidiaryId: 'sub-1', name: 'HQ' });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({
            action: 'create',
            entity: 'location',
            entityId: created.id,
          }),
      );
    });
  });

  describe('update / remove', () => {
    it('rejects non-super_admin updates with 403', async () => {
      const user = makeDataEntry();

      await expect(
        service.update(user, 'loc-1', { name: 'New name' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('updates only provided fields and audits with before/after', async () => {
      const user = makeSuperAdmin();
      const existing = makeLocation({ subsidiaryId: 'sub-1', name: 'Old' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.location.update.mockResolvedValue({ ...existing, name: 'New' });

      const dto = await service.update(user, existing.id, { name: 'New' });

      expect(prisma.location.update).toHaveBeenCalledWith({
        where: { id: existing.id },
        data: { name: 'New' },
      });
      expect(dto.name).toBe('New');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({ action: 'update', entity: 'location' }),
      );
    });

    it('removes a scoped location and audits it', async () => {
      const user = makeSuperAdmin();
      const existing = makeLocation({ subsidiaryId: 'sub-1' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.location.delete.mockResolvedValue(existing);

      const res = await service.remove(user, existing.id);

      expect(res).toEqual({ id: existing.id, deleted: true });
      // The third argument is the transaction client: the row is gone after
      // this call, so a failed audit insert must roll the delete back with it.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({ action: 'delete', entity: 'location' }),
        prisma,
      );
    });

    it('treats deleting a location outside the access set as not found', async () => {
      const user = makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.location.findUnique.mockResolvedValue(
        makeLocation({ subsidiaryId: 'sub-999' }),
      );

      await expect(service.remove(user, 'loc-x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.location.delete).not.toHaveBeenCalled();
    });
  });
});
