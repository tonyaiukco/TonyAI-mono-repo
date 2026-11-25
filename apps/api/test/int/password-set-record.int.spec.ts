import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../src/audit/audit.service';
import { PreferencesService } from '../../src/auth/preferences.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { connect, connectOwner, createTenant, type Tenant } from './db';

/**
 * `POST /me/password-set` writes one `password_set` row per password change
 * (`account-access`; Codex review of `pre-g5-security-hardening`): two records
 * of one change, at once, on the runtime role, leave exactly one row.
 */

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;

beforeAll(async () => {
  // Two connections, so the two records truly overlap.
  runtime = connect(2);
  owner = connectOwner();
  tenant = await createTenant();
}, 60_000);

afterAll(async () => {
  await tenant?.cleanup();
  await runtime?.$disconnect();
  await owner?.$disconnect();
});

const rowsFor = (userId: string) => owner.auditLog.findMany({ where: { action: 'password_set', entityId: userId }, select: { diff: true } });

describe('one password_set row per change', () => {
  it('two records of the same change at once write one row; another change writes its own', async () => {
    const service = new PreferencesService(runtime, new AuditService(runtime));
    const user = tenant.users.standardUser;
    const change = randomUUID();

    await Promise.all([service.recordPasswordSet(user, 'invite', change), service.recordPasswordSet(user, 'invite', change)]);
    await service.recordPasswordSet(user, 'invite', change);
    expect(await rowsFor(user.id)).toEqual([{ diff: { flow: 'invite', changeId: change } }]);

    const next = randomUUID();
    await service.recordPasswordSet(user, 'recovery', next);
    expect((await rowsFor(user.id)).length).toBe(2);
  });
});
