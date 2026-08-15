import { describe, it, expect, beforeEach, vi } from 'vitest';
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

import { AuditService } from '../audit/audit.service';

/**
 * Audit writes go through the shared AuditService. A single shared spy lets the
 * specs assert WHAT was audited; the row shape it stamps (actor role +
 * organisation) is covered by audit.service.spec.ts.
 */
const audit = { record: vi.fn() };
const auditMock = () => audit as unknown as AuditService;

/**
 * Await a call that must be refused and hand back its message. A plain
 * `.catch(e => e)` types as "error OR the success value", and a guard that
 * stopped throwing would then be asserted against an object with no `message`
 * at all — green by accident.
 */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected this call to be refused, but it succeeded');
}

/**
 * The delete guard counts committed and still-editable records separately, in
 * one `Promise.all` against the same mock. Route each call by the filter it
 * actually sends, so "3 drafts" cannot silently also mean "3 approved" — the
 * two lead to opposite advice.
 */
function countRecords(
  prisma: PrismaMock,
  { committed = 0, open = 0 }: { committed?: number; open?: number },
): void {
  prisma.activityRecord.count.mockImplementation(async ({ where }: any) =>
    where.status?.in ? open : committed,
  );
}

describe('SubsidiariesService', () => {
  let prisma: PrismaMock;
  let service: SubsidiariesService;

  beforeEach(() => {

    audit.record.mockClear();
    prisma = createPrismaMock();
    // Direct instantiation with the mock — the service only depends on the
    // narrow PrismaService surface, so no Nest container / DB is needed.
    service = new SubsidiariesService(prisma as unknown as PrismaService, auditMock());
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
      expect(audit.record).not.toHaveBeenCalled();
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
            const result = await service.create(user, dto);

      expect(result.id).toBe('sub-new');
      expect(prisma.subsidiary.create).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledTimes(1);
      // The actor is the first argument now; the entry describes the change.
      expect(audit.record.mock.calls[0][0]).toMatchObject({ id: user.id });
      const auditArg = audit.record.mock.calls[0][1];
      expect(auditArg).toMatchObject({
        action: 'create',
        entity: 'subsidiary',
        entityId: 'sub-new',
      });
      expect(auditArg.diff).toHaveProperty('after');
    });

    it('applies documented defaults (pending status, scopes [1,2]) for optional fields', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.create.mockResolvedValue(makeSubsidiary({ id: 'sub-new' }));
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
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses to update a subsidiary outside the access set WITHOUT querying it', async () => {
      // Regression guard for the cross-tenant write hole: update used to check
      // the ROLE only and then findUnique by id, so a super_admin of one
      // organisation could edit another's subsidiary. The "never queried"
      // assertion is what distinguishes the fix from the old code — a
      // not-found id alone would 404 either way.
      const user = makeSuperAdmin();

      await expect(
        service.update(user, 'sub-of-another-org', { legalName: 'Hijacked' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.subsidiary.findUnique).not.toHaveBeenCalled();
      expect(prisma.subsidiary.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('throws NotFound when an in-scope row has since been deleted', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(null);

      await expect(
        service.update(user, 'sub-1', { legalName: 'Renamed' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.subsidiary.update).not.toHaveBeenCalled();
    });

    it('updates and audits with before/after diff for super_admin', async () => {
      const user = makeSuperAdmin();
      const before = makeSubsidiary({ id: 'sub-1', legalName: 'Old' });
      const after = makeSubsidiary({ id: 'sub-1', legalName: 'New' });
      prisma.subsidiary.findUnique.mockResolvedValue(before);
      prisma.subsidiary.update.mockResolvedValue(after);
            const result = await service.update(user, 'sub-1', { legalName: 'New' });

      expect(result.legalName).toBe('New');
      expect(prisma.subsidiary.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: { legalName: 'New' },
      });
      const auditArg = audit.record.mock.calls[0][1];
      expect(auditArg.action).toBe('update');
      expect(auditArg.diff).toHaveProperty('before');
      expect(auditArg.diff).toHaveProperty('after');
    });

    it('a geography change touches ONLY the subsidiary — no record is recalculated', async () => {
      // The UI warns before this change, and the warning tells the user that
      // committed figures do not move. That promise rests entirely on this:
      // `geographyCode` is read at record-WRITE time and frozen into the
      // calculation snapshot, so updating the subsidiary must not reach into
      // activity_records at all. If it ever did, the warning would be a lie and
      // historic emissions would silently change.
      const user = makeSuperAdmin();
      const before = makeSubsidiary({ id: 'sub-1', geographyCode: 'UK' });
      const after = makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' });
      prisma.subsidiary.findUnique.mockResolvedValue(before);
      prisma.subsidiary.update.mockResolvedValue(after);

      const result = await service.update(user, 'sub-1', { geographyCode: 'TR' });

      // Assert the PAYLOAD, not just the returned row: the row comes from the
      // mocked resolution, so dropping `geographyCode` from the update data
      // left this green (found by mutation).
      expect(prisma.subsidiary.update.mock.calls[0][0].data).toEqual({
        geographyCode: 'TR',
      });
      expect(result.geographyCode).toBe('TR');
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
      expect(prisma.activityRecord.updateMany).not.toHaveBeenCalled();
      expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();

      // The change is reconstructible from the audit trail on its own.
      const diff = audit.record.mock.calls[0][1].diff as {
        before: { geographyCode: string };
        after: { geographyCode: string };
      };
      expect(diff.before.geographyCode).toBe('UK');
      expect(diff.after.geographyCode).toBe('TR');
    });

    it('only includes explicitly-provided fields in the update payload', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      prisma.subsidiary.update.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
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
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses to delete a subsidiary outside the access set WITHOUT querying it', async () => {
      const user = makeSuperAdmin();

      await expect(service.remove(user, 'sub-of-another-org')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.subsidiary.findUnique).not.toHaveBeenCalled();
      expect(prisma.subsidiary.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('throws NotFound when an in-scope row has since been deleted', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(null);

      await expect(service.remove(user, 'sub-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.subsidiary.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete a subsidiary that still holds committed records', async () => {
      // `ActivityRecord.subsidiary` is ON DELETE CASCADE, so a delete did not
      // detach those records — it DESTROYED them with their evidence, targets
      // and period locks. Measured: a record taken through submit AND approve
      // was a 404 immediately after one DELETE, leaving one "delete subsidiary"
      // audit row and nothing about the approved figures that went with it.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, { committed: 102 });

      await expect(service.remove(user, 'sub-1')).rejects.toThrow(
        /102 submitted, approved or locked/,
      );
      // Committed records cannot be deleted at all, so "inactive" is the only
      // thing the caller can actually do — the message must say so.
      await expect(service.remove(user, 'sub-1')).rejects.toThrow(/"inactive"/);
      expect(prisma.subsidiary.delete).not.toHaveBeenCalled();
    });

    it('blocks on drafts, but tells the caller they can be removed', async () => {
      // A drafts-only subsidiary is fully recoverable — the drafts delete
      // through their own endpoint. Sending that caller to `inactive` would be
      // the mirror image of unfollowable advice: telling someone not to bother
      // with the one action that would work.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, { open: 3 });

      const message = await refusal(service.remove(user, 'sub-1'));
      expect(message).toMatch(/3 draft or rejected record\(s\)/);
      expect(message).not.toMatch(/"inactive"/);
      expect(prisma.subsidiary.delete).not.toHaveBeenCalled();
    });

    it('blocks on a closed period, and on locations/targets/denominators', async () => {
      // The cascade erases a period lock WITHOUT the `unlock` audit row that
      // `DELETE /period-locks/:id` writes — a closed reporting period reopened
      // with no trace. Same for targets and denominators: compliance artifacts
      // that would vanish behind one "delete subsidiary" row.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, {});
      prisma.periodLock.count.mockResolvedValue(1);
      prisma.location.count.mockResolvedValue(2);
      prisma.target.count.mockResolvedValue(1);
      prisma.subsidiaryDenominator.count.mockResolvedValue(1);

      const message = await refusal(service.remove(user, 'sub-1'));
      expect(message).toMatch(/2 location\(s\)/);
      expect(message).toMatch(/1 closed reporting period\(s\)/);
      expect(message).toMatch(/1 reduction target\(s\)/);
      expect(message).toMatch(/1 intensity denominator\(s\)/);
      expect(prisma.subsidiary.delete).not.toHaveBeenCalled();
    });

    it('deletes and audits with the before snapshot for super_admin', async () => {
      const user = makeSuperAdmin();
      const before = makeSubsidiary({ id: 'sub-1' });
      prisma.subsidiary.findUnique.mockResolvedValue(before);
      prisma.subsidiary.delete.mockResolvedValue(before);
            const result = await service.remove(user, 'sub-1');

      expect(result).toEqual({ id: 'sub-1', deleted: true });
      expect(prisma.subsidiary.delete).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
      const auditArg = audit.record.mock.calls[0][1];
      expect(auditArg.action).toBe('delete');
      expect(auditArg.diff).toHaveProperty('before');
      // Written through the transaction client — a delete whose audit row fails
      // must roll back, or the subsidiary is gone with no trail at all.
      expect(audit.record.mock.calls[0][2]).toBe(prisma);
    });
  });
});
