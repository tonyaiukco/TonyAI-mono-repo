import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  INTEGRITY_CHECKS,
  INTEGRITY_TRIGGERS,
  RUNTIME_ROLE,
  checkIntegrityTriggers,
  checkRuntimeRole,
  checkFunctionExecutors,
  checkTableLevelGrants,
  checkTenantInvariants,
  factorLibraryReport,
  platformDefaultPrivileges,
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

  it('a grant of ours cannot hide behind PUBLIC, a per-database setting, CREATE elsewhere or a Storage column (`security-rls` round 2)', async () => {
    const { problems, exposures } = await withRollback(owner, async (tx) => {
      // A schema and table PUBLIC can use and read — and then OUR extra grants on them.
      await tx.$executeRawUnsafe('CREATE SCHEMA lp103_probe');
      await tx.$executeRawUnsafe('GRANT USAGE ON SCHEMA lp103_probe TO PUBLIC');
      await tx.$executeRawUnsafe('CREATE TABLE lp103_probe.t (id int)');
      await tx.$executeRawUnsafe('GRANT SELECT ON lp103_probe.t TO PUBLIC');
      await tx.$executeRawUnsafe('GRANT INSERT ON lp103_probe.t TO tonyai_runtime');
      await tx.$executeRawUnsafe('GRANT CREATE ON SCHEMA lp103_probe TO tonyai_runtime');
      await tx.$executeRawUnsafe(
        `DO $$ BEGIN EXECUTE format('ALTER ROLE tonyai_runtime IN DATABASE %I SET search_path = public', current_database()); END $$`,
      );
      await tx.$executeRawUnsafe('GRANT UPDATE (name) ON storage.objects TO tonyai_runtime');
      const query = (sql: string) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql);
      return { problems: await checkRuntimeRole(query), exposures: await runtimeRoleExposures(query) };
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'tonyai_runtime was granted INSERT on lp103_probe.t',
        'tonyai_runtime was granted CREATE on schema lp103_probe',
        'tonyai_runtime carries role settings for a database: search_path=public',
        'tonyai_runtime was granted UPDATE (column-level) on storage.objects',
      ]),
    );
    // What PUBLIC itself holds stays a warning.
    expect(exposures).toEqual(expect.arrayContaining(['SELECT on lp103_probe.t (via PUBLIC)']));
  });

  it('notices column-level grants, which has_table_privilege does not see (`qa-auditor`)', async () => {
    const problems = await withRollback(owner, async (tx) => {
      // LP4-01's profile INSERT is per column: one column beyond its list is
      // reported, and so is a listed one taken away.
      await tx.$executeRawUnsafe('GRANT INSERT (disabled_at) ON profiles TO tonyai_runtime');
      await tx.$executeRawUnsafe('REVOKE INSERT (organisation_id) ON profiles FROM tonyai_runtime');
      await tx.$executeRawUnsafe('GRANT INSERT (organisation_id) ON audit_log TO tonyai_runtime');
      await tx.$executeRawUnsafe('GRANT SELECT (migration_name) ON _prisma_migrations TO tonyai_runtime');
      await tx.$executeRawUnsafe('GRANT UPDATE (organisation_id) ON subsidiaries TO tonyai_runtime');
      await tx.$executeRawUnsafe('GRANT UPDATE (profile_id) ON invitations TO tonyai_runtime');
      return checkRuntimeRole((sql) => tx.$queryRawUnsafe(sql));
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'tonyai_runtime can INSERT public.profiles.disabled_at',
        'tonyai_runtime cannot INSERT public.profiles.organisation_id',
        'tonyai_runtime has column-level SELECT on public._prisma_migrations',
        'tonyai_runtime can UPDATE public.subsidiaries.organisation_id',
        'tonyai_runtime can UPDATE public.invitations.profile_id',
      ]),
    );
    // A table already granted INSERT whole is not re-checked per column.
    expect(problems.filter((p) => p.includes('audit_log'))).toEqual([]);
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

describe('the factor model is in force on this database (LP3-03)', () => {
  it('holds every integrity trigger, ENABLE ALWAYS, on its events, with its migration\'s function body; every key CHECK', async () => {
    expect(await checkIntegrityTriggers((sql: string) => runtime.$queryRawUnsafe(sql))).toEqual([]);
  });

  it('leaves the table-level verbs (TRIGGER, TRUNCATE, REFERENCES, MAINTAIN) to the owners alone, now and by default', async () => {
    expect(await checkTableLevelGrants((sql: string) => owner.$queryRawUnsafe(sql))).toEqual([]);
  });

  it('lets no role but the owner EXECUTE (so attach, or call through /rpc) a function in public, now or by default', async () => {
    expect(await checkFunctionExecutors((sql: string) => owner.$queryRawUnsafe(sql))).toEqual([]);
  });

  it('pins every CHECK on a guarded table — a new or renamed one cannot go unwatched', async () => {
    const guarded = [...new Set(INTEGRITY_TRIGGERS.map((t) => t.table))];
    const rows = await owner.$queryRawUnsafe<{ key: string }[]>(
      `SELECT c.conrelid::regclass::text || '.' || c.conname AS key
         FROM pg_constraint c
        WHERE c.contype = 'c' AND c.conrelid::regclass::text IN (${guarded.map((t) => `'${t}'`).join(', ')})`,
    );
    const pinned = new Set(INTEGRITY_CHECKS.map(([table, name]) => `${table}.${name}`));
    expect(rows.map((r) => r.key).filter((k) => !pinned.has(k))).toEqual([]);
    expect(rows.length).toBe(INTEGRITY_CHECKS.length);
  });

  it('reports the seed\'s placeholder releases as notices, and no unspecified row under an authoritative release', async () => {
    const report = await factorLibraryReport((sql: string) => owner.$queryRawUnsafe(sql));
    expect(report.problems).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.notices.some((n: string) => n.startsWith('placeholder release TonyAI prototype 2026.1'))).toBe(true);
  });

  it('cannot reconcile the library\'s record as the runtime role, which may not read it — and says so', async () => {
    const report = await factorLibraryReport((sql: string) => runtime.$queryRawUnsafe(sql));
    expect(report.problems).toEqual([]);
    expect(report.skipped).toEqual([
      "the library's record was not reconciled: tonyai_runtime cannot read factor_release_events — run this check through the owner (DIRECT_URL)",
    ]);
  });
});

/**
 * Open questions, LP3-03 PR B (14): a function a migration adds to `public`
 * is born executable by its owner alone, and the check fails when one is not.
 * Locally `pnpm db:reset` has dropped Supabase's per-schema defaults, so the
 * negative cases set the defaults they need themselves; CI keeps Supabase's.
 */
describe('no function in public is born executable by a client (OQ 14)', () => {
  const probe = `CREATE FUNCTION public.oq14_probe() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
    AS $$ BEGIN RETURN NULL; END $$`;
  const executors = `SELECT r.role, pg_catalog.has_function_privilege(r.role, 'public.oq14_probe()', 'EXECUTE') AS "may"
    FROM unnest(ARRAY['public', 'anon', 'authenticated', 'service_role', '${RUNTIME_ROLE}']) AS r(role) ORDER BY 1`;
  let creator: string;
  const actsAs = (client: string, role: string) =>
    `${client} can act as ${role} (a member — inherited, by SET ROLE or by ADMIN), an owner in public or of the database — it may alter, disable or drop what that role owns; no client may be`;
  const ownsSomething = (client: string) =>
    `${client} owns the database, the schema public or something in it — it may alter, disable or drop it; no client may own one`;
  const ownedBy = (fn: string, role: string) =>
    `public.${fn} is owned by ${role} — who may run, attach, alter and drop it; only the owner of the schema's tables may own one`;
  const mayCreate = (client: string, via?: string) =>
    `${client} may create in public${via ? ` as ${via}` : ''} — a function it creates there is its own to run, attach and grant; no client may`;

  beforeAll(async () => {
    [{ creator }] = await owner.$queryRaw<{ creator: string }[]>`SELECT current_user AS "creator"`;
  });

  it('a SECURITY DEFINER trigger function created now: EXECUTE for its owner alone, and the check stays clean', async () => {
    const { may, problems } = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(probe);
      return {
        may: await tx.$queryRawUnsafe<{ role: string; may: boolean }[]>(executors),
        problems: await checkFunctionExecutors((sql: string) => tx.$queryRawUnsafe(sql)),
      };
    });
    expect(may.filter((r) => r.may)).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('fails when the default grants EXECUTE again — naming the default and the function born with it, whoever runs the check', async () => {
    const { problems, asAnotherRole } = await withRollback(owner, async (tx) => {
      // PUBLIC: back to PostgreSQL's built-in default (the global row goes);
      // anon: what Supabase's per-schema default gives.
      await tx.$executeRawUnsafe('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC');
      await tx.$executeRawUnsafe('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon');
      await tx.$executeRawUnsafe(probe);
      const query = (sql: string) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql);
      const asOwner = await checkFunctionExecutors(query);
      // `check` and `rls:probe` run as the runtime role where DATABASE_URL is
      // it: the owner's defaults stay the owner's, not the caller's.
      await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
      return { problems: asOwner, asAnotherRole: await checkFunctionExecutors(query) };
    });
    expect(asAnotherRole).toEqual(problems);
    expect(problems).toEqual(
      expect.arrayContaining([
        `PUBLIC may EXECUTE every new public function ${creator} creates — only its owner may`,
        `anon may EXECUTE every new public function ${creator} creates — only its owner may`,
        'PUBLIC may EXECUTE public.oq14_probe() — attach it to a table of its own; only its owner may',
        'anon may EXECUTE public.oq14_probe() — attach it to a table of its own; only its owner may',
      ]),
    );
  });

  it('names a function called through /rpc, with its arguments — not only trigger functions', async () => {
    const problems = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(
        `CREATE FUNCTION public.oq14_rpc(p_id uuid, p_note text) RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = '' AS 'SELECT 1'`,
      );
      await tx.$executeRawUnsafe('GRANT EXECUTE ON FUNCTION public.oq14_rpc(uuid, text) TO anon');
      return checkFunctionExecutors((sql: string) => tx.$queryRawUnsafe(sql));
    });
    expect(problems).toEqual(['anon may EXECUTE public.oq14_rpc(p_id uuid, p_note text) — call it, through /rpc too; only its owner may']);
  });

  it('names a function in public that another role owns — its owner may run, attach, alter and drop it', async () => {
    const problems = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(probe);
      // A new owner needs CREATE on the schema; taken back at once, so only ownership remains.
      await tx.$executeRawUnsafe('GRANT CREATE ON SCHEMA public TO service_role');
      await tx.$executeRawUnsafe('ALTER FUNCTION public.oq14_probe() OWNER TO service_role');
      await tx.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM service_role');
      return checkFunctionExecutors((sql: string) => tx.$queryRawUnsafe(sql));
    });
    expect(problems).toEqual([
      ownedBy('oq14_probe()', 'service_role'),
      // PostgREST's login may SET ROLE service_role, so it reaches the function too.
      actsAs('authenticator', 'service_role'),
      ownsSomething('service_role'),
    ]);
  });

  it('names a procedure and an aggregate a client may run — not only functions', async () => {
    const problems = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(`CREATE PROCEDURE public.oq14_proc() LANGUAGE sql AS 'SELECT 1'`);
      await tx.$executeRawUnsafe('CREATE AGGREGATE public.oq14_agg(integer) (SFUNC = int4pl, STYPE = integer)');
      await tx.$executeRawUnsafe('GRANT EXECUTE ON PROCEDURE public.oq14_proc() TO anon');
      await tx.$executeRawUnsafe('GRANT EXECUTE ON FUNCTION public.oq14_agg(integer) TO authenticated');
      return checkFunctionExecutors((sql: string) => tx.$queryRawUnsafe(sql));
    });
    expect(problems).toEqual([
      'authenticated may EXECUTE public.oq14_agg(integer) — call it, through /rpc too; only its owner may',
      'anon may EXECUTE public.oq14_proc() — call it, through /rpc too; only its owner may',
    ]);
  });

  it('names a procedure and an aggregate another role owns — and the clients that can act as it', async () => {
    const problems = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL createrole_self_grant = 'set, inherit'");
      await tx.$executeRawUnsafe('CREATE ROLE oq14_owner NOLOGIN');
      await tx.$executeRawUnsafe(`CREATE PROCEDURE public.oq14_proc() LANGUAGE sql AS 'SELECT 1'`);
      await tx.$executeRawUnsafe('CREATE AGGREGATE public.oq14_agg(integer) (SFUNC = int4pl, STYPE = integer)');
      await tx.$executeRawUnsafe('GRANT CREATE ON SCHEMA public TO oq14_owner');
      await tx.$executeRawUnsafe('ALTER PROCEDURE public.oq14_proc() OWNER TO oq14_owner');
      await tx.$executeRawUnsafe('ALTER AGGREGATE public.oq14_agg(integer) OWNER TO oq14_owner');
      await tx.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM oq14_owner');
      await tx.$executeRawUnsafe('GRANT oq14_owner TO anon WITH INHERIT FALSE, SET TRUE');
      return checkFunctionExecutors((sql: string) => tx.$queryRawUnsafe(sql));
    });
    expect(problems).toEqual([
      ownedBy('oq14_agg(integer)', 'oq14_owner'),
      ownedBy('oq14_proc()', 'oq14_owner'),
      actsAs('anon', 'oq14_owner'),
      actsAs('authenticator', 'oq14_owner'),
    ]);
  });

  it('names a client that may create in public — by its own CREATE, or by SET ROLE or ADMIN in a role that has it, transitively (Codex P2-2)', async () => {
    const { direct, viaRole } = await withRollback(owner, async (tx) => {
      const query = (sql: string) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql);
      await tx.$executeRawUnsafe('GRANT CREATE ON SCHEMA public TO authenticated');
      const direct = await checkFunctionExecutors(query);
      await tx.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM authenticated');
      // SET only, no INHERIT: has_schema_privilege('anon', …) stays false, and
      // authenticator reaches it through its own SET-only grant of anon.
      await tx.$executeRawUnsafe('CREATE ROLE oq14_creator NOLOGIN');
      await tx.$executeRawUnsafe('GRANT CREATE ON SCHEMA public TO oq14_creator');
      await tx.$executeRawUnsafe('GRANT oq14_creator TO anon WITH INHERIT FALSE, SET TRUE');
      // ADMIN alone: it may grant itself SET.
      await tx.$executeRawUnsafe('GRANT oq14_creator TO service_role WITH ADMIN TRUE, INHERIT FALSE, SET FALSE');
      return { direct, viaRole: await checkFunctionExecutors(query) };
    });
    expect(direct).toEqual([mayCreate('authenticated'), mayCreate('authenticator', 'authenticated')]);
    expect(viaRole).toEqual([mayCreate('anon', 'oq14_creator'), mayCreate('authenticator', 'oq14_creator'), mayCreate('service_role', 'oq14_creator')]);
  });

  it('names a client that can act as an owner in public — by INHERIT, or by ADMIN alone, and transitively (Codex P2-1)', async () => {
    const problems = await withRollback(owner, async (tx) => {
      // The owner may become the role it creates, so that it can hand it a function.
      await tx.$executeRawUnsafe("SET LOCAL createrole_self_grant = 'set, inherit'");
      await tx.$executeRawUnsafe('CREATE ROLE oq14_owner NOLOGIN');
      await tx.$executeRawUnsafe(probe);
      // A new owner needs CREATE on the schema; taken back at once, so only ownership remains.
      await tx.$executeRawUnsafe('GRANT CREATE ON SCHEMA public TO oq14_owner');
      await tx.$executeRawUnsafe('ALTER FUNCTION public.oq14_probe() OWNER TO oq14_owner');
      await tx.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM oq14_owner');
      await tx.$executeRawUnsafe('GRANT oq14_owner TO service_role WITH INHERIT TRUE, SET FALSE');
      await tx.$executeRawUnsafe('GRANT oq14_owner TO authenticated WITH ADMIN TRUE, INHERIT FALSE, SET FALSE');
      return checkFunctionExecutors((sql: string) => tx.$queryRawUnsafe(sql));
    });
    expect(problems).toEqual([
      ownedBy('oq14_probe()', 'oq14_owner'),
      actsAs('authenticated', 'oq14_owner'),
      // PostgREST's login reaches it through its SET-only grant of authenticated.
      actsAs('authenticator', 'oq14_owner'),
      actsAs('service_role', 'oq14_owner'),
    ]);
  });

  it("names a client that owns a table in public, or can act as a table's owner (security-rls, re-review)", async () => {
    const { member, owns } = await withRollback(owner, async (tx) => {
      const query = (sql: string) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql);
      await tx.$executeRawUnsafe("SET LOCAL createrole_self_grant = 'set, inherit'");
      await tx.$executeRawUnsafe('CREATE ROLE oq14_tabowner NOLOGIN');
      await tx.$executeRawUnsafe('CREATE TABLE public.oq14_t (x integer)');
      await tx.$executeRawUnsafe('GRANT CREATE ON SCHEMA public TO oq14_tabowner');
      await tx.$executeRawUnsafe('ALTER TABLE public.oq14_t OWNER TO oq14_tabowner');
      await tx.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM oq14_tabowner');
      await tx.$executeRawUnsafe('GRANT oq14_tabowner TO anon WITH INHERIT TRUE, SET FALSE');
      const member = await checkFunctionExecutors(query);
      await tx.$executeRawUnsafe('REVOKE oq14_tabowner FROM anon');
      await tx.$executeRawUnsafe('GRANT CREATE ON SCHEMA public TO service_role');
      await tx.$executeRawUnsafe('ALTER TABLE public.oq14_t OWNER TO service_role');
      await tx.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM service_role');
      return { member, owns: await checkFunctionExecutors(query) };
    });
    expect(member).toEqual([actsAs('anon', 'oq14_tabowner'), actsAs('authenticator', 'oq14_tabowner')]);
    expect(owns).toEqual([actsAs('authenticator', 'service_role'), ownsSomething('service_role')]);
  });

  it("names a client that owns a type in public, or can act as a type's owner — an enum's values are the roles (security-rls, verification pass)", async () => {
    const { member, owns } = await withRollback(owner, async (tx) => {
      const query = (sql: string) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql);
      await tx.$executeRawUnsafe("SET LOCAL createrole_self_grant = 'set, inherit'");
      await tx.$executeRawUnsafe('CREATE ROLE oq14_typowner NOLOGIN');
      await tx.$executeRawUnsafe('GRANT CREATE ON SCHEMA public TO oq14_typowner, service_role');
      await tx.$executeRawUnsafe('ALTER TYPE public."ActivityRecordStatus" OWNER TO oq14_typowner');
      await tx.$executeRawUnsafe('ALTER TYPE public."UserRole" OWNER TO service_role');
      await tx.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM oq14_typowner, service_role');
      const owns = await checkFunctionExecutors(query);
      await tx.$executeRawUnsafe('ALTER TYPE public."UserRole" OWNER TO CURRENT_USER');
      await tx.$executeRawUnsafe('GRANT oq14_typowner TO anon WITH INHERIT FALSE, SET TRUE');
      return { owns, member: await checkFunctionExecutors(query) };
    });
    expect(owns).toEqual([actsAs('authenticator', 'service_role'), ownsSomething('service_role')]);
    expect(member).toEqual([actsAs('anon', 'oq14_typowner'), actsAs('authenticator', 'oq14_typowner')]);
  });

  it('names a client that can act as the runtime role — ADMIN alone, directly or transitively (security-rls, re-review)', async () => {
    const { direct, transitive } = await withRollback(owner, async (tx) => {
      const query = (sql: string) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql);
      await tx.$executeRawUnsafe(`GRANT ${RUNTIME_ROLE} TO authenticated WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
      const direct = await checkFunctionExecutors(query);
      await tx.$executeRawUnsafe(`REVOKE ${RUNTIME_ROLE} FROM authenticated`);
      await tx.$executeRawUnsafe('CREATE ROLE oq14_mid NOLOGIN');
      await tx.$executeRawUnsafe(`GRANT ${RUNTIME_ROLE} TO oq14_mid WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
      await tx.$executeRawUnsafe('GRANT oq14_mid TO anon');
      return { direct, transitive: await checkFunctionExecutors(query) };
    });
    const asRuntime = (client: string) =>
      `${client} can act as ${RUNTIME_ROLE} (a member — inherited, by SET ROLE or by ADMIN), the API's role — BYPASSRLS and its every grant; no client may be`;
    expect(direct).toEqual([asRuntime('authenticated'), asRuntime('authenticator')]);
    expect(transitive).toEqual([asRuntime('anon'), asRuntime('authenticator')]);
  });

  it('reads only: every reader `check` runs works in a READ ONLY transaction, as the runtime role', async () => {
    const { problems, notices } = await withRollback(runtime, async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const query = (sql: string) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql);
      return {
        problems: [
          ...(await checkRuntimeRole(query)),
          ...(await checkTenantInvariants(query)),
          ...(await checkTableLevelGrants(query)),
          ...(await checkFunctionExecutors(query)),
          ...(await checkIntegrityTriggers(query)),
          ...(await factorLibraryReport(query)).problems,
        ],
        notices: [...(await platformDefaultPrivileges(query)), ...(await runtimeRoleExposures(query))],
      };
    });
    expect(problems).toEqual([]);
    expect(Array.isArray(notices)).toBe(true);
  });

  it('covers every function in public — not only the integrity functions it names', async () => {
    const problems = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe('GRANT EXECUTE ON FUNCTION public.organisations_remove_access_before_delete() TO authenticated');
      return checkFunctionExecutors((sql: string) => tx.$queryRawUnsafe(sql));
    });
    expect(problems).toEqual([
      'authenticated may EXECUTE public.organisations_remove_access_before_delete() — attach it to a table of its own; only its owner may',
    ]);
  });

  it("reads the owner's global table default too, not only its per-schema one", async () => {
    const problems = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe('ALTER DEFAULT PRIVILEGES GRANT TRIGGER ON TABLES TO anon');
      return checkTableLevelGrants((sql: string) => tx.$queryRawUnsafe(sql));
    });
    expect(problems).toEqual([`anon is granted TRIGGER on every new public table ${creator} creates — only its owner may hold it`]);
  });

  it("names another creator's defaults as the platform's — they fail neither check", async () => {
    const { problems, notices } = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe('ALTER DEFAULT PRIVILEGES FOR ROLE service_role IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon');
      await tx.$executeRawUnsafe('ALTER DEFAULT PRIVILEGES FOR ROLE service_role IN SCHEMA public GRANT TRIGGER ON TABLES TO anon');
      const query = (sql: string) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql);
      return {
        problems: [...(await checkFunctionExecutors(query)), ...(await checkTableLevelGrants(query))],
        notices: await platformDefaultPrivileges(query),
      };
    });
    expect(problems).toEqual([]);
    expect(notices).toEqual(
      expect.arrayContaining([
        'anon is granted TRIGGER on every new public table service_role creates',
        'anon is granted EXECUTE on every new public function service_role creates',
      ]),
    );
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
    // LP4-01: an invitation creates its profile, but never one born disabled
    // or carrying the Auth or reset bookkeeping.
    ['creating a profile born disabled', `INSERT INTO profiles (id, email, full_name, updated_at, disabled_at) VALUES (gen_random_uuid(), 'x@x.test', 'x', now(), now())`],
    ['creating a profile with Auth bookkeeping', `INSERT INTO profiles (id, email, full_name, updated_at, auth_sync_pending_since) VALUES (gen_random_uuid(), 'x@x.test', 'x', now(), now())`],
    ['creating a profile already in a reset cooldown', `INSERT INTO profiles (id, email, full_name, updated_at, recovery_sent_at) VALUES (gen_random_uuid(), 'x@x.test', 'x', now(), now())`],
    ['deleting an invitation (a withdrawn one is revoked)', 'DELETE FROM invitations WHERE false'],
    ['re-pointing an invitation', 'UPDATE invitations SET profile_id = profile_id WHERE false'],
    ['rewriting who invited', 'UPDATE invitations SET invited_by = NULL WHERE false'],
    ['rewriting an invitation language', `UPDATE invitations SET language = 'en' WHERE false`],
    ['marking an organisation offboarded (the operator CLI does)', 'UPDATE organisations SET offboarded_at = now() WHERE false'],
    ['moving a profile to another organisation (D17)', 'UPDATE profiles SET organisation_id = NULL WHERE id = gen_random_uuid()'],
    ['rewriting a profile identity', `UPDATE profiles SET email = 'x@x.test' WHERE id = gen_random_uuid()`],
    ['deleting a profile', 'DELETE FROM profiles WHERE id = gen_random_uuid()'],
    ['editing a grant in place', 'UPDATE user_subsidiary_access SET organisation_id = organisation_id WHERE false'],
    ['writing reference factors', 'DELETE FROM emission_factors WHERE false'],
    // LP3-03: the factor library is read-only to the API — loaded on the owner
    // connection by the seed and LP4-02's loader, never through the runtime.
    [
      'loading a factor release',
      `INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status) VALUES (gen_random_uuid(), 'TonyAI test fixture', 'x', 'x', 999999, 'fixture')`,
    ],
    ['withdrawing a factor release', `UPDATE factor_releases SET status = 'withdrawn' WHERE false`],
    ['deleting a factor release', 'DELETE FROM factor_releases WHERE false'],
    [
      'loading a factor',
      `INSERT INTO emission_factors (id, release_id, category, activity_type, gas, geography_code, reporting_year, data_year, scope, scope2_method, calorific_basis, factor_value, factor_unit, normalized_unit, methodology, source, version, updated_at)
       SELECT gen_random_uuid(), id, 'Waste', 'unspecified', 'CO2e', 'UK', 2026, 2026, 3, 'not_applicable', 'not_applicable', 1, 'x', 'kg', 'x', 'x', 'x', now() FROM factor_releases LIMIT 1`,
    ],
    [
      'loading a unit conversion',
      `INSERT INTO unit_conversions (id, release_id, category, activity_type, geography_code, reporting_year, data_year, from_unit, to_unit, multiplier, calorific_basis, basis)
       SELECT gen_random_uuid(), id, 'Natural Gas', 'natural_gas', 'UK', 2031, 2031, 'cubic_metres', 'kWh', 1, 'gross', 'x' FROM factor_releases LIMIT 1`,
    ],
    ['rewriting a unit conversion', 'UPDATE unit_conversions SET multiplier = 1 WHERE false'],
    [
      "forging the factor library's record",
      `INSERT INTO factor_release_events (id, release_id, publisher, edition, release_status, event, db_role)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'x', 'x', 'x', 'loaded', 'x')`,
    ],
    ["erasing the factor library's record", 'DELETE FROM factor_release_events WHERE false'],
    ["reading the factor library's record (no reader yet)", 'SELECT 1 FROM factor_release_events LIMIT 1'],
    ['truncating the factor library', 'TRUNCATE factor_releases CASCADE'],
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

  it('…while the profile columns it may change still change (control for the refusals above)', async () => {
    expect(await attempt('UPDATE profiles SET role = role WHERE id = gen_random_uuid()')).toBeNull();
    // LP3-01: the UI language, the user's own (PATCH /me/preferences).
    expect(await attempt(`UPDATE profiles SET language = 'tr' WHERE id = gen_random_uuid()`)).toBeNull();
    // LP4-01: disabling (D19), Auth's catch-up (K4), the reset cooldown.
    expect(
      await attempt('UPDATE profiles SET disabled_at = now(), auth_sync_pending_since = now(), recovery_sent_at = now() WHERE id = gen_random_uuid()'),
    ).toBeNull();
    // An invitation's profile, and the state it moves through.
    expect(
      await attempt(`INSERT INTO profiles (id, email, full_name, role, language, theme, organisation_id, created_at, updated_at) SELECT gen_random_uuid(), 'x@x.test', 'x', 'data_entry', 'en', 'light', NULL, now(), now() WHERE false`),
    ).toBeNull();
    expect(
      await attempt(`UPDATE invitations SET status = 'sent', attempts = attempts + 1, sent_at = now(), last_attempt_at = now(), last_error_step = NULL, last_error_code = NULL, updated_at = now() WHERE false`),
    ).toBeNull();
  });

  it('an address is stored in one spelling — trimmed, lower-case — whoever writes it (LP4-01)', async () => {
    for (const email of ['Mixed@x.test', ' padded@x.test']) {
      expect(
        await attempt(`INSERT INTO profiles (id, email, full_name, updated_at) VALUES (gen_random_uuid(), '${email}', 'x', now())`),
      ).toMatch(/profiles_email_normalised/);
    }
  });

  it('a language the product does not speak is refused by the column itself (LP3-01)', async () => {
    expect(
      await attempt(`UPDATE profiles SET language = 'de' WHERE id = (SELECT id FROM profiles LIMIT 1)`),
    ).toMatch(/profiles_language_supported/);
  });
});
