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
 * `provision` refuses any database that is not plainly on this machine — an
 * accident guard, not proof of locality: a port forwarded to a deployed
 * database (`ssh -L`, a cloud proxy) looks local, so never run local tooling
 * through one — and sends a SCRAM verifier computed here, so the password itself never reaches
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
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  // The factor library (LP3-03): reference data the API reads and never
  // writes — releases and conversions are loaded by the seed and LP4-02's
  // loader on the owner connection.
  emission_factors: ['SELECT'],
  factor_releases: ['SELECT'],
  unit_conversions: ['SELECT'],
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
  // `pg_roles.rolconfig` shows only the settings for every database; `ALTER
  // ROLE … IN DATABASE … SET` lives in pg_db_role_setting alone.
  const settings = await query(
    `SELECT array_to_string(s.setconfig, ', ') AS config, s.setdatabase <> 0 AS per_database
       FROM pg_db_role_setting s WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = '${role}')`,
  );
  for (const { config, per_database } of settings) {
    problems.push(`${role} carries role settings${per_database ? ' for a database' : ''}: ${config}`);
  }

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

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema'];
const RELATION_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
const sqlList = (xs) => xs.map((x) => `'${x}'`).join(', ');

/**
 * Everything the role can reach beyond its declared grants (the tables of
 * `public`, checked against RUNTIME_TABLE_PRIVILEGES, and
 * RUNTIME_STORAGE_PRIVILEGES): USAGE or CREATE on a schema; any privilege, table
 * or column level, on a relation of a schema it can use — in `public` the
 * relations that are not tables; EXECUTE on a SECURITY DEFINER function there.
 * Each privilege is marked `viaPublic` only when PUBLIC itself holds THAT
 * privilege, so a grant this repository made cannot hide behind an unrelated
 * PUBLIC entry in the same ACL (`security-rls` round 2).
 */
async function outsideReach(query) {
  const role = RUNTIME_ROLE;
  const declared = new Set(
    Object.entries(RUNTIME_STORAGE_PRIVILEGES).flatMap(([rel, privileges]) => privileges.map((p) => `${rel}:${p}`)),
  );
  const out = [];
  const schemas = await query(
    `SELECT n.nspname AS name, n.oid::int AS oid,
            has_schema_privilege('${role}', n.oid, 'USAGE') AS usage,
            has_schema_privilege('public', n.oid, 'USAGE') AS usage_public,
            has_schema_privilege('${role}', n.oid, 'CREATE') AS create_,
            has_schema_privilege('public', n.oid, 'CREATE') AS create_public
       FROM pg_namespace n
      WHERE n.nspname NOT IN (${sqlList(SYSTEM_SCHEMAS)})
        AND n.nspname NOT LIKE 'pg\\_%'
        AND (has_schema_privilege('${role}', n.oid, 'USAGE') OR has_schema_privilege('${role}', n.oid, 'CREATE'))
      ORDER BY 1`,
  );
  for (const { name, usage, usage_public, create_, create_public } of schemas) {
    // `public` is checked above, as a problem whoever granted it.
    if (create_ && name !== 'public') out.push({ what: `CREATE on schema ${name}`, viaPublic: create_public });
    if (!usage) continue;
    if (name !== 'public' && name !== 'storage') out.push({ what: `USAGE on schema ${name}`, viaPublic: usage_public });
    const kinds = name === 'public' ? ['v', 'm', 'S', 'f'] : ['r', 'p', 'v', 'm', 'S', 'f'];
    const reach = await query(
      `SELECT c.relname AS rel, x.priv, false AS column_level, has_table_privilege('public', c.oid, x.priv) AS via_public
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN unnest(ARRAY[${sqlList(RELATION_PRIVILEGES)}]) AS x(priv)
        WHERE n.nspname = '${name}' AND c.relkind IN (${sqlList(kinds)})
          AND has_table_privilege('${role}', c.oid, x.priv)
       UNION ALL
       SELECT c.relname, x.priv, true, has_any_column_privilege('public', c.oid, x.priv)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN unnest(ARRAY[${sqlList(COLUMN_PRIVILEGES)}]) AS x(priv)
        WHERE n.nspname = '${name}' AND c.relkind IN (${sqlList(kinds.filter((k) => k !== 'S'))})
          AND NOT has_table_privilege('${role}', c.oid, x.priv)
          AND has_any_column_privilege('${role}', c.oid, x.priv)
        ORDER BY 1, 2`,
    );
    const grouped = new Map();
    for (const { rel, priv, column_level, via_public } of reach) {
      if (!column_level && declared.has(`${name}.${rel}:${priv}`)) continue;
      const key = `${rel}|${column_level}|${via_public}`;
      const entry = grouped.get(key) ?? { rel, column_level, via_public, privs: [] };
      entry.privs.push(priv);
      grouped.set(key, entry);
    }
    for (const { rel, column_level, via_public, privs } of grouped.values()) {
      out.push({
        what: `${privs.join(',')}${column_level ? ' (column-level)' : ''} on ${name}.${rel}`,
        viaPublic: via_public,
      });
    }
    const definers = await query(
      `SELECT p.proname AS fn, has_function_privilege('public', p.oid, 'EXECUTE') AS via_public
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = '${name}' AND p.prosecdef AND has_function_privilege('${role}', p.oid, 'EXECUTE')
        ORDER BY 1`,
    );
    for (const { fn, via_public } of definers) {
      out.push({ what: `EXECUTE on SECURITY DEFINER ${name}.${fn}()`, viaPublic: via_public });
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
 * The integrity triggers the LP3-03 migration installs: each must exist, be
 * ENABLE ALWAYS (`tgenabled = 'A'`, firing in replica mode too, so a restore
 * cannot slip past it), fire on exactly its events, and run its own function
 * with exactly the body the migrations define. A trigger disabled, dropped,
 * re-created on fewer events or pointed at an emptied function is a silent
 * hole: the snapshot of an approved record becomes editable, or a loaded
 * factor rewritable.
 *
 * `type` is `pg_trigger.tgtype`: ROW 1, BEFORE 2, INSERT 4, DELETE 8,
 * UPDATE 16, TRUNCATE 32.
 */
const ROW = 1;
const BEFORE = 2;
const ON = { insert: 4, delete: 8, update: 16, truncate: 32 };
export const INTEGRITY_TRIGGERS = Object.freeze([
  { table: 'activity_records', trigger: 'activity_records_snapshot_immutable', fn: 'activity_records_snapshot_immutable', type: ROW | BEFORE | ON.update },
  { table: 'activity_records', trigger: 'activity_records_slot_kind', fn: 'activity_records_slot_kind', type: ROW | BEFORE | ON.insert | ON.update },
  ...['factor_releases', 'emission_factors', 'unit_conversions'].flatMap((table) => {
    const rows = table === 'factor_releases' ? 'factor_releases' : 'factor_rows';
    return [
      { table, trigger: `${table}_before_insert`, fn: `${rows}_before_insert`, type: ROW | BEFORE | ON.insert },
      { table, trigger: `${table}_before_update`, fn: `${rows}_before_update`, type: ROW | BEFORE | ON.update },
      { table, trigger: `${table}_before_delete`, fn: `${rows}_before_delete`, type: ROW | BEFORE | ON.delete },
      { table, trigger: `${table}_before_truncate`, fn: 'factor_tables_before_truncate', type: BEFORE | ON.truncate },
    ];
  }),
]);

/** The CHECK constraints the factor model's guarantees rest on. */
export const INTEGRITY_CHECKS = Object.freeze([
  ['factor_releases', 'factor_releases_status_check'],
  ['factor_releases', 'factor_releases_publisher_check'],
  ['factor_releases', 'factor_releases_placeholder_publisher_check'],
  ['factor_releases', 'factor_releases_fixture_publisher_check'],
  ['factor_releases', 'factor_releases_ordinal_check'],
  ['factor_releases', 'factor_releases_authoritative_provenance_check'],
  ['factor_releases', 'factor_releases_review_after_publication_check'],
  ['factor_releases', 'factor_releases_withdrawal_check'],
  ['factor_releases', 'factor_releases_source_url_check'],
  ['factor_releases', 'factor_releases_text_check'],
  ['emission_factors', 'emission_factors_activity_type_check'],
  ['emission_factors', 'emission_factors_gas_check'],
  ['emission_factors', 'emission_factors_gas_coverage_check'],
  ['emission_factors', 'emission_factors_scope2_method_check'],
  ['emission_factors', 'emission_factors_scope_check'],
  ['emission_factors', 'emission_factors_calorific_basis_check'],
  ['emission_factors', 'emission_factors_factor_value_check'],
  ['unit_conversions', 'unit_conversions_activity_type_check'],
  ['unit_conversions', 'unit_conversions_calorific_basis_check'],
  ['unit_conversions', 'unit_conversions_multiplier_check'],
  ['unit_conversions', 'unit_conversions_units_check'],
  ['unit_conversions', 'unit_conversions_text_check'],
  ['activity_records', 'activity_records_activity_type_check'],
]);

const MIGRATIONS_DIR = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));

/**
 * Each trigger function's body as the LAST migration that (re)defines it has
 * it — what `pg_proc.prosrc` must equal, byte for byte.
 */
export function expectedTriggerFunctionBodies(dir = MIGRATIONS_DIR) {
  const bodies = new Map();
  const names = new Set(INTEGRITY_TRIGGERS.map((t) => t.fn));
  for (const migration of readdirSync(dir).filter((d) => /^\d/.test(d)).sort()) {
    let sql;
    try {
      sql = readFileSync(`${dir}/${migration}/migration.sql`, 'utf8');
    } catch {
      continue;
    }
    const definition = /CREATE (?:OR REPLACE )?FUNCTION "public"\."([a-z_]+)"\(\)[\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/g;
    for (const [, name, body] of sql.matchAll(definition)) if (names.has(name)) bodies.set(name, body);
  }
  return bodies;
}

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

/** Every integrity trigger and CHECK, present, in force and unaltered. */
export async function checkIntegrityTriggers(query, expectedBodies = expectedTriggerFunctionBodies()) {
  const triggers = await query(
    `SELECT c.relname AS "table", t.tgname AS "trigger", t.tgenabled AS "enabled", t.tgtype::int AS "type",
            pn.nspname AS "fnSchema", p.proname AS "fn", md5(p.prosrc) AS "bodyMd5"
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
       JOIN pg_namespace pn ON pn.oid = p.pronamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
  );
  const constraints = await query(
    `SELECT c.relname AS "table", k.conname AS "name", k.convalidated AS "validated"
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND k.contype = 'c'`,
  );
  const problems = [];
  for (const want of INTEGRITY_TRIGGERS) {
    const found = triggers.find((t) => t.table === want.table && t.trigger === want.trigger);
    if (!found) {
      problems.push(`trigger ${want.trigger} on ${want.table} is missing`);
      continue;
    }
    if (found.enabled !== 'A') {
      problems.push(`trigger ${want.trigger} on ${want.table} is not ENABLE ALWAYS (tgenabled = '${found.enabled}')`);
    }
    if (found.type !== want.type) {
      problems.push(`trigger ${want.trigger} on ${want.table} fires on the wrong events (tgtype ${found.type}, expected ${want.type})`);
    }
    if (found.fnSchema !== 'public' || found.fn !== want.fn) {
      problems.push(`trigger ${want.trigger} on ${want.table} runs ${found.fnSchema}.${found.fn}, not public.${want.fn}`);
    } else if (!expectedBodies.has(want.fn)) {
      problems.push(`no migration defines public.${want.fn}()`);
    } else if (found.bodyMd5 !== md5(expectedBodies.get(want.fn))) {
      problems.push(`function public.${want.fn}() differs from its migration's definition`);
    }
  }
  for (const [table, name] of INTEGRITY_CHECKS) {
    const found = constraints.find((c) => c.table === table && c.name === name);
    if (!found) problems.push(`CHECK ${name} on ${table} is missing`);
    else if (!found.validated) problems.push(`CHECK ${name} on ${table} is NOT VALID`);
  }
  return problems;
}

/**
 * What the factor library holds that production must not calculate from, as
 * data. `problems`: an `unspecified` activity type under an authoritative
 * release (the insert trigger refuses it; a replica-mode restore would not).
 * `notices`: every non-authoritative release present — expected locally and
 * in CI, a finding on staging or production, where the seed never runs
 * (owner decision K3).
 */
export async function factorLibraryReport(query) {
  const [{ n }] = await query(
    `SELECT (
        (SELECT count(*) FROM emission_factors f JOIN factor_releases r ON r.id = f.release_id
          WHERE r.status = 'authoritative' AND f.activity_type = 'unspecified')
      + (SELECT count(*) FROM unit_conversions u JOIN factor_releases r ON r.id = u.release_id
          WHERE r.status = 'authoritative' AND u.activity_type = 'unspecified')
     )::int AS n`,
  );
  const releases = await query(
    `SELECT r.publisher, r.edition, r.status,
            (SELECT count(*) FROM emission_factors f WHERE f.release_id = r.id)::int AS factors,
            (SELECT count(*) FROM unit_conversions u WHERE u.release_id = r.id)::int AS conversions
       FROM factor_releases r
      WHERE r.status IN ('placeholder', 'fixture')
      ORDER BY r.publisher, r.ordinal`,
  );
  return {
    problems: n > 0 ? [`${n} factor/conversion row(s) with an unspecified activity type under an authoritative release`] : [],
    notices: releases.map(
      (r) => `${r.status} release ${r.publisher} ${r.edition} (${r.factors} factor(s), ${r.conversions} conversion(s))`,
    ),
  };
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
    let library;
    try {
      const query = (sql) => client.$queryRawUnsafe(sql);
      library = await factorLibraryReport(query);
      problems = [
        ...(await checkRuntimeRole(query)),
        ...(await checkTenantInvariants(query)),
        ...(await checkIntegrityTriggers(query)),
        ...library.problems,
      ];
      exposures = await runtimeRoleExposures(query);
    } finally {
      await client.$disconnect();
    }
    for (const e of exposures) console.warn(`  ! ${RUNTIME_ROLE} can also reach ${e}`);
    // Not a failure here — local and CI databases hold the seed's placeholder
    // library on purpose. On staging or production each line is a finding.
    for (const n of library.notices) console.warn(`  ! factor library holds a ${n}`);
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
