// db-candidate02: fixture SQL / GUC validator tests. Pure; no client, no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  FIXTURE, SETUP_STATEMENTS, SETUP_SCRIPT, SETUP_SHA256, COLLISION_QUERY, DB_ROLE_SETTING_QUERY, GUC_NAMES, GUC_QUERY,
  BOOTSTRAP_QUERIES, FixtureRefusal, validateSetupStatements, validateSetupScript, classifyBootstrapStatement,
  splitIdentifierString, parseSimpleRoleList, parseSingleRole, parsePreloadList, validateCollisionRows,
  validateDbRoleSettingRows, validateGucRows, compareLaneGucs, validateGucExpectation, validateGucFixture,
} from '../scripts/r3_db_candidate/fixture-sql.mjs';
import { rolePatternMatches } from '../scripts/r3_db_candidate/fixture-sql.mjs';

const code = expected => error => error instanceof FixtureRefusal && error.code === expected;
const cyrillicA = String.fromCharCode(0x430);

// Literal copy of plan 01 section 2; the frozen constant must equal it byte for byte.
const PLAN_TEXT = `BEGIN;
SET LOCAL statement_timeout = '3s';
SET LOCAL lock_timeout = '1s';
CREATE ROLE regress_r3_target NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE regress_r3_probe LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3;
COMMIT;
CREATE DATABASE regress_r3_candidate TEMPLATE template0;
REVOKE CONNECT, TEMPORARY ON DATABASE regress_r3_candidate FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE regress_r3_candidate TO regress_r3_probe;
`;

test('setup constants are frozen and equal the plan text', () => {
  assert.equal(SETUP_SCRIPT, PLAN_TEXT);
  assert.equal(SETUP_SHA256, createHash('sha256').update(PLAN_TEXT).digest('hex'));
  assert.ok(Object.isFrozen(SETUP_STATEMENTS) && Object.isFrozen(GUC_NAMES) && Object.isFrozen(BOOTSTRAP_QUERIES) && Object.isFrozen(FIXTURE));
  assert.throws(() => { SETUP_STATEMENTS.push('DROP ROLE x;'); }, TypeError);
  assert.equal(validateSetupStatements([...SETUP_STATEMENTS]), SETUP_SHA256);
  assert.equal(validateSetupScript(PLAN_TEXT), SETUP_SHA256);
  assert.ok(!/PASSWORD|SUPERUSER |CREATEROLE |ADMIN|SET ROLE/.test(SETUP_SCRIPT.replace(/NO(SUPERUSER|CREATEROLE)/g, '')));
});

const statementMutations = {
  missing: list => list.slice(1),
  extra: list => [...list, 'DROP ROLE regress_r3_probe;'],
  reordered: list => [list[1], list[0], ...list.slice(2)],
  'trailing space': list => list.map((value, index) => index === 3 ? value + ' ' : value),
  'no semicolon': list => list.map((value, index) => index === 0 ? 'BEGIN' : value),
  lowercase: list => list.map((value, index) => index === 5 ? 'commit;' : value),
  'homoglyph role': list => list.map((value, index) => index === 4 ? value.replace('probe', 'prob' + String.fromCharCode(0x435)) : value),
  'password added': list => list.map((value, index) => index === 4 ? value.replace(' CONNECTION', " PASSWORD 'x' CONNECTION") : value),
  'superuser probe': list => list.map((value, index) => index === 4 ? value.replace('NOSUPERUSER', 'SUPERUSER') : value),
  'connection limit raised': list => list.map((value, index) => index === 4 ? value.replace('LIMIT 3', 'LIMIT 30') : value),
  'grant to public': list => list.map((value, index) => index === 8 ? value.replace('TO regress_r3_probe', 'TO PUBLIC') : value),
};
for (const [name, mutate] of Object.entries(statementMutations)) {
  test('setup statement list mutation refused: ' + name, () => {
    assert.throws(() => validateSetupStatements(mutate([...SETUP_STATEMENTS])), FixtureRefusal);
  });
}
test('setup statement list rejects non-array and exotic arrays', () => {
  const sparse = [...SETUP_STATEMENTS]; delete sparse[2];
  const extraProp = [...SETUP_STATEMENTS]; extraProp.injected = 'DROP ROLE x;';
  const strings = SETUP_STATEMENTS.map(value => new String(value));
  const arrayLike = Object.assign({ length: SETUP_STATEMENTS.length }, SETUP_STATEMENTS);
  class Sub extends Array {}
  for (const value of [SETUP_SCRIPT, null, undefined, arrayLike, sparse, extraProp, strings, Sub.from(SETUP_STATEMENTS)]) {
    assert.throws(() => validateSetupStatements(value), FixtureRefusal);
  }
});
test('setup script rejects CRLF, missing newline, BOM, appended statement', () => {
  for (const value of [PLAN_TEXT.replace(/\n/g, '\r\n'), PLAN_TEXT.slice(0, -1), String.fromCharCode(0xfeff) + PLAN_TEXT,
    PLAN_TEXT + 'DROP ROLE regress_r3_probe;\n', PLAN_TEXT + '\n', Buffer.from(PLAN_TEXT)]) {
    assert.throws(() => validateSetupScript(value), code('SETUP_SCRIPT'));
  }
});
test('bootstrap statement classifier admits only the frozen statements', () => {
  for (const value of SETUP_STATEMENTS) assert.equal(classifyBootstrapStatement(value), 'setup');
  for (const value of [COLLISION_QUERY, DB_ROLE_SETTING_QUERY, GUC_QUERY]) assert.equal(classifyBootstrapStatement(value), 'query');
  for (const value of ['SHOW ALL', 'SELECT * FROM pg_settings', GUC_QUERY + ' ', "ALTER SYSTEM SET supautils.reserved_roles = ''",
    "SET supautils.reserved_roles = ''", 'SELECT pg_read_file(\'/etc/passwd\')', 'DROP ROLE regress_r3_probe;', '', 'BEGIN']) {
    assert.throws(() => classifyBootstrapStatement(value), code('BOOTSTRAP_STATEMENT_NOT_ALLOWED'));
  }
  assert.throws(() => classifyBootstrapStatement(null), code('BOOTSTRAP_STATEMENT_TYPE'));
});
test('GUC query names the ten allowlisted settings in C order with a 10-row limit', () => {
  assert.equal(GUC_NAMES.length, 10); assert.equal(new Set(GUC_NAMES).size, 10);
  assert.deepEqual([...GUC_NAMES].sort(), [...GUC_NAMES]);
  for (const name of GUC_NAMES) assert.ok(GUC_QUERY.includes(`'${name}'`));
  assert.equal(GUC_QUERY.match(/'/g).length, 20);
  assert.match(GUC_QUERY, /ORDER BY name COLLATE "C" LIMIT 10$/);
  assert.doesNotMatch(GUC_QUERY, /SHOW|\*|pg_file_settings|current_setting/);
  assert.match(GUC_QUERY, /^SELECT name, setting, source, sourcefile, sourceline, pending_restart FROM pg_settings\n/);
});

// SplitIdentifierString port: PostgreSQL 17 semantics.
const splitCases = [
  ['', true, []], ['   ', true, []], ['a', true, ['a']], ['a, b', true, ['a', 'b']], [' A ,B ', true, ['a', 'b']],
  ['a,\nb', true, ['a', 'b']], ['a\v,b', true, ['a', 'b']], ['ab"c', true, ['ab"c']], ['A*', true, ['a*']],
  ['"Ab"', true, ['Ab']], ['"a""b"', true, ['a"b']], ['"a,b", c', true, ['a,b', 'c']], ['a.b', true, ['a.b']],
  ['a,', false], [',a', false], ['a,,b', false], ['a b', false], ['"a', false], ['"a"b', false], ['a ,', false], ['a\tb', false],
];
for (const [raw, ok, names] of splitCases) {
  test('splitIdentifierString ' + JSON.stringify(raw), () => {
    const result = splitIdentifierString(raw);
    assert.equal(result.ok, ok);
    if (ok) assert.deepEqual(result.names, names); else assert.deepEqual(result.names, []);
  });
}
test('splitIdentifierString truncates to 63 bytes on a character boundary', () => {
  assert.deepEqual(splitIdentifierString('a'.repeat(70)).names, ['a'.repeat(63)]);
  const e = String.fromCharCode(0xe9);
  assert.deepEqual(splitIdentifierString(e.repeat(40)).names, [e.repeat(31)]);
  assert.deepEqual(splitIdentifierString('xx' + e.repeat(31)).names, ['xx' + e.repeat(30)]);
  assert.deepEqual(splitIdentifierString('"' + 'B'.repeat(70) + '"').names, ['B'.repeat(63)]);
});

test('simple role list accepts only the lowercase subset', () => {
  assert.deepEqual(parseSimpleRoleList(''), []); assert.deepEqual(parseSimpleRoleList(' \t'), []);
  assert.deepEqual(parseSimpleRoleList('supabase_admin, authenticator,\tpgbouncer'), ['supabase_admin', 'authenticator', 'pgbouncer']);
  assert.deepEqual(parseSimpleRoleList('xregress_r3_probe,regress_r3_probex'), ['xregress_r3_probe', 'regress_r3_probex']);
});
const richLists = {
  '"regress_r3_probe"': 'RICH_IDENTIFIER_SYNTAX', 'Regress_R3_Probe': 'RICH_IDENTIFIER_SYNTAX', 'regress_**': 'RICH_IDENTIFIER_SYNTAX', 'a*b': 'RICH_IDENTIFIER_SYNTAX', '*': 'RICH_IDENTIFIER_SYNTAX', '*a': 'RICH_IDENTIFIER_SYNTAX',
  'regress_r3_probe:inherit': 'RICH_IDENTIFIER_SYNTAX', 'a.b': 'RICH_IDENTIFIER_SYNTAX', 'a\nb': 'RICH_IDENTIFIER_SYNTAX',
  ['a' + String.fromCharCode(0)]: 'RICH_IDENTIFIER_SYNTAX', ['regress_r3_prob' + cyrillicA]: 'RICH_IDENTIFIER_SYNTAX',
  'a,,b': 'IDENTIFIER_LIST_SYNTAX', 'a,': 'IDENTIFIER_LIST_SYNTAX', ',a': 'IDENTIFIER_LIST_SYNTAX', 'a b': 'IDENTIFIER_LIST_SYNTAX',
  '1abc': 'RICH_IDENTIFIER_SYNTAX', ['a'.repeat(64)]: 'PARSER_DISAGREEMENT' /* PostgreSQL would truncate */, 'a,a': 'DUPLICATE_LIST_ENTRY', 'a$b': 'RICH_IDENTIFIER_SYNTAX',
};
for (const [raw, expected] of Object.entries(richLists)) {
  test('simple role list refuses ' + JSON.stringify(raw), () => { assert.throws(() => parseSimpleRoleList(raw), code(expected)); });
}
test('role list and single role reject non-strings', () => {
  for (const value of [null, undefined, 1, ['a'], { toString: () => 'a' }]) {
    assert.throws(() => parseSimpleRoleList(value), code('ROLE_LIST_TYPE'));
    assert.throws(() => parseSingleRole(value), code('ROLE_TYPE'));
  }
  assert.equal(parseSingleRole(''), null); assert.equal(parseSingleRole('supabase_admin'), 'supabase_admin');
  for (const value of [' supabase_admin', 'a,b', '"x"', 'Admin']) assert.throws(() => parseSingleRole(value), code('RICH_IDENTIFIER_SYNTAX'));
});
test('preload list parser accepts the unquoted subset only', () => {
  assert.deepEqual(parsePreloadList(''), []);
  assert.deepEqual(parsePreloadList('pg_stat_statements, supautils, $libdir/plpgsql'), ['pg_stat_statements', 'supautils', '$libdir/plpgsql']);
  for (const value of ['"supautils"', 'a,,b', 'a,', '../evil', '/tmp/./x', 'a//b', 'dir/', 'a;b', 'a\nb']) {
    assert.throws(() => parsePreloadList(value), code('PRELOAD_SYNTAX'));
  }
});

test('collision and db-role-setting rows require exact zero integers', () => {
  assert.equal(validateCollisionRows([{ roles: 0, databases: 0 }]), true);
  assert.equal(validateDbRoleSettingRows([{ settings: 0 }]), true);
  assert.throws(() => validateCollisionRows([{ roles: 1, databases: 0 }]), code('FIXTURE_NAME_COLLISION'));
  assert.throws(() => validateCollisionRows([{ roles: 0, databases: 1 }]), code('FIXTURE_NAME_COLLISION'));
  for (const rows of [[{ roles: '0', databases: 0 }], [{ roles: 0n, databases: 0 }]]) assert.throws(() => validateCollisionRows(rows), code('FIXTURE_NAME_COLLISION'));
  for (const rows of [[], [{ roles: 0, databases: 0 }, { roles: 0, databases: 0 }], [{ roles: 0 }], [{ roles: 0, databases: 0, x: 1 }], {}]) {
    assert.throws(() => validateCollisionRows(rows), code('COLLISION_SHAPE'));
  }
  assert.throws(() => validateDbRoleSettingRows([{ settings: 1 }]), code('DB_ROLE_SETTING_PRESENT'));
  assert.throws(() => validateDbRoleSettingRows([{ settings: 0, extra: 0 }]), code('DB_ROLE_SETTING_SHAPE'));
});

// Synthetic GUC rows for validator tests only; NOT the pinned image configuration (still unbound).
const row = (name, setting, source = 'default', sourcefile = null, sourceline = null) =>
  ({ name, setting, source, sourcefile, sourceline, pending_restart: false });
const bootstrapRows = () => [
  row('dynamic_library_path', '$libdir'),
  row('local_preload_libraries', ''),
  row('session_preload_libraries', ''),
  row('shared_preload_libraries', 'pg_stat_statements, supautils', 'configuration file', '/synthetic/postgresql.conf', 10),
  row('supautils.privileged_extensions_superuser', 'synthetic_admin', 'configuration file', '/synthetic/supautils.conf', 2),
  row('supautils.privileged_role', 'synthetic_privileged', 'configuration file', '/synthetic/supautils.conf', 3),
  row('supautils.privileged_role_allowed_configs', 'synthetic.*', 'configuration file', '/synthetic/supautils.conf', 4),
  row('supautils.reserved_memberships', 'synthetic_member', 'configuration file', '/synthetic/supautils.conf', 5),
  row('supautils.reserved_roles', 'synthetic_admin, synthetic_reserved', 'configuration file', '/synthetic/supautils.conf', 6),
  row('supautils.superuser', 'synthetic_admin', 'configuration file', '/synthetic/supautils.conf', 1),
];
const laneRows = rows => rows.filter(value => !['dynamic_library_path', 'session_preload_libraries', 'shared_preload_libraries'].includes(value.name))
  .map(value => ({ ...value, sourcefile: null, sourceline: null }));
const expected = rows => Object.fromEntries(rows.map(value => [value.name, { setting: value.setting, source: value.source }]));
const edit = (name, patch) => bootstrapRows().map(value => value.name === name ? { ...value, ...patch } : value);

test('valid bootstrap GUC rows parse into a frozen summary', () => {
  const summary = validateGucRows(bootstrapRows(), { context: 'bootstrap' });
  assert.ok(Object.isFrozen(summary));
  assert.deepEqual(summary['supautils.reserved_roles'], ['synthetic_admin', 'synthetic_reserved']);
  assert.deepEqual(summary.shared_preload_libraries, ['pg_stat_statements', 'supautils']);
  assert.equal(summary['supautils.superuser'], 'synthetic_admin');
});
const gucMutations = {
  'nine rows': [bootstrapRows().slice(1), 'GUC_CARDINALITY'],
  'eleven rows': [[...bootstrapRows(), row('supautils.superuser', 'x')], 'GUC_CARDINALITY'],
  'duplicate name': [bootstrapRows().map((value, index) => index === 1 ? bootstrapRows()[0] : value), 'GUC_ORDER'],
  'out of order': [[bootstrapRows()[1], bootstrapRows()[0], ...bootstrapRows().slice(2)], 'GUC_ORDER'],
  'unknown name': [bootstrapRows().map((value, index) => index === 0 ? { ...value, name: 'log_statement' } : value), 'GUC_NAME'],
  'extra key': [edit('dynamic_library_path', { boot_val: '$libdir' }), 'GUC_SHAPE'],
  'null setting': [edit('dynamic_library_path', { setting: null }), 'GUC_SETTING_TYPE'],
  'numeric setting': [edit('dynamic_library_path', { setting: 1 }), 'GUC_SETTING_TYPE'],
  'pending restart': [edit('shared_preload_libraries', { pending_restart: true }), 'GUC_PENDING_RESTART'],
  'pending restart string': [edit('shared_preload_libraries', { pending_restart: 'f' }), 'GUC_PENDING_RESTART'],
  'relative sourcefile': [edit('supautils.superuser', { sourcefile: 'supautils.conf' }), 'GUC_SOURCE_LOCATION'],
  'zero sourceline': [edit('supautils.superuser', { sourceline: 0 }), 'GUC_SOURCE_LOCATION'],
  'sourcefile with newline': [edit('supautils.superuser', { sourcefile: '/a\nb' }), 'GUC_SOURCE_LOCATION'],
  'default with sourcefile': [edit('dynamic_library_path', { sourcefile: '/x', sourceline: 1 }), 'GUC_SOURCE_LOCATION'],
  'probe reserved': [edit('supautils.reserved_roles', { setting: 'synthetic_admin,regress_r3_probe' }), 'FIXTURE_ROLE_RESERVED'],
  'target reserved with blanks': [edit('supautils.reserved_roles', { setting: ' regress_r3_target ' }), 'FIXTURE_ROLE_RESERVED'],
  'target reserved membership': [edit('supautils.reserved_memberships', { setting: 'regress_r3_target' }), 'FIXTURE_ROLE_RESERVED'],
  'probe reserved membership': [edit('supautils.reserved_memberships', { setting: 'synthetic_member, regress_r3_probe' }), 'FIXTURE_ROLE_RESERVED'],
  'quoted reserved': [edit('supautils.reserved_roles', { setting: '"regress_r3_probe"' }), 'RICH_IDENTIFIER_SYNTAX'],
  'uppercase reserved': [edit('supautils.reserved_roles', { setting: 'REGRESS_R3_PROBE' }), 'RICH_IDENTIFIER_SYNTAX'],
  'wildcard reserved': [edit('supautils.reserved_memberships', { setting: 'regress_r3_*' }), 'FIXTURE_ROLE_RESERVED'],
  'short wildcard reserved': [edit('supautils.reserved_roles', { setting: 'regress*' }), 'FIXTURE_ROLE_RESERVED'],
  'inner wildcard refused': [edit('supautils.reserved_roles', { setting: 're*gress' }), 'RICH_IDENTIFIER_SYNTAX'],
  'probe superuser': [bootstrapRows().map(value => value.name.endsWith('superuser') ? { ...value, setting: 'regress_r3_probe' } : value), 'FIXTURE_ROLE_PRIVILEGED'],
  'target privileged role': [edit('supautils.privileged_role', { setting: 'regress_r3_target' }), 'FIXTURE_ROLE_PRIVILEGED'],
  'superuser alias mismatch': [edit('supautils.superuser', { setting: 'other_admin' }), 'SUPERUSER_ALIAS_MISMATCH'],
  'supautils not preloaded': [edit('shared_preload_libraries', { setting: 'pg_stat_statements' }), 'SUPAUTILS_NOT_PRELOADED_ONCE'],
  'supautils preloaded twice': [edit('shared_preload_libraries', { setting: 'supautils, $libdir/supautils' }), 'SUPAUTILS_NOT_PRELOADED_ONCE'],
  'quoted preload': [edit('shared_preload_libraries', { setting: '"supautils"' }), 'PRELOAD_SYNTAX'],
  'oversized rows': [edit('supautils.privileged_role_allowed_configs', { setting: 'x'.repeat(4096) }).map(value =>
    value.name === 'dynamic_library_path' || value.name.startsWith('session') ? { ...value, setting: 'y'.repeat(4096) } : value)
    .map(value => value.name === 'local_preload_libraries' ? { ...value, setting: 'z'.repeat(4096) } : value), 'GUC_SIZE'],
};
for (const source of ['session', 'user', 'database', 'database user', 'client', 'global', 'override', 'environment variable', 'interactive', 'test']) {
  gucMutations['source ' + source] = [edit('supautils.reserved_roles', { source, sourcefile: null, sourceline: null }), 'GUC_SOURCE'];
}
for (const [name, [rows, expectedCode]] of Object.entries(gucMutations)) {
  test('bootstrap GUC rows refused: ' + name, () => {
    assert.throws(() => validateGucRows(rows, { context: 'bootstrap' }), code(expectedCode));
  });
}
test('GUC rows reject accessor/prototype tricks and bad contexts', () => {
  const getterRow = bootstrapRows();
  let reads = 0;
  getterRow[8] = Object.defineProperty({ ...getterRow[8] }, 'setting', { enumerable: true, get: () => (reads++ ? 'regress_r3_probe' : 'synthetic_admin') });
  assert.throws(() => validateGucRows(getterRow, { context: 'bootstrap' }), code('GUC_SHAPE'));
  const protoRow = bootstrapRows(); protoRow[0] = Object.assign(Object.create({ inherited: 1 }), protoRow[0]);
  assert.throws(() => validateGucRows(protoRow, { context: 'bootstrap' }), code('GUC_SHAPE'));
  for (const context of [undefined, 'superuser', 'Lane']) assert.throws(() => validateGucRows(bootstrapRows(), { context }), code('GUC_CONTEXT'));
  assert.throws(() => validateGucRows('rows', { context: 'lane' }), code('GUC_CARDINALITY'));
});
test('lane rows: subset allowed, file locations refused', () => {
  const lane = laneRows(bootstrapRows());
  assert.equal(validateGucRows(lane, { context: 'lane' }).context, 'lane');
  assert.equal(validateGucRows([], { context: 'lane' }).names.length, 0);
  const visible = lane.map(value => value.name === 'supautils.superuser' ? { ...value, sourcefile: '/synthetic/supautils.conf', sourceline: 1 } : value);
  assert.throws(() => validateGucRows(visible, { context: 'lane' }), code('LANE_SOURCE_VISIBILITY'));
});
test('lane comparison detects overrides and visibility mismatches', () => {
  const base = bootstrapRows(), lane = laneRows(base), visibleNames = lane.map(value => value.name);
  assert.equal(compareLaneGucs(base, lane, { visibleNames }), true);
  const overridden = lane.map(value => value.name === 'supautils.reserved_roles' ? { ...value, setting: 'synthetic_admin' } : value);
  assert.throws(() => compareLaneGucs(base, overridden, { visibleNames }), code('LANE_OVERRIDE'));
  const resourced = lane.map(value => value.name === 'local_preload_libraries' ? { ...value, source: 'command line' } : value);
  assert.throws(() => compareLaneGucs(base, resourced, { visibleNames }), code('LANE_OVERRIDE'));
  assert.throws(() => compareLaneGucs(base, lane.slice(1), { visibleNames }), code('LANE_VISIBILITY_MISMATCH'));
  assert.throws(() => compareLaneGucs(base, lane, {}), code('LANE_VISIBILITY_MISMATCH'));
  assert.throws(() => compareLaneGucs(base, lane, { visibleNames: [...visibleNames, 'log_statement'] }), code('LANE_VISIBILITY_MISMATCH'));
});
test('expectation must be the independently bound full configuration', () => {
  const base = bootstrapRows();
  assert.equal(validateGucExpectation(base, expected(base)), true);
  const missing = expected(base); delete missing['supautils.reserved_roles'];
  assert.throws(() => validateGucExpectation(base, missing), code('EXPECTED_CONFIG_BINDING'));
  assert.throws(() => validateGucExpectation(base, { ...expected(base), extra: { setting: '', source: 'default' } }), code('EXPECTED_CONFIG_BINDING'));
  assert.throws(() => validateGucExpectation(base, undefined), code('EXPECTED_CONFIG_BINDING'));
  const wrongSetting = expected(base); wrongSetting['supautils.reserved_roles'] = { setting: 'synthetic_admin', source: 'configuration file' };
  assert.throws(() => validateGucExpectation(base, wrongSetting), code('GUC_EXPECTATION_MISMATCH:supautils.reserved_roles'));
  const wrongSource = expected(base); wrongSource.dynamic_library_path = { setting: '$libdir', source: 'configuration file' };
  assert.throws(() => validateGucExpectation(base, wrongSource), code('GUC_EXPECTATION_MISMATCH:dynamic_library_path'));
  const extraField = expected(base); extraField.dynamic_library_path = { setting: '$libdir', source: 'default', sourcefile: null };
  assert.throws(() => validateGucExpectation(base, extraField), code('GUC_EXPECTATION_MISMATCH:dynamic_library_path'));
});
test('full GUC fixture validation: consistent, drift and lane-set refusals', () => {
  const base = bootstrapRows(), lane = laneRows(base), visibleNames = lane.map(value => value.name);
  const input = { bootstrapBefore: base, bootstrapAfter: bootstrapRows(), lanes: { A: lane, B: lane, C: lane }, expected: expected(base), visibleNames };
  const result = validateGucFixture(input);
  assert.equal(result.status, 'GUC_FIXTURE_CONSISTENT'); assert.equal(result.setup_sha256, SETUP_SHA256);
  const drifted = bootstrapRows().map(value => value.name === 'supautils.superuser' ? { ...value, sourceline: 9 } : value);
  assert.throws(() => validateGucFixture({ ...input, bootstrapAfter: drifted }), code('GUC_DRIFT'));
  assert.throws(() => validateGucFixture({ ...input, lanes: { A: lane, B: lane } }), code('LANE_SET'));
  assert.throws(() => validateGucFixture({ ...input, lanes: { A: lane, B: lane, C: lane, D: lane } }), code('LANE_SET'));
  assert.throws(() => validateGucFixture({}), code('GUC_CARDINALITY'));
});

// db-candidate05 amendment A1: the pinned image's own reserved lists (supautils.conf 06cb09b9…) parse, and
// their prefix wildcards do not cover the fixture roles.
test('A1: image reserved_roles with trailing-* prefixes parses and does not cover the fixture', () => {
  const image = 'supabase_admin, supabase_auth_admin, supabase_storage_admin, supabase_read_only_user, supabase_realtime_admin, supabase_replication_admin, supabase_etl_admin, dashboard_user, pgbouncer, service_role*, authenticator*, authenticated*, anon*, supabase_privileged_role';
  const list = parseSimpleRoleList(image);
  assert.equal(list.length, 14);
  assert.ok(list.includes('service_role*') && list.includes('anon*'));
  assert.equal(rolePatternMatches('service_role*', 'service_role_x'), true);
  assert.equal(rolePatternMatches('service_role*', 'regress_r3_probe'), false);
  assert.equal(rolePatternMatches('regress_r3', 'regress_r3_probe'), false);
  assert.equal(rolePatternMatches('regress*', 'regress_r3_target'), true);
});
