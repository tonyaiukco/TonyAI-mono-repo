import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma, UserRole } from '@tonyai/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseAuthGuard } from '../../src/auth/auth.guard';
import type { RequestUser } from '../../src/auth/auth.types';
import { tokenVerifier } from '../../src/auth/token-verifier';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { addMember, connect, connectOwner, createTenant, createTenantData, type Tenant, type TenantData, withRollback } from './db';

/**
 * LP1-03 (F06): a grant of a subsidiary to a profile never crosses an
 * organisation — at the database (composite foreign keys, for every writer), in
 * RLS (the explicit-grant branch of every tenant policy, independently of the
 * keys) and in the API's guard (on a real database). Two organisations, every
 * role, and grants malformed on purpose.
 *
 * The RLS and guard tests need a cross-organisation grant to exist, which the
 * keys now make impossible; they drop the keys inside an owner transaction
 * that is always rolled back, so nothing outside the test ever sees it.
 */

let owner: PrismaService;
let runtime: PrismaService;
let a: Tenant;
let b: Tenant;
let dataA: TenantData;
let dataB: TenantData;

beforeAll(() => {
  owner = connectOwner();
  runtime = connect();
});

afterAll(async () => {
  await Promise.all([owner.$disconnect(), runtime.$disconnect()]);
});

beforeEach(async () => {
  [a, b] = await Promise.all([createTenant(), createTenant()]);
  [dataA, dataB] = await Promise.all([createTenantData(owner, a), createTenantData(owner, b)]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([a.cleanup(), b.cleanup()]);
});

const FK_VIOLATION = /23503|Foreign key constraint|violates foreign key/i;

/** Runs `fn` on `client` in a rolled-back transaction; resolves to the error it raised, or null. */
async function failure(client: PrismaService, fn: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  try {
    await withRollback(client, fn);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const DROP_GRANT_KEYS = [
  'ALTER TABLE user_subsidiary_access DROP CONSTRAINT user_subsidiary_access_user_id_organisation_id_fkey',
  'ALTER TABLE user_subsidiary_access DROP CONSTRAINT user_subsidiary_access_subsidiary_id_organisation_id_fkey',
];

/**
 * In an owner transaction: removes the keys and grants A's user B's subsidiary
 * — the malformed grant. Labelled with A's organisation by default, the worst
 * case: it then looks like A's own grant to anything that trusts the label
 * (Prisma's composite `profile.subsidiaryAccess` relation joins on it).
 */
async function plantCrossTenantGrant(
  tx: Prisma.TransactionClient,
  userId = a.users.standardUser.id,
  label: 'profile' | 'subsidiary' = 'profile',
) {
  for (const sql of DROP_GRANT_KEYS) await tx.$executeRawUnsafe(sql);
  const organisationId = label === 'profile' ? a.organisationId : b.organisationId;
  await tx.$executeRaw`
    INSERT INTO user_subsidiary_access (user_id, subsidiary_id, organisation_id)
    VALUES (${userId}::uuid, ${b.subsidiaryId}::uuid, ${organisationId}::uuid)`;
}

describe('the database refuses a grant across organisations', () => {
  it.each([
    ["labelled with the profile's organisation", () => a.organisationId],
    ["labelled with the subsidiary's organisation", () => b.organisationId],
  ])('A user, B subsidiary, %s — as the owner and as the runtime role', async (_label, org) => {
    for (const client of [owner, runtime]) {
      const error = await failure(client, (tx) =>
        tx.userSubsidiaryAccess.create({
          data: { userId: a.users.standardUser.id, subsidiaryId: b.subsidiaryId, organisationId: org() },
        }),
      );
      expect(error).toMatch(FK_VIOLATION);
    }
  });

  it('…while a same-organisation grant is accepted (control)', async () => {
    const extra = await owner.subsidiary.create({
      data: { organisationId: a.organisationId, legalName: 'Int-test second subsidiary', geographyCode: 'UK' },
    });
    expect(
      await failure(runtime, (tx) =>
        tx.userSubsidiaryAccess.create({
          data: { userId: a.users.standardUser.id, subsidiaryId: extra.id, organisationId: a.organisationId },
        }),
      ),
    ).toBeNull();
  });

  it('a profile with no organisation can hold no grant', async () => {
    const error = await failure(owner, async (tx) => {
      const orphan = await tx.profile.create({
        data: { id: randomUUID(), email: `int-orphan-${randomUUID().slice(0, 8)}@tonyai.test`, fullName: 'Int orphan' },
      });
      await tx.userSubsidiaryAccess.create({
        data: { userId: orphan.id, subsidiaryId: a.subsidiaryId, organisationId: a.organisationId },
      });
    });
    expect(error).toMatch(FK_VIOLATION);
  });

  it('a profile holding a grant cannot move to another organisation, nor drop its organisation', async () => {
    for (const organisationId of [b.organisationId, null]) {
      const error = await failure(owner, (tx) =>
        tx.profile.update({ where: { id: a.users.standardUser.id }, data: { organisationId } }),
      );
      expect(error).toMatch(FK_VIOLATION);
    }
  });

  it('a subsidiary that is granted cannot move to another organisation', async () => {
    // The tenant's first subsidiary is its tree's root: since the group tree
    // (inc26-group-tree, WP7 review) TA018 refuses it as the other
    // organisation's second root before the grant's key is checked.
    const error = await failure(owner, (tx) =>
      tx.subsidiary.update({ where: { id: a.subsidiaryId }, data: { organisationId: b.organisationId } }),
    );
    expect(error).toMatch(/TA018[\s\S]*already has its holding/);
    // A granted company that is not a root meets the grant's same-organisation key.
    const granted = await failure(owner, async (tx) => {
      const company = await tx.subsidiary.create({
        data: { organisationId: a.organisationId, legalName: 'Int-test granted company', geographyCode: 'UK' },
      });
      await tx.userSubsidiaryAccess.create({
        data: { userId: a.users.standardUser.id, subsidiaryId: company.id, organisationId: a.organisationId },
      });
      // Placed under the other organisation's root, so only the grant's key refuses it.
      await tx.subsidiary.update({ where: { id: company.id }, data: { organisationId: b.organisationId, parentId: b.subsidiaryId } });
    });
    expect(granted).toMatch(FK_VIOLATION);
  });

  it('deleting an organisation that still has grants succeeds and takes the grants with it', async () => {
    const left = await withRollback(owner, async (tx) => {
      // Its records first: no foreign key's action reaches a record (LP4-01).
      await tx.activityRecord.deleteMany({ where: { subsidiaryId: a.subsidiaryId } });
      await tx.organisation.delete({ where: { id: a.organisationId } });
      return tx.userSubsidiaryAccess.count({ where: { userId: a.users.standardUser.id } });
    });
    expect(left).toBe(0);
  });

  it('deleting the subsidiary, or the profile, removes the grant', async () => {
    // A company with no facility: one with a facility, or one whose facility
    // went earlier in the transaction, is deleted by no writer (inc26-group-tree,
    // RD9, TA023), so the tenant's own companies cannot show this.
    const afterSubsidiary = await withRollback(owner, async (tx) => {
      const company = await tx.subsidiary.create({
        data: { organisationId: a.organisationId, legalName: 'Int-test granted company', geographyCode: 'UK' },
      });
      await tx.userSubsidiaryAccess.create({
        data: { userId: a.users.superAdmin.id, subsidiaryId: company.id, organisationId: a.organisationId },
      });
      await tx.subsidiary.delete({ where: { id: company.id } });
      return tx.userSubsidiaryAccess.count({ where: { subsidiaryId: company.id } });
    });
    const afterProfile = await withRollback(owner, async (tx) => {
      await tx.profile.delete({ where: { id: a.users.standardUser.id } });
      return tx.userSubsidiaryAccess.count({ where: { userId: a.users.standardUser.id } });
    });
    expect([afterSubsidiary, afterProfile]).toEqual([0, 0]);
  });
});

/** Every tenant table a policy scopes by subsidiary, and how to find a tenant's row in it. */
const SCOPED: [table: string, idOf: (t: Tenant, d: TenantData) => string, column: string][] = [
  ['subsidiaries', (t) => t.subsidiaryId, 'id'],
  ['locations', (_t, d) => d.locationId, 'id'],
  ['activity_records', (_t, d) => d.recordId, 'id'],
  ['evidence', (_t, d) => d.evidenceId, 'id'],
  ['activity_record_evidence', (_t, d) => d.evidenceId, 'evidence_id'],
  ['period_locks', (_t, d) => d.periodLockId, 'id'],
  ['targets', (_t, d) => d.targetId, 'id'],
  ['subsidiary_denominators', (_t, d) => d.denominatorId, 'id'],
  ['import_batches', (_t, d) => d.importBatchId, 'id'],
  // LP3-04 PR B: the boundary version's header (scoped by a declared,
  // granted subsidiary for a granted user) and its five row tables, one
  // row each in the tenant's version.
  ['inventory_boundaries', (_t, d) => d.boundaryId, 'id'],
  ['inventory_boundary_subsidiaries', (_t, d) => d.boundaryId, 'boundary_id'],
  ['inventory_boundary_sites', (_t, d) => d.boundaryId, 'boundary_id'],
  ['inventory_attribution_policies', (_t, d) => d.boundaryId, 'boundary_id'],
  ['inventory_applicability_cells', (_t, d) => d.boundaryId, 'boundary_id'],
  ['inventory_sources', (_t, d) => d.boundaryId, 'boundary_id'],
];

/** Counts, as `userId` through RLS (PostgREST's role), the row of each scoped table identified for (tenant, data). */
async function visibleAs(tx: Prisma.TransactionClient, userId: string, tenant: Tenant, data: TenantData) {
  await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
  await tx.$executeRaw`SELECT set_config('request.jwt.claim.sub', ${userId}, true),
                              set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`;
  const seen: Record<string, number> = {};
  for (const [table, idOf, column] of SCOPED) {
    const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1::uuid`,
      idOf(tenant, data),
    );
    seen[table] = n;
  }
  await tx.$executeRawUnsafe('RESET ROLE');
  return seen;
}

const everyTable = (n: number) => Object.fromEntries(SCOPED.map(([table]) => [table, n]));

describe('RLS: a grant reaches only its own organisation — even when the keys are gone', () => {
  it("A's standard user, granted B's subsidiary: sees none of B's rows, and still all of its own", async () => {
    const seen = await withRollback(owner, async (tx) => {
      await plantCrossTenantGrant(tx);
      // A batch A's user uploaded that names B's subsidiary: the grant row exists,
      // the subsidiary belongs to another organisation — invisible.
      const foreignBatch = await tx.importBatch.create({
        data: {
          organisationId: a.organisationId,
          uploadedBy: a.users.standardUser.id,
          fileName: 'int-test-foreign.csv',
          fileFormat: 'csv',
          sizeBytes: 1,
          sha256: '0'.repeat(64),
          totalRows: 1,
          subsidiaryIds: [b.subsidiaryId],
        },
      });
      const ofB = await visibleAs(tx, a.users.standardUser.id, b, dataB);
      const ofA = await visibleAs(tx, a.users.standardUser.id, a, dataA);
      const foreign = await visibleAs(tx, a.users.standardUser.id, a, { ...dataA, importBatchId: foreignBatch.id });
      return { ofB, ofA, foreignBatch: foreign.import_batches };
    });
    // B's import batch belongs to B and was uploaded by B's user: never A's either way.
    expect(seen.ofB).toEqual(everyTable(0));
    expect(seen.ofA).toEqual(everyTable(1));
    expect(seen.foreignBatch).toBe(0);
  });

  it.each(['masterkey', 'superAdmin', 'auditor'] as const)(
    "A's %s, holding a stray grant of B's subsidiary: sees none of B's rows, all of its own",
    async (role) => {
      const seen = await withRollback(owner, async (tx) => {
        await plantCrossTenantGrant(tx, a.users[role].id);
        return {
          ofB: await visibleAs(tx, a.users[role].id, b, dataB),
          ofA: await visibleAs(tx, a.users[role].id, a, dataA),
        };
      });
      expect(seen.ofB).toEqual(everyTable(0));
      // An organisation-wide reader sees its organisation's batches; the batch
      // here was uploaded by A's standard user, so a super_admin (who sees
      // only its own uploads) does not.
      expect(seen.ofA).toEqual({ ...everyTable(1), ...(role === 'superAdmin' ? { import_batches: 0 } : {}) });
    },
  );

  it("B's own standard user sees B's rows (control: the probe can see a row at all)", async () => {
    const seen = await withRollback(owner, (tx) => visibleAs(tx, b.users.standardUser.id, b, dataB));
    expect(seen).toEqual(everyTable(1));
  });
});

/** The guard's request user for `userId`, computed on `client` exactly as for a real request. */
async function guardUser(client: PrismaService | Prisma.TransactionClient, userId: string): Promise<RequestUser> {
  vi.spyOn(tokenVerifier, 'verify').mockResolvedValue({ sub: userId, exp: Math.floor(Date.now() / 1000) + 60 });
  const request: { headers: Record<string, string>; user?: RequestUser } = {
    headers: { authorization: 'Bearer int-test' },
  };
  const context = {
    getHandler: () => guardUser,
    getClass: () => SupabaseAuthGuard,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const guard = new SupabaseAuthGuard(new Reflector(), client as PrismaService);
  expect(await guard.canActivate(context)).toBe(true);
  return request.user!;
}

describe("the API's guard on a real database: a grant counts only inside the user's organisation", () => {
  it.each(['profile', 'subsidiary'] as const)(
    "A's standard user with a stray grant of B's subsidiary (labelled with the %s's organisation) reaches only A's",
    async (label) => {
      const user = await withRollback(owner, async (tx) => {
        await plantCrossTenantGrant(tx, a.users.standardUser.id, label);
        return guardUser(tx, a.users.standardUser.id);
      });
      expect(user.accessibleSubsidiaryIds).toEqual([a.subsidiaryId]);
    },
  );

  it('a standard user whose organisation is gone reaches nothing, whatever it was granted', async () => {
    const user = await withRollback(owner, async (tx) => {
      for (const sql of DROP_GRANT_KEYS) await tx.$executeRawUnsafe(sql);
      await tx.profile.update({ where: { id: a.users.standardUser.id }, data: { organisationId: null } });
      return guardUser(tx, a.users.standardUser.id);
    });
    expect(user.accessibleSubsidiaryIds).toEqual([]);
  });

  it.each(['masterkey', 'superAdmin', 'auditor', 'standardUser'] as const)(
    "A's %s, on the runtime role: its companies of A — every one for an organisation-wide role, its grant for a scoped one — never B's",
    async (role) => {
      const user = await guardUser(runtime, a.users[role].id);
      expect(user.organisationId).toBe(a.organisationId);
      const organisationWide = role === 'masterkey' || role === 'auditor';
      expect([...user.accessibleSubsidiaryIds].sort()).toEqual(
        (organisationWide ? [a.subsidiaryId, a.otherSubsidiaryId] : [a.subsidiaryId]).sort(),
      );
      // Categories ride on a standard user's grant only (INC-2.6 §1).
      expect(Object.keys(user.categoryGrants ?? {})).toEqual(role === 'standardUser' ? [a.subsidiaryId] : []);
    },
  );
});

/**
 * Task 5.5: the SCOPED tables under `SET LOCAL ROLE authenticated`, for each
 * of the four roles, over the organisation's two companies — the fixture's
 * granted one and the one granted to nobody, which gets a row in every table
 * here (inside the rolled-back transaction only).
 */
describe('RLS: the four roles over two companies of one organisation (INC-2.6, task 5.5)', () => {
  async function seenByRole(extra?: (tx: Prisma.TransactionClient) => Promise<{ label: string; id: string }>) {
    return withRollback(owner, async (tx) => {
      // The other company's boundary version is the year's second.
      const other = await createTenantData(tx as unknown as PrismaService, { ...a, subsidiaryId: a.otherSubsidiaryId }, { boundaryVersion: 2 });
      const readers: { label: string; id: string }[] = (['masterkey', 'superAdmin', 'standardUser', 'auditor'] as const)
        .map((role) => ({ label: role, id: a.users[role].id }));
      if (extra) readers.push(await extra(tx));
      const out: Record<string, { own: Record<string, number>; other: Record<string, number> }> = {};
      for (const reader of readers) {
        out[reader.label] = {
          own: await visibleAs(tx, reader.id, a, dataA),
          other: await visibleAs(tx, reader.id, { ...a, subsidiaryId: a.otherSubsidiaryId }, other),
        };
      }
      return out;
    });
  }

  it('the masterkey and the auditor see both companies; the super_admin and the standard user their granted one alone', async () => {
    const seen = await seenByRole();
    for (const role of ['masterkey', 'auditor']) {
      expect(seen[role], role).toEqual({ own: everyTable(1), other: everyTable(1) });
    }
    // A super_admin sees import batches it uploaded itself (the batches here
    // are the standard user's), every other row of its company.
    expect(seen.superAdmin).toEqual({ own: { ...everyTable(1), import_batches: 0 }, other: everyTable(0) });
    // The other company's batch is the standard user's upload, but it names a
    // company the standard user is not granted: invisible.
    expect(seen.standardUser).toEqual({ own: everyTable(1), other: everyTable(0) });
  });

  // `evidence_select_scoped` (owner ruling, 412f99fe): a standard user sees a
  // file it uploaded, or one linked to a record of a ticked category or of its own.
  it("a standard user granted only another category of the company sees the company's rows but not a colleague's record of that category, nor its file or evidence link", async () => {
    const seen = await seenByRole(async (tx) => {
      const narrow = await addMember(tx as unknown as PrismaService, a, UserRole.standard_user, {
        grants: [a.subsidiaryId],
        categories: ['Fuel'],
      });
      return { label: 'narrow', id: narrow.id };
    });
    expect(seen.narrow).toEqual({
      // The record is an Electricity record of the fixture's standard user.
      own: { ...everyTable(1), activity_records: 0, evidence: 0, activity_record_evidence: 0, import_batches: 0 },
      other: everyTable(0),
    });
  });
});
