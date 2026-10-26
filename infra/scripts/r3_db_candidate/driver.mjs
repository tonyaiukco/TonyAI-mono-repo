// Private preparation core. No CLI, imports of Prisma, client construction, or execution authority.
// db-candidate02 amendment of db-candidate01/driver.mjs (sha256 87a3cfb4ae4fc58ef335aa80f336161109b1faa5a8ed3eb9ce54755f9920492c):
// injected in-transaction attestation for baseline B/A and fresh C, lane GUC read, LIMIT 2 / LIMIT 1,
// application-call bound <= 256 and record-archive bound <= 4 MiB.
import { createHash } from 'node:crypto';
import { GUC_QUERY, validateGucRows } from './fixture-sql.mjs';

export const MATRIX = Object.freeze([
  ['grant-current', 'GRANT regress_r3_target TO CURRENT_USER;', '42501'],
  ['revoke-current', 'REVOKE regress_r3_target FROM CURRENT_USER;', '42501'],
  ['grant-session', 'GRANT regress_r3_target TO SESSION_USER;', '42501'],
  ['revoke-session', 'REVOKE regress_r3_target FROM SESSION_USER;', '42501'],
  ['grant-public', 'GRANT regress_r3_target TO PUBLIC;', '42704'],
  ['revoke-public', 'REVOKE regress_r3_target FROM PUBLIC;', '42704'],
].map(Object.freeze));
export const CONTROLS = Object.freeze([
  ['grant-named-control', 'GRANT regress_r3_target TO regress_r3_probe;', '42501'],
  ['revoke-named-control', 'REVOKE regress_r3_target FROM regress_r3_probe;', '42501'],
].map(Object.freeze));
export const SQL = Object.freeze({
  statement: "SET LOCAL statement_timeout = '3s'",
  lock: "SET LOCAL lock_timeout = '1s'",
  timezone: "SET LOCAL TIME ZONE 'UTC'",
  create: 'CREATE TEMP TABLE r3_session_sentinel (nonce text NOT NULL) ON COMMIT DROP',
  insert: 'INSERT INTO pg_temp.r3_session_sentinel (nonce) VALUES ($1)',
  identity: `SELECT pg_backend_pid()::int AS pid,
    (SELECT backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS backend_start,
    pg_postmaster_start_time()::text AS postmaster_start,
    current_user::text AS current_user, session_user::text AS session_user,
    current_database()::text AS database_name,
    current_setting('server_version_num') AS server_version_num,
    current_setting('transaction_read_only') AS transaction_read_only,
    nonce, 1::int AS positive FROM pg_temp.r3_session_sentinel LIMIT 2`,
  roles: `SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb,
    rolreplication, rolbypassrls, rolinherit FROM pg_roles
    WHERE rolname IN ('regress_r3_probe', 'regress_r3_target') ORDER BY rolname`,
  members: `SELECT roleid::int, member::int, grantor::int, admin_option, inherit_option, set_option
    FROM pg_auth_members WHERE roleid IN
      (SELECT oid FROM pg_roles WHERE rolname IN ('regress_r3_probe', 'regress_r3_target'))
    OR member IN (SELECT oid FROM pg_roles WHERE rolname IN ('regress_r3_probe', 'regress_r3_target'))
    ORDER BY roleid, member, grantor LIMIT 1`,
  gucs: GUC_QUERY,
  savepoint: 'SAVEPOINT r3_probe', rollback: 'ROLLBACK TO SAVEPOINT r3_probe', release: 'RELEASE SAVEPOINT r3_probe',
});
const sha = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function requireValue(value, code) { if (!value) throw new Refusal(code); }
class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
function safeFailure(error) {
  return error instanceof Refusal ? error.code : 'DRIVER_OR_CALLBACK_FAILURE';
}
export const BOUNDS = Object.freeze({ calls: 256, records: 256, recordBytes: 16384, archiveBytes: 4 * 1024 * 1024 });
const ATTESTATION_PHASE = Object.freeze({ A: 'baseline-A', B: 'baseline-B', C: 'fresh-C' });
function sqlstate(error) {
  return error?.name === 'PrismaClientKnownRequestError' && error.code === 'P2010' &&
    typeof error.meta?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.meta.code)
    ? error.meta.code : null;
}
const options = milliseconds => ({ maxWait: 5000, timeout: milliseconds, isolationLevel: 'ReadCommitted' });
const identityKeys = ['pid', 'backend_start', 'postmaster_start', 'current_user', 'session_user',
  'database_name', 'server_version_num', 'transaction_read_only', 'nonce', 'positive'];

// Adapters expose interactive(callback, options), disconnect only. tx exposes query/execute.
// The future live adapter must verify approval, isolated runtime, source and private credentials first.
export async function runCandidate({ a, b, createFreshC, expectedDatabase, nonces, record, attest }) {
  requireValue(typeof expectedDatabase === 'string' && /^[A-Za-z0-9_]{1,63}$/.test(expectedDatabase), 'DATABASE_BINDING');
  requireValue(Array.isArray(nonces) && nonces.length === 3 && new Set(nonces).size === 3 &&
    nonces.every(value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)), 'NONCE_BINDING');
  requireValue(a && b && a !== b && typeof record === 'function' && typeof createFreshC === 'function', 'ADAPTER_BINDING');
  requireValue(typeof attest === 'function', 'ATTESTATION_BINDING');
  let c, phase = 'start', sequence = 0, calls = 0, archiveBytes = 0;
  const attested = { A: 0, B: 0, C: 0 };
  const entered = { A: 0, B: 0, C: 0 }, completed = { A: 0, B: 0, C: 0 };
  const acknowledged = { A: false, B: false, C: false };
  let fixtureVerified = false, postCommitFixtureVerified = false, finalBVerified = false;
  const enter = name => requireValue(++entered[name] === 1, 'REPEATED_TRANSACTION_CALLBACK');
  const result = { status: 'PARTIAL_REVIEW_REQUIRED', historical_status: 'NOT_REPRODUCED',
    qualification: false, installation_success: false, cases: [], failure: null, cleanup_failures: [],
    required_external_evidence: ['runtime-source-loaded-binary', 'supautils-configuration', 'server-log-interval', 'encrypted-custody'] };
  async function emit(kind, data) {
    sequence += 1;
    requireValue(sequence <= 256, 'RECORD_BOUND');
    const event = { sequence, kind, data: copy(data) };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    requireValue(bytes <= BOUNDS.recordBytes, 'RECORD_SIZE');
    archiveBytes += bytes;
    requireValue(archiveBytes <= BOUNDS.archiveBytes, 'RECORD_ARCHIVE_BOUND');
    await record(event);
  }
  // Every application SQL call goes through this bound; the adapter still enforces the SQL allowlist.
  const bounded = tx => Object.freeze({
    query: async (...args) => { requireValue(++calls <= BOUNDS.calls, 'CALL_BOUND'); return tx.query(...args); },
    execute: async (...args) => { requireValue(++calls <= BOUNDS.calls, 'CALL_BOUND'); return tx.execute(...args); },
  });
  // Runs inside the lane's open transaction, before any stimulus for A/B; inspection after close is impossible.
  async function attestation(lane, tx, nonce, identity) {
    const gucs = await tx.query(SQL.gucs);
    try { validateGucRows(gucs, { context: 'lane' }); } catch { throw new Refusal('LANE_GUC_' + lane); }
    const snapshot = copy({ lane, phase: ATTESTATION_PHASE[lane], identity, gucs });
    await emit('attestation-' + lane, snapshot);
    let accepted;
    try { accepted = await attest(Object.freeze(snapshot)); } catch { throw new Refusal('ATTESTATION_FAILURE'); }
    requireValue(accepted === true, 'ATTESTATION_REFUSED');
    requireValue(++attested[lane] === 1, 'REPEATED_ATTESTATION');
    return control(tx, nonce, identity);
  }
  async function control(tx, nonce, baseline = null) {
    const rows = await tx.query(SQL.identity);
    requireValue(Array.isArray(rows) && rows.length === 1, 'SENTINEL_CARDINALITY');
    const value = rows[0];
    requireValue(value && same(Object.keys(value).sort(), [...identityKeys].sort()), 'IDENTITY_SHAPE');
    requireValue(Number.isSafeInteger(value.pid) && value.pid > 0 && value.positive === 1 &&
      value.current_user === 'regress_r3_probe' && value.session_user === 'regress_r3_probe' &&
      value.database_name === expectedDatabase && value.server_version_num === '170011' &&
      value.transaction_read_only === 'off' && value.nonce === nonce &&
      ['backend_start', 'postmaster_start'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 80),
      'IDENTITY_OR_POSITIVE_CONTROL');
    if (baseline) requireValue(same(value, baseline), 'CONNECTION_CHANGED');
    return copy(value);
  }
  async function initialize(tx, nonce) {
    for (const key of ['statement', 'lock', 'timezone', 'create']) await tx.execute(SQL[key]);
    await tx.execute(SQL.insert, nonce);
    return control(tx, nonce);
  }
  async function fixture(tx) {
    const roles = await tx.query(SQL.roles), members = await tx.query(SQL.members);
    requireValue(Array.isArray(roles) && roles.length === 2 && Array.isArray(members) && members.length === 0, 'ROLE_FIXTURE');
    for (const [index, name] of ['regress_r3_probe', 'regress_r3_target'].entries()) {
      const role = roles[index];
      requireValue(role && same(Object.keys(role).sort(), ['rolname', 'rolcanlogin', 'rolsuper', 'rolcreaterole',
        'rolcreatedb', 'rolreplication', 'rolbypassrls', 'rolinherit'].sort()) &&
        role.rolname === name && role.rolcanlogin === (index === 0) &&
        ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls', 'rolinherit'].every(key => role[key] === false), 'ROLE_PRIVILEGE');
    }
    return copy({ roles, members });
  }
  try {
    await b.interactive(async rawB => {
      enter('B'); const txB = bounded(rawB);
      phase = 'initialize-B'; const idB = await initialize(txB, nonces[1]);
      phase = 'attest-B'; await attestation('B', txB, nonces[1], idB);
      const fixtureBefore = await fixture(txB); await emit('baseline-B', { identity: idB, fixture: fixtureBefore });
      await a.interactive(async rawA => {
        enter('A'); const txA = bounded(rawA);
        phase = 'initialize-A'; const idA = await initialize(txA, nonces[0]);
        requireValue(idA.pid !== idB.pid && idA.postmaster_start === idB.postmaster_start, 'INDEPENDENT_A_B');
        await emit('baseline-A', idA);
        phase = 'attest-A'; await attestation('A', txA, nonces[0], idA);
        const sequenceCases = [...CONTROLS.map(value => [value, 1]),
          ...MATRIX.flatMap(value => [1, 2, 3].map(repetition => [value, repetition]))];
        for (const [[id, statement, expected], repetition] of sequenceCases) {
          phase = 'before-' + id;
          const beforeA = await control(txA, nonces[0], idA), beforeB = await control(txB, nonces[1], idB);
          await emit('before', { id, repetition, A: beforeA, B: beforeB });
          await txA.execute(SQL.savepoint);
          const item = { id, repetition, statement_sha256: sha(statement), expected_sqlstate: expected,
            observed_sqlstate: null, unexpected_success: false, recovery_failure: null, controls_passed: false };
          phase = 'stimulus-' + id;
          try { await txA.execute(statement); item.unexpected_success = true; }
          catch (error) { item.observed_sqlstate = sqlstate(error); }
          // Always roll back even an unexpectedly accepted mutation before refusing the candidate.
          try { await txA.execute(SQL.rollback); await txA.execute(SQL.release); }
          catch { item.recovery_failure = 'SAVEPOINT_RECOVERY_FAILED'; }
          result.cases.push(item); await emit('outcome', item);
          requireValue(item.recovery_failure === null, 'SAVEPOINT_RECOVERY_FAILED');
          requireValue(!item.unexpected_success && item.observed_sqlstate === expected, 'STATEMENT_OUTCOME');
          phase = 'after-' + id;
          const afterA = await control(txA, nonces[0], idA), afterB = await control(txB, nonces[1], idB);
          item.controls_passed = true;
          await emit('after', { id, repetition, A: afterA, B: afterB });
        }
        phase = 'fresh-C'; const candidateC = await createFreshC();
        requireValue(candidateC && candidateC !== a && candidateC !== b, 'FRESH_C_ADAPTER');
        c = candidateC;
        await c.interactive(async rawC => {
          enter('C'); const txC = bounded(rawC);
          const idC = await initialize(txC, nonces[2]);
          requireValue(idC.pid !== idA.pid && idC.pid !== idB.pid && idC.postmaster_start === idA.postmaster_start, 'INDEPENDENT_C');
          await emit('fresh-C', idC);
          phase = 'attest-C'; await attestation('C', txC, nonces[2], idC); completed.C++;
        }, options(10000));
        requireValue(completed.C === 1, 'MISSING_C_CALLBACK'); acknowledged.C = true;
        await control(txA, nonces[0], idA); await control(txB, nonces[1], idB);
        const fixtureAfter = await fixture(txB);
        requireValue(same(fixtureAfter, fixtureBefore), 'ROLE_EFFECT_DRIFT');
        await emit('fixture-after', fixtureAfter); fixtureVerified = true; completed.A++;
      }, options(60000));
      requireValue(completed.A === 1, 'MISSING_A_CALLBACK'); acknowledged.A = true;
      phase = 'final-B'; await control(txB, nonces[1], idB); finalBVerified = true;
      const persistedFixture = await fixture(txB);
      requireValue(same(persistedFixture, fixtureBefore), 'POST_COMMIT_ROLE_EFFECT_DRIFT');
      await emit('fixture-after-A-commit', persistedFixture); postCommitFixtureVerified = true; completed.B++;
    }, options(90000));
    requireValue(completed.B === 1, 'MISSING_B_CALLBACK'); acknowledged.B = true;
    const expectedOrder = [...CONTROLS.map(value => [value, 1]),
      ...MATRIX.flatMap(value => [1, 2, 3].map(repetition => [value, repetition]))];
    requireValue(['A', 'B', 'C'].every(name => entered[name] === 1 && completed[name] === 1 && acknowledged[name] && attested[name] === 1) &&
      fixtureVerified && postCommitFixtureVerified && finalBVerified && result.cases.length === expectedOrder.length &&
      result.cases.every((item, index) => {
        const [[id, statement, expected], repetition] = expectedOrder[index];
        return item.id === id && item.repetition === repetition && item.statement_sha256 === sha(statement) &&
          item.expected_sqlstate === expected && item.observed_sqlstate === expected && item.controls_passed === true &&
          item.unexpected_success === false && item.recovery_failure === null;
      }), 'INCOMPLETE_EXECUTION');
    result.status = 'CANDIDATE_CLIENT_CHECKS_COMPLETED_REVIEW_REQUIRED';
  } catch (error) {
    result.failure = { phase, code: safeFailure(error) };
  } finally {
    // Cleanup cannot change a failure to success; errors are redacted and retained.
    for (const [name, client] of [['C', c], ['A', a], ['B', b]]) {
      if (!client) continue;
      try { await client.disconnect(); } catch { result.cleanup_failures.push(name); }
    }
    if (result.cleanup_failures.length) result.status = 'PARTIAL_REVIEW_REQUIRED';
  }
  await emit('result', result);
  return result;
}
