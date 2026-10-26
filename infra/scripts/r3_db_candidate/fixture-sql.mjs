// Private offline preparation (db-candidate02; db-candidate05 amendment A1 below). Pure frozen constants and validators only.
// No client construction, no I/O, no CLI, no execution authority. Historical status stays NOT_REPRODUCED.
import { createHash } from 'node:crypto';

export const FIXTURE = Object.freeze({
  probe: 'regress_r3_probe', target: 'regress_r3_target', database: 'regress_r3_candidate',
});

// Plan 01 section 2: exact proposed setup statements, executed by a separate bootstrap identity only.
export const SETUP_STATEMENTS = Object.freeze([
  'BEGIN;',
  "SET LOCAL statement_timeout = '3s';",
  "SET LOCAL lock_timeout = '1s';",
  'CREATE ROLE regress_r3_target NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT;',
  'CREATE ROLE regress_r3_probe LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3;',
  'COMMIT;',
  'CREATE DATABASE regress_r3_candidate TEMPLATE template0;',
  'REVOKE CONNECT, TEMPORARY ON DATABASE regress_r3_candidate FROM PUBLIC;',
  'GRANT CONNECT, TEMPORARY ON DATABASE regress_r3_candidate TO regress_r3_probe;',
]);
export const SETUP_SCRIPT = SETUP_STATEMENTS.join('\n') + '\n';
const sha = value => createHash('sha256').update(value).digest('hex');
export const SETUP_SHA256 = sha(SETUP_SCRIPT);

// Plan 01 section 2 requires a collision check and absent pg_db_role_setting rows but gives no SQL text.
// These two bootstrap-only reads are the narrowest fixed form; they are additions pending review.
export const COLLISION_QUERY = `SELECT (SELECT count(*) FROM pg_roles
    WHERE rolname IN ('regress_r3_probe', 'regress_r3_target'))::int AS roles,
  (SELECT count(*) FROM pg_database WHERE datname = 'regress_r3_candidate')::int AS databases`;
export const DB_ROLE_SETTING_QUERY = `SELECT count(*)::int AS settings FROM pg_db_role_setting
  WHERE setrole IN (SELECT oid FROM pg_roles WHERE rolname IN ('regress_r3_probe', 'regress_r3_target'))
    OR setdatabase IN (SELECT oid FROM pg_database WHERE datname = 'regress_r3_candidate')
    OR (setrole = 0 AND setdatabase = 0)`;

// Plan 01 section 2: explicit allowlisted GUCs only (C-collation order), six fixed columns, max 10 rows.
export const GUC_NAMES = Object.freeze([
  'dynamic_library_path',
  'local_preload_libraries',
  'session_preload_libraries',
  'shared_preload_libraries',
  'supautils.privileged_extensions_superuser',
  'supautils.privileged_role',
  'supautils.privileged_role_allowed_configs',
  'supautils.reserved_memberships',
  'supautils.reserved_roles',
  'supautils.superuser',
]);
export const GUC_QUERY = `SELECT name, setting, source, sourcefile, sourceline, pending_restart FROM pg_settings
  WHERE name IN (${GUC_NAMES.map(name => `'${name}'`).join(', ')})
  ORDER BY name COLLATE "C" LIMIT 10`;
export const GUC_LIMITS = Object.freeze({ rows: 10, bytes: 16384, setting: 4096, sourcefile: 1024 });
export const BOOTSTRAP_QUERIES = Object.freeze([COLLISION_QUERY, DB_ROLE_SETTING_QUERY, GUC_QUERY]);
const GUC_KEYS = Object.freeze(['name', 'pending_restart', 'setting', 'source', 'sourcefile', 'sourceline']);
// Session/role/database/client-level sources are overrides and are refused in every context.
const ALLOWED_SOURCES = new Set(['default', 'configuration file', 'command line']);
const SIMPLE_ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
// db-candidate05 amendment A1: supautils reserved lists use a single trailing '*' as a role-name PREFIX
// pattern (the pinned image ships `service_role*, authenticator*, authenticated*, anon*`). List entries may
// carry it; single roles may not. A bare '*', an inner '*', or '**' stays refused.
const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}\*?$/;
export function rolePatternMatches(pattern, role) {
  return pattern.endsWith('*') ? role.startsWith(pattern.slice(0, -1)) : role === pattern;
}

export class FixtureRefusal extends Error {
  constructor(code) { super(code); this.name = 'FixtureRefusal'; this.code = code; }
}
const refuse = code => { throw new FixtureRefusal(code); };
const check = (condition, code) => { if (!condition) refuse(code); };
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.getOwnPropertySymbols(value).length === 0 &&
  Object.values(Object.getOwnPropertyDescriptors(value)).every(d => 'value' in d && d.enumerable);
const denseArray = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype &&
  Object.keys(value).length === value.length && Object.keys(value).every((key, index) => key === String(index));

export function validateSetupStatements(statements) {
  check(denseArray(statements) && statements.length === SETUP_STATEMENTS.length, 'SETUP_SHAPE');
  statements.forEach((value, index) => check(typeof value === 'string' && value === SETUP_STATEMENTS[index], 'SETUP_STATEMENT_' + index));
  return SETUP_SHA256;
}
export function validateSetupScript(text) {
  check(typeof text === 'string' && text === SETUP_SCRIPT && sha(text) === SETUP_SHA256, 'SETUP_SCRIPT');
  return SETUP_SHA256;
}
export function classifyBootstrapStatement(statement) {
  check(typeof statement === 'string', 'BOOTSTRAP_STATEMENT_TYPE');
  if (SETUP_STATEMENTS.includes(statement)) return 'setup';
  if (BOOTSTRAP_QUERIES.includes(statement)) return 'query';
  return refuse('BOOTSTRAP_STATEMENT_NOT_ALLOWED');
}

// Port of PostgreSQL 17 SplitIdentifierString (varlena.c) with separator ','. Whitespace follows
// scanner_isspace (PG16+ includes \v). Unquoted names are ASCII-downcased (UTF-8 server encoding
// leaves high-bit bytes alone) and every name is truncated to NAMEDATALEN-1 bytes on a character boundary.
const scannerSpace = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
function truncateIdentifier(name) {
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length < 64) return name;
  let end = 63;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
export function splitIdentifierString(raw, separator = ',') {
  check(typeof raw === 'string' && typeof separator === 'string' && separator.length === 1, 'SPLIT_INPUT');
  const names = [];
  let i = 0;
  while (i < raw.length && scannerSpace(raw[i])) i++;
  if (i >= raw.length) return { ok: true, names };
  for (;;) {
    let name;
    if (raw[i] === '"') {
      let value = '', j = i + 1;
      for (;;) {
        const end = raw.indexOf('"', j);
        if (end < 0) return { ok: false, names: [] };
        value += raw.slice(j, end);
        if (raw[end + 1] !== '"') { i = end + 1; break; }
        value += '"'; j = end + 2;
      }
      name = value;
    } else {
      const start = i;
      while (i < raw.length && raw[i] !== separator && !scannerSpace(raw[i])) i++;
      if (start === i) return { ok: false, names: [] };
      name = raw.slice(start, i).replace(/[A-Z]/g, ch => ch.toLowerCase());
    }
    while (i < raw.length && scannerSpace(raw[i])) i++;
    let done = false;
    if (raw[i] === separator) {
      i++;
      while (i < raw.length && scannerSpace(raw[i])) i++;
    } else if (i >= raw.length) done = true;
    else return { ok: false, names: [] };
    names.push(truncateIdentifier(name));
    // A trailing separator loops back to an empty unquoted name, which fails exactly as in PostgreSQL.
    if (done) return { ok: true, names };
  }
}

// Accepted subset where any plausible list parser agrees: lowercase simple names (A1: optionally ending in
// one '*' prefix wildcard), ',' and blanks only. Quotes, uppercase, inner wildcards, flags, dots, control
// characters or non-ASCII are refused, not interpreted.
export function parseSimpleRoleList(raw) {
  check(typeof raw === 'string' && raw.length <= GUC_LIMITS.setting, 'ROLE_LIST_TYPE');
  check(/^[a-z0-9_*, \t]*$/.test(raw), 'RICH_IDENTIFIER_SYNTAX');
  const parsed = splitIdentifierString(raw);
  check(parsed.ok, 'IDENTIFIER_LIST_SYNTAX');
  const naive = raw.replace(/^[ \t]+|[ \t]+$/g, '') === '' ? [] : raw.split(',').map(value => value.replace(/^[ \t]+|[ \t]+$/g, ''));
  check(JSON.stringify(naive) === JSON.stringify(parsed.names), 'PARSER_DISAGREEMENT');
  check(parsed.names.every(name => ROLE_PATTERN.test(name)), 'RICH_IDENTIFIER_SYNTAX');
  check(new Set(parsed.names).size === parsed.names.length, 'DUPLICATE_LIST_ENTRY');
  return Object.freeze(parsed.names);
}
export function parseSingleRole(raw) {
  check(typeof raw === 'string' && raw.length <= 63, 'ROLE_TYPE');
  if (raw === '') return null;
  check(SIMPLE_ROLE.test(raw), 'RICH_IDENTIFIER_SYNTAX');
  return raw;
}
// Unquoted subset of SplitDirectoriesString input; anything canonicalize_path could rewrite is refused.
export function parsePreloadList(raw) {
  check(typeof raw === 'string' && raw.length <= GUC_LIMITS.setting, 'PRELOAD_TYPE');
  check(/^[A-Za-z0-9_$.\/, \t-]*$/.test(raw), 'PRELOAD_SYNTAX');
  if (raw.replace(/[ \t]/g, '') === '') return Object.freeze([]);
  const items = raw.split(',').map(value => value.replace(/^[ \t]+|[ \t]+$/g, ''));
  check(items.every(item => /^[A-Za-z0-9_$.\/-]+$/.test(item) && !item.includes('//') && !item.endsWith('/') &&
    !/(^|\/)\.\.?(\/|$)/.test(item)), 'PRELOAD_SYNTAX');
  return Object.freeze(items);
}
const supautilsEntry = item => item.replace(/^\$libdir\//, '').replace(/\.so$/, '') === 'supautils';

export function validateCollisionRows(rows) {
  check(denseArray(rows) && rows.length === 1 && plainObject(rows[0]) &&
    Object.keys(rows[0]).sort().join(',') === 'databases,roles', 'COLLISION_SHAPE');
  check(rows[0].roles === 0 && rows[0].databases === 0, 'FIXTURE_NAME_COLLISION');
  return true;
}
export function validateDbRoleSettingRows(rows) {
  check(denseArray(rows) && rows.length === 1 && plainObject(rows[0]) &&
    Object.keys(rows[0]).join(',') === 'settings', 'DB_ROLE_SETTING_SHAPE');
  check(rows[0].settings === 0, 'DB_ROLE_SETTING_PRESENT');
  return true;
}

export function validateGucRows(rows, { context } = {}) {
  check(context === 'bootstrap' || context === 'lane', 'GUC_CONTEXT');
  check(denseArray(rows) && rows.length <= GUC_LIMITS.rows, 'GUC_CARDINALITY');
  check(context === 'lane' || rows.length === GUC_NAMES.length, 'GUC_CARDINALITY');
  let encoded;
  try { encoded = JSON.stringify(rows); } catch { refuse('GUC_SHAPE'); }
  check(Buffer.byteLength(encoded) <= GUC_LIMITS.bytes, 'GUC_SIZE');
  const byName = Object.create(null);
  let previous = '';
  for (const row of rows) {
    check(plainObject(row) && Object.keys(row).sort().join(',') === GUC_KEYS.join(','), 'GUC_SHAPE');
    check(typeof row.name === 'string' && GUC_NAMES.includes(row.name), 'GUC_NAME');
    check(row.name > previous, 'GUC_ORDER'); previous = row.name;
    check(typeof row.setting === 'string' && row.setting.length <= GUC_LIMITS.setting, 'GUC_SETTING_TYPE');
    check(typeof row.source === 'string' && ALLOWED_SOURCES.has(row.source), 'GUC_SOURCE');
    check(row.pending_restart === false, 'GUC_PENDING_RESTART');
    if (context === 'lane' || row.source !== 'configuration file') {
      // The probe lacks pg_read_all_settings, so any visible file location is itself a privilege finding.
      check(row.sourcefile === null && row.sourceline === null, context === 'lane' ? 'LANE_SOURCE_VISIBILITY' : 'GUC_SOURCE_LOCATION');
    } else {
      check(typeof row.sourcefile === 'string' && row.sourcefile.startsWith('/') && row.sourcefile.length <= GUC_LIMITS.sourcefile &&
        !/[\u0000-\u001f\u007f]/.test(row.sourcefile) && Number.isSafeInteger(row.sourceline) && row.sourceline > 0, 'GUC_SOURCE_LOCATION');
    }
    byName[row.name] = row;
  }
  const fixtureRoles = [FIXTURE.probe, FIXTURE.target];
  const summary = { context, names: rows.map(row => row.name) };
  for (const name of ['supautils.superuser', 'supautils.privileged_extensions_superuser', 'supautils.privileged_role']) {
    if (!byName[name]) continue;
    const role = parseSingleRole(byName[name].setting);
    check(!fixtureRoles.includes(role), 'FIXTURE_ROLE_PRIVILEGED');
    summary[name] = role;
  }
  if (byName['supautils.superuser'] && byName['supautils.privileged_extensions_superuser']) {
    check(byName['supautils.superuser'].setting === byName['supautils.privileged_extensions_superuser'].setting, 'SUPERUSER_ALIAS_MISMATCH');
  }
  for (const name of ['supautils.reserved_roles', 'supautils.reserved_memberships']) {
    if (!byName[name]) continue;
    const list = parseSimpleRoleList(byName[name].setting);
    check(!list.some(entry => fixtureRoles.some(role => rolePatternMatches(entry, role))), 'FIXTURE_ROLE_RESERVED');
    summary[name] = list;
  }
  for (const name of ['shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries']) {
    if (byName[name]) summary[name] = parsePreloadList(byName[name].setting);
  }
  if (byName.shared_preload_libraries) {
    check(summary.shared_preload_libraries.filter(supautilsEntry).length === 1, 'SUPAUTILS_NOT_PRELOADED_ONCE');
  }
  return Object.freeze(summary);
}

// Lane rows must equal the bootstrap rows for every name the reviewed visibility expectation lists.
export function compareLaneGucs(bootstrapRows, laneRows, { visibleNames } = {}) {
  validateGucRows(bootstrapRows, { context: 'bootstrap' });
  validateGucRows(laneRows, { context: 'lane' });
  check(denseArray(visibleNames) && visibleNames.every(name => GUC_NAMES.includes(name)) &&
    JSON.stringify(laneRows.map(row => row.name)) === JSON.stringify(visibleNames), 'LANE_VISIBILITY_MISMATCH');
  for (const row of laneRows) {
    const base = bootstrapRows.find(value => value.name === row.name);
    check(base && base.setting === row.setting && base.source === row.source, 'LANE_OVERRIDE');
  }
  return true;
}

// Expected values come from an independently bound startup configuration; nothing here supplies defaults.
export function validateGucExpectation(rows, expected) {
  validateGucRows(rows, { context: 'bootstrap' });
  check(plainObject(expected) && JSON.stringify(Object.keys(expected).sort()) === JSON.stringify([...GUC_NAMES]), 'EXPECTED_CONFIG_BINDING');
  for (const row of rows) {
    const value = expected[row.name];
    check(plainObject(value) && Object.keys(value).sort().join(',') === 'setting,source' &&
      value.setting === row.setting && value.source === row.source, 'GUC_EXPECTATION_MISMATCH:' + row.name);
  }
  return true;
}

export function validateGucFixture({ bootstrapBefore, bootstrapAfter, lanes, expected, visibleNames } = {}) {
  validateGucExpectation(bootstrapBefore, expected);
  validateGucExpectation(bootstrapAfter, expected);
  check(JSON.stringify(bootstrapBefore) === JSON.stringify(bootstrapAfter), 'GUC_DRIFT');
  check(plainObject(lanes) && Object.keys(lanes).sort().join(',') === 'A,B,C', 'LANE_SET');
  for (const lane of ['A', 'B', 'C']) compareLaneGucs(bootstrapBefore, lanes[lane], { visibleNames });
  return Object.freeze({ status: 'GUC_FIXTURE_CONSISTENT', setup_sha256: SETUP_SHA256, guc_query_sha256: sha(GUC_QUERY) });
}
