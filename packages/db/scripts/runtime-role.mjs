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
 *
 * A third credential, one job (LP4-02): FACTOR_LOADER_DATABASE_URL —
 * `tonyai_factor_loader`, created by `20261011120000_lp4_02_loader`: the factor
 * library's loader (`apps/api/src/factor-releases`), which loads, seals and
 * withdraws releases and touches nothing else. No BYPASSRLS — policies of its
 * own admit it. Provisioned like the runtime's login, by its own command:
 *
 *   FACTOR_LOADER_DB_PASSWORD=<pw> DIRECT_URL=<owner> node packages/db/scripts/runtime-role.mjs provision-loader
 *
 * and in a deployed environment with `\password tonyai_factor_loader`, then
 * `ALTER ROLE tonyai_factor_loader LOGIN`.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUNTIME_ROLE = 'tonyai_runtime';
/** The factor library's loader (LP4-02) — its one writer besides the owner. */
export const FACTOR_LOADER_ROLE = 'tonyai_factor_loader';

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

function loginUrlFrom(ownerUrl, role, password, caller) {
  if (!password) throw new Error(`${caller}: a password is required`);
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

/** The same database as `ownerUrl`, logged in as the runtime role with `password`. */
export function runtimeUrlFrom(ownerUrl, password) {
  return loginUrlFrom(ownerUrl, RUNTIME_ROLE, password, 'runtimeUrlFrom');
}

/** The same database as `ownerUrl`, logged in as the factor loader with `password`. */
export function factorLoaderUrlFrom(ownerUrl, password) {
  return loginUrlFrom(ownerUrl, FACTOR_LOADER_ROLE, password, 'factorLoaderUrlFrom');
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
  // writes — the seed loads it on the owner connection, LP4-02's loader
  // through its own role (FACTOR_LOADER_TABLE_PRIVILEGES).
  emission_factors: ['SELECT'],
  factor_releases: ['SELECT'],
  unit_conversions: ['SELECT'],
  // The library's record: written by its own triggers only, and not read by
  // the API yet — the grant arrives with its first reader.
  factor_release_events: [],
  // + INSERT and UPDATE on listed columns only — see RUNTIME_COLUMN_INSERTS
  // and RUNTIME_COLUMN_UPDATES.
  profiles: ['SELECT'],
  // LP4-01's onboarding state: created with its profile, moved along by
  // delivery and acceptance, never deleted (a withdrawn one is `revoked`).
  // + UPDATE on the state columns only — see RUNTIME_COLUMN_UPDATES.
  invitations: ['SELECT', 'INSERT'],
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
  // LP3-04's inventory boundary: read by the dataset producer's reader, the
  // routes and the subsidiary and site delete paths' counts (W9); written by
  // the routes (W1, E1). A header is created, deleted while open, and changes
  // only its decision and freeze — + INSERT and UPDATE on listed columns only,
  // see RUNTIME_COLUMN_INSERTS and RUNTIME_COLUMN_UPDATES (the UPDATE also
  // lets the routes lock it, FOR UPDATE / FOR SHARE). A declaration's rows
  // are inserted, never updated: a PUT replaces them, so no row is ever
  // re-keyed — a policy never carries its sources along (ON UPDATE CASCADE) —
  // and the guard's key rule (TA014) is never met. Only a subsidiary's row is
  // deleted, whole: its keys cascade to its sites, policies, cells and
  // sources as their owner, so no single one of them goes outside an audited
  // replace (`architect`'s review, measured).
  inventory_boundaries: ['SELECT', 'DELETE'],
  inventory_boundary_subsidiaries: ['SELECT', 'INSERT', 'DELETE'],
  inventory_boundary_sites: ['SELECT', 'INSERT'],
  inventory_attribution_policies: ['SELECT', 'INSERT'],
  inventory_applicability_cells: ['SELECT', 'INSERT'],
  inventory_sources: ['SELECT', 'INSERT'],
  // LP3-04 PR C's retained datasets (V5): a capture inserts, the dataset
  // routes read — never an update or a delete (the guard, TA016, refuses
  // them for every writer but the organisation's own deletion).
  report_datasets: ['SELECT', 'INSERT'],
  // Prisma's migration history: neither readable nor writable.
  _prisma_migrations: [],
});

/**
 * Column-level INSERT grants on tables whose table-level INSERT is withheld.
 * Exactly these columns, no more and no fewer.
 */
export const RUNTIME_COLUMN_INSERTS = Object.freeze({
  // An invitation creates its profile (LP4-01): identity, role, language and
  // organisation, never `disabled_at` or the Auth/reset bookkeeping — a new
  // account is born enabled. Prisma fills `theme` and `auth_sync_generation`
  // (their schema defaults) and the two timestamps on every create.
  profiles: ['id', 'email', 'full_name', 'role', 'language', 'theme', 'auth_sync_generation', 'organisation_id', 'created_at', 'updated_at'],
  // A boundary version is born open and undecided (LP3-04's write path):
  // never `decided_by`, `decided_at` or `frozen_at`, and never `created_at`
  // (the database's clock) — so not even a bug can insert a version already
  // confirmed, frozen or backdated. Prisma fills `decision`, its default.
  inventory_boundaries: ['id', 'organisation_id', 'reporting_year', 'version', 'decision', 'created_by'],
});

/** Column-level UPDATE grants on tables whose table-level UPDATE is withheld. */
export const RUNTIME_COLUMN_UPDATES = Object.freeze({
  // The role changes at runtime (AccessAdminService), and so does the UI
  // language, the user's own (LP3-01, PATCH /me/preferences); the
  // organisation never does (D17). LP4-01: an account is disabled and enabled
  // (D19), Auth's catch-up is flagged (K4) and the reset cooldown kept.
  profiles: [
    'role',
    'language',
    'updated_at',
    'disabled_at',
    'sessions_revoked_at',
    'auth_sync_pending_since',
    'auth_sync_generation',
    'recovery_sent_at',
  ],
  // The state an invitation moves through; never its profile, inviter,
  // language or creation time.
  invitations: [
    'status',
    'attempts',
    'last_error_step',
    'last_error_code',
    'last_attempt_at',
    'sent_at',
    'accepted_at',
    'revoked_at',
    'updated_at',
  ],
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
  // What `confirm` writes — and PR C's capture, which freezes unconfirmed —
  // the four columns the guard lets change (TA014); never the organisation,
  // year, version or author.
  inventory_boundaries: ['decision', 'decided_by', 'decided_at', 'frozen_at'],
});

/**
 * The runtime role's way to Storage's catalogue (`storage.objects`): two
 * SECURITY DEFINER functions in `public`, by signature as `oidvectortypes`
 * prints it — `storage:reconcile`'s page of a bucket's keys and its "does the
 * catalogue name this object". It holds no USAGE on `storage` itself (LP1-03
 * granted it; `20261020120000_runtime_storage_readers` took it back):
 * Supabase's own SECURITY DEFINER helpers there pin no search_path, so a
 * caller's temporary type ran as Storage's owner. Checked only where
 * `storage.objects` exists; the API's `CATALOGUE_READERS` lists the same.
 */
export const RUNTIME_CATALOGUE_READERS = Object.freeze([
  'storage_catalogue_page(text, text, text, timestamp with time zone, integer)',
  'storage_catalogue_has(text, text)',
]);

/**
 * The loader's table privileges (LP4-02): the factor library and nothing else
 * — a table not listed here holds none. It reads the library (an identical
 * release already loaded is a no-op, a differing one a refusal) and inserts
 * releases and their rows; no DELETE (a fixture is the owner's to remove).
 */
export const FACTOR_LOADER_TABLE_PRIVILEGES = Object.freeze({
  factor_releases: ['SELECT', 'INSERT'],
  emission_factors: ['SELECT', 'INSERT'],
  unit_conversions: ['SELECT', 'INSERT'],
});

/** A release's seal and its withdrawal: the columns those two changes write. */
export const FACTOR_LOADER_COLUMN_UPDATES = Object.freeze({
  factor_releases: ['sealed_at', 'status', 'withdrawn_at', 'withdrawn_by', 'withdrawal_reason'],
});

const RUNTIME_SPEC = Object.freeze({
  role: RUNTIME_ROLE,
  migration: 'LP1-03',
  bypassrls: true,
  tables: RUNTIME_TABLE_PRIVILEGES,
  everyTableListed: true,
  columnInserts: RUNTIME_COLUMN_INSERTS,
  columnUpdates: RUNTIME_COLUMN_UPDATES,
  outside: {},
  definers: RUNTIME_CATALOGUE_READERS,
});

const FACTOR_LOADER_SPEC = Object.freeze({
  role: FACTOR_LOADER_ROLE,
  migration: 'LP4-02',
  bypassrls: false,
  tables: FACTOR_LOADER_TABLE_PRIVILEGES,
  everyTableListed: false,
  columnInserts: {},
  columnUpdates: FACTOR_LOADER_COLUMN_UPDATES,
  outside: {},
  definers: [],
});

/**
 * Compares the role in the connected database with the intended privileges.
 * `query(sql)` runs one read-only statement and resolves to its rows. Returns
 * a list of problems — empty when the role is exactly as intended.
 */
export async function checkRuntimeRole(query) {
  return checkRole(query, RUNTIME_SPEC);
}

/**
 * The loader as `checkRuntimeRole` checks the runtime role (LP4-02) — plus
 * the one setting that would undo the library's guards: `SET
 * session_replication_role = replica` turns its load-time triggers off, so
 * the loader may not set it (only a superuser, or a role granted SET on it,
 * may).
 */
export async function checkFactorLoaderRole(query) {
  const problems = await checkRole(query, FACTOR_LOADER_SPEC);
  if (problems.some((p) => p.endsWith('does not exist — is the LP4-02 migration applied?'))) return problems;
  const [{ replica }] = await query(
    `SELECT pg_catalog.has_parameter_privilege('${FACTOR_LOADER_ROLE}', 'session_replication_role', 'SET') AS replica`,
  );
  if (replica) {
    problems.push(`${FACTOR_LOADER_ROLE} may SET session_replication_role — replica mode turns the library's load-time triggers off`);
  }
  return problems;
}

async function checkRole(query, spec) {
  const problems = [];
  const { role } = spec;

  const [attrs] = await query(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconfig
       FROM pg_roles WHERE rolname = '${role}'`,
  );
  if (!attrs) return [`role ${role} does not exist — is the ${spec.migration} migration applied?`];
  for (const [attr, label] of [
    ['rolsuper', 'SUPERUSER'],
    ['rolcreatedb', 'CREATEDB'],
    ['rolcreaterole', 'CREATEROLE'],
    ['rolreplication', 'REPLICATION'],
  ]) {
    if (attrs[attr]) problems.push(`${role} has ${label}`);
  }
  if (spec.bypassrls && !attrs.rolbypassrls) {
    problems.push(`${role} lacks BYPASSRLS — the API would see no rows and the Storage sweeper would stall`);
  }
  if (!spec.bypassrls && attrs.rolbypassrls) {
    problems.push(`${role} has BYPASSRLS — its policies would no longer bound it`);
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
  // Who may act AS the role: only its creator, with ADMIN and neither
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
  const expectedTables = new Set(Object.keys(spec.tables));
  for (const { name, forced } of tables) {
    if (forced) problems.push(`public.${name} has FORCE ROW LEVEL SECURITY`);
    if (!expectedTables.delete(name) && spec.everyTableListed) {
      problems.push(`public.${name} has no entry in RUNTIME_TABLE_PRIVILEGES — decide the runtime's privileges for it`);
      continue;
    }
    const expected = new Set(spec.tables[name] ?? []);
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
    for (const p of ['SELECT', 'REFERENCES']) {
      if (expected.has(p)) continue;
      const [{ any }] = await query(`SELECT has_any_column_privilege('${role}', 'public.${name}', '${p}') AS any`);
      if (any) problems.push(`${role} has column-level ${p} on public.${name}`);
    }
    // INSERT and UPDATE may be granted per column instead — exactly the listed
    // columns (LP4-01's profile INSERT, LP1-03's profile and subsidiary UPDATE).
    for (const [p, listed] of [
      ['INSERT', spec.columnInserts],
      ['UPDATE', spec.columnUpdates],
    ]) {
      if (expected.has(p)) continue;
      const allowed = new Set(listed[name] ?? []);
      const cols = await query(
        `SELECT a.attname AS col, has_column_privilege('${role}', 'public.${name}', a.attname, '${p}') AS can
           FROM pg_attribute a
          WHERE a.attrelid = 'public.${name}'::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
      );
      for (const { col, can } of cols) {
        if (can && !allowed.has(col)) problems.push(`${role} can ${p} public.${name}.${col}`);
        if (!can && allowed.has(col)) problems.push(`${role} cannot ${p} public.${name}.${col}`);
      }
    }
  }
  for (const missing of expectedTables) problems.push(`${role}'s table privileges list public.${missing}, which does not exist`);

  for (const [qualified, privileges] of Object.entries(spec.outside)) {
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

  // The definers in `public` the role calls (the runtime role's readers of
  // Storage's catalogue): present, still SECURITY DEFINER, and its to EXECUTE
  // — where the catalogue exists. Their path and owner are
  // checkFunctionSearchPaths' and checkFunctionExecutors'. Looked up in the
  // catalogues by name: `to_regclass('storage.objects')` needs the USAGE on
  // `storage` the role no longer holds, and the check runs as the role too.
  if (spec.definers.length > 0) {
    const readers = await query(
      `SELECT x.signature AS "signature", p.oid IS NOT NULL AS "present", COALESCE(p.prosecdef, false) AS "definer",
              COALESCE(pg_catalog.has_function_privilege('${role}', p.oid, 'EXECUTE'), false) AS "executes"
         FROM unnest(ARRAY[${sqlList(spec.definers)}]::text[]) AS x(signature)
         LEFT JOIN pg_catalog.pg_proc p
           ON p.pronamespace = 'public'::regnamespace
          AND p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' = x.signature
        WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'storage' AND c.relname = 'objects')
        ORDER BY 1`,
    );
    for (const { signature, present, definer, executes } of readers) {
      if (!present) problems.push(`public.${signature} is missing — ${role} reads Storage's catalogue through it`);
      else if (!definer) problems.push(`public.${signature} is not SECURITY DEFINER — ${role}, which holds no USAGE on storage, cannot read through it`);
      else if (!executes) problems.push(`${role} lacks EXECUTE on public.${signature}`);
    }
  }

  // Outside `public` the role should reach nothing it was granted on its own
  // — `storage` included; what every role inherits from PUBLIC is reported
  // by `runtimeRoleExposures` instead (the platform's grants, not ours).
  for (const row of await outsideReach(query, spec)) {
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
 * `public`, checked against RUNTIME_TABLE_PRIVILEGES, and the definers it
 * calls, RUNTIME_CATALOGUE_READERS): USAGE or CREATE on a schema — `storage`
 * like any other; any privilege, table or column level, on a relation of a
 * schema it can use — in `public` the relations that are not tables; EXECUTE
 * on a SECURITY DEFINER function there.
 * Each privilege is marked `viaPublic` only when PUBLIC itself holds THAT
 * privilege, so a grant this repository made cannot hide behind an unrelated
 * PUBLIC entry in the same ACL (`security-rls` round 2).
 */
async function outsideReach(query, spec) {
  const { role } = spec;
  const declared = new Set(
    Object.entries(spec.outside).flatMap(([rel, privileges]) => privileges.map((p) => `${rel}:${p}`)),
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
    if (name !== 'public') out.push({ what: `USAGE on schema ${name}`, viaPublic: usage_public });
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
      `SELECT p.proname AS fn, p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS signature,
              has_function_privilege('public', p.oid, 'EXECUTE') AS via_public
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = '${name}' AND p.prosecdef AND has_function_privilege('${role}', p.oid, 'EXECUTE')
        ORDER BY 1, 2`,
    );
    for (const { fn, signature, via_public } of definers) {
      if (name === 'public' && spec.definers.includes(signature)) continue;
      out.push({ what: `EXECUTE on SECURITY DEFINER ${name}.${fn}()`, viaPublic: via_public });
    }
  }
  return out;
}

/**
 * What the runtime role can reach outside its own grants because PUBLIC holds
 * it — granted by the platform (Supabase's `pg_net` tables), not by this
 * repository, and not revocable by the owner. Reported,
 * not failed: in a deployed environment each line is a reason to disable the
 * extension or to have the platform revoke the grant.
 */
export async function runtimeRoleExposures(query) {
  return (await outsideReach(query, RUNTIME_SPEC)).filter((r) => r.viaPublic).map((r) => `${r.what} (via PUBLIC)`);
}

/** The same for the factor loader (LP4-02). */
export async function factorLoaderExposures(query) {
  return (await outsideReach(query, FACTOR_LOADER_SPEC)).filter((r) => r.viaPublic).map((r) => `${r.what} (via PUBLIC)`);
}

const LIBRARY_TABLES = Object.freeze(['factor_releases', 'emission_factors', 'unit_conversions']);

/**
 * Who may write the factor library (LP4-02): its loader (exactly
 * FACTOR_LOADER_TABLE_PRIVILEGES and FACTOR_LOADER_COLUMN_UPDATES, which
 * `checkFactorLoaderRole` holds it to) and the owner — nobody else, at table
 * or column level, PUBLIC included. Read from the ACLs themselves, so a role
 * this repository never heard of is named too; a member of the loader is
 * named by `checkFactorLoaderRole`.
 */
export async function checkLibraryWriters(query) {
  // And any table in public with a key to a release — a library table added
  // later is born writable by the service role (the owner's default
  // privileges), so it is held to the library's writers until someone decides
  // otherwise. (Only direct references; Open questions, "LP4-02 follow-ups".)
  const referencing = await query(
    `SELECT DISTINCT c.relname AS "table"
       FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
      WHERE k.contype = 'f' AND k.confrelid = 'public.factor_releases'::pg_catalog.regclass`,
  );
  const names = [...new Set([...LIBRARY_TABLES, ...referencing.map((r) => r.table)])];
  const tables = names.map((t) => `'public.${t}'::pg_catalog.regclass`).join(', ');
  const rows = await query(
    `SELECT c.relname AS "table", CASE x.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END AS "grantee",
            x.privilege_type AS "priv", false AS "columnLevel"
       FROM pg_catalog.pg_class c,
            LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) x
      WHERE c.oid IN (${tables}) AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE') AND x.grantee <> c.relowner
     UNION
     SELECT c.relname, CASE x.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END,
            x.privilege_type, true
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid,
            LATERAL pg_catalog.aclexplode(a.attacl) x
      WHERE c.oid IN (${tables}) AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
        AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE') AND x.grantee <> c.relowner
      ORDER BY 1, 2, 3, 4`,
  );
  return rows
    .filter((r) => r.grantee !== FACTOR_LOADER_ROLE)
    .map(
      (r) =>
        `${r.grantee} may ${r.priv} public.${r.table}${r.columnLevel ? ' (column-level)' : ''} — the factor library is written by its loader and the owner alone`,
    );
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
  // The slot rule (`activity_records_slot_kind`) steps aside for a restore's
  // inserts: a slot holding typed records and an untyped one counts a fuel
  // twice.
  const [{ slots }] = await query(
    `SELECT count(*)::int AS slots FROM (
       SELECT 1 FROM activity_records
        WHERE status <> 'voided'
        GROUP BY subsidiary_id, location_id, reporting_year, reporting_period, period_value, category
       HAVING bool_or(activity_type IS NULL) AND bool_or(activity_type IS NOT NULL)
     ) mixed`,
  );
  return [
    ...(n > 0 ? [`${n} user_subsidiary_access row(s) cross an organisation or point at nothing`] : []),
    ...(slots > 0 ? [`${slots} activity_records slot(s) hold typed records and an untyped one`] : []),
  ];
}

const TABLE_VERBS = "('TRIGGER', 'TRUNCATE', 'REFERENCES', 'MAINTAIN')";
const OWNER_OF_OUR_TABLES = "(SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.activity_records'::regclass)";

/**
 * What a new object of `objtype` ('r' table, 'f' function) in `public` is born
 * granting, per role that could create it: every role with CREATE on the
 * schema, every role holding a default privilege in it, and the owner of our
 * tables. A role's global default replaces PostgreSQL's built-in one (for a
 * function: EXECUTE to PUBLIC) and its per-schema default adds to that, so
 * both are read — the per-schema one alone cannot show what a new object
 * gets. `ours` marks the role that owns the schema's tables (the migrations'
 * role); another creator's defaults — Supabase's `supabase_admin` — are the
 * platform's, out of a migration's reach (`platformDefaultPrivileges`).
 */
async function publicDefaultGrants(query, objtype, privileges) {
  return query(
    `WITH creators AS (
       SELECT r.oid AS role FROM pg_catalog.pg_roles r WHERE pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE')
        UNION
       SELECT d.defaclrole FROM pg_catalog.pg_default_acl d WHERE d.defaclnamespace = 'public'::regnamespace
        UNION
       SELECT ${OWNER_OF_OUR_TABLES}
     ), born AS (
       SELECT c.role, COALESCE(g.defaclacl, pg_catalog.acldefault('${objtype}', c.role)) AS acl
         FROM creators c
         LEFT JOIN pg_catalog.pg_default_acl g
           ON g.defaclrole = c.role AND g.defaclnamespace = 0 AND g.defaclobjtype = '${objtype}'
       UNION ALL
       SELECT d.defaclrole, d.defaclacl FROM pg_catalog.pg_default_acl d
        WHERE d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = '${objtype}'
     )
     SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS "grantee",
            pg_catalog.pg_get_userbyid(b.role) AS "creator", a.privilege_type AS "privilege",
            b.role = ${OWNER_OF_OUR_TABLES} AS "ours"
       FROM born b, LATERAL pg_catalog.aclexplode(b.acl) a
      WHERE a.privilege_type IN ${privileges} AND a.grantee <> b.role
      ORDER BY 2, 1, 3`,
  );
}

/**
 * Table-level verbs no role but a table's owner may hold in `public`, now or
 * by default privilege: TRIGGER (a trigger on any table a referential action
 * reaches runs as the owner — PostgreSQL runs those actions as the owner — so
 * past every guard that trusts it), TRUNCATE (past every row guard),
 * REFERENCES and MAINTAIN. Supabase's default privileges grant all four to
 * anon, authenticated and the service role; the LP3-03 migration takes them
 * back. A failure here is a default of the role that owns the schema's tables
 * (the migrations' role), global or per-schema; another creator's are named by
 * `platformDefaultPrivileges` — no migration can change them, and no table of
 * ours is created by it.
 */
export async function checkTableLevelGrants(query) {
  const granted = await query(
    `SELECT c.relname AS "table", CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS "grantee",
            a.privilege_type AS "privilege"
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
            LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND a.privilege_type IN ${TABLE_VERBS} AND a.grantee <> c.relowner
      ORDER BY 1, 2, 3`,
  );
  const defaults = (await publicDefaultGrants(query, 'r', TABLE_VERBS)).filter((d) => d.ours);
  return [
    ...granted.map((g) => `${g.grantee} holds ${g.privilege} on public.${g.table} — only its owner may`),
    ...defaults.map((d) => `${d.grantee} is granted ${d.privilege} on every new public table ${d.creator} creates — only its owner may hold it`),
  ];
}

/**
 * The roles a client connects as or becomes: PostgREST's login and the three
 * roles it switches to. The runtime role is held tighter by `checkRuntimeRole`
 * (a member of no role, no CREATE in `public`).
 */
const CLIENT_ROLES = Object.freeze(['anon', 'authenticated', 'service_role', 'authenticator']);

/**
 * Functions in `public` a client may call, keyed by signature — the name and
 * argument types as `oidvectortypes` prints them, `name(uuid, text)`, so an
 * overload is not let through by its name — with the roles that may: none.
 * PostgREST exposes every function a role may EXECUTE at `/rpc`; one added
 * here says who calls it and why.
 */
export const CLIENT_CALLABLE_FUNCTIONS = Object.freeze({});

/**
 * EXECUTE on every function in `public` — what attaching a trigger function to
 * a table requires, and what PostgREST's `/rpc` serves — for its owner alone,
 * now and by default; and that owner the one that owns the schema's tables (a
 * function another role owns is that role's to run, attach and replace).
 * PostgreSQL grants EXECUTE to PUBLIC on creation and Supabase's default
 * privileges to anon, authenticated and the service role; a SECURITY DEFINER
 * event writer attached to a table of the caller's own would write forged rows
 * into the library's record as the owner. No function there is meant for a
 * client (`clientCallable`, CLIENT_CALLABLE_FUNCTIONS by default): the policies
 * call only `auth.uid()`, and a trigger fires without its function's EXECUTE.
 * The runtime role — no client: no client may act as it — runs its readers of
 * Storage's catalogue (RUNTIME_CATALOGUE_READERS), and nothing else there.
 * A client role (CLIENT_ROLES) is held to more than its ACL entries. It may own
 * nothing an owner's power flows from — the database, the schema `public`, a
 * relation, a type or a function there (a type's owner may rename an enum's
 * values or drop it with the columns that use it) — and be a member of no role
 * that does, nor of
 * the runtime role (BYPASSRLS): through any chain of grants, INHERIT or SET, or
 * ADMIN alone, which lets it grant itself the rest (`has_function_privilege`
 * sees only what is inherited). And it may create nothing there, by its own
 * CREATE or a role's it is a member of: what it created would be its own to
 * run, attach and grant.
 */
export async function checkFunctionExecutors(query, clientCallable = CLIENT_CALLABLE_FUNCTIONS) {
  const executors = await query(
    `SELECT p.proname AS "fn", pg_catalog.pg_get_function_identity_arguments(p.oid) AS "args",
            p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS "signature",
            p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype AS "trigger",
            CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS "grantee"
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
            LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      WHERE n.nspname = 'public'
        AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
      ORDER BY 1, 2, 4`,
  );
  const owners = await query(
    `SELECT p.proname AS "fn", pg_catalog.pg_get_function_identity_arguments(p.oid) AS "args",
            pg_catalog.pg_get_userbyid(p.proowner) AS "owner"
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proowner <> ${OWNER_OF_OUR_TABLES}
      ORDER BY 1, 2`,
  );
  const actsAs = await query(
    `SELECT c.rolname AS "client", pg_catalog.pg_get_userbyid(o.role) AS "owner",
            c.oid = o.role AS "itself", o.role = '${RUNTIME_ROLE}'::regrole AS "runtime",
            o.role = pg_catalog.to_regrole('${FACTOR_LOADER_ROLE}') AS "loader"
       FROM pg_catalog.pg_roles c,
            (SELECT ${OWNER_OF_OUR_TABLES} AS role
              UNION SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()
              UNION SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'
              UNION SELECT k.relowner FROM pg_catalog.pg_class k WHERE k.relnamespace = 'public'::regnamespace
              UNION SELECT t.typowner FROM pg_catalog.pg_type t WHERE t.typnamespace = 'public'::regnamespace
              UNION SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
              UNION SELECT '${RUNTIME_ROLE}'::regrole
              UNION SELECT pg_catalog.to_regrole('${FACTOR_LOADER_ROLE}')) o
      WHERE c.rolname IN (${sqlList(CLIENT_ROLES)})
        AND pg_catalog.pg_has_role(c.oid, o.role, 'MEMBER')
      ORDER BY 1, 2`,
  );
  const creators = await query(
    `SELECT c.rolname AS "client", pg_catalog.pg_get_userbyid(r.oid) AS "via"
       FROM pg_catalog.pg_roles c, pg_catalog.pg_roles r
      WHERE c.rolname IN (${sqlList(CLIENT_ROLES)})
        AND pg_catalog.pg_has_role(c.oid, r.oid, 'MEMBER')
        AND pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE')
      ORDER BY 1, 2`,
  );
  const defaults = (await publicDefaultGrants(query, 'f', "('EXECUTE')")).filter((d) => d.ours);
  return [
    ...owners.map((o) => `public.${o.fn}(${o.args ?? ''}) is owned by ${o.owner} — who may run, attach, alter and drop it; only the owner of the schema's tables may own one`),
    ...actsAs.map((a) =>
      a.itself
        ? `${a.client} owns the database, the schema public or something in it — it may alter, disable or drop it; no client may own one`
        : a.runtime
          ? `${a.client} can act as ${a.owner} (a member — inherited, by SET ROLE or by ADMIN), the API's role — BYPASSRLS and its every grant; no client may be`
          : a.loader
            ? `${a.client} can act as ${a.owner} (a member — inherited, by SET ROLE or by ADMIN), the factor library's loader — it loads, seals and withdraws releases; no client may be`
            : `${a.client} can act as ${a.owner} (a member — inherited, by SET ROLE or by ADMIN), an owner in public or of the database — it may alter, disable or drop what that role owns; no client may be`,
    ),
    ...creators.map(
      (c) => `${c.client} may create in public${c.via === c.client ? '' : ` as ${c.via}`} — a function it creates there is its own to run, attach and grant; no client may`,
    ),
    ...executors
      .filter((e) => !(Object.hasOwn(clientCallable, e.signature) && clientCallable[e.signature].includes(e.grantee)))
      .filter((e) => !(e.grantee === RUNTIME_ROLE && !e.trigger && RUNTIME_CATALOGUE_READERS.includes(e.signature)))
      .map(
        (e) =>
          `${e.grantee} may EXECUTE public.${e.fn}(${e.args ?? ''}) — ${e.trigger ? 'attach it to a table of its own' : 'call it, through /rpc too'}; only its owner may`,
      ),
    ...defaults.map((d) => `${d.grantee} may EXECUTE every new public function ${d.creator} creates — only its owner may`),
  ];
}

/**
 * The default privileges in `public` of every creator but the migrations'
 * role — Supabase's `supabase_admin`, the platform's, which no migration can
 * change, and `pg_database_owner` where it owns the schema — reported, not
 * failed. No table or function of ours is created by either; on staging or
 * production each line is a question for the platform.
 */
export async function platformDefaultPrivileges(query) {
  const rows = [
    ...(await publicDefaultGrants(query, 'r', TABLE_VERBS)).map((r) => ({ ...r, kind: 'table' })),
    ...(await publicDefaultGrants(query, 'f', "('EXECUTE')")).map((r) => ({ ...r, kind: 'function' })),
  ].filter((r) => !r.ours);
  const grouped = new Map();
  for (const { creator, grantee, privilege, kind } of rows) {
    const key = `${creator}|${kind}|${grantee}`;
    const entry = grouped.get(key) ?? { creator, grantee, kind, privileges: [] };
    entry.privileges.push(privilege);
    grouped.set(key, entry);
  }
  return [...grouped.values()].map(
    (g) => `${g.grantee} is granted ${g.privileges.join(', ')} on every new public ${g.kind} ${g.creator} creates`,
  );
}

/**
 * The integrity triggers the LP3-03 and LP4-01 migrations install: each must
 * exist, be ENABLE ALWAYS (`tgenabled = 'A'`, firing in replica mode too, so a
 * restore cannot slip past it), fire on exactly its events, and run its own
 * function with exactly the body the migrations define. A trigger disabled,
 * dropped, re-created on fewer events or pointed at an emptied function is a
 * silent hole: the snapshot of an approved record becomes editable, a loaded
 * factor rewritable, or a tenant deletable by a client.
 *
 * `type` is `pg_trigger.tgtype`: ROW 1, BEFORE 2, INSERT 4, DELETE 8,
 * UPDATE 16, TRUNCATE 32.
 */
const ROW = 1;
const BEFORE = 2;
const ON = { insert: 4, delete: 8, update: 16, truncate: 32 };
/** The rows of an inventory boundary version (LP3-04 PR B), below its header. */
const INVENTORY_BOUNDARY_ROW_TABLES = Object.freeze([
  'inventory_boundary_subsidiaries',
  'inventory_boundary_sites',
  'inventory_attribution_policies',
  'inventory_applicability_cells',
  'inventory_sources',
]);
export const INTEGRITY_TRIGGERS = Object.freeze([
  { table: 'activity_records', trigger: 'activity_records_snapshot_immutable', fn: 'activity_records_snapshot_immutable', type: ROW | BEFORE | ON.update },
  { table: 'activity_records', trigger: 'activity_records_slot_kind', fn: 'activity_records_slot_kind', type: ROW | BEFORE | ON.insert | ON.update },
  { table: 'activity_records', trigger: 'activity_records_committed_delete', fn: 'activity_records_committed_delete', type: ROW | BEFORE | ON.delete },
  ...['factor_releases', 'emission_factors', 'unit_conversions'].flatMap((table) => {
    const rows = table === 'factor_releases' ? 'factor_releases' : 'factor_rows';
    return [
      { table, trigger: `${table}_before_insert`, fn: `${rows}_before_insert`, type: ROW | BEFORE | ON.insert },
      { table, trigger: `${table}_before_update`, fn: `${rows}_before_update`, type: ROW | BEFORE | ON.update },
      { table, trigger: `${table}_before_delete`, fn: `${rows}_before_delete`, type: ROW | BEFORE | ON.delete },
      { table, trigger: `${table}_before_truncate`, fn: 'factor_tables_before_truncate', type: BEFORE | ON.truncate },
    ];
  }),
  // The library's record: AFTER triggers, SECURITY DEFINER so the table needs
  // no INSERT grant; and the record's own append-only guards.
  { table: 'factor_releases', trigger: 'factor_releases_record_event', fn: 'factor_releases_record_event', type: ROW | ON.insert | ON.update | ON.delete, definer: true },
  ...['emission_factors', 'unit_conversions'].flatMap((table) => [
    { table, trigger: `${table}_record_insert`, fn: 'factor_rows_record_event', type: ON.insert, definer: true },
    { table, trigger: `${table}_record_delete`, fn: 'factor_rows_record_event', type: ON.delete, definer: true },
  ]),
  { table: 'factor_release_events', trigger: 'factor_release_events_before_insert', fn: 'factor_release_events_before_insert', type: ROW | BEFORE | ON.insert },
  { table: 'factor_release_events', trigger: 'factor_release_events_before_update', fn: 'factor_release_events_refuse', type: ROW | BEFORE | ON.update },
  { table: 'factor_release_events', trigger: 'factor_release_events_before_delete', fn: 'factor_release_events_refuse', type: ROW | BEFORE | ON.delete },
  { table: 'factor_release_events', trigger: 'factor_release_events_before_truncate', fn: 'factor_tables_before_truncate', type: BEFORE | ON.truncate },
  // LP4-01: who may write a record's lifecycle (born a draft; a status moved
  // only in the API's or the owner's session); an organisation deleted, and a
  // subsidiary moved, by the owner's session alone. `subsidiaries` is guarded
  // (a later BEFORE UPDATE trigger could rewrite NEW.organisation_id after the
  // guard); `organisations` is not: LP1-03's access-removal trigger also lives
  // there (Open questions, "LP3-03 PR B" (20)), and a later trigger cannot
  // undo the guard's refusal.
  { table: 'activity_records', trigger: 'activity_records_lifecycle_writer', fn: 'activity_records_lifecycle_writer', type: ROW | BEFORE | ON.insert | ON.update },
  { table: 'organisations', trigger: 'organisations_delete_owner_only', fn: 'organisations_delete_owner_only', type: ROW | BEFORE | ON.delete },
  { table: 'subsidiaries', trigger: 'subsidiaries_stay_in_organisation', fn: 'subsidiaries_stay_in_organisation', type: ROW | BEFORE | ON.update },
  // LP4-02: a release left unsealed by its loading transaction is refused at
  // the commit — a constraint trigger, DEFERRABLE INITIALLY DEFERRED.
  { table: 'factor_releases', trigger: 'factor_releases_sealed_at_commit', fn: 'factor_releases_sealed_at_commit', type: ROW | ON.insert, deferred: true },
  // LP3-04 PR B: a frozen inventory boundary version takes no change, the
  // owner's included (TA014) — SECURITY DEFINER, to read its header FOR SHARE
  // and copy the names in as it freezes.
  { table: 'inventory_boundaries', trigger: 'inventory_boundaries_frozen', fn: 'inventory_boundaries_frozen', type: ROW | BEFORE | ON.insert | ON.update | ON.delete, definer: true },
  { table: 'inventory_boundaries', trigger: 'inventory_boundaries_before_truncate', fn: 'inventory_boundary_before_truncate', type: BEFORE | ON.truncate },
  ...INVENTORY_BOUNDARY_ROW_TABLES.flatMap((table) => [
    { table, trigger: `${table}_frozen`, fn: 'inventory_boundary_rows_frozen', type: ROW | BEFORE | ON.insert | ON.update | ON.delete, definer: true },
    { table, trigger: `${table}_before_truncate`, fn: 'inventory_boundary_before_truncate', type: BEFORE | ON.truncate },
  ]),
  // LP3-04 PR C: a retained dataset names a frozen version of its
  // organisation and year, agrees with its own content, and is never changed
  // or deleted but with its organisation (TA016) — SECURITY DEFINER, to read
  // the version and the subsidiaries whoever inserts.
  { table: 'report_datasets', trigger: 'report_datasets_guard', fn: 'report_datasets_guard', type: ROW | BEFORE | ON.insert | ON.update | ON.delete, definer: true },
  { table: 'report_datasets', trigger: 'report_datasets_before_truncate', fn: 'report_datasets_before_truncate', type: BEFORE | ON.truncate },
  // LP4-02 (27): a subsidiary's or a site's geography — what its records are
  // priced with — changes in the API's or the owner's session alone (TA015).
  // `locations` is guarded from here on: a later BEFORE UPDATE trigger could
  // change NEW.geography_code after the guard compared it.
  { table: 'subsidiaries', trigger: 'subsidiaries_geography_writer', fn: 'geography_code_writer', type: ROW | BEFORE | ON.update },
  { table: 'locations', trigger: 'locations_geography_writer', fn: 'geography_code_writer', type: ROW | BEFORE | ON.update },
]);

/**
 * The CHECK constraints the factor model's and the records' guarantees rest on, each with the
 * md5 of its `pg_get_constraintdef` on a database migrated from this
 * repository — so `CHECK (true)` under the same name is a finding, not a pass.
 * A migration that changes one updates its hash here (`runtime-role.int.spec`
 * fails until it does).
 */
export const INTEGRITY_CHECKS = Object.freeze([
  ['activity_records', 'activity_records_activity_type_check', '209bc4e708c65029678d21cb1c434ea6'],
  // LP4-02 (33): what a record says, held for every writer at the door.
  ['activity_records', 'activity_records_activity_value_check', 'eeef9e2c8cf6539c36909ac41432c40a'],
  ['activity_records', 'activity_records_period_value_check', 'd15080e375207c7ca22a5777c479af8b'],
  ['activity_records', 'activity_records_scope_check', 'e8da473541720c3a2b4ecaeff36399b4'],
  ['emission_factors', 'emission_factors_activity_type_check', '93f97c3cb3164b22248b3f9dc0b31bc9'],
  ['emission_factors', 'emission_factors_calorific_basis_check', '87fcf58708e411abac6ea8b86c8ba832'],
  ['emission_factors', 'emission_factors_factor_value_check', '9fd4bc38d56fd6f39cda5c362d62ca79'],
  ['emission_factors', 'emission_factors_gas_check', '98099ec2264bdb41bb798716f68f2471'],
  ['emission_factors', 'emission_factors_gas_coverage_check', 'a074aa7da19f92fe950c538451581817'],
  ['emission_factors', 'emission_factors_scope2_method_check', '491d417be371753abd66161e71bfd365'],
  ['emission_factors', 'emission_factors_scope_check', 'baf79c7460165f52d4d03548c8049f8e'],
  ['factor_release_events', 'factor_release_events_actor_check', '7a4d849bfe1c4906fef80b31a7585182'],
  ['factor_release_events', 'factor_release_events_db_role_check', 'ce62d7745ab1349239767e82684dfa4d'],
  ['factor_release_events', 'factor_release_events_event_check', 'bd339e53208ce61c108c800f8284f170'],
  ['factor_release_events', 'factor_release_events_rows_check', '1501bbfca3f7df329a4bc8fe3eab8dda'],
  ['factor_releases', 'factor_releases_authoritative_provenance_check', '07c31e476a2f5a64d9b7bf843eb69ce1'],
  ['factor_releases', 'factor_releases_fixture_publisher_check', 'f732d504c73b4902273df4dd596bb839'],
  ['factor_releases', 'factor_releases_gwp_set_check', 'f6e24213b9fca85d3a461e21251bc870'],
  ['factor_releases', 'factor_releases_ordinal_check', '6580fa22ba83139e4fd215ea6bc16a65'],
  ['factor_releases', 'factor_releases_placeholder_publisher_check', '8e38e4580950d19e9acc916fd2a67bce'],
  ['factor_releases', 'factor_releases_publisher_check', '436f2593daab905bce8207daac167c44'],
  ['factor_releases', 'factor_releases_review_after_publication_check', '353156c1deb3822c89c3e2f11821ec78'],
  ['factor_releases', 'factor_releases_source_url_check', '21eb1a772e5e1387ef77a535984e21b3'],
  ['factor_releases', 'factor_releases_status_check', 'fd922ea1cc055a55f0e91a96f486f183'],
  ['factor_releases', 'factor_releases_text_check', 'd23326d88a280c94d486b236f0c12e0b'],
  ['factor_releases', 'factor_releases_withdrawal_check', '4430a3652b1631e86ce68f076eae32a4'],
  ['factor_releases', 'factor_releases_withdrawn_sealed_check', '071f2bdff4397aeabbe9fc0c396e8dc6'],
  ['inventory_applicability_cells', 'inventory_applicability_cells_category_check', 'a4735b502a4150198c717e43593a8dbd'],
  ['inventory_applicability_cells', 'inventory_applicability_cells_decision_check', '1c7ffcfe38222b37c40d68f642315667'],
  ['inventory_applicability_cells', 'inventory_applicability_cells_location_key_check', 'a12859b8651bbff6733c214dce008b93'],
  ['inventory_attribution_policies', 'inventory_attribution_policies_category_check', 'a4735b502a4150198c717e43593a8dbd'],
  ['inventory_attribution_policies', 'inventory_attribution_policies_level_check', '584fbf926f5623ee47e8d5e34cfbcf8a'],
  ['inventory_attribution_policies', 'inventory_attribution_policies_period_check', '002fa1bd1e5ae2f5bfc7921603e932bb'],
  ['inventory_boundaries', 'inventory_boundaries_decision_check', 'b1d011288917c94e6edec6e5ccba2e9b'],
  ['inventory_boundaries', 'inventory_boundaries_version_check', '3e5843bf80ef107834bb748fbe091642'],
  ['inventory_boundaries', 'inventory_boundaries_year_check', 'f2002164747518aed94d85ff98c93112'],
  ['inventory_boundary_sites', 'inventory_boundary_sites_frozen_copy_check', '4340b19c70c173cbd9e75c45db21635d'],
  ['inventory_boundary_sites', 'inventory_boundary_sites_location_check', 'efe3320200e78e53721ffa0f886fb792'],
  ['inventory_boundary_sites', 'inventory_boundary_sites_months_check', '0cfb87cc9023eba104c2c2d6975c1f89'],
  ['inventory_boundary_subsidiaries', 'inventory_boundary_subsidiaries_frozen_copy_check', '0cdd3453f7c56d858e22cb0b45c58681'],
  ['inventory_boundary_subsidiaries', 'inventory_boundary_subsidiaries_months_check', '0cfb87cc9023eba104c2c2d6975c1f89'],
  ['inventory_sources', 'inventory_sources_cadence_check', 'c6aa9e325b08a34f32b0f39ae3fd8771'],
  ['inventory_sources', 'inventory_sources_decision_check', '1c7ffcfe38222b37c40d68f642315667'],
  ['inventory_sources', 'inventory_sources_included_key_check', '8dd7ef5d1dcbce5b18d5ce7e1cb88f4a'],
  ['inventory_sources', 'inventory_sources_location_key_check', 'a12859b8651bbff6733c214dce008b93'],
  ['inventory_sources', 'inventory_sources_mapping_check', '58f17af88daeadf0cd7b256ef9972040'],
  ['inventory_sources', 'inventory_sources_name_check', '89abd8a30af4e8ea9fe6138919107443'],
  // LP3-04 PR C: what a retained dataset row is (V5).
  ['report_datasets', 'report_datasets_fingerprint_check', '63204d1bbd98e2266744f4d2a7eb9a0c'],
  ['report_datasets', 'report_datasets_referenced_check', 'a61fe632e52e8c2bc789ca1a3a429491'],
  ['report_datasets', 'report_datasets_schema_check', '14dd828e62fc6a8879ad1d25e61e94cc'],
  ['report_datasets', 'report_datasets_selection_check', '8ff91db91299eba2a1b97fa4d1533b93'],
  ['report_datasets', 'report_datasets_selection_context_check', '30735b94defd559b810da8a1f204d001'],
  ['unit_conversions', 'unit_conversions_activity_type_check', '93f97c3cb3164b22248b3f9dc0b31bc9'],
  ['unit_conversions', 'unit_conversions_calorific_basis_check', '87fcf58708e411abac6ea8b86c8ba832'],
  ['unit_conversions', 'unit_conversions_multiplier_check', 'b44055800a17e765590df1c5c881b412'],
  ['unit_conversions', 'unit_conversions_text_check', '8d2e1321b2663ba9997f792676f25afc'],
  ['unit_conversions', 'unit_conversions_units_check', 'beeb2e7d9604ac1218b01390e2f1e6cb'],
]);

/**
 * Functions the triggers call that are not trigger functions themselves —
 * replacing one changes what a trigger records (`db_role`) as surely as
 * replacing the trigger function. Each must keep its migration body and be a
 * SECURITY INVOKER function pinned to search_path pg_catalog, pg_temp (FUNCTION_SEARCH_PATH).
 */
export const INTEGRITY_HELPERS = Object.freeze([{ fn: 'factor_release_events_actor_role', language: 'sql' }]);

const MIGRATIONS_DIR = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));

/**
 * Each trigger function's body as the LAST migration that (re)defines it has
 * it — what `pg_proc.prosrc` must equal, byte for byte.
 */
export function expectedTriggerFunctionBodies(dir = MIGRATIONS_DIR) {
  const bodies = new Map();
  const names = new Set([...INTEGRITY_TRIGGERS.map((t) => t.fn), ...INTEGRITY_HELPERS.map((h) => h.fn)]);
  for (const migration of readdirSync(dir).filter((d) => /^\d/.test(d)).sort()) {
    let sql;
    try {
      sql = readFileSync(`${dir}/${migration}/migration.sql`, 'utf8');
    } catch {
      continue;
    }
    const definition = /CREATE (?:OR REPLACE )?FUNCTION "public"\."([a-z_]+)"\(\)[\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/g;
    const parsed = new Set();
    for (const [, name, body] of sql.matchAll(definition)) {
      if (names.has(name)) {
        bodies.set(name, body);
        parsed.add(name);
      }
    }
    // A redefinition written another way (other quoting, another delimiter)
    // must fail here, loudly — not be skipped and later reported as tampering.
    for (const name of names) {
      const mentioned = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+[^(]*\\b${name}\\b`, 'i').test(sql);
      if (mentioned && !parsed.has(name)) {
        throw new Error(
          `${migration} defines ${name} in a form the integrity check cannot read; ` +
            `write it as CREATE FUNCTION "public"."${name}"() … AS $fn$ … $fn$;`,
        );
      }
    }
  }
  return bodies;
}

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

/**
 * The foreign keys of `activity_records` (LP4-01), each with the md5 of its
 * `pg_get_constraintdef` on a database migrated from this repository — so a
 * key re-created under its own name on other columns, or with another action,
 * is a finding. Every key of the table, listed or not, must answer both its
 * parent's delete and a change of the parent's key with RESTRICT or NO ACTION:
 * a referential action runs as the table's owner, whom
 * `activity_records_committed_delete` lets delete a committed record, so an ON
 * DELETE CASCADE or SET NULL would let whoever may delete the parent (a
 * service-role client, the API's role with SQL access) remove or re-file
 * committed records, and an ON UPDATE action would write them. A key dropped
 * is reported too: records could then outlive their subsidiary, or sit at
 * another subsidiary's site. So is a key whose enforcement is switched off: a
 * foreign key is four system triggers — an insert and an update check on
 * `activity_records`, a delete and a key-change action on the parent — and a
 * superuser can disable one, or make it replica-only, while the key's
 * definition and `convalidated` read as before (Codex's review of #159). Each
 * must be present and fire in an ordinary session: ENABLE, as PostgreSQL makes
 * them, or ALWAYS.
 */
export const RECORD_FOREIGN_KEYS = Object.freeze([
  ['activity_records_import_batch_id_fkey', '7058a8305daff968e129c1e3f0ab5801'],
  ['activity_records_location_id_subsidiary_id_fkey', '3221f47aaba83bbcdf1c5a4443e32cd8'],
  ['activity_records_subsidiary_id_fkey', '8b855abe0326a26240a4a9f99e9146c7'],
]);
const REFERENTIAL_ACTIONS = Object.freeze({ a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' });
/** The suffix of the system function that carries out each action (`RI_FKey_<suffix>_del` / `_upd`). */
const RI_ACTION_FUNCTIONS = Object.freeze({ a: 'noaction', r: 'restrict', c: 'cascade', n: 'setnull', d: 'setdefault' });
/** `pg_trigger.tgenabled`: fires in an ordinary session ('O' origin, 'A' always), or does not ('D', 'R'). */
const TRIGGER_STATES = Object.freeze({ D: 'disabled', R: 'replica-only (it fires in replica mode alone)' });

/**
 * The search path every function in `public` is pinned to — pg_catalog first,
 * the session's temporary schema LAST. With '' alone PostgreSQL still
 * searches pg_temp FIRST for type names, so a caller's temporary domain
 * shadowing `jsonb`, `timestamptz` or `text` ran its own check function as
 * whoever the function ran as: a SECURITY DEFINER's owner (`security-rls` P1,
 * LP3-04 PR C, reproduced as the runtime login), and so an INVOKER function a
 * definer calls — the factor event recorders' actor helper ran the loader's
 * domain as postgres (Codex's P1, reproduced from a fresh loader login) — or a
 * trigger an owner-run statement or an FK cascade fires. So the path is not
 * decided by `prosecdef`: definers and invokers alike.
 */
export const FUNCTION_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';
export const expectedFunctionConfig = () => [FUNCTION_SEARCH_PATH];

/**
 * Every function in `public` pinned to FUNCTION_SEARCH_PATH — the registered
 * integrity triggers and helpers, and any other, a later one included: one
 * left at '' (or unpinned) is a finding.
 */
export async function checkFunctionSearchPaths(query) {
  const rows = await query(
    `SELECT p.oid::regprocedure::text AS "fn", COALESCE(p.proconfig, '{}'::text[]) AS "config"
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      ORDER BY 1`,
  );
  return rows
    .filter((r) => JSON.stringify(r.config) !== JSON.stringify([FUNCTION_SEARCH_PATH]))
    .map((r) => `function public.${r.fn} is not pinned to ${FUNCTION_SEARCH_PATH} (config ${JSON.stringify(r.config)})`);
}

/**
 * Every SECURITY DEFINER function either of our logins can set running pins
 * its search_path with pg_temp listed last, wherever it lives and whoever
 * granted the reach — PUBLIC included, which the owner cannot revoke: the
 * remedy for a platform function is to take the reach away. One that pins
 * none resolves a type name through the CALLER's path, where pg_temp comes
 * first unless listed, so a temporary domain the login creates (TEMP is
 * PUBLIC's) runs the login's own CHECK as the function's owner — Supabase's
 * Storage helpers, while the runtime role held USAGE on `storage` (reproduced
 * from a fresh runtime login; closed by `20261020120000_runtime_storage_readers`).
 * "Set running" is calling it (USAGE on its schema and EXECUTE), writing a
 * table one of its triggers guards (table or column level), or running DDL an
 * enabled event trigger of it watches — creating a temporary object is DDL.
 * `public`'s own functions are held tighter by checkFunctionSearchPaths
 * (exactly `pg_catalog, pg_temp`, definer or invoker), which also covers what
 * a cascade fires there. A platform function reviewed as resolving no name
 * through the path passes while its body is the one reviewed
 * (`reviewed`, REVIEWED_PLATFORM_DEFINERS by default).
 */
export async function checkReachableDefiners(query, reviewed = REVIEWED_PLATFORM_DEFINERS) {
  const rows = await query(
    `SELECT r.rolname AS "role", x.how AS "how", COALESCE(p.proconfig, '{}'::text[]) AS "config",
            n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS "fn",
            pg_catalog.md5(p.prosrc) AS "body"
       FROM pg_catalog.pg_roles r
      CROSS JOIN LATERAL (
            SELECT f.oid, 'calling it' AS how
              FROM pg_catalog.pg_proc f
             WHERE f.prosecdef
               AND pg_catalog.has_schema_privilege(r.oid, f.pronamespace, 'USAGE')
               AND pg_catalog.has_function_privilege(r.oid, f.oid, 'EXECUTE')
            UNION
            SELECT t.tgfoid, 'writing ' || cn.nspname || '.' || c.relname
              FROM pg_catalog.pg_trigger t
              JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
              JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
             WHERE t.tgenabled <> 'D'
               AND pg_catalog.has_schema_privilege(r.oid, c.relnamespace, 'USAGE')
               AND (pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
                    OR pg_catalog.has_any_column_privilege(r.oid, c.oid, 'INSERT, UPDATE'))
            UNION
            SELECT e.evtfoid, 'running DDL (event trigger ' || e.evtname || ')'
              FROM pg_catalog.pg_event_trigger e
             WHERE e.evtenabled <> 'D'
           ) x
       JOIN pg_catalog.pg_proc p ON p.oid = x.oid
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE r.rolname IN (${sqlList([RUNTIME_ROLE, FACTOR_LOADER_ROLE])}) AND p.prosecdef
      ORDER BY 1, 4, 2`,
  );
  return rows
    .filter((r) => !pinsPgTempLast(r.config ?? []))
    .filter((r) => !(Object.hasOwn(reviewed, r.fn) && reviewed[r.fn] === r.body))
    .map(
      (r) =>
        `${r.role} can run SECURITY DEFINER ${r.fn}, by ${r.how}, and it does not pin its search_path with pg_temp last (config ${JSON.stringify(r.config ?? [])}) — a temporary type of the caller's would run as its owner`,
    );
}

/**
 * Platform SECURITY DEFINER functions our logins can set running that pin no
 * search_path, each reviewed: its body resolves no type or relation name
 * through the caller's path. Keyed as checkReachableDefiners names a function,
 * to the md5 of the body reviewed — a changed body (an extension upgrade) is
 * unreviewed again, and fails.
 */
export const REVIEWED_PLATFORM_DEFINERS = Object.freeze({
  // pg_graphql's schema-version bump, which its event triggers
  // (`graphql_watch_ddl`, `graphql_watch_drop`) run as supabase_admin after
  // every DDL statement — a login's temporary object included. Its body is one
  // fully qualified `pg_catalog.nextval('graphql.seq_schema_version')`:
  // nothing resolves through the path (2026-10-17; temporary domains over
  // text, regclass, int8, bigint, name, oid, bool, boolean, int4 and integer
  // did not run under it). An open question in the status file.
  'graphql.increment_schema_version()': 'cf541948e5ba6c830440b810d5601e44',
});

/**
 * Whether a function's settings pin a search_path that lists pg_temp once,
 * last: PostgreSQL searches the first pg_temp it is given, so
 * `pg_temp, pg_catalog, pg_temp` still puts it first.
 */
function pinsPgTempLast(config) {
  const entry = config.findLast((c) => c.startsWith('search_path='));
  if (!entry) return false;
  const path = entry
    .slice('search_path='.length)
    .split(',')
    .map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
  return path.indexOf('pg_temp') === path.length - 1;
}

/** The tables the integrity triggers guard: nothing else may hook into them. */
const GUARDED_TABLES = Object.freeze([
  'activity_records', 'factor_releases', 'emission_factors', 'unit_conversions', 'factor_release_events', 'subsidiaries',
  'inventory_boundaries', ...INVENTORY_BOUNDARY_ROW_TABLES, 'locations', 'report_datasets',
]);

/** Every integrity trigger, CHECK and record key, present, in force and unaltered. */
export async function checkIntegrityTriggers(query, expectedBodies = expectedTriggerFunctionBodies()) {
  const triggers = await query(
    `SELECT c.relname AS "table", t.tgname AS "trigger", t.tgenabled AS "enabled", t.tgtype::int AS "type",
            t.tgqual IS NULL AS "unconditional", cardinality(t.tgattr::int2[]) = 0 AS "allColumns",
            pn.nspname AS "fnSchema", p.proname AS "fn", md5(p.prosrc) AS "bodyMd5",
            p.prosecdef AS "definer", COALESCE(p.proconfig, '{}') AS "config", l.lanname AS "language",
            t.tgdeferrable AS "deferrable", t.tginitdeferred AS "initiallyDeferred"
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
       JOIN pg_namespace pn ON pn.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
  );
  const helpers = await query(
    `SELECT p.proname AS "fn", md5(p.prosrc) AS "bodyMd5", p.prosecdef AS "definer",
            COALESCE(p.proconfig, '{}') AS "config", l.lanname AS "language"
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'public' AND p.proname IN (${INTEGRITY_HELPERS.map((h) => `'${h.fn}'`).join(', ')})`,
  );
  const constraints = await query(
    `SELECT c.relname AS "table", k.conname AS "name", k.convalidated AS "validated",
            md5(pg_get_constraintdef(k.oid)) AS "definitionMd5", pg_get_constraintdef(k.oid) AS "definition"
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND k.contype = 'c'`,
  );
  const foreignKeys = await query(
    `SELECT k.conname AS "name", k.confdeltype AS "onDelete", k.confupdtype AS "onUpdate", k.convalidated AS "validated",
            md5(pg_get_constraintdef(k.oid)) AS "definitionMd5", pg_get_constraintdef(k.oid) AS "definition",
            pc.relname AS "parent"
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class pc ON pc.oid = k.confrelid
      WHERE n.nspname = 'public' AND c.relname = 'activity_records' AND k.contype = 'f'`,
  );
  // The system triggers that enforce those keys (the trigger query above
  // leaves internal triggers out), on both sides, by their constraint.
  const keyTriggers = await query(
    `SELECT k.conname AS "key", tc.relname AS "table", p.proname AS "fn", t.tgenabled AS "enabled"
       FROM pg_trigger t
       JOIN pg_constraint k ON k.oid = t.tgconstraint
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class tc ON tc.oid = t.tgrelid
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public' AND c.relname = 'activity_records' AND k.contype = 'f'`,
  );
  const rules = await query(
    `SELECT c.relname AS "table", r.rulename AS "rule"
       FROM pg_rewrite r
       JOIN pg_class c ON c.oid = r.ev_class
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND r.ev_type <> '1'`,
  );
  const problems = [];
  // Anything else hooked into a guarded table could undo what the integrity
  // triggers check (a later BEFORE trigger rewriting NEW, a DO INSTEAD rule).
  for (const t of triggers) {
    if (GUARDED_TABLES.includes(t.table) && !INTEGRITY_TRIGGERS.some((w) => w.table === t.table && w.trigger === t.trigger)) {
      problems.push(`unexpected trigger ${t.trigger} on ${t.table}`);
    }
  }
  for (const r of rules) {
    if (GUARDED_TABLES.includes(r.table)) problems.push(`unexpected rule ${r.rule} on ${r.table}`);
  }
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
    if (!found.unconditional || !found.allColumns) {
      problems.push(`trigger ${want.trigger} on ${want.table} is narrowed (a WHEN condition or an UPDATE OF column list)`);
    }
    if (want.deferred && !(found.deferrable && found.initiallyDeferred)) {
      problems.push(`trigger ${want.trigger} on ${want.table} is not DEFERRABLE INITIALLY DEFERRED — it must run at the commit, once the load is in`);
    }
    if (found.definer !== Boolean(want.definer) || found.language !== 'plpgsql'
      || JSON.stringify(found.config) !== JSON.stringify(expectedFunctionConfig())) {
      problems.push(
        `function public.${found.fn}() is not a SECURITY ${want.definer ? 'DEFINER' : 'INVOKER'} plpgsql function pinned to ` +
          `${FUNCTION_SEARCH_PATH} ` +
          `(definer ${found.definer}, ${found.language}, config ${JSON.stringify(found.config)})`,
      );
    }
    if (found.fnSchema !== 'public' || found.fn !== want.fn) {
      problems.push(`trigger ${want.trigger} on ${want.table} runs ${found.fnSchema}.${found.fn}, not public.${want.fn}`);
    } else if (!expectedBodies.has(want.fn)) {
      problems.push(`no migration defines public.${want.fn}()`);
    } else if (found.bodyMd5 !== md5(expectedBodies.get(want.fn))) {
      problems.push(`function public.${want.fn}() differs from its migration's definition`);
    }
  }
  for (const [table, name, definitionMd5] of INTEGRITY_CHECKS) {
    const found = constraints.find((c) => c.table === table && c.name === name);
    if (!found) problems.push(`CHECK ${name} on ${table} is missing`);
    else if (!found.validated) problems.push(`CHECK ${name} on ${table} is NOT VALID`);
    else if (found.definitionMd5 !== definitionMd5) {
      // The observed hash and definition, so a legitimate change can be
      // recognised and re-pinned without a separate replay.
      problems.push(
        `CHECK ${name} on ${table} differs from its migration's definition (md5 ${found.definitionMd5}: ${found.definition})`,
      );
    }
  }
  for (const [name, definitionMd5] of RECORD_FOREIGN_KEYS) {
    const found = foreignKeys.find((k) => k.name === name);
    if (!found) problems.push(`foreign key ${name} on activity_records is missing`);
    else if (!found.validated) problems.push(`foreign key ${name} on activity_records is NOT VALID`);
    else if (found.definitionMd5 !== definitionMd5) {
      problems.push(`foreign key ${name} on activity_records differs from its migration's definition (md5 ${found.definitionMd5}: ${found.definition})`);
    }
  }
  for (const k of foreignKeys) {
    for (const [event, action] of [['delete', k.onDelete], ['key change', k.onUpdate]]) {
      if (action !== 'r' && action !== 'a') {
        problems.push(
          `foreign key ${k.name} on activity_records answers its parent's ${event} with ${REFERENTIAL_ACTIONS[action] ?? action} — ` +
            'a referential action writes the records as the owner, whom the delete guard lets through; only RESTRICT or NO ACTION',
        );
      }
    }
    const enforcement = [
      ['RI_FKey_check_ins', 'activity_records', 'an insert into activity_records'],
      ['RI_FKey_check_upd', 'activity_records', 'an update of activity_records'],
      [`RI_FKey_${RI_ACTION_FUNCTIONS[k.onDelete] ?? k.onDelete}_del`, k.parent, `a delete from ${k.parent}`],
      [`RI_FKey_${RI_ACTION_FUNCTIONS[k.onUpdate] ?? k.onUpdate}_upd`, k.parent, `a key change in ${k.parent}`],
    ];
    for (const [fn, table, write] of enforcement) {
      const found = keyTriggers.filter((t) => t.key === k.name && t.fn === fn && t.table === table);
      if (found.length === 0) {
        problems.push(`foreign key ${k.name} on activity_records has no ${fn} trigger on ${table}: ${write} is not checked against it`);
      }
      for (const t of found) {
        if (t.enabled !== 'O' && t.enabled !== 'A') {
          problems.push(
            `foreign key ${k.name} on activity_records is not enforced on ${write}: its ${fn} trigger on ${table} is ` +
              `${TRIGGER_STATES[t.enabled] ?? `in state '${t.enabled}'`} — the key holds nothing for new writes while its definition reads as before`,
          );
        }
      }
    }
  }
  for (const want of INTEGRITY_HELPERS) {
    const found = helpers.find((h) => h.fn === want.fn);
    if (!found) problems.push(`function public.${want.fn}() is missing`);
    else if (
      found.definer ||
      found.language !== want.language ||
      JSON.stringify(found.config) !== JSON.stringify(expectedFunctionConfig()) ||
      found.bodyMd5 !== md5(expectedBodies.get(want.fn) ?? '')
    ) {
      problems.push(`function public.${want.fn}() differs from its migration's definition`);
    }
  }
  return problems;
}

/**
 * What the factor library holds that production must not calculate from, as
 * data. `problems`: an `unspecified` activity type under an authoritative
 * release (the insert trigger refuses it; a replica-mode restore would not).
 * `notices`: every non-authoritative release present — expected locally and
 * in CI, a finding on staging or production, where the seed never runs
 * (owner decision K3). `skipped`: a check this connection cannot run — the
 * runtime role may not read `factor_release_events`, so the record is
 * reconciled only through the owner.
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
  // The loader seals a release in the transaction that loads it, and a
  // deferred trigger refuses the commit otherwise: only a data-only restore
  // or a disabled guard leaves one unsealed (LP4-02).
  const [{ unsealed }] = await query(`SELECT count(*)::int AS unsealed FROM factor_releases WHERE sealed_at IS NULL`);
  const releases = await query(
    `SELECT r.publisher, r.edition, r.status,
            (SELECT count(*) FROM emission_factors f WHERE f.release_id = r.id)::int AS factors,
            (SELECT count(*) FROM unit_conversions u WHERE u.release_id = r.id)::int AS conversions
       FROM factor_releases r
      WHERE r.status IN ('placeholder', 'fixture')
      ORDER BY r.publisher, r.ordinal`,
  );
  // Every row the library holds was recorded as added (net of fixture
  // deletions), and every recorded row is held: a difference either way means
  // a load or a delete bypassed the record's triggers.
  const [{ readable, who }] = await query(
    `SELECT pg_catalog.has_table_privilege('public.factor_release_events', 'SELECT') AS readable, current_user AS who`,
  );
  if (!readable) {
    return {
      problems: [...unspecified(n), ...unsealedReleases(unsealed)],
      notices: placeholderNotices(releases),
      skipped: [`the library's record was not reconciled: ${who} cannot read factor_release_events — run this check through the owner (DIRECT_URL)`],
    };
  }
  const unrecorded = await query(
    `WITH held AS (
       SELECT release_id, 'emission_factors' AS table_name, count(*)::int AS n FROM emission_factors GROUP BY release_id
       UNION ALL
       SELECT release_id, 'unit_conversions', count(*)::int FROM unit_conversions GROUP BY release_id
     ), recorded AS (
       SELECT release_id, table_name,
              sum(CASE event WHEN 'rows_added' THEN row_count ELSE -row_count END)::int AS n
         FROM factor_release_events WHERE event IN ('rows_added', 'rows_deleted')
        GROUP BY release_id, table_name
     )
     SELECT release_id AS "releaseId", table_name AS "tableName", COALESCE(h.n, 0) AS "held", COALESCE(r.n, 0) AS "recorded"
       FROM held h FULL JOIN recorded r USING (release_id, table_name)
      WHERE COALESCE(h.n, 0) <> COALESCE(r.n, 0)
      ORDER BY 1, 2`,
  );
  return {
    problems: [
      ...unspecified(n),
      ...unsealedReleases(unsealed),
      ...unrecorded.map(
        (u) => `release ${u.releaseId} holds ${u.held} ${u.tableName} row(s) but factor_release_events records ${u.recorded}`,
      ),
    ],
    notices: placeholderNotices(releases),
    skipped: [],
  };
}

function unspecified(n) {
  return n > 0 ? [`${n} factor/conversion row(s) with an unspecified activity type under an authoritative release`] : [];
}

function unsealedReleases(n) {
  return n > 0
    ? [`${n} factor release(s) not sealed — a release is sealed in the transaction that loads it, and pricing ignores an unsealed one`]
    : [];
}

function placeholderNotices(releases) {
  return releases.map((r) => `${r.status} release ${r.publisher} ${r.edition} (${r.factors} factor(s), ${r.conversions} conversion(s))`);
}

/**
 * Gives the runtime role a login with `password`, through the owner connection
 * `client` (a PrismaClient). Loopback databases only; the server receives a
 * SCRAM verifier, never the password.
 */
export async function provisionLocalRuntimeLogin(client, ownerUrl, password) {
  await provisionLocalLogin(client, ownerUrl, RUNTIME_ROLE, password);
}

/** The same for the factor loader (LP4-02). */
export async function provisionLocalFactorLoaderLogin(client, ownerUrl, password) {
  await provisionLocalLogin(client, ownerUrl, FACTOR_LOADER_ROLE, password);
}

async function provisionLocalLogin(client, ownerUrl, role, password) {
  if (!isLoopbackUrl(ownerUrl)) {
    throw new Error(
      `Refusing to set a ${role} password on a database that is not plainly local (a loopback host and no ` +
        'redirecting parameter). A deployed environment sets the login through its rotation runbook.',
    );
  }
  if ([RUNTIME_ROLE, FACTOR_LOADER_ROLE].includes(urlUser(ownerUrl))) {
    throw new Error(`Provisioning needs the owner connection, not ${urlUser(ownerUrl)}.`);
  }
  await client.$executeRawUnsafe(`ALTER ROLE "${role}" WITH LOGIN PASSWORD '${scramVerifier(password)}'`);
}

/**
 * Everything `check` runs, in one place — the CLI, the integration suite and
 * any operator script read the same list. `problems` fail the check; the rest
 * are warnings (what PUBLIC grants, another creator's defaults, the library's
 * non-authoritative releases and what this connection could not reconcile).
 */
export async function checkAll(query) {
  const library = await factorLibraryReport(query);
  return {
    problems: [
      ...(await checkRuntimeRole(query)),
      ...(await checkFactorLoaderRole(query)),
      ...(await checkLibraryWriters(query)),
      ...(await checkTenantInvariants(query)),
      ...(await checkTableLevelGrants(query)),
      ...(await checkFunctionExecutors(query)),
      ...(await checkFunctionSearchPaths(query)),
      ...(await checkReachableDefiners(query)),
      ...(await checkIntegrityTriggers(query)),
      ...library.problems,
    ],
    exposures: [
      ...(await runtimeRoleExposures(query)).map((e) => `${RUNTIME_ROLE} can also reach ${e}`),
      ...(await factorLoaderExposures(query)).map((e) => `${FACTOR_LOADER_ROLE} can also reach ${e}`),
    ],
    platformDefaults: await platformDefaultPrivileges(query),
    library,
  };
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

  if (command === 'provision-loader') {
    const ownerUrl = process.env.DIRECT_URL;
    const password = process.env.FACTOR_LOADER_DB_PASSWORD;
    if (!ownerUrl) throw new Error('Set DIRECT_URL to the owner connection string.');
    if (!password) throw new Error('Set FACTOR_LOADER_DB_PASSWORD to the password the factor loader should log in with.');
    const owner = new PrismaClient({ datasourceUrl: ownerUrl });
    try {
      await provisionLocalFactorLoaderLogin(owner, ownerUrl, password);
    } finally {
      await owner.$disconnect();
    }
    const loader = new PrismaClient({ datasourceUrl: factorLoaderUrlFrom(ownerUrl, password) });
    try {
      const [{ user }] = await loader.$queryRawUnsafe('SELECT current_user AS "user"');
      console.log(`factor loader login ready: ${user} on ${new URL(ownerUrl).host} — FACTOR_LOADER_DATABASE_URL is the owner URL with this user and password`);
    } finally {
      await loader.$disconnect();
    }
    return;
  }

  if (command === 'check') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Set DATABASE_URL to the database to check.');
    const client = new PrismaClient({ datasourceUrl: url });
    let report;
    try {
      report = await checkAll((sql) => client.$queryRawUnsafe(sql));
    } finally {
      await client.$disconnect();
    }
    const { problems, exposures, platformDefaults, library } = report;
    for (const e of exposures) console.warn(`  ! ${e}`);
    for (const d of platformDefaults) console.warn(`  ! ${d} (another creator's default, not the migrations' role)`);
    // Not a failure here — local and CI databases hold the seed's placeholder
    // library on purpose. On staging or production each line is a finding.
    for (const n of library.notices) console.warn(`  ! factor library holds a ${n}`);
    for (const k of library.skipped) console.warn(`  ! ${k}`);
    if (problems.length > 0) {
      console.error(`${RUNTIME_ROLE} and ${FACTOR_LOADER_ROLE} on ${new URL(url).host}: ${problems.length} problem(s)`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`${RUNTIME_ROLE} and ${FACTOR_LOADER_ROLE} on ${new URL(url).host}: privileges as intended`);
    return;
  }

  console.error('usage: runtime-role.mjs provision | provision-loader | check');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
