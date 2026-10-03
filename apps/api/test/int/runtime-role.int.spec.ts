import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  RUNTIME_ROLE,
  checkRuntimeRole,
  checkTenantInvariants,
  runtimeRoleExposures,
} from '../../../../packages/db/scripts/runtime-role.mjs';
import { connect, connectOwner, createTenant, withRollback } from './db';

/**
 * LP1-03 (F06): the least-privileged runtime role. Every other spec in this
 * suite runs its services on it (`connect()`), which proves the grants are
 * enough; this one proves they are no more than intended — first against the
 * catalogue, then by trying each forbidden operation for real. Every attempt
 * runs in a transaction that is rolled back, so a privilege that wrongly
 * exists fails the test without changing anything.
 */

let runtime: PrismaService;
let owner: PrismaService;

beforeAll(() => {
  runtime = connect();
  owner = connectOwner();
});

afterAll(async () => {
  await Promise.all([runtime.$disconnect(), owner.$disconnect()]);
});

/** Runs `sql` as the runtime role, rolled back; resolves to the error it raised, or null. */
async function attempt(sql: string): Promise<string | null> {
  try {
    await withRollback(runtime, (tx) => tx.$executeRawUnsafe(sql));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const DENIED = /42501|permission denied|must be owner|must have admin option/i;

describe('the runtime role', () => {
  it('is what the services connect as — not the owner', async () => {
    const [{ user }] = await runtime.$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`;
    expect(user).toBe(RUNTIME_ROLE);
  });

  it('holds exactly the intended privileges (catalogue check, the same one `runtime-role.mjs check` runs)', async () => {
    const problems = await checkRuntimeRole((sql) => runtime.$queryRawUnsafe(sql));
    expect(problems).toEqual([]);
  });

  it('no grant in the data crosses an organisation (what a restore could bring back past the keys)', async () => {
    expect(await checkTenantInvariants((sql) => runtime.$queryRawUnsafe(sql))).toEqual([]);
  });

  it("reaches nothing outside its grants except what PUBLIC holds — and the check notices a grant of ours there", async () => {
    // Whatever the platform grants to PUBLIC (pg_net's queue, Storage's helper
    // functions) is reported, not failed: the owner cannot revoke it.
    const exposures = await runtimeRoleExposures((sql) => runtime.$queryRawUnsafe(sql));
    for (const e of exposures) expect(e).toMatch(/\(via PUBLIC\)$/);
    // A grant made by us outside public is a problem, not an exposure.
    const problems = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe('GRANT SELECT ON storage.buckets TO tonyai_runtime');
      return checkRuntimeRole((sql) => tx.$queryRawUnsafe(sql));
    });
    expect(problems).toContain('tonyai_runtime was granted SELECT on storage.buckets');
  });

  it('notices column-level grants, which has_table_privilege does not see (`qa-auditor`)', async () => {
    const problems = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe('GRANT INSERT (id, email, full_name, updated_at) ON profiles TO tonyai_runtime');
      await tx.$executeRawUnsafe('GRANT SELECT (migration_name) ON _prisma_migrations TO tonyai_runtime');
      await tx.$executeRawUnsafe('GRANT UPDATE (organisation_id) ON subsidiaries TO tonyai_runtime');
      return checkRuntimeRole((sql) => tx.$queryRawUnsafe(sql));
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'tonyai_runtime has column-level INSERT on public.profiles',
        'tonyai_runtime has column-level SELECT on public._prisma_migrations',
        'tonyai_runtime can UPDATE public.subsidiaries.organisation_id',
      ]),
    );
  });

  it('cannot move a subsidiary to another organisation — every other column of it, it can edit', async () => {
    expect(await attempt('UPDATE subsidiaries SET organisation_id = organisation_id WHERE false')).toMatch(DENIED);
    expect(await attempt('UPDATE subsidiaries SET id = id WHERE false')).toMatch(DENIED);
    expect(await attempt(`UPDATE subsidiaries SET legal_name = legal_name, updated_at = now() WHERE false`)).toBeNull();
  });

  it('sees every row (BYPASSRLS) — the API and the Storage sweeper act for every tenant', async () => {
    const tenant = await createTenant();
    try {
      expect(await runtime.subsidiary.count({ where: { id: tenant.subsidiaryId } })).toBe(1);
      expect(await runtime.userSubsidiaryAccess.count({ where: { userId: tenant.users.dataEntry.id } })).toBe(1);
    } finally {
      await tenant.cleanup();
    }
  });

  it('may append to the audit trail and read it', async () => {
    const [{ id }] = await owner.$queryRaw<{ id: string }[]>`SELECT id::text FROM profiles LIMIT 1`;
    const inserted = await withRollback(runtime, (tx) =>
      tx.auditLog.create({ data: { userId: id, action: 'create', entity: 'subsidiary' } }),
    );
    expect(inserted.id).toBeTruthy();
  });
});

describe('the runtime role is refused', () => {
  it.each([
    ['rewriting the audit trail', `UPDATE audit_log SET action = 'forged' WHERE id = gen_random_uuid()`],
    ['deleting from the audit trail', 'DELETE FROM audit_log WHERE id = gen_random_uuid()'],
    ['truncating the audit trail', 'TRUNCATE audit_log'],
    ['truncating tenant data (TRUNCATE ignores RLS)', 'TRUNCATE activity_records CASCADE'],
    ['reading the migration history', 'SELECT 1 FROM _prisma_migrations LIMIT 1'],
    [
      'forging the migration history',
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count)
       VALUES (gen_random_uuid()::text, 'x', 'forged', now(), 0)`,
    ],
    ['creating a table', 'CREATE TABLE public.lp1_03_probe (id int)'],
    ['altering a policy', 'ALTER POLICY subsidiaries_select_scoped ON subsidiaries USING (true)'],
    ['dropping a policy', 'DROP POLICY subsidiaries_select_scoped ON subsidiaries'],
    ['turning RLS off', 'ALTER TABLE subsidiaries DISABLE ROW LEVEL SECURITY'],
    ['forcing RLS on', 'ALTER TABLE subsidiaries FORCE ROW LEVEL SECURITY'],
    ['creating an organisation', `INSERT INTO organisations (id, legal_name, country, geography_code, updated_at) VALUES (gen_random_uuid(), 'x', 'GB', 'UK', now())`],
    ['creating a profile', `INSERT INTO profiles (id, email, full_name, updated_at) VALUES (gen_random_uuid(), 'x@x.test', 'x', now())`],
    ['moving a profile to another organisation (D17)', 'UPDATE profiles SET organisation_id = NULL WHERE id = gen_random_uuid()'],
    ['rewriting a profile identity', `UPDATE profiles SET email = 'x@x.test' WHERE id = gen_random_uuid()`],
    ['deleting a profile', 'DELETE FROM profiles WHERE id = gen_random_uuid()'],
    ['editing a grant in place', 'UPDATE user_subsidiary_access SET organisation_id = organisation_id WHERE false'],
    ['writing reference factors', 'DELETE FROM emission_factors WHERE false'],
    ['assuming a client role', 'SET LOCAL ROLE authenticated'],
    ['assuming the owner', 'SET LOCAL ROLE postgres'],
    ['creating a role', 'CREATE ROLE lp1_03_probe'],
    ['writing Storage metadata', 'DELETE FROM storage.objects WHERE false'],
  ])('%s', async (_label, sql) => {
    expect(await attempt(sql)).toMatch(DENIED);
  });

  it('granting itself more: PostgreSQL only warns, and nothing is granted', async () => {
    const after = await withRollback(runtime, async (tx) => {
      await tx.$executeRawUnsafe('GRANT UPDATE, DELETE ON audit_log TO tonyai_runtime');
      return tx.$queryRaw<{ update: boolean; delete: boolean }[]>`
        SELECT has_table_privilege(current_user, 'audit_log', 'UPDATE') AS update,
               has_table_privilege(current_user, 'audit_log', 'DELETE') AS delete`;
    }).catch((err: unknown) => (DENIED.test(String(err)) ? [{ update: false, delete: false }] : Promise.reject(err)));
    expect(after).toEqual([{ update: false, delete: false }]);
  });

  it('…while the one profile column it may change still changes (control for the refusals above)', async () => {
    expect(await attempt('UPDATE profiles SET role = role WHERE id = gen_random_uuid()')).toBeNull();
  });
});
