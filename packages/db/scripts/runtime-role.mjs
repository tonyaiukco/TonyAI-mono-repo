/**
 * The runtime database role (LP1-03, F06) — one definition for everything that
 * provisions, derives or verifies it.
 *
 * Two credentials, two jobs:
 *  - DIRECT_URL — the OWNER (`postgres`). Migrations, DDL, the seed, operator
 *    tooling. Owns every table; can alter policies and `_prisma_migrations`.
 *  - DATABASE_URL — `tonyai_runtime`, created by the
 *    `20261003180000_lp1_03_tenant_invariants` migration: the API process, its
 *    in-process Storage sweeper, `storage:reconcile`, `anomaly:recompute`. It owns
 *    nothing and holds exactly the table privileges in RUNTIME_TABLE_PRIVILEGES.
 *    BYPASSRLS: the API's guard is the tenant boundary for these queries; RLS is
 *    the defense-in-depth layer for PostgREST clients only.
 *
 * The migration creates the role NOLOGIN and without a password — a credential
 * never goes into git. This script gives it a login on the LOCAL stack only:
 *
 *   node packages/db/scripts/runtime-role.mjs provision   # owner URL from DIRECT_URL
 *   node packages/db/scripts/runtime-role.mjs check       # verifies DATABASE_URL's database
 *
 * `provision` refuses any non-loopback database. `check` only reads the
 * catalogue, so an operator can point it at a deployed database (with either
 * credential) to verify the privileges actually granted there:
 *
 *   DATABASE_URL=<url> node packages/db/scripts/runtime-role.mjs check
 */
import { pathToFileURL } from 'node:url';

export const RUNTIME_ROLE = 'tonyai_runtime';

/**
 * The local stack's runtime password — public by design, like the local
 * `postgres:postgres`, and only ever set on a loopback database. A deployed
 * environment's operator sets its own (rotation runbook).
 */
export const LOCAL_RUNTIME_PASSWORD = 'tonyai-runtime-local';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True when `url` points at this machine. */
export function isLoopbackUrl(url) {
  return LOOPBACK_HOSTS.has(new URL(url).hostname);
}

/** The user name a connection string logs in as. */
export function urlUser(url) {
  return decodeURIComponent(new URL(url).username);
}

/** The same database as `ownerUrl`, logged in as the runtime role. */
export function runtimeUrlFrom(ownerUrl, password = LOCAL_RUNTIME_PASSWORD) {
  const url = new URL(ownerUrl);
  url.username = RUNTIME_ROLE;
  url.password = password;
  return url.toString();
}

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const SIUD = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/**
 * The intended table privileges of the runtime role — EVERY table in `public`
 * is listed, so a new table without a decision fails `check` (and the
 * integration suite) instead of silently coming up unreachable or over-granted.
 * Nothing anywhere gets TRUNCATE, REFERENCES or TRIGGER.
 */
export const RUNTIME_TABLE_PRIVILEGES = Object.freeze({
  organisations: ['SELECT'],
  emission_factors: ['SELECT'],
  // + UPDATE on (role, updated_at) only — see RUNTIME_COLUMN_UPDATES.
  profiles: ['SELECT'],
  user_subsidiary_access: ['SELECT', 'INSERT', 'DELETE'],
  subsidiaries: SIUD,
  locations: SIUD,
  targets: SIUD,
  subsidiary_denominators: SIUD,
  activity_records: SIUD,
  // UPDATE because `SELECT … FOR UPDATE` requires it (LP1-01's row locks).
  evidence: SIUD,
  activity_record_evidence: ['SELECT', 'INSERT', 'DELETE'],
  period_locks: ['SELECT', 'INSERT', 'DELETE'],
  import_batches: ['SELECT', 'INSERT', 'UPDATE'],
  // Append-only: written with every mutation, read by /audit.
  audit_log: ['SELECT', 'INSERT'],
  storage_intents: SIUD,
  // Prisma's migration history: neither readable nor writable.
  _prisma_migrations: [],
});

/** Column-level UPDATE grants on tables whose table-level UPDATE is withheld. */
export const RUNTIME_COLUMN_UPDATES = Object.freeze({
  // The role is the one profile attribute that changes at runtime
  // (AccessAdminService); the organisation never does (D17).
  profiles: ['role', 'updated_at'],
});

/** Privileges outside `public`, checked only where the schema exists. */
export const RUNTIME_STORAGE_PRIVILEGES = Object.freeze({
  'storage.objects': ['SELECT'],
});

/**
 * Compares the role in the connected database with the intended privileges.
 * `query(sql)` runs one read-only statement and resolves to its rows. Returns
 * a list of problems — empty when the role is exactly as intended.
 */
export async function checkRuntimeRole(query) {
  const problems = [];
  const role = RUNTIME_ROLE;

  const [attrs] = await query(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = '${role}'`,
  );
  if (!attrs) return [`role ${role} does not exist — is the LP1-03 migration applied?`];
  for (const [attr, label] of [
    ['rolsuper', 'SUPERUSER'],
    ['rolcreatedb', 'CREATEDB'],
    ['rolcreaterole', 'CREATEROLE'],
    ['rolreplication', 'REPLICATION'],
  ]) {
    if (attrs[attr]) problems.push(`${role} has ${label}`);
  }
  if (!attrs.rolbypassrls) {
    problems.push(`${role} lacks BYPASSRLS — the API would see no rows and the Storage sweeper would stall`);
  }

  const memberships = await query(
    `SELECT r.rolname FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.roleid
      WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = '${role}')`,
  );
  for (const m of memberships) problems.push(`${role} is a member of ${m.rolname}`);

  const owned = await query(
    `SELECT 'relation ' || c.relname AS what FROM pg_class c WHERE c.relowner = '${role}'::regrole
     UNION ALL SELECT 'schema ' || n.nspname FROM pg_namespace n WHERE n.nspowner = '${role}'::regrole
     UNION ALL SELECT 'function ' || p.proname FROM pg_proc p WHERE p.proowner = '${role}'::regrole`,
  );
  for (const o of owned) problems.push(`${role} owns ${o.what}`);

  const [schema] = await query(
    `SELECT has_schema_privilege('${role}', 'public', 'USAGE') AS usage,
            has_schema_privilege('${role}', 'public', 'CREATE') AS create_,
            has_database_privilege('${role}', current_database(), 'CREATE') AS createdb_obj`,
  );
  if (!schema.usage) problems.push(`${role} lacks USAGE on schema public`);
  if (schema.create_) problems.push(`${role} can CREATE in schema public`);
  if (schema.createdb_obj) problems.push(`${role} can CREATE schemas in this database`);

  const tables = await query(
    `SELECT c.relname AS name, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
  );
  const expectedTables = new Set(Object.keys(RUNTIME_TABLE_PRIVILEGES));
  for (const { name, forced } of tables) {
    if (forced) problems.push(`public.${name} has FORCE ROW LEVEL SECURITY`);
    if (!expectedTables.delete(name)) {
      problems.push(`public.${name} has no entry in RUNTIME_TABLE_PRIVILEGES — decide the runtime's privileges for it`);
      continue;
    }
    const expected = new Set(RUNTIME_TABLE_PRIVILEGES[name]);
    const rows = await query(
      `SELECT ${PRIVILEGES.map((p) => `has_table_privilege('${role}', 'public.${name}', '${p}') AS "${p}"`).join(', ')}`,
    );
    for (const p of PRIVILEGES) {
      if (rows[0][p] && !expected.has(p)) problems.push(`${role} has ${p} on public.${name}`);
      if (!rows[0][p] && expected.has(p)) problems.push(`${role} lacks ${p} on public.${name}`);
    }
    if (!expected.has('UPDATE')) {
      const allowed = new Set(RUNTIME_COLUMN_UPDATES[name] ?? []);
      const cols = await query(
        `SELECT a.attname AS col, has_column_privilege('${role}', 'public.${name}', a.attname, 'UPDATE') AS can
           FROM pg_attribute a
          WHERE a.attrelid = 'public.${name}'::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
      );
      for (const { col, can } of cols) {
        if (can && !allowed.has(col)) problems.push(`${role} can UPDATE public.${name}.${col}`);
        if (!can && allowed.has(col)) problems.push(`${role} cannot UPDATE public.${name}.${col}`);
      }
    }
  }
  for (const missing of expectedTables) problems.push(`RUNTIME_TABLE_PRIVILEGES lists public.${missing}, which does not exist`);

  for (const [qualified, privileges] of Object.entries(RUNTIME_STORAGE_PRIVILEGES)) {
    const [{ exists }] = await query(`SELECT to_regclass('${qualified}') IS NOT NULL AS exists`);
    if (!exists) continue;
    const expected = new Set(privileges);
    const rows = await query(
      `SELECT ${PRIVILEGES.map((p) => `has_table_privilege('${role}', '${qualified}', '${p}') AS "${p}"`).join(', ')}`,
    );
    for (const p of PRIVILEGES) {
      if (rows[0][p] && !expected.has(p)) problems.push(`${role} has ${p} on ${qualified}`);
      if (!rows[0][p] && expected.has(p)) problems.push(`${role} lacks ${p} on ${qualified}`);
    }
  }
  return problems;
}

/**
 * Gives the runtime role a login with LOCAL_RUNTIME_PASSWORD, through the
 * owner connection `client` (a PrismaClient). Loopback databases only.
 */
export async function provisionLocalRuntimeLogin(client, ownerUrl) {
  if (!isLoopbackUrl(ownerUrl)) {
    throw new Error(
      `Refusing to set the local runtime password on non-local host "${new URL(ownerUrl).hostname}". ` +
        'A deployed environment provisions its runtime login through its rotation runbook.',
    );
  }
  await client.$executeRawUnsafe(
    `ALTER ROLE "${RUNTIME_ROLE}" WITH LOGIN PASSWORD '${LOCAL_RUNTIME_PASSWORD}'`,
  );
}

async function main() {
  const command = process.argv[2];
  const { PrismaClient } = await import('../generated/client/index.js');

  if (command === 'provision') {
    const ownerUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
    if (!ownerUrl) throw new Error('Set DIRECT_URL to the owner connection string.');
    if (urlUser(ownerUrl) === RUNTIME_ROLE) {
      throw new Error('DIRECT_URL logs in as the runtime role; provisioning needs the owner.');
    }
    const owner = new PrismaClient({ datasourceUrl: ownerUrl });
    try {
      await provisionLocalRuntimeLogin(owner, ownerUrl);
    } finally {
      await owner.$disconnect();
    }
    const runtime = new PrismaClient({ datasourceUrl: runtimeUrlFrom(ownerUrl) });
    try {
      const [{ user }] = await runtime.$queryRawUnsafe('SELECT current_user AS "user"');
      console.log(`runtime login ready: ${user} on ${new URL(ownerUrl).host}`);
    } finally {
      await runtime.$disconnect();
    }
    return;
  }

  if (command === 'check') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Set DATABASE_URL to the database to check.');
    const client = new PrismaClient({ datasourceUrl: url });
    let problems;
    try {
      problems = await checkRuntimeRole((sql) => client.$queryRawUnsafe(sql));
    } finally {
      await client.$disconnect();
    }
    if (problems.length > 0) {
      console.error(`${RUNTIME_ROLE} on ${new URL(url).host}: ${problems.length} problem(s)`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`${RUNTIME_ROLE} on ${new URL(url).host}: privileges as intended`);
    return;
  }

  console.error('usage: runtime-role.mjs provision | check');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
