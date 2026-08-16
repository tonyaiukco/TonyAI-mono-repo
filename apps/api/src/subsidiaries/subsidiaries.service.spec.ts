import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Subsidiary } from '@tonyai/db';
import { SubsidiariesService } from './subsidiaries.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createPrismaMock,
  stubRead,
  makeLocation,
  makeSubsidiary,
  makeSuperAdmin,
  makeDataEntry,
  type PrismaMock,
} from '../../test/helpers';

import { AuditService } from '../audit/audit.service';
import { LocationsService, TrustedParent } from '../locations/locations.service';

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
 * Give the subsidiary a real set of record statuses, and let each of the guard's
 * three count queries filter it the way Postgres would.
 *
 * The first cut handed each query a fixed number instead, keyed off the shape of
 * its `where`. That decoupled the buckets from each other, and it cost a real
 * mutation: folding `submitted` back in with `approved` — the exact bug this
 * grading exists to fix — left the suite green, because the obliging mock never
 * let one record be seen by two queries. It has to be one set, filtered.
 */
/**
 * The guard asks `location.count` twice with different filters — all of them,
 * and only the ones holding activity records. A single `mockResolvedValue`
 * answers both, which made a subsidiary with two plain locations look like a
 * subsidiary with two locations full of records. Route by the filter, the way
 * `countRecords` does for statuses.
 */
function countLocations(
  prisma: PrismaMock,
  { total = 0, holdingForeign = 0 }: { total?: number; holdingForeign?: number },
): void {
  // Routes on the FILTER's contents, not merely on the key being present. The
  // earlier version answered any `activityRecords` clause the same way, so
  // narrowing the query from "records of another subsidiary" to "records of
  // this one" — which is the whole meaning of the tier — was invisible.
  const impl = async ({ where }: any) => {
    if (!where.activityRecords) return total;
    return where.activityRecords.some?.subsidiaryId?.not ? holdingForeign : 0;
  };
  prisma.location.count.mockImplementation(impl);
  prisma.txClient.location.count.mockImplementation(impl);
}

function countRecords(prisma: PrismaMock, statuses: string[]): void {
  // Both clients: `summary()` counts on the default one and the delete guard
  // counts on the transaction's, and a test that means "the database contains
  // these records" should not have to know which path it is exercising. Reads
  // are client-agnostic; mutations are not, and those are asserted per-client.
  const impl = async ({ where }: any) => {
    const f = where.status;
    return statuses.filter((s) => (f.in ? f.in.includes(s) : !f.notIn.includes(s)))
      .length;
  };
  prisma.activityRecord.count.mockImplementation(impl);
  prisma.txClient.activityRecord.count.mockImplementation(impl);
}

describe('SubsidiariesService', () => {
  let prisma: PrismaMock;
  let service: SubsidiariesService;
  /**
   * The shared location writer, mocked. The real one lives in
   * `LocationsService` so a location created during a subsidiary create writes
   * the SAME audit row as one added later; that shape is pinned by
   * `locations.service.spec.ts`, and what belongs here is that this service
   * calls it once per location, inside the transaction, with the new id.
   */
  let locations: {
    writeLocationForTrustedParent: ReturnType<typeof vi.fn>;
    deleteLocationForTrustedParent: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {

    audit.record.mockClear();
    prisma = createPrismaMock();
    // Direct instantiation with the mock — the service only depends on the
    // narrow PrismaService surface, so no Nest container / DB is needed.
    locations = {
      writeLocationForTrustedParent: vi.fn(),
      deleteLocationForTrustedParent: vi.fn(),
    };
    service = new SubsidiariesService(
      prisma as unknown as PrismaService,
      auditMock(),
      locations as unknown as LocationsService,
    );
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
      expect(prisma.txClient.subsidiary.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('throws Forbidden when a super_admin has no organisation context', async () => {
      const user = makeSuperAdmin({ organisationId: null });

      await expect(service.create(user, dto)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.txClient.subsidiary.create).not.toHaveBeenCalled();
    });

    it('creates and writes an audit log for super_admin', async () => {
      const user = makeSuperAdmin();
      const created = makeSubsidiary({ id: 'sub-new', legalName: 'New Co' });
      prisma.txClient.subsidiary.create.mockResolvedValue(created);
            const result = await service.create(user, dto);

      expect(result.id).toBe('sub-new');
      expect(prisma.txClient.subsidiary.create).toHaveBeenCalledTimes(1);
      // One row for the subsidiary. With locations it is one MORE per location
      // — see the SUB-3 tests below; never a single batched row, or a
      // location's history would depend on how it was created.
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

    it('creates its locations in the SAME transaction, one audit row each', async () => {
      // Round-1 SUB-3. Atomic on purpose: a subsidiary's locations are its
      // reporting borders, and a partial set is a completeness denominator
      // that is quietly wrong rather than obviously missing.
      const user = makeSuperAdmin();
      prisma.txClient.subsidiary.create.mockResolvedValue(makeSubsidiary({ id: 'sub-new' }));

      await service.create(user, {
        legalName: 'New Co',
        geographyCode: 'UK',
        locations: [
          { name: 'Istanbul HQ', geographyCode: 'TR' },
          { name: 'Leeds Depot', geographyCode: 'UK', address: 'Holbeck' },
        ],
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(locations.writeLocationForTrustedParent).toHaveBeenCalledTimes(2);
      // On the TRANSACTION's client. `$transaction` being called once proves
      // nothing here — the subsidiary's own create opens it regardless — so
      // writing the locations on `this.prisma` instead passed until the mock
      // started handing out a distinct object.
      for (const call of locations.writeLocationForTrustedParent.mock.calls) {
        expect(call[0]).toBe(prisma.txClient);
      }
      expect(audit.record.mock.calls[0][2]).toBe(prisma.txClient);
      // The parent id is the one this transaction just minted — it cannot come
      // from the caller, and it is not yet in `accessibleSubsidiaryIds`, which
      // is why this path cannot go through `LocationsService.create`.
      // The parent arrives as a TrustedParent token, not a raw id — a third
      // caller cannot obtain one without adding a factory, which is the point.
      for (const call of locations.writeLocationForTrustedParent.mock.calls) {
        expect(call[2]).toBeInstanceOf(TrustedParent);
        expect(call[2].subsidiaryId).toBe('sub-new');
      }
      expect(locations.writeLocationForTrustedParent.mock.calls[0][3]).toMatchObject({
        name: 'Istanbul HQ',
      });
    });

    it('writes nothing at all when a location fails', async () => {
      // The whole point of one transaction. Asserted through the mock's
      // rejection rather than a real rollback, but the shape is what matters:
      // the failure must propagate out of `create`, not be swallowed into a
      // subsidiary with a missing location.
      const user = makeSuperAdmin();
      prisma.txClient.subsidiary.create.mockResolvedValue(makeSubsidiary({ id: 'sub-new' }));
      locations.writeLocationForTrustedParent.mockRejectedValueOnce(
        new Error('location insert failed'),
      );

      await expect(
        service.create(user, {
          legalName: 'New Co',
          geographyCode: 'UK',
          locations: [{ name: 'Istanbul HQ', geographyCode: 'TR' }],
        }),
      ).rejects.toThrow(/location insert failed/);
    });

    it('is unchanged when no locations are supplied', async () => {
      // Optional at this layer deliberately: the create FORM requires one, but
      // making it mandatory in the contract would break every existing caller,
      // and a holding entity with no distinct site is a real thing.
      const user = makeSuperAdmin();
      prisma.txClient.subsidiary.create.mockResolvedValue(makeSubsidiary({ id: 'sub-new' }));

      await service.create(user, { legalName: 'New Co', geographyCode: 'UK' });

      expect(locations.writeLocationForTrustedParent).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledTimes(1);
    });

    it('applies documented defaults (pending status, scopes [1,2]) for optional fields', async () => {
      const user = makeSuperAdmin();
      prisma.txClient.subsidiary.create.mockResolvedValue(makeSubsidiary({ id: 'sub-new' }));
            await service.create(user, dto);

      const createArg = prisma.txClient.subsidiary.create.mock.calls[0][0];
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
      expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
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
      expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('throws NotFound when an in-scope row has since been deleted', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(null);

      await expect(
        service.update(user, 'sub-1', { legalName: 'Renamed' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
    });

    it('updates and audits with before/after diff for super_admin', async () => {
      const user = makeSuperAdmin();
      const before = makeSubsidiary({ id: 'sub-1', legalName: 'Old' });
      const after = makeSubsidiary({ id: 'sub-1', legalName: 'New' });
      prisma.subsidiary.findUnique.mockResolvedValue(before);
      prisma.txClient.subsidiary.update.mockResolvedValue(after);
            const result = await service.update(user, 'sub-1', { legalName: 'New' });

      expect(result.legalName).toBe('New');
      expect(prisma.txClient.subsidiary.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: { legalName: 'New' },
      });
      const auditArg = audit.record.mock.calls[0][1];
      expect(auditArg.action).toBe('update');
      expect(auditArg.diff).toHaveProperty('before');
      expect(auditArg.diff).toHaveProperty('after');
    });

    it('refuses location granularity for a subsidiary with no locations', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      prisma.location.count.mockResolvedValue(0);

      // Allowing it would make the denominator `0 × 12 = 0`, and "0 of 0
      // covered" is vacuously complete — a subsidiary holding no data at all
      // would turn green on the screen whose job is to show missing data.
      await expect(
        service.update(user, 'sub-1', { trackingGranularity: 'location' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
    });

    it('allows location granularity once a location exists', async () => {
      const user = makeSuperAdmin();
      const before = makeSubsidiary({ id: 'sub-1' });
      prisma.subsidiary.findUnique.mockResolvedValue(before);
      prisma.location.count.mockResolvedValue(2);
      prisma.txClient.subsidiary.update.mockResolvedValue(
        makeSubsidiary({ id: 'sub-1', trackingGranularity: 'location' } as Partial<Subsidiary>),
      );

      const result = await service.update(user, 'sub-1', {
        trackingGranularity: 'location',
      });

      expect(result.trackingGranularity).toBe('location');
      expect(prisma.txClient.subsidiary.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: { trackingGranularity: 'location' },
      });
      // The count must be SCOPED. Asserting only its return value let
      // `count({})` through, where another tenant's locations would unlock
      // `location` mode for a subsidiary that owns none.
      expect(prisma.location.count).toHaveBeenCalledWith({
        where: { subsidiaryId: 'sub-1' },
      });
    });

    it('refuses location granularity at CREATE without inline locations', async () => {
      const user = makeSuperAdmin();

      // The same invariant on the other write path. Stating it here as pure
      // input validation is what let `UpdateSubsidiaryInput` stay derived and
      // the DTO key-parity guard stay unmodified.
      await expect(
        service.create(user, {
          legalName: 'No Sites Ltd.',
          geographyCode: 'UK',
          trackingGranularity: 'location',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.txClient.subsidiary.create).not.toHaveBeenCalled();
    });

    it('accepts location granularity at CREATE when locations come with it', async () => {
      const user = makeSuperAdmin();
      prisma.txClient.subsidiary.create.mockResolvedValue(
        makeSubsidiary({ id: 'sub-new', trackingGranularity: 'location' } as Partial<Subsidiary>),
      );

      const created = await service.create(user, {
        legalName: 'Two Sites Ltd.',
        geographyCode: 'UK',
        trackingGranularity: 'location',
        locations: [{ name: 'Site A', geographyCode: 'UK' }],
      } as never);

      expect(created.trackingGranularity).toBe('location');
      // No DB read for the check: the locations are in the request.
      expect(prisma.location.count).not.toHaveBeenCalled();
    });

    it('never counts locations when switching BACK to subsidiary granularity', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(
        makeSubsidiary({ id: 'sub-1', trackingGranularity: 'location' } as Partial<Subsidiary>),
      );
      prisma.txClient.subsidiary.update.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));

      await service.update(user, 'sub-1', { trackingGranularity: 'subsidiary' });

      // The guard is one-directional on purpose: a subsidiary can always be
      // taken back off the invoice rule, including one whose locations were
      // since removed. Gating that too would strand it.
      expect(prisma.location.count).not.toHaveBeenCalled();
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
      prisma.txClient.subsidiary.update.mockResolvedValue(after);

      const result = await service.update(user, 'sub-1', { geographyCode: 'TR' });

      // Assert the PAYLOAD, not just the returned row: the row comes from the
      // mocked resolution, so dropping `geographyCode` from the update data
      // left this green (found by mutation).
      expect(prisma.txClient.subsidiary.update.mock.calls[0][0].data).toEqual({
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

    it('mutates and audits in ONE transaction', async () => {
      // Reverting this to a bare update plus a two-argument audit call passed
      // the entire unit suite: the existing test reads `calls[0][1]` and never
      // looks at the client. Create and delete were transactional and update
      // was not — one of three verbs able to lose its trail.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      prisma.txClient.subsidiary.update.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));

      await service.update(user, 'sub-1', { sector: 'Energy' });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0][2]).toBe(prisma.txClient);
    });

    it('only includes explicitly-provided fields in the update payload', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      prisma.txClient.subsidiary.update.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
            await service.update(user, 'sub-1', { reportingStatus: 'active' });

      const updateArg = prisma.txClient.subsidiary.update.mock.calls[0][0];
      expect(updateArg.data).toEqual({ reportingStatus: 'active' });
    });
  });

  describe('contact fields (round-1 UAT SUB-2)', () => {
    it('round-trips through create, and lands in the audit diff', async () => {
      // Deliberate, not incidental: `create`/`update`/`delete` embed the whole
      // DTO in `diff`, so contact details become permanent, uncorrectable rows
      // in an append-only log. Excluded here would mean "contact changed" is
      // unauditable, which is worse — but it IS a choice, so it is pinned.
      const user = makeSuperAdmin();
      const created = makeSubsidiary({
        id: 'sub-new',
        designatedPerson: 'Aylin Demir',
        contactEmail: 'aylin.demir@example.com',
        contactPhone: '+90 555 000 0001',
      });
      prisma.txClient.subsidiary.create.mockResolvedValue(created);

      const dto = await service.create(user, {
        legalName: 'New Co',
        geographyCode: 'UK',
        contactEmail: 'aylin.demir@example.com',
        contactPhone: '+90 555 000 0001',
      });

      expect(prisma.txClient.subsidiary.create.mock.calls[0][0].data).toMatchObject({
        contactEmail: 'aylin.demir@example.com',
        contactPhone: '+90 555 000 0001',
      });
      expect(dto.contactEmail).toBe('aylin.demir@example.com');
      expect(dto.contactPhone).toBe('+90 555 000 0001');
      const diff = audit.record.mock.calls[0][1].diff as {
        after: { contactEmail: string; contactPhone: string };
      };
      expect(diff.after.contactEmail).toBe('aylin.demir@example.com');
      expect(diff.after.contactPhone).toBe('+90 555 000 0001');
    });

    it('defaults both to null when omitted, never undefined', async () => {
      // `undefined` would serialise the key away entirely, so a client could
      // not tell "no contact recorded" from "this API version has no such
      // field". Every other optional column on this entity answers `null`.
      const user = makeSuperAdmin();
      prisma.txClient.subsidiary.create.mockResolvedValue(makeSubsidiary({ id: 'sub-new' }));

      const dto = await service.create(user, { legalName: 'New Co', geographyCode: 'UK' });

      expect(prisma.txClient.subsidiary.create.mock.calls[0][0].data).toMatchObject({
        contactEmail: null,
        contactPhone: null,
      });
      expect(dto.contactEmail).toBeNull();
      expect(dto.contactPhone).toBeNull();
    });

    it('can be cleared, and clearing is distinguishable from not touching', async () => {
      // The `!== undefined` discipline is what makes this possible: an explicit
      // `null` clears the field, an absent key leaves it alone. A truthiness
      // check here would make a contact impossible to remove once set.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      prisma.txClient.subsidiary.update.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));

      await service.update(user, 'sub-1', { contactEmail: null });

      expect(prisma.txClient.subsidiary.update.mock.calls[0][0].data).toEqual({
        contactEmail: null,
      });
    });
  });

  describe('summary — the counts behind the control panel', () => {
    it('reports every dependent class, and is tenant-scoped', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, ['approved', 'locked', 'submitted', 'draft', 'draft']);
      countLocations(prisma, { total: 2 });
      stubRead(prisma, (c) => c.periodLock.count, 1);
      stubRead(prisma, (c) => c.target.count, 3);
      stubRead(prisma, (c) => c.subsidiaryDenominator.count, 4);

      const s = await service.summary(user, 'sub-1');

      expect(s).toEqual({
        subsidiaryId: 'sub-1',
        terminalRecords: 2,
        reviewRecords: 1,
        openRecords: 2,
        locations: 2,
        periodLocks: 1,
        targets: 3,
        denominators: 4,
        hasBlockingDependents: true,
        // Two approved/locked records are present, so the terminal branch wins
        // and the answer is one sentence rather than a list of things to clear.
        // The counts are still all reported — the panel shows them; only the
        // ADVICE collapses, because nothing the caller clears would help.
        blockers: [
          '2 approved or locked activity record(s) belong to this subsidiary, and ' +
            'deleting it would permanently destroy them along with their evidence. ' +
            'Those records cannot be deleted at any point, so a subsidiary that has ' +
            'reported data stays. Set its status to "inactive" to retire it instead.',
        ],
      });
    });

    it('reports no blockers only when literally nothing is left', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, []);

      expect((await service.summary(user, 'sub-1')).hasBlockingDependents).toBe(false);
    });

    it('a record-free location does NOT block — the delete clears it, audited', async () => {
      // It used to. The refusal existed because the FK cascade destroyed
      // locations unaudited; writing a row each removes the objection, and PR 3
      // made the friction routine by requiring a location at create time.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      prisma.txClient.subsidiary.delete.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, []);
      countLocations(prisma, { total: 1 });
      const loc = makeLocation({ id: 'loc-1', subsidiaryId: 'sub-1' });
      prisma.txClient.location.findMany.mockResolvedValue([loc]);

      const s = await service.summary(user, 'sub-1');
      expect(s.locations).toBe(1);
      expect(s.hasBlockingDependents, 'the panel must agree with the guard').toBe(false);

      await expect(service.remove(user, 'sub-1')).resolves.toEqual({
        id: 'sub-1',
        deleted: true,
      });
      expect(locations.deleteLocationForTrustedParent).toHaveBeenCalledTimes(1);
      expect(locations.deleteLocationForTrustedParent.mock.calls[0][2]).toBe(loc);
      // On the TRANSACTION's client. Handing the deleter `this.prisma` instead
      // survived the whole suite — the assertion above reads argument 2 and
      // never argument 0.
      expect(locations.deleteLocationForTrustedParent.mock.calls[0][0]).toBe(
        prisma.txClient,
      );
      // And scoped to THIS subsidiary. Dropping the `where` from the findMany
      // left 409 tests green while deleting every location in the database,
      // across every organisation — the single most destructive query this
      // change adds, and nothing pinned it.
      expect(prisma.txClient.location.findMany).toHaveBeenCalledWith({
        where: { subsidiaryId: 'sub-1' },
      });
    });

    it('a location holding ANOTHER subsidiary\'s record blocks', async () => {
      // Not the audit reason — the geography one, and only for the invariant
      // violation. Counting every record at the location instead double-counted
      // this subsidiary's own (already in the three tiers) and produced advice
      // that contradicted itself: remove the location, and the location stays.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, []);
      countLocations(prisma, { total: 1 });
      // The invariant says this cannot happen while the record counts are zero.
      // There is no composite FK enforcing it, so the delete checks anyway.
      countLocations(prisma, { total: 1, holdingForeign: 1 });
      // The location must actually be IN the list the clear would walk —
      // otherwise "clear before guard" and "guard before clear" behave
      // identically and the ordering is untested. Swapping the two lines
      // survived the whole suite until this stub existed.
      prisma.txClient.location.findMany.mockResolvedValue([
        makeLocation({ id: 'loc-held', subsidiaryId: 'sub-1' }),
      ]);

      const message = await refusal(service.remove(user, 'sub-1'));
      expect(message).toMatch(/1 location\(s\) holding a record that belongs to another subsidiary/);
      expect(message).toMatch(/the record has to move or go first/);
      expect(locations.deleteLocationForTrustedParent).not.toHaveBeenCalled();
      expect(prisma.txClient.subsidiary.delete).not.toHaveBeenCalled();
    });

    it.each([
      'terminalRecords', 'reviewRecords', 'openRecords',
      // `locations` is deliberately absent: a record-free location is cleared
      // by the delete now, audited, so it is never something the user must
      // remove first. `locationsWithRecords` took its place, and blocks for the
      // geography reason rather than the audit one.
      'locationsHoldingForeignRecords', 'periodLocks', 'targets', 'denominators',
    ] as const)('%s alone blocks the delete, so it belongs in the blocker list', async (key) => {
      // `describeBlockers` is now the only thing that decides, so this pins the
      // summary and the guard to it by setting each dependent to 1 ON ITS OWN
      // and asserting both answers. (It replaced a `BLOCKING_DEPENDENTS` array
      // that had to be kept in sync by hand — the array is gone, this is not.)
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, []);
      const byKey: Record<string, () => void> = {
        terminalRecords: () => countRecords(prisma, ['approved']),
        reviewRecords: () => countRecords(prisma, ['submitted']),
        openRecords: () => countRecords(prisma, ['draft']),
        locationsHoldingForeignRecords: () =>
          countLocations(prisma, { total: 1, holdingForeign: 1 }),
        periodLocks: () => stubRead(prisma, (c) => c.periodLock.count, 1),
        targets: () => stubRead(prisma, (c) => c.target.count, 1),
        denominators: () => stubRead(prisma, (c) => c.subsidiaryDenominator.count, 1),
      };
      byKey[key]();

      expect((await service.summary(user, 'sub-1')).hasBlockingDependents).toBe(true);
      await expect(service.remove(user, 'sub-1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.txClient.subsidiary.delete).not.toHaveBeenCalled();
    });

    it('scopes EVERY count to this subsidiary, not just the record ones', async () => {
      // `countRecords` only ever inspected `where.status`, and the other six
      // counters were bare `mockResolvedValue` — so the tenant scoping of all
      // seven was invisible to this suite. Dropping `subsidiaryId` from
      // `periodLock.count` passed 369 unit, 56 E2E and 30 RLS probes, because
      // the seed ships zero period locks and every assertion compared 0 to 0.
      // Shared with the delete guard, that would make every subsidiary in the
      // database undeletable the moment one lock existed anywhere.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, []);

      await service.summary(user, 'sub-1');

      for (const counter of [
        prisma.location.count,
        prisma.periodLock.count,
        prisma.target.count,
        prisma.subsidiaryDenominator.count,
      ]) {
        expect(counter).toHaveBeenCalledWith({ where: { subsidiaryId: 'sub-1' } });
      }
      for (const call of prisma.activityRecord.count.mock.calls) {
        expect(call[0].where).toMatchObject({ subsidiaryId: 'sub-1' });
      }
    });

    it('never takes a row lock — a read must not serialise against the delete', async () => {
      // `remove()` locks the row before counting; `summary()` deliberately does
      // not. Pinned as a NEGATIVE so nobody later "fixes" the snapshot skew
      // below by putting a FOR UPDATE inside a GET.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, []);

      await service.summary(user, 'sub-1');

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('reports the SAME sentences the 409 uses — they cannot diverge', async () => {
      // The reason `describeBlockers` exists. If the panel's explanation and
      // the endpoint's refusal were written separately, two slightly different
      // accounts of one rule would read like two rules — prose drift, which is
      // worse than the numeric drift `countDependents` was extracted to stop,
      // because nothing typechecks a sentence.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, ['submitted', 'draft']);
      countLocations(prisma, { total: 1 });
      stubRead(prisma, (c) => c.periodLock.count, 1);

      const { blockers } = await service.summary(user, 'sub-1');
      const message = await refusal(service.remove(user, 'sub-1'));

      expect(blockers.length).toBeGreaterThan(0);
      for (const phrase of blockers) {
        expect(message, `the 409 must contain "${phrase}"`).toContain(phrase);
      }
      // …and the ordering advice the counts alone cannot carry.
      expect(message).toMatch(/reopen any closed period rather than deleting its lock/);
      expect(message).toMatch(/sent back by a reviewer/);
    });

    it('gives the terminal refusal as one sentence, not a shopping list', async () => {
      // An approved record is not an item to clear — the answer is that the
      // subsidiary stays. Splitting it into a phrase like the others would
      // invite a UI to render it as a to-do.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, ['approved', 'locked']);
      stubRead(prisma, (c) => c.location.count, 3);

      const { blockers } = await service.summary(user, 'sub-1');
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toMatch(/2 approved or locked activity record\(s\)/);
      expect(blockers[0]).toMatch(/"inactive"/);
      // The locations are real but irrelevant: nothing the caller clears will
      // make this subsidiary deletable, so listing them would be a false lead.
      expect(blockers[0]).not.toMatch(/location/);
    });

    it('is empty when nothing blocks', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, []);

      expect((await service.summary(user, 'sub-1')).blockers).toEqual([]);
    });

    it('refuses an id outside the access set WITHOUT counting anything', async () => {
      const user = makeDataEntry({ accessibleSubsidiaryIds: ['sub-1'] });

      await expect(service.summary(user, 'sub-99')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.subsidiary.findUnique).not.toHaveBeenCalled();
      expect(prisma.activityRecord.count).not.toHaveBeenCalled();
    });

    it('is readable by a non-admin inside the tenant (reads are not role-gated)', async () => {
      // SUB-2: the PANEL is super_admin-only, but reads stay tenant-scoped for
      // everyone — and this exposes nothing a data_entry user could not already
      // count by listing the collections they can see, only far more cheaply.
      const user = makeDataEntry({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, ['approved']);

      expect((await service.summary(user, 'sub-1')).terminalRecords).toBe(1);
    });
  });

  describe('remove — RBAC + audit', () => {
    it('throws Forbidden for a non-super_admin and deletes nothing', async () => {
      const user = makeDataEntry();

      await expect(service.remove(user, 'sub-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.txClient.subsidiary.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses to delete a subsidiary outside the access set WITHOUT querying it', async () => {
      const user = makeSuperAdmin();

      await expect(service.remove(user, 'sub-of-another-org')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.subsidiary.findUnique).not.toHaveBeenCalled();
      expect(prisma.txClient.subsidiary.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('throws NotFound when an in-scope row has since been deleted', async () => {
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(null);

      await expect(service.remove(user, 'sub-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.txClient.subsidiary.delete).not.toHaveBeenCalled();
    });

    it('does NOT tell the caller a reviewable record is permanent', async () => {
      // `submitted`/`under_review` look terminal and are not: a reviewer
      // rejects the record, it becomes deletable, and so does the subsidiary —
      // measured live, the delete then went through with 200. Sending that
      // caller to "inactive" forecloses an action the API actually grants, the
      // same error as promising a delete that cannot happen, inverted.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, ['submitted', 'under_review']);

      const message = await refusal(service.remove(user, 'sub-1'));
      expect(message).toMatch(/2 record\(s\) awaiting review/);
      expect(message).toMatch(/sent back by a reviewer/);
      expect(message).not.toMatch(/"inactive"/);
      expect(prisma.txClient.subsidiary.delete).not.toHaveBeenCalled();
    });

    it('counts the subsidiary row BEFORE anything can be added to it', async () => {
      // The counts are a time-of-check read. Inserting any child takes a
      // FOR KEY SHARE lock on the parent row, so locking it FOR UPDATE first
      // serialises the guard against a concurrent create — and the loser of
      // that race is not an error, it is a row the FK cascades away silently.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      prisma.txClient.subsidiary.delete.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));

      await service.remove(user, 'sub-1');

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [fragments] = prisma.$queryRaw.mock.calls[0] as [string[]];
      expect(fragments.join('?')).toMatch(/FOR UPDATE/);
      // Order is the invariant, not mere presence: a lock taken AFTER the
      // counts protects nothing at all.
      const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
        fn.mock.invocationCallOrder[0];
      expect(order(prisma.$transaction)).toBeLessThan(order(prisma.$queryRaw));
      // The counts happen on the TRANSACTION's client — naming it here is the
      // assertion, not an implementation detail: counting on the default client
      // would be a read outside the lock, which is the race this pins.
      expect(order(prisma.$queryRaw)).toBeLessThan(
        order(prisma.txClient.activityRecord.count),
      );
      // Transaction MEMBERSHIP is not assertable here and this test does not
      // pretend otherwise: `$transaction` hands the callback the same mock
      // object, by design, so `tx.x` and `prisma.x` are one spy. That the
      // counts run on `tx` is structural, and was verified against a live API.
    });

    it('refuses to delete a subsidiary that still holds terminal records', async () => {
      // `ActivityRecord.subsidiary` is ON DELETE CASCADE, so a delete did not
      // detach those records — it DESTROYED them with their evidence, targets
      // and period locks. Measured: a record taken through submit AND approve
      // was a 404 immediately after one DELETE, leaving one "delete subsidiary"
      // audit row and nothing about the approved figures that went with it.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, Array(101).fill('approved').concat('locked'));

      await expect(service.remove(user, 'sub-1')).rejects.toThrow(
        /102 approved or locked/,
      );
      // Committed records cannot be deleted at all, so "inactive" is the only
      // thing the caller can actually do — the message must say so.
      await expect(service.remove(user, 'sub-1')).rejects.toThrow(/"inactive"/);
      expect(prisma.txClient.subsidiary.delete).not.toHaveBeenCalled();
    });

    it('blocks on drafts, but tells the caller they can be removed', async () => {
      // A drafts-only subsidiary is fully recoverable — the drafts delete
      // through their own endpoint. Sending that caller to `inactive` would be
      // the mirror image of unfollowable advice: telling someone not to bother
      // with the one action that would work.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, ['draft', 'draft', 'rejected']);

      const message = await refusal(service.remove(user, 'sub-1'));
      expect(message).toMatch(/3 draft or rejected record\(s\)/);
      expect(message).not.toMatch(/"inactive"/);
      expect(prisma.txClient.subsidiary.delete).not.toHaveBeenCalled();
    });

    it('blocks on a closed period, and on locations/targets/denominators', async () => {
      // The cascade erases a period lock WITHOUT the `unlock` audit row that
      // `DELETE /period-locks/:id` writes — a closed reporting period reopened
      // with no trace. Same for targets and denominators: compliance artifacts
      // that would vanish behind one "delete subsidiary" row.
      const user = makeSuperAdmin();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      countRecords(prisma, []);
      stubRead(prisma, (c) => c.periodLock.count, 1);
      countLocations(prisma, { total: 2 });
      stubRead(prisma, (c) => c.target.count, 1);
      stubRead(prisma, (c) => c.subsidiaryDenominator.count, 1);

      const message = await refusal(service.remove(user, 'sub-1'));
      // Plain locations are absent on purpose — the delete clears them, so
      // listing them would be advice the user does not need to act on.
      expect(message).not.toMatch(/2 location\(s\)/);
      expect(message).toMatch(/1 closed reporting period\(s\)/);
      expect(message).toMatch(/1 reduction target\(s\)/);
      expect(message).toMatch(/1 intensity denominator\(s\)/);
      expect(prisma.txClient.subsidiary.delete).not.toHaveBeenCalled();
    });

    it('deletes and audits with the before snapshot for super_admin', async () => {
      const user = makeSuperAdmin();
      const before = makeSubsidiary({ id: 'sub-1' });
      prisma.subsidiary.findUnique.mockResolvedValue(before);
      prisma.txClient.subsidiary.delete.mockResolvedValue(before);
            const result = await service.remove(user, 'sub-1');

      expect(result).toEqual({ id: 'sub-1', deleted: true });
      expect(prisma.txClient.subsidiary.delete).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
      const auditArg = audit.record.mock.calls[0][1];
      expect(auditArg.action).toBe('delete');
      expect(auditArg.diff).toHaveProperty('before');
      // Written through the transaction client — a delete whose audit row fails
      // must roll back, or the subsidiary is gone with no trail at all.
      expect(audit.record.mock.calls[0][2]).toBe(prisma.txClient);
    });
  });
});
