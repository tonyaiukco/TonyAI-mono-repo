// db-candidate02: tests for the plan-01 section 3 driver/adapter amendments. Injected fakes only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MATRIX, CONTROLS, SQL, BOUNDS, runCandidate } from '../scripts/r3_db_candidate/driver.mjs';
import { wrapCandidatePrisma } from '../scripts/r3_db_candidate/prisma-adapter.mjs';
import { GUC_QUERY } from '../scripts/r3_db_candidate/fixture-sql.mjs';
import * as original from './r3_db_candidate01_driver.mjs';

const nonces = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
const stimuli = new Set([...CONTROLS, ...MATRIX].map(row => row[1]));
const laneRow = (name, setting, source = 'configuration file') =>
  ({ name, setting, source, sourcefile: null, sourceline: null, pending_restart: false });
const goodGucs = () => [laneRow('local_preload_libraries', '', 'default'), laneRow('supautils.reserved_roles', 'synthetic_reserved')];

function harness(change = {}) {
  const trace = [], records = [], attestations = [], active = new Set();
  let grants = 0, calls = 0;
  const states = Object.fromEntries(['A', 'B', 'C'].map((name, index) => [name, {
    pid: 200 + index, backend_start: '2026-10-25 00:00:00+00', postmaster_start: '2026-10-24 23:00:00+00',
    current_user: 'regress_r3_probe', session_user: 'regress_r3_probe', database_name: 'regress_r3_candidate',
    server_version_num: '170011', transaction_read_only: 'off', nonce: nonces[index], positive: 1,
  }]));
  const roles = ['regress_r3_probe', 'regress_r3_target'].map((rolname, index) => ({ rolname, rolcanlogin: index === 0,
    rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolinherit: false }));
  const clients = Object.fromEntries(['A', 'B', 'C'].map(name => [name, {
    async interactive(callback) {
      active.add(name); trace.push([name, 'begin']);
      try {
        const value = await callback({
          async execute(sql, ..._parameters) {
            calls++; trace.push([name, 'execute', sql]);
            if (stimuli.has(sql)) { grants++; throw { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: [...CONTROLS, ...MATRIX].find(row => row[1] === sql)[2] } }; }
            return sql === SQL.insert ? 1 : 0;
          },
          async query(sql) {
            calls++; trace.push([name, 'query', sql]);
            if (sql === SQL.gucs) return change.gucs ? change.gucs(name) : goodGucs();
            if (sql === SQL.roles) return structuredClone(roles);
            if (sql === SQL.members) return [];
            assert.equal(sql, SQL.identity);
            const state = structuredClone(states[name]);
            if (change.identity) return change.identity({ name, state, trace });
            return [state];
          },
        });
        trace.push([name, 'commit']); return value;
      } finally { active.delete(name); }
    },
    async disconnect() { trace.push([name, 'disconnect']); },
  }]));
  const input = {
    a: clients.A, b: clients.B, expectedDatabase: 'regress_r3_candidate', nonces,
    createFreshC: async () => clients.C,
    record: async value => { records.push(structuredClone(value)); },
    attest: async snapshot => {
      attestations.push({ snapshot, active: [...active].sort(), grants, frozen: Object.isFrozen(snapshot) });
      return change.attest ? change.attest(snapshot) : true;
    },
  };
  return { run: () => runCandidate(input), input, trace, records, attestations, grants: () => grants, calls: () => calls };
}

test('amended SQL differs from db-candidate01 only by the LIMIT suffixes and the new GUC query', () => {
  assert.equal(SQL.identity, original.SQL.identity + ' LIMIT 2');
  assert.equal(SQL.members, original.SQL.members + ' LIMIT 1');
  assert.equal(SQL.gucs, GUC_QUERY);
  const unchanged = Object.keys(original.SQL).filter(key => !['identity', 'members'].includes(key));
  for (const key of unchanged) assert.equal(SQL[key], original.SQL[key]);
  assert.deepEqual(Object.keys(SQL).sort(), [...Object.keys(original.SQL), 'gucs'].sort());
  assert.deepEqual(MATRIX, original.MATRIX); assert.deepEqual(CONTROLS, original.CONTROLS);
  assert.ok(Object.isFrozen(BOUNDS));
  assert.deepEqual({ ...BOUNDS }, { calls: 256, records: 256, recordBytes: 16384, archiveBytes: 4194304 });
});

test('success path attests B, A, C inside live transactions before stimuli and stays within bounds', async () => {
  const h = harness(), result = await h.run();
  assert.equal(result.status, 'CANDIDATE_CLIENT_CHECKS_COMPLETED_REVIEW_REQUIRED');
  assert.equal(result.historical_status, 'NOT_REPRODUCED'); assert.equal(result.qualification, false);
  assert.deepEqual(h.attestations.map(value => value.snapshot.lane), ['B', 'A', 'C']);
  assert.deepEqual(h.attestations.map(value => value.snapshot.phase), ['baseline-B', 'baseline-A', 'fresh-C']);
  assert.deepEqual(h.attestations.map(value => value.active), [['B'], ['A', 'B'], ['A', 'B', 'C']]);
  assert.deepEqual(h.attestations.map(value => value.grants), [0, 0, 20]);
  assert.ok(h.attestations.every(value => value.frozen));
  assert.deepEqual(h.attestations.map(value => value.snapshot.identity.pid), [201, 200, 202]);
  for (const value of h.attestations) assert.deepEqual(Object.keys(value.snapshot).sort(), ['gucs', 'identity', 'lane', 'phase']);
  // 187 pre-amendment direct calls + 3 lane GUC reads + 3 post-attestation continuity controls.
  assert.equal(h.calls(), 193); assert.ok(h.calls() <= BOUNDS.calls);
  assert.equal(h.trace.filter(value => value[2] === SQL.gucs).length, 3);
  const kinds = h.records.map(value => value.kind);
  assert.deepEqual(kinds.slice(0, 5), ['attestation-B', 'baseline-B', 'baseline-A', 'attestation-A', 'before']);
  assert.ok(kinds.indexOf('attestation-C') === kinds.indexOf('fresh-C') + 1 && kinds.indexOf('attestation-C') < kinds.indexOf('fixture-after'));
  assert.ok(h.records.length <= BOUNDS.records);
  const archive = h.records.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
  assert.ok(archive <= BOUNDS.archiveBytes);
});

for (const lane of ['B', 'A', 'C']) {
  for (const verdict of [false, 'true', 1, {}, undefined, null, [true]]) {
    test(`attestation verdict ${JSON.stringify(verdict) ?? 'undefined'} on ${lane} refuses`, async () => {
      const h = harness({ attest: snapshot => snapshot.lane === lane ? verdict : true }), result = await h.run();
      assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED');
      assert.deepEqual(result.failure, { phase: 'attest-' + lane, code: 'ATTESTATION_REFUSED' });
      assert.equal(h.grants(), lane === 'C' ? 20 : 0);
    });
  }
  test('attestation exception is redacted and stops the lane: ' + lane, async () => {
    const h = harness({ attest: snapshot => { if (snapshot.lane === lane) throw new Error('private secret marker'); return true; } });
    const result = await h.run();
    assert.equal(result.failure.code, 'ATTESTATION_FAILURE');
    assert.doesNotMatch(JSON.stringify([result, h.records]), /private secret marker/);
    assert.equal(h.grants(), lane === 'C' ? 20 : 0);
  });
}

test('attestation callback receives no transaction or SQL authority', async () => {
  let leaked;
  const h = harness({ attest: snapshot => { leaked = snapshot; return true; } });
  await h.run();
  assert.equal(typeof leaked.query, 'undefined'); assert.equal(typeof leaked.execute, 'undefined');
  assert.throws(() => { leaked.lane = 'A'; }, TypeError);
});

test('missing attestation binding refuses before any transaction', async () => {
  for (const attest of [undefined, null, true, 'attest']) {
    const h = harness(); h.input.attest = attest;
    await assert.rejects(h.run(), /ATTESTATION_BINDING/); assert.equal(h.trace.length, 0);
  }
});

const badLane = {
  'probe reserved': [laneRow('supautils.reserved_roles', 'synthetic_reserved, regress_r3_probe')],
  'target reserved membership': [laneRow('supautils.reserved_memberships', 'regress_r3_target')],
  'quoted reserved entry': [laneRow('supautils.reserved_roles', '"regress_r3_probe"')],
  'wildcard reserved entry': [laneRow('supautils.reserved_roles', 'regress_*')],
  'probe privileged role': [laneRow('supautils.privileged_role', 'regress_r3_probe')],
  'session override source': [laneRow('supautils.reserved_roles', 'synthetic_reserved', 'session')],
  'visible source file': [{ ...laneRow('supautils.reserved_roles', 'x'), sourcefile: '/etc/postgresql-custom/supautils.conf', sourceline: 1 }],
  'pending restart': [{ ...laneRow('supautils.reserved_roles', 'x'), pending_restart: true }],
  'unknown name': [laneRow('log_statement', 'all')],
  'out of order': [laneRow('supautils.superuser', 'supabase_admin'), laneRow('supautils.reserved_roles', 'x')],
  'eleven rows': Array.from({ length: 11 }, () => laneRow('supautils.reserved_roles', 'x')),
  'extra column': [{ ...laneRow('supautils.reserved_roles', 'x'), boot_val: 'x' }],
  'not an array': { rows: [] },
};
for (const [name, rows] of Object.entries(badLane)) {
  test('invalid lane GUC rows refuse before attestation and stimuli: ' + name, async () => {
    const h = harness({ gucs: () => structuredClone(rows) }), result = await h.run();
    assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED');
    assert.deepEqual(result.failure, { phase: 'attest-B', code: 'LANE_GUC_B' });
    assert.equal(h.attestations.length, 0); assert.equal(h.grants(), 0);
  });
}

test('lane C GUC refusal after the matrix is still partial', async () => {
  const h = harness({ gucs: lane => lane === 'C' ? [laneRow('supautils.reserved_roles', 'regress_r3_probe')] : goodGucs() });
  const result = await h.run();
  assert.deepEqual(result.failure, { phase: 'attest-C', code: 'LANE_GUC_C' }); assert.equal(h.grants(), 20);
});

test('connection change across the attestation window refuses', async () => {
  const h = harness({ identity: ({ name, state, trace }) => {
    const attestedB = trace.some(value => value[0] === 'B' && value[2] === SQL.gucs);
    return [name === 'B' && attestedB ? { ...state, backend_start: 'changed' } : state];
  } });
  const result = await h.run();
  assert.deepEqual(result.failure, { phase: 'attest-B', code: 'CONNECTION_CHANGED' }); assert.equal(h.grants(), 0);
});

test('an oversized lane snapshot is refused by the per-record bound', async () => {
  const names = ['dynamic_library_path', 'local_preload_libraries', 'session_preload_libraries', 'supautils.privileged_role_allowed_configs'];
  const rows = names.map(name => laneRow(name, 'a'.repeat(3940)));
  const target = 16384 - 8;
  rows[3].setting += 'a'.repeat(target - Buffer.byteLength(JSON.stringify(rows)));
  assert.equal(Buffer.byteLength(JSON.stringify(rows)), target); assert.ok(rows[3].setting.length <= 4096);
  const h = harness({ gucs: () => structuredClone(rows) }), result = await h.run();
  assert.equal(result.failure.code, 'RECORD_SIZE'); assert.equal(h.attestations.length, 0); assert.equal(h.grants(), 0);
});

test('identity query cardinality is bounded by LIMIT 2 and still refuses duplicates', async () => {
  const h = harness({ identity: ({ state }) => [state, state] }), result = await h.run();
  assert.equal(result.failure.code, 'SENTINEL_CARDINALITY'); assert.equal(h.grants(), 0);
});

// End-to-end through the amended adapter with fake Prisma clients: every SQL string must pass the allowlist.
function prismaFake(lane, log) {
  return {
    $transaction: async (fn, options) => {
      log.push([lane, 'transaction', options]);
      return fn({
        $queryRawUnsafe: async sql => {
          log.push([lane, 'query', sql]);
          if (sql === SQL.gucs) return goodGucs();
          if (sql === SQL.members) return [];
          if (sql === SQL.roles) return ['regress_r3_probe', 'regress_r3_target'].map((rolname, index) => ({ rolname, rolcanlogin: index === 0,
            rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolinherit: false }));
          return [{ pid: 300 + 'ABC'.indexOf(lane), backend_start: 'x', postmaster_start: 'y', current_user: 'regress_r3_probe',
            session_user: 'regress_r3_probe', database_name: 'regress_r3_candidate', server_version_num: '170011',
            transaction_read_only: 'off', nonce: nonces['ABC'.indexOf(lane)], positive: 1 }];
        },
        $executeRawUnsafe: async sql => {
          log.push([lane, 'execute', sql]);
          const row = [...CONTROLS, ...MATRIX].find(value => value[1] === sql);
          if (row) throw { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: row[2] } };
          return 0;
        },
      });
    },
    $disconnect: async () => { log.push([lane, 'disconnect']); },
  };
}
test('driver through the amended adapter completes with only allowlisted SQL and stimuli on A', async () => {
  const log = [], records = [];
  const result = await runCandidate({
    a: wrapCandidatePrisma(prismaFake('A', log), 'A'), b: wrapCandidatePrisma(prismaFake('B', log), 'B'),
    createFreshC: async () => wrapCandidatePrisma(prismaFake('C', log), 'C'),
    expectedDatabase: 'regress_r3_candidate', nonces, record: async value => { records.push(value); }, attest: async () => true,
  });
  assert.equal(result.status, 'CANDIDATE_CLIENT_CHECKS_COMPLETED_REVIEW_REQUIRED');
  assert.equal(log.filter(row => row[2] === SQL.gucs).length, 3);
  assert.ok(log.filter(row => stimuli.has(row[2])).every(row => row[0] === 'A'));
  assert.equal(log.filter(row => stimuli.has(row[2])).length, 20);
  assert.equal(log.filter(row => row[1] === 'query' || row[1] === 'execute').length, 193);
});
