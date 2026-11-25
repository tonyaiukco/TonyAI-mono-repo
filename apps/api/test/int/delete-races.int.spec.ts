import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import type { RequestUser } from '../../src/auth/auth.types';
import { LocationsService } from '../../src/locations/locations.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { SubsidiariesService } from '../../src/subsidiaries/subsidiaries.service';
import { connect, connectOwner, createTenant, holdBefore, type Tenant } from './db';

/**
 * A subsidiary's delete clears its record-free sites; a `DELETE /locations/:id`
 * for one of them can win the race after the sweep read its list (Codex
 * review of #350). Against real PostgreSQL, so what is proven is that the
 * losing sweep's transaction carries on and commits — not a mock's idea of it.
 */

// Two runtime clients of one connection each: the held request keeps its
// connection inside its transaction, and the other request needs its own.
let runtime: PrismaService;
let other: PrismaService;
let owner: PrismaService;
let tenant: Tenant;
let subsidiaryId: string;
let sites: string[];
let admin: RequestUser;

beforeAll(() => {
  runtime = connect();
  other = connect();
  owner = connectOwner();
});

afterAll(async () => {
  await runtime.$disconnect();
  await other.$disconnect();
  await owner.$disconnect();
});

beforeEach(async () => {
  tenant = await createTenant();
  subsidiaryId = (
    await owner.subsidiary.create({ data: { organisationId: tenant.organisationId, legalName: 'Int delete-race subsidiary', geographyCode: 'UK' } })
  ).id;
  sites = [];
  for (const name of ['Int race site 1', 'Int race site 2']) {
    sites.push((await owner.location.create({ data: { subsidiaryId, name, geographyCode: 'UK' } })).id);
  }
  admin = { ...tenant.users.masterkey, accessibleSubsidiaryIds: [...tenant.users.masterkey.accessibleSubsidiaryIds, subsidiaryId] };
});

afterEach(async () => {
  await tenant?.cleanup();
});

const auditRows = (entityId: string) => owner.auditLog.findMany({ where: { entityId, action: 'delete' }, select: { entity: true } });

describe('a site deleted on its own while its subsidiary is being deleted', () => {
  it('the subsidiary delete still commits, and each site has exactly one delete audit row', async () => {
    // Held before the sweep's first site delete: the list is read, nothing deleted yet.
    const hold = holdBefore(runtime, 'Location', 'delete');
    const subsidiaries = new SubsidiariesService(hold.client, new AuditService(hold.client), new LocationsService(hold.client, new AuditService(hold.client)));
    const sweeping = subsidiaries.remove(admin, subsidiaryId);
    await hold.reached();
    // Whichever site the sweep is held on, it reaches the one deleted here
    // only after this delete has committed.
    try {
      await new LocationsService(other, new AuditService(other)).remove(admin, sites[0]);
    } finally {
      hold.release();
    }

    await expect(sweeping).resolves.toEqual({ id: subsidiaryId, deleted: true });
    expect(await owner.subsidiary.count({ where: { id: subsidiaryId } })).toBe(0);
    expect(await owner.location.count({ where: { id: { in: sites } } })).toBe(0);
    for (const site of sites) expect(await auditRows(site), site).toEqual([{ entity: 'location' }]);
    expect(await auditRows(subsidiaryId)).toEqual([{ entity: 'subsidiary' }]);
  });

  it('the standalone delete that lost to the sweep answers 404', async () => {
    const hold = holdBefore(runtime, 'Location', 'delete');
    const losing = new LocationsService(hold.client, new AuditService(hold.client)).remove(admin, sites[0]);
    await hold.reached();
    try {
      await expect(new SubsidiariesService(other, new AuditService(other), new LocationsService(other, new AuditService(other))).remove(admin, subsidiaryId))
        .resolves.toEqual({ id: subsidiaryId, deleted: true });
    } finally {
      hold.release();
    }
    await expect(losing).rejects.toMatchObject({ response: expect.objectContaining({ code: 'location_not_found' }) });
    expect(await auditRows(sites[0])).toEqual([{ entity: 'location' }]);
  });
});
