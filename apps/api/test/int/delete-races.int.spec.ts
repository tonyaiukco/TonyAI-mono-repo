import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { AccessAdminService } from '../../src/auth/access-admin.service';
import type { RequestUser } from '../../src/auth/auth.types';
import type { CalculationsService } from '../../src/calculations/calculations.service';
import { LocationsService } from '../../src/locations/locations.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { SubsidiariesService } from '../../src/subsidiaries/subsidiaries.service';
import { connect, connectOwner, createTenant, holdBefore, type Tenant } from './db';

/**
 * A company with a facility is not deleted (inc26-group-tree, RD9): the delete
 * no longer sweeps record-free facilities, so the race it once had with a
 * `DELETE /locations/:id` (Codex review of #350) is gone, and the one left is
 * a facility ADDED while the company is being deleted. Against real
 * PostgreSQL: the delete's row lock (FOR UPDATE) makes the insert's key check
 * wait, so the facility is refused rather than cascaded away unaudited.
 */

/** Every geography priced: the geography rule is not what these cases test. */
const pricesAll = {
  coverage: async () => ({ entries: ['UK', 'TR', 'EU'].map((geographyCode) => ({ geographyCode, reportingYear: 2026, statuses: ['authoritative'] })) }),
} as unknown as CalculationsService;

function services(client: PrismaService) {
  const audit = new AuditService(client);
  const locations = new LocationsService(client, audit, pricesAll);
  return {
    locations,
    subsidiaries: new SubsidiariesService(client, audit, locations, new AccessAdminService(client, audit), pricesAll),
  };
}

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

describe('a company with facilities (RD9)', () => {
  it('is refused as in use, naming its facilities, and neither it nor a facility goes', async () => {
    await expect(services(runtime).subsidiaries.remove(admin, subsidiaryId)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'subsidiary_in_use', message: expect.stringMatching(/2 facility\(ies\)/) }),
    });
    expect(await owner.subsidiary.count({ where: { id: subsidiaryId } })).toBe(1);
    expect(await owner.location.count({ where: { id: { in: sites } } })).toBe(2);
    expect(await auditRows(subsidiaryId)).toEqual([]);
  });

  it('goes once its facilities are deleted, each with its own audit row', async () => {
    for (const site of sites) await services(runtime).locations.remove(admin, site);
    await expect(services(runtime).subsidiaries.remove(admin, subsidiaryId)).resolves.toEqual({ id: subsidiaryId, deleted: true });
    for (const site of sites) expect(await auditRows(site), site).toEqual([{ entity: 'location' }]);
    expect(await auditRows(subsidiaryId)).toEqual([{ entity: 'subsidiary' }]);
  });
});

describe('a facility added while its company is being deleted', () => {
  it('waits for the delete, then finds no company: nothing is cascaded away unaudited', async () => {
    for (const site of sites) await services(runtime).locations.remove(admin, site);
    // Held after the guard counted no facility, the company's row locked.
    const hold = holdBefore(runtime, 'Subsidiary', 'delete');
    const deleting = services(hold.client).subsidiaries.remove(admin, subsidiaryId);
    await hold.reached();
    const adding = services(other).locations.create(admin, { subsidiaryId, name: 'Int late site', geographyCode: 'UK' });
    adding.catch(() => undefined);
    hold.release();

    await expect(deleting).resolves.toEqual({ id: subsidiaryId, deleted: true });
    await expect(adding).rejects.toBeDefined();
    expect(await owner.location.count({ where: { subsidiaryId } })).toBe(0);
    expect(await owner.auditLog.count({ where: { entity: 'location', action: 'create', diff: { path: ['after', 'name'], equals: 'Int late site' } } })).toBe(0);
  });
});
