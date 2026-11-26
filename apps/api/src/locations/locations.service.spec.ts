import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { LocationsService, TrustedParent } from './locations.service';
import { Prisma } from '@tonyai/db';
import { PrismaService } from '../prisma/prisma.service';
import {
  createPrismaMock,
  makeLocation,
  makeAuditor,
  makeMasterkey,
  makeStandardUser,
  makeSuperAdmin,
  type PrismaMock,
} from '../../test/helpers';

import { AuditService } from '../audit/audit.service';
import type { CalculationsService } from '../calculations/calculations.service';

/**
 * Audit writes go through the shared AuditService. A single shared spy lets the
 * specs assert WHAT was audited; the row shape it stamps (actor role +
 * organisation) is covered by audit.service.spec.ts.
 */
const audit = { record: vi.fn() };
const auditMock = () => audit as unknown as AuditService;

/** The factor library's coverage (inc26-group-tree, D10): UK and TR priced. */
const calculations = {
  coverage: vi.fn(async () => ({
    entries: [
      { geographyCode: 'TR', reportingYear: 2026, statuses: ['authoritative'] },
      { geographyCode: 'UK', reportingYear: 2026, statuses: ['authoritative'] },
    ],
  })),
};
const calculationsMock = () => calculations as unknown as CalculationsService;

describe('LocationsService', () => {
  let prisma: PrismaMock;
  let service: LocationsService;

  beforeEach(() => {

    audit.record.mockClear();
    prisma = createPrismaMock();
    calculations.coverage.mockClear();
    service = new LocationsService(prisma as unknown as PrismaService, auditMock(), calculationsMock());
  });

  describe('list', () => {
    it('scopes the query to the accessible subsidiary set', async () => {
      const user = makeStandardUser({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
      prisma.location.findMany.mockResolvedValue([]);

      await service.list(user);

      expect(prisma.location.findMany).toHaveBeenCalledWith({
        where: { subsidiaryId: { in: ['sub-1', 'sub-2'] } },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('returns empty for an inaccessible subsidiaryId filter without hitting the DB', async () => {
      const user = makeStandardUser({ accessibleSubsidiaryIds: ['sub-1'] });

      const rows = await service.list(user, 'sub-999');

      expect(rows).toEqual([]);
      expect(prisma.location.findMany).not.toHaveBeenCalled();
    });

    it('narrows to a single accessible subsidiary when requested', async () => {
      const user = makeStandardUser({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
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
      const user = makeStandardUser({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.location.findUnique.mockResolvedValue(
        makeLocation({ subsidiaryId: 'sub-999' }),
      );

      await expect(service.get(user, 'loc-x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // The same coded body a missing id gets — nothing of the row in it.
      await expect(service.get(user, 'loc-x')).rejects.toMatchObject({
        response: { code: 'location_not_found', message: 'Location not found' },
      });
      prisma.location.findUnique.mockResolvedValue(null);
      await expect(service.get(user, 'loc-x')).rejects.toMatchObject({
        response: { code: 'location_not_found', message: 'Location not found' },
      });
    });
  });

  describe('create', () => {
    it.each([
      ['a standard_user', makeStandardUser()],
      ['an auditor', makeAuditor()],
    ])('rejects %s with 403, even in a company it reads (location.write)', async (_who, user) => {
      const e = await service
        .create(user, { subsidiaryId: 'sub-1', name: 'HQ', geographyCode: 'TR' })
        .catch((err: unknown) => err);
      expect(e).toBeInstanceOf(ForbiddenException);
      expect((e as Error).message).toBe('Only a masterkey or a super_admin may modify locations');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.txClient.location.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('rejects attaching to an inaccessible subsidiary as not found', async () => {
      const user = makeMasterkey({ accessibleSubsidiaryIds: ['sub-1'] });

      await expect(
        service.create(user, { subsidiaryId: 'sub-999', name: 'HQ', geographyCode: 'TR' }),
      ).rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
      expect(prisma.txClient.location.create).not.toHaveBeenCalled();
    });

    it('creates and writes an audit row', async () => {
      const user = makeMasterkey();
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
      const user = makeMasterkey();
      prisma.txClient.location.create.mockResolvedValue(makeLocation({ subsidiaryId: 'sub-1' }));

      await service.create(user, {
        subsidiaryId: 'sub-1',
        name: 'Istanbul HQ',
        geographyCode: 'TR',
        address: 'Levent, Istanbul',
        authorizedPerson: 'Aylin Demir',
        locationType: 'office',
      });

      expect(prisma.txClient.location.create).toHaveBeenCalledWith({
        data: {
          subsidiaryId: 'sub-1',
          name: 'Istanbul HQ',
          geographyCode: 'TR',
          address: 'Levent, Istanbul',
          authorizedPerson: 'Aylin Demir',
          locationType: 'office',
        },
      });
    });

    describe('the group tree (inc26-group-tree)', () => {
      it('stores a facility with no type as null, and answers it so', async () => {
        prisma.txClient.location.create.mockResolvedValue(makeLocation({ subsidiaryId: 'sub-1' }));
        const dto = await service.create(makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-1'] }), {
          subsidiaryId: 'sub-1', name: 'Depot', geographyCode: 'TR',
        });
        expect(prisma.txClient.location.create.mock.calls[0][0].data.locationType).toBeNull();
        expect(dto.locationType).toBeNull();
      });

      it('answers the stored facility type', async () => {
        prisma.txClient.location.create.mockResolvedValue(makeLocation({ subsidiaryId: 'sub-1', locationType: 'warehouse' }));
        const dto = await service.create(makeMasterkey(), {
          subsidiaryId: 'sub-1', name: 'Depot', geographyCode: 'TR', locationType: 'warehouse',
        });
        expect(dto.locationType).toBe('warehouse');
      });

      it('refuses a facility under a sector group, and writes nothing', async () => {
        prisma.txClient.subsidiary.findUnique.mockResolvedValue({ nodeType: 'sector_group' });
        await expect(
          service.create(makeMasterkey(), { subsidiaryId: 'sub-1', name: 'Depot', geographyCode: 'TR' }),
        ).rejects.toMatchObject({ response: { code: 'node_placement_invalid', statusCode: 400 } });
        expect(prisma.txClient.location.create).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });

      it('refuses a geography the factor library cannot price with 422, naming it, and writes nothing', async () => {
        await expect(
          service.create(makeMasterkey(), { subsidiaryId: 'sub-1', name: 'Munich', geographyCode: 'EU' }),
        ).rejects.toMatchObject({
          status: 422,
          response: { code: 'geography_without_factors', params: { geography: 'EU' } },
        });
        expect(prisma.txClient.location.create).not.toHaveBeenCalled();
      });

      it('answers TA021 reached through a race as node_placement_invalid', async () => {
        prisma.txClient.location.create.mockRejectedValue(
          new Prisma.PrismaClientUnknownRequestError(
            'Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "TA021", message: "node_placement_invalid: subsidiary x is a sector group and holds no facility", severity: "ERROR", detail: None, column: None, hint: None }) })',
            { clientVersion: '6' },
          ),
        );
        await expect(
          service.create(makeMasterkey(), { subsidiaryId: 'sub-1', name: 'Depot', geographyCode: 'TR' }),
        ).rejects.toMatchObject({ response: { code: 'node_placement_invalid' } });
      });
    });

    it('writes against the TrustedParent, never a parent id in the input', async () => {
      // The writer's docblock claims that even if the nested DTO regained a
      // `subsidiaryId`, it would not be read — `Omit<>` erases at runtime, so
      // that structural property is the real defence and nothing asserted it.
      // Driven against the writer itself, because `create()`'s own dto id IS
      // the parameter; only the shared writer can be handed a mismatch.
      const user = makeMasterkey();
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
      const user = makeMasterkey();
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

  describe('a scoped super_admin — facilities in its granted companies only (INC-2.6 task 5.3)', () => {
    // Granted sub-1 and sub-2; sub-3 is a company of the SAME organisation it
    // is not granted — answered as unknown, never 403, so nothing about it leaks.
    const superAdmin = makeSuperAdmin();
    /** The account as the write re-reads it under the admin lock. */
    const standing = (over: Record<string, unknown> = {}) =>
      prisma.txClient.profile.findUnique.mockResolvedValue({
        role: 'super_admin', organisationId: 'org-1', disabledAt: null, organisation: { offboardedAt: null },
        subsidiaryAccess: [{ subsidiaryId: 'sub-1' }, { subsidiaryId: 'sub-2' }], ...over,
      });
    beforeEach(() => standing());

    it("writes nothing once its grant on the company was withdrawn, or the company moved to another organisation, while the request waited (owner's fifth review, P2)", async () => {
      standing({ subsidiaryAccess: [{ subsidiaryId: 'sub-1' }] });
      await expect(service.create(superAdmin, { subsidiaryId: 'sub-2', name: 'Plant', geographyCode: 'TR' }))
        .rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
      const loc = makeLocation({ id: 'loc-2', subsidiaryId: 'sub-2' });
      prisma.location.findUnique.mockResolvedValue(loc);
      prisma.txClient.location.findUnique.mockResolvedValue(loc);
      await expect(service.update(superAdmin, 'loc-2', { locationType: 'warehouse' }))
        .rejects.toMatchObject({ response: { code: 'location_not_found' } });
      // Granted, but the company is no longer in the actor's organisation.
      standing();
      prisma.txClient.$queryRaw.mockImplementation((async (sql: TemplateStringsArray) =>
        (sql.join('?').includes('FROM subsidiaries') ? [] : [{ id: 'locked' }])) as never);
      await expect(service.create(superAdmin, { subsidiaryId: 'sub-2', name: 'Plant', geographyCode: 'TR' }))
        .rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
      await expect(service.update(superAdmin, 'loc-2', { locationType: 'warehouse' }))
        .rejects.toMatchObject({ response: { code: 'location_not_found' } });
      expect(prisma.txClient.location.create).not.toHaveBeenCalled();
      expect(prisma.txClient.location.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('creates a location in a granted company, audited as itself in the same transaction', async () => {
      const created = makeLocation({ subsidiaryId: 'sub-2', name: 'Plant' });
      prisma.txClient.location.create.mockResolvedValue(created);

      const dto = await service.create(superAdmin, { subsidiaryId: 'sub-2', name: 'Plant', geographyCode: 'TR' });

      expect(dto).toMatchObject({ subsidiaryId: 'sub-2', name: 'Plant' });
      expect(prisma.txClient.location.create.mock.calls[0][0].data.subsidiaryId).toBe('sub-2');
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ id: superAdmin.id, role: 'super_admin' }),
        expect.objectContaining({ action: 'create', entity: 'location', entityId: created.id }),
        prisma.txClient,
      );
    });

    it('updates and deletes a location in a granted company, each audited', async () => {
      const existing = makeLocation({ subsidiaryId: 'sub-1', name: 'Old' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.txClient.location.update.mockResolvedValue({ ...existing, name: 'New' });
      prisma.txClient.location.delete.mockResolvedValue(existing);

      expect((await service.update(superAdmin, existing.id, { name: 'New' })).name).toBe('New');
      await service.remove(superAdmin, existing.id);

      expect(audit.record.mock.calls.map(([, entry]) => (entry as { action: string }).action)).toEqual(['update', 'delete']);
      expect(audit.record.mock.calls.every(([actor]) => (actor as { role: string }).role === 'super_admin')).toBe(true);
    });

    it('refuses a create in an ungranted company of its own organisation as subsidiary_not_found — nothing written', async () => {
      const e = await service
        .create(superAdmin, { subsidiaryId: 'sub-3', name: 'HQ', geographyCode: 'TR' })
        .catch((err: unknown) => err);
      expect(e).toBeInstanceOf(NotFoundException);
      expect(e).toMatchObject({ response: { code: 'subsidiary_not_found' } });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.txClient.location.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses an update or delete of a location in an ungranted company as location_not_found — byte for byte a missing one', async () => {
      prisma.location.findUnique.mockResolvedValue(makeLocation({ subsidiaryId: 'sub-3' }));
      const update = await service.update(superAdmin, 'loc-3', { name: 'x' }).catch((err: NotFoundException) => err.getResponse());
      const remove = await service.remove(superAdmin, 'loc-3').catch((err: NotFoundException) => err.getResponse());
      prisma.location.findUnique.mockResolvedValue(null);
      const missing = await service.update(superAdmin, 'loc-3', { name: 'x' }).catch((err: NotFoundException) => err.getResponse());
      expect(update).toMatchObject({ code: 'location_not_found' });
      expect(remove).toEqual(update);
      expect(missing).toEqual(update);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.txClient.location.update).not.toHaveBeenCalled();
      expect(prisma.txClient.location.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('lists only its granted companies\' locations', async () => {
      await service.list(superAdmin);
      expect(prisma.location.findMany).toHaveBeenCalledWith({
        where: { subsidiaryId: { in: ['sub-1', 'sub-2'] } },
        orderBy: { createdAt: 'asc' },
      });
      prisma.location.findMany.mockClear();
      expect(await service.list(superAdmin, 'sub-3')).toEqual([]);
      expect(prisma.location.findMany).not.toHaveBeenCalled();
    });
  });

  describe('update / remove', () => {
    it.each([
      ['a standard_user', makeStandardUser()],
      ['an auditor', makeAuditor()],
    ])('rejects %s updates and deletes with 403, before reading the location', async (_who, user) => {
      prisma.location.findUnique.mockResolvedValue(makeLocation({ subsidiaryId: 'sub-1' }));
      for (const write of [
        () => service.update(user, 'loc-1', { name: 'New name' }),
        () => service.remove(user, 'loc-1'),
      ]) {
        const e = await write().catch((err: unknown) => err);
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as Error).message).toBe('Only a masterkey or a super_admin may modify locations');
      }
      expect(prisma.location.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('sets, and clears, the facility type (inc26-group-tree)', async () => {
      const existing = makeLocation({ subsidiaryId: 'sub-1' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.txClient.location.update.mockResolvedValue({ ...existing, locationType: 'factory' });
      expect((await service.update(makeMasterkey(), existing.id, { locationType: 'factory' })).locationType).toBe('factory');
      expect(prisma.txClient.location.update).toHaveBeenLastCalledWith({ where: { id: existing.id }, data: { locationType: 'factory' } });
      prisma.txClient.location.update.mockResolvedValue({ ...existing, locationType: null });
      await service.update(makeMasterkey(), existing.id, { locationType: null });
      expect(prisma.txClient.location.update).toHaveBeenLastCalledWith({ where: { id: existing.id }, data: { locationType: null } });
    });

    it('saves a facility from before the release with its stored, unpriced geography unchanged', async () => {
      const existing = makeLocation({ subsidiaryId: 'sub-1', geographyCode: 'EU' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.txClient.location.update.mockResolvedValue({ ...existing, name: 'Renamed' });
      await service.update(makeMasterkey(), existing.id, { name: 'Renamed', geographyCode: 'EU' });
      expect(calculations.coverage).not.toHaveBeenCalled();
      expect(prisma.txClient.location.update).toHaveBeenCalled();
    });

    it('judges the stored-geography exception against the row as locked: a stale edit cannot write an unpriced one back (owner review of WP7, P2)', async () => {
      // Read as EU; changed to TR by another edit before this one locked it.
      prisma.location.findUnique.mockResolvedValue(makeLocation({ subsidiaryId: 'sub-1', geographyCode: 'EU' }));
      prisma.txClient.location.findUnique.mockResolvedValue(makeLocation({ subsidiaryId: 'sub-1', geographyCode: 'TR' }));
      await expect(service.update(makeMasterkey(), 'loc-1', { name: 'Renamed', geographyCode: 'EU' })).rejects.toMatchObject({ status: 422 });
      expect(prisma.txClient.location.update).not.toHaveBeenCalled();
      // Locked FOR UPDATE before the read.
      expect((prisma.txClient.$queryRaw.mock.calls[0][0] as unknown as string[]).join('?')).toMatch(/FROM locations WHERE id = \?::uuid FOR UPDATE/);
    });

    it('refuses a change to an unpriced geography with 422, and writes nothing', async () => {
      const existing = makeLocation({ subsidiaryId: 'sub-1', geographyCode: 'TR' });
      prisma.location.findUnique.mockResolvedValue(existing);
      await expect(service.update(makeMasterkey(), existing.id, { geographyCode: 'EU' })).rejects.toMatchObject({
        status: 422,
        response: { code: 'geography_without_factors', params: { geography: 'EU' } },
      });
      expect(prisma.txClient.location.update).not.toHaveBeenCalled();
    });

    it('accepts a change to a priced geography', async () => {
      const existing = makeLocation({ subsidiaryId: 'sub-1', geographyCode: 'UK' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.txClient.location.update.mockResolvedValue({ ...existing, geographyCode: 'TR' });
      expect((await service.update(makeMasterkey(), existing.id, { geographyCode: 'TR' })).geographyCode).toBe('TR');
      expect(calculations.coverage).toHaveBeenCalledTimes(1);
    });

    it('updates only provided fields and audits with before/after', async () => {
      const user = makeMasterkey();
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

    it('answers a record filed between the check and the delete with the same 409, not a 500 (LP4-01)', async () => {
      // The site's key is RESTRICT since LP4-01: the race the check cannot
      // close (it runs before the transaction) now fails the DELETE with
      // P2003 instead of re-filing the newcomer at company level.
      const user = makeMasterkey();
      const existing = makeLocation({ subsidiaryId: 'sub-1' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.activityRecord.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      prisma.txClient.location.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', { code: 'P2003', clientVersion: 'test' }),
      );

      await expect(service.remove(user, existing.id)).rejects.toThrow(/1 activity record/);
    });

    it('answers 404, not a 500, when a concurrent delete removed the site first (pre-pilot defects)', async () => {
      const user = makeMasterkey();
      const existing = makeLocation({ subsidiaryId: 'sub-1' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.txClient.location.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record to delete does not exist.', { code: 'P2025', clientVersion: 'test' }),
      );

      await expect(service.remove(user, existing.id)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'location_not_found' }),
      });
      // The winner wrote the delete's audit row; the loser writes none.
      expect(audit.record).not.toHaveBeenCalled();
    });

    describe('deleteLocationForTrustedParent (Codex review of #350)', () => {
      const gone = () =>
        new Prisma.PrismaClientKnownRequestError('Record to delete does not exist.', { code: 'P2025', clientVersion: 'test' });

      it('answers true and audits the row it deleted', async () => {
        const location = makeLocation({ subsidiaryId: 'sub-1' });
        prisma.txClient.location.delete.mockResolvedValue(location);
        await expect(service.deleteLocationForTrustedParent(prisma.txClient as never, makeMasterkey(), location)).resolves.toBe(true);
        expect(audit.record).toHaveBeenCalledTimes(1);
      });

      it('answers false, with no audit row and no error, for a row a concurrent delete removed first', async () => {
        // The subsidiary sweep's case: its transaction must carry on, not roll back as a 500.
        const location = makeLocation({ subsidiaryId: 'sub-1' });
        prisma.txClient.location.delete.mockRejectedValue(gone());
        await expect(service.deleteLocationForTrustedParent(prisma.txClient as never, makeMasterkey(), location)).resolves.toBe(false);
        expect(audit.record).not.toHaveBeenCalled();
      });

      it.each(['P2003', 'P2034'])('passes any other failure through (%s)', async (code) => {
        const location = makeLocation({ subsidiaryId: 'sub-1' });
        const failure = new Prisma.PrismaClientKnownRequestError('another failure', { code, clientVersion: 'test' });
        prisma.txClient.location.delete.mockRejectedValue(failure);
        await expect(service.deleteLocationForTrustedParent(prisma.txClient as never, makeMasterkey(), location)).rejects.toBe(failure);
        expect(audit.record).not.toHaveBeenCalled();
      });
    });

    it('passes any other failure through unchanged, even with a record now at the site', async () => {
      // Only the key's refusal means "a record arrived": an audit-insert or
      // connection failure must surface as itself, not as a 409 about records.
      const user = makeMasterkey();
      const existing = makeLocation({ subsidiaryId: 'sub-1' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.activityRecord.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      const failure = new Error('audit insert failed');
      prisma.txClient.location.delete.mockRejectedValue(failure);

      await expect(service.remove(user, existing.id)).rejects.toBe(failure);
      expect(prisma.activityRecord.count).toHaveBeenCalledTimes(1);
    });

    it('refuses to delete a site declared in an inventory boundary version, and deletes nothing (W9)', async () => {
      const user = makeMasterkey();
      const existing = makeLocation({ subsidiaryId: 'sub-1' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.inventoryBoundarySite.count.mockResolvedValue(2);

      await expect(service.remove(user, existing.id)).rejects.toThrow(/declared in 2 inventory boundary version\(s\)/);
      await expect(service.remove(user, existing.id)).rejects.toMatchObject({
        response: { code: 'location_in_boundary', params: { count: 2 } },
      });
      prisma.inventoryBoundarySite.count.mockResolvedValue(7);
      await expect(service.remove(user, existing.id)).rejects.toMatchObject({
        response: { code: 'location_in_boundary', params: { count: 7 } },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('answers a version declaring the site between the check and the delete with the same 409, not a 500 (W9)', async () => {
      // The boundary's guard refuses the cascade (TA014) — the race the check
      // cannot close. Prisma reports a trigger's RAISE on a model query as an
      // unknown request error carrying the PostgreSQL code.
      const user = makeMasterkey();
      const existing = makeLocation({ subsidiaryId: 'sub-1' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.inventoryBoundarySite.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      prisma.txClient.location.delete.mockRejectedValue(
        new Prisma.PrismaClientUnknownRequestError(
          'Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "TA014", message: "site is declared in inventory boundary", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
          { clientVersion: 'test' },
        ),
      );

      await expect(service.remove(user, existing.id)).rejects.toThrow(/declared in 1 inventory boundary version\(s\)/);
    });

    it('answers 409 once the guard refused, even if the declaring version is gone by the recount (Codex B9 P2-2)', async () => {
      // The guard's TA014 means a version declared the site when the delete
      // ran; a recount after that version's removal finds none — the delete
      // still did not happen, and the answer is still the conflict, never 500.
      const user = makeMasterkey();
      const existing = makeLocation({ subsidiaryId: 'sub-1' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.inventoryBoundarySite.count.mockResolvedValue(0);
      prisma.txClient.location.delete.mockRejectedValue(
        new Prisma.PrismaClientUnknownRequestError(
          'Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "TA014", message: "site is declared in inventory boundary", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
          { clientVersion: 'test' },
        ),
      );

      const refusal = await service.remove(user, existing.id).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as Error).message).toMatch(/inventory boundary version/);
      expect((refusal as ConflictException).getResponse()).toMatchObject({ code: 'location_declared_during_delete' });
    });

    it('refuses to delete a location that records are attached to', async () => {
      // The FK was ON DELETE SET NULL (RESTRICT since LP4-01), so this used to succeed and leave every
      // referencing record claiming the SUBSIDIARY's geography while its frozen
      // snapshot was computed from the LOCATION's — measured live: subsidiary
      // TR, location UK, record detached with 'UK' still in the snapshot.
      const user = makeMasterkey();
      const existing = makeLocation({ subsidiaryId: 'sub-1' });
      prisma.location.findUnique.mockResolvedValue(existing);
      prisma.activityRecord.count.mockResolvedValue(3);

      await expect(service.remove(user, existing.id)).rejects.toThrow(/3 activity record/);
      await expect(service.remove(user, existing.id)).rejects.toMatchObject({
        response: { code: 'location_has_records', params: { count: 3 } },
      });
      expect(prisma.txClient.location.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('removes a scoped location and audits it', async () => {
      const user = makeMasterkey();
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
      // …and the DELETE itself, which that comment describes but never checked.
      // Swapping `db.location.delete` for `this.prisma.location.delete` left
      // 409 tests green — and it destroys the row OUTSIDE the transaction while
      // its audit row stays inside, so a later failure commits the destruction
      // and rolls back the trail. The unaudited cascade WP16 PR 1 exists to
      // stop, reintroduced through the fix for it.
      expect(prisma.txClient.location.delete).toHaveBeenCalledWith({
        where: { id: existing.id },
      });
      expect(prisma.location.delete).not.toHaveBeenCalled();
    });

    it('treats deleting a location outside the access set as not found', async () => {
      const user = makeMasterkey({ accessibleSubsidiaryIds: ['sub-1'] });
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
