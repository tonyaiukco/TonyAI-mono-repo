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
 * never goes into git. This script gives it a login on the LOCAL stack only,
 * with a password generated per environment (`pnpm setup` writes it into the
 * .env files; the integration suite and CI's e2e API generate their own):
 *
 *   RUNTIME_DB_PASSWORD=<pw> DIRECT_URL=<owner> node packages/db/scripts/runtime-role.mjs provision
 *   node packages/db/scripts/runtime-role.mjs check       # verifies DATABASE_URL's database
 *
 * `provision` refuses any database that is not plainly on this machine, and
 * sends a SCRAM verifier computed here, so the password itself never reaches
 * the server (or its statement logs). `check` only reads the catalogue, so an
 * operator can point it at a deployed database (with either credential) to
 * verify the privileges actually granted there:
 *
 *   DATABASE_URL=<url> node packages/db/scripts/runtime-role.mjs check
 *
 * A deployed environment's operator sets the password with psql's
 * `\password tonyai_runtime` (also client-side hashed), never with a plain
 * `ALTER ROLE … PASSWORD '…'`, which statement logs and pg_stat_statements keep.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const RUNTIME_ROLE = 'tonyai_runtime';

/** A fresh random password for a local runtime login. */
export function randomRuntimePassword() {
  return randomBytes(24).toString('base64url');
}

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for `password` (RFC 5802/7677,
 * PostgreSQL's `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`).
 * Handing the server this instead of the password keeps the password out of
 * its logs. The password must be ASCII (SASLprep is then the identity), which
 * `randomRuntimePassword` always is.
 */
export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error('scramVerifier: the password must be printable ASCII');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Connection-string parameters a local URL may carry. Anything else is
 * refused: Prisma's engine honours `?host=` (and libpq `hostaddr`) over the
 * URL's host, so `postgresql://…@localhost:54322/postgres?host=staging.example`
 * would pass a hostname check and connect somewhere else entirely.
 */
const ALLOWED_PARAMS = new Set([
  'schema',
  'connection_limit',
  'pool_timeout',
  'connect_timeout',
  'socket_timeout',
  'statement_cache_size',
  'pgbouncer',
  'sslmode',
  'application_name',
]);

/** True only when `url` plainly points at this machine: a loopback host and no parameter that could redirect it. */
export function isLoopbackUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) return false;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return false;
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key.toLowerCase())) return false;
  }
  return true;
}

/** The user name a connection string logs in as. */
export function urlUser(url) {
  return decodeURIComponent(new URL(url).username);
}

/** The same database as `ownerUrl`, logged in as the runtime role with `password`. */
export function runtimeUrlFrom(ownerUrl, password) {
  if (!password) throw new Error('runtimeUrlFrom: a password is required');
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
  // + UPDATE on every column but its identity and organisation — see
  // RUNTIME_COLUMN_UPDATES.
  subsidiaries: ['SELECT', 'INSERT', 'DELETE'],
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
  // Everything an edit changes; never `id` or `organisation_id`, so not even a
  // bug can move a subsidiary — and every record, file and lock under it — to
  // another tenant. A new column needs its grant here and in a migration.
  subsidiaries: [
    'legal_name',
    'trading_name',
    'location',
    'geography_code',
    'business_area',
    'sector',
    'designated_person',
    'reporting_status',
    'included_scopes',
    'updated_at',
    'contact_email',
    'contact_phone',
    'tracking_granularity',
  ],
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
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconfig
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
  // Settings attached to the role (`ALTER ROLE … SET`) apply to every session
  // it opens — a search_path among them would change what its queries resolve to.
  if (attrs.rolconfig?.length) problems.push(`${role} carries role settings: ${attrs.rolconfig.join(', ')}`);

  const memberships = await query(
    `SELECT r.rolname FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.roleid
      WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = '${role}')`,
  );
  for (const m of memberships) problems.push(`${role} is a member of ${m.rolname}`);
  // Who may act AS the runtime role: only its creator, with ADMIN and neither
  // INHERIT nor SET (PostgreSQL 16's grant to a CREATEROLE creator).
  const members = await query(
    `SELECT r.rolname, m.inherit_option, m.set_option FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member
      WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = '${role}')`,
  );
  for (const m of members) {
    if (m.inherit_option || m.set_option) problems.push(`${m.rolname} may act as ${role} (INHERIT or SET)`);
  }

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
    // Column-level grants are invisible to has_table_privilege: `INSERT (…)` on
    // `profiles` or `SELECT (migration_name)` on `_prisma_migrations` would
    // pass the loop above (`qa-auditor`).
    for (const p of ['SELECT', 'INSERT', 'REFERENCES']) {
      if (expected.has(p)) continue;
      const [{ any }] = await query(`SELECT has_any_column_privilege('${role}', 'public.${name}', '${p}') AS any`);
      if (any) problems.push(`${role} has column-level ${p} on public.${name}`);
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

  // Outside `public` and Storage's catalogue the role should reach nothing it
  // was granted on its own; what every role inherits from PUBLIC is reported
  // by `runtimeRoleExposures` instead (the platform's grants, not ours).
  for (const row of await outsideReach(query)) {
    if (!row.viaPublic) problems.push(`${role} was granted ${row.what}`);
  }
  return problems;
}

const OWN_SCHEMAS = ['public', 'pg_catalog', 'information_schema'];

/**
 * What the role can reach outside `public` beyond `RUNTIME_STORAGE_PRIVILEGES`:
 * schemas it may use, relations it may touch in them, and SECURITY DEFINER
 * functions it may call there — each marked when PUBLIC holds the grant.
 */
async function outsideReach(query) {
  const role = RUNTIME_ROLE;
  const expected = Object.keys(RUNTIME_STORAGE_PRIVILEGES);
  const schemas = await query(
    `SELECT n.nspname AS name,
            EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a WHERE a.grantee = 0 AND a.privilege_type = 'USAGE') AS via_public
       FROM pg_namespace n
      WHERE has_schema_privilege('${role}', n.oid, 'USAGE')
        AND n.nspname NOT IN (${OWN_SCHEMAS.map((x) => `'${x}'`).join(', ')})
        AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY 1`,
  );
  const out = [];
  for (const { name, via_public } of schemas) {
    if (name !== 'storage') out.push({ what: `USAGE on schema ${name}`, viaPublic: via_public });
    const relations = await query(
      `SELECT c.relname AS rel,
              array_to_string(ARRAY(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
                                    WHERE has_table_privilege('${role}', c.oid, p)), ',') AS privs,
              EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0) AS via_public
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${name}' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
        ORDER BY 1`,
    );
    for (const { rel, privs, via_public: relPublic } of relations) {
      if (!privs || expected.includes(`${name}.${rel}`)) continue;
      out.push({ what: `${privs} on ${name}.${rel}`, viaPublic: relPublic });
    }
    const definers = await query(
      `SELECT p.proname AS fn, p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS via_public
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = '${name}' AND p.prosecdef AND has_function_privilege('${role}', p.oid, 'EXECUTE')
        ORDER BY 1`,
    );
    for (const { fn, via_public: fnPublic } of definers) {
      out.push({ what: `EXECUTE on SECURITY DEFINER ${name}.${fn}()`, viaPublic: fnPublic });
    }
  }
  return out;
}

/**
 * What the runtime role can reach outside its own grants because PUBLIC holds
 * it — granted by the platform (Supabase's `pg_net` tables, Storage's helper
 * functions), not by this repository, and not revocable by the owner. Reported,
 * not failed: in a deployed environment each line is a reason to disable the
 * extension or to have the platform revoke the grant.
 */
export async function runtimeRoleExposures(query) {
  return (await outsideReach(query)).filter((r) => r.viaPublic).map((r) => `${r.what} (via PUBLIC)`);
}

/**
 * The data the keys and policies are meant to keep true, checked as data: a
 * session in replica mode (a restore, `session_replication_role = replica`)
 * skips foreign-key triggers, so a restored database can hold what no write
 * path could create. Run after every restore.
 */
export async function checkTenantInvariants(query) {
  const [{ n }] = await query(
    `SELECT count(*)::int AS n
       FROM user_subsidiary_access usa
       LEFT JOIN profiles p ON p.id = usa.user_id
       LEFT JOIN subsidiaries s ON s.id = usa.subsidiary_id
      WHERE p.id IS NULL OR s.id IS NULL
         OR p.organisation_id IS DISTINCT FROM usa.organisation_id
         OR s.organisation_id IS DISTINCT FROM usa.organisation_id`,
  );
  return n > 0 ? [`${n} user_subsidiary_access row(s) cross an organisation or point at nothing`] : [];
}

/**
 * Gives the runtime role a login with `password`, through the owner connection
 * `client` (a PrismaClient). Loopback databases only; the server receives a
 * SCRAM verifier, never the password.
 */
export async function provisionLocalRuntimeLogin(client, ownerUrl, password) {
  if (!isLoopbackUrl(ownerUrl)) {
    throw new Error(
      'Refusing to set a runtime password on a database that is not plainly local (a loopback host and no ' +
        'redirecting parameter). A deployed environment sets its runtime login through its rotation runbook.',
    );
  }
  if (urlUser(ownerUrl) === RUNTIME_ROLE) throw new Error('Provisioning needs the owner connection, not the runtime role.');
  await client.$executeRawUnsafe(`ALTER ROLE "${RUNTIME_ROLE}" WITH LOGIN PASSWORD '${scramVerifier(password)}'`);
}

async function main() {
  const command = process.argv[2];
  const { PrismaClient } = await import('../generated/client/index.js');

  if (command === 'provision') {
    const ownerUrl = process.env.DIRECT_URL;
    const password = process.env.RUNTIME_DB_PASSWORD;
    if (!ownerUrl) throw new Error('Set DIRECT_URL to the owner connection string.');
    if (!password) throw new Error('Set RUNTIME_DB_PASSWORD to the password the runtime role should log in with.');
    const owner = new PrismaClient({ datasourceUrl: ownerUrl });
    try {
      await provisionLocalRuntimeLogin(owner, ownerUrl, password);
    } finally {
      await owner.$disconnect();
    }
    const runtime = new PrismaClient({ datasourceUrl: runtimeUrlFrom(ownerUrl, password) });
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
    let exposures;
    try {
      const query = (sql) => client.$queryRawUnsafe(sql);
      problems = [...(await checkRuntimeRole(query)), ...(await checkTenantInvariants(query))];
      exposures = await runtimeRoleExposures(query);
    } finally {
      await client.$disconnect();
    }
    for (const e of exposures) console.warn(`  ! ${RUNTIME_ROLE} can also reach ${e}`);
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
