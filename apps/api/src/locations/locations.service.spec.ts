import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { LocationsService, TrustedParent } from './locations.service';
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
      expect(prisma.txClient.location.create).not.toHaveBeenCalled();
    });

    it('rejects attaching to an inaccessible subsidiary as not found', async () => {
      const user = makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-1'] });

      await expect(
        service.create(user, { subsidiaryId: 'sub-999', name: 'HQ', geographyCode: 'TR' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.txClient.location.create).not.toHaveBeenCalled();
    });

    it('creates and writes an audit row', async () => {
      const user = makeSuperAdmin();
      const created = makeLocation({ subsidiaryId: 'sub-1', name: 'HQ' });
      prisma.txClient.location.create.mockResolvedValue(created);

      const dto = await service.create(user, { subsidiaryId: 'sub-1', name: 'HQ', geographyCode: 'TR' });

      expect(dto).toMatchObject({ subsidiaryId: 'sub-1', name: 'HQ' });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({
          action: 'create',
          entity: 'location',
          entityId: created.id,
        }),
        // Third argument: the transaction client. This endpoint used to write
        // its audit row AFTER the mutation, on the default client, so a crash
        // in between left a location with no trail — the failure the audit
        // service's own docblock records. Sharing the writer with the
        // subsidiary create fixed it here as a side effect, and this pins it.
        prisma.txClient,
      );
    });

    it('carries every field through to the row, not just the required ones', async () => {
      // Nothing asserted that `address`/`authorizedPerson` arrive with a VALUE
      // — only that a blank becomes null — so hardcoding them to null in the
      // writer passed 401 unit tests and 71 E2E. Silent data loss on both
      // create paths, in code this PR introduced.
      const user = makeSuperAdmin();
      prisma.txClient.location.create.mockResolvedValue(makeLocation({ subsidiaryId: 'sub-1' }));

      await service.create(user, {
        subsidiaryId: 'sub-1',
        name: 'Istanbul HQ',
        geographyCode: 'TR',
        address: 'Levent, Istanbul',
        authorizedPerson: 'Aylin Demir',
      });

      expect(prisma.txClient.location.create).toHaveBeenCalledWith({
        data: {
          subsidiaryId: 'sub-1',
          name: 'Istanbul HQ',
          geographyCode: 'TR',
          address: 'Levent, Istanbul',
          authorizedPerson: 'Aylin Demir',
        },
      });
    });

    it('writes against the TrustedParent, never a parent id in the input', async () => {
      // The writer's docblock claims that even if the nested DTO regained a
      // `subsidiaryId`, it would not be read — `Omit<>` erases at runtime, so
      // that structural property is the real defence and nothing asserted it.
      // Driven against the writer itself, because `create()`'s own dto id IS
      // the parameter; only the shared writer can be handed a mismatch.
      const user = makeSuperAdmin();
      prisma.txClient.location.create.mockResolvedValue(makeLocation({ subsidiaryId: 'sub-1' }));
      const parent = TrustedParent.becauseInAccessibleSet(user, 'sub-1');

      await service.writeLocationForTrustedParent(
        prisma.txClient as never,
        user,
        parent,
        { name: 'HQ', geographyCode: 'TR', subsidiaryId: 'sub-OTHER' } as never,
      );

      expect(prisma.txClient.location.create.mock.calls[0][0].data.subsidiaryId).toBe('sub-1');
    });

    it('writes the row and its audit entry in ONE transaction', async () => {
      const user = makeSuperAdmin();
      prisma.txClient.location.create.mockResolvedValue(makeLocation({ subsidiaryId: 'sub-1' }));

      await service.create(user, { subsidiaryId: 'sub-1', name: 'HQ', geographyCode: 'TR' });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // …and on the transaction's client, not the default one. Before the mock
      // handed out a distinct object this was unassertable.
      expect(prisma.txClient.location.create).toHaveBeenCalled();
      expect(audit.record.mock.calls[0][2]).toBe(prisma.txClient);
      // EXACTLY one row. A writer that audited twice passed the unit suite and
      // the whole E2E run, because every assertion read `calls[0]` or
      // `items[0]` and never a count.
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(prisma.txClient.location.create).toHaveBeenCalledTimes(1);
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
      prisma.txClient.location.update.mockResolvedValue({ ...existing, name: 'New' });

      const dto = await service.update(user, existing.id, { name: 'New' });

      expect(prisma.txClient.location.update).toHaveBeenCalledWith({
        where: { id: existing.id },
        data: { name: 'New' },
      });
      expect(dto.name).toBe('New');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({ action: 'update', entity: 'location' }),
        // Third argument: the transaction client. Create and delete were
        // already atomic; update wrote its audit row afterwards on the default
        // client, so a crash in between lost the trail for exactly one of the
        // three verbs — the sort of half-state that reads as safe.
        prisma.txClient,
      );
    });

    it('refuses to delete a location that records are attached to', async () => {
      // The FK is ON DELETE SET NULL, so this used to succeed and leave every
      // referencing record claiming the SUBSIDIARY's geography while its frozen
      // snapshot was computed from the LOCATION's — measured live: subsidiary
      // TR, location UK, record detached with 'UK' still in the snapshot.
      const user = makeSuperAdmin();
      const existing = makeLocation({ subsidiaryId: 'sub-1' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.activityRecord.count.mockResolvedValue(3);

      await expect(service.remove(user, existing.id)).rejects.toThrow(/3 activity record/);
      expect(prisma.txClient.location.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('removes a scoped location and audits it', async () => {
      const user = makeSuperAdmin();
      const existing = makeLocation({ subsidiaryId: 'sub-1' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.activityRecord.count.mockResolvedValue(0);
      prisma.txClient.location.delete.mockResolvedValue(existing);

      const res = await service.remove(user, existing.id);

      expect(res).toEqual({ id: existing.id, deleted: true });
      // The third argument is the transaction client: the row is gone after
      // this call, so a failed audit insert must roll the delete back with it.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({ action: 'delete', entity: 'location' }),
        prisma.txClient,
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
      expect(prisma.txClient.location.delete).not.toHaveBeenCalled();
    });
  });
});
