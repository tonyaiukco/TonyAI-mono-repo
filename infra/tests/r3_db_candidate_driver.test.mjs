import assert from 'node:assert/strict';
import test from 'node:test';
import { MATRIX, CONTROLS, SQL, runCandidate } from '../scripts/r3_db_candidate/driver.mjs';

function fixture(change = {}) {
  const trace = [], records = [], active = new Set(), counters = {};
  const nonces = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
  const states = Object.fromEntries(['A', 'B', 'C'].map((name, index) => [name, {
    pid: 100 + index, backend_start: '2026-10-24 18:00:00.123456+00', postmaster_start: '2026-10-24 17:00:00+00',
    current_user: 'regress_r3_probe', session_user: 'regress_r3_probe', database_name: 'r3_fixture',
    server_version_num: '170011', transaction_read_only: 'off', nonce: nonces[index], positive: 1,
  }]));
  const roles = ['regress_r3_probe', 'regress_r3_target'].map((rolname, index) => ({ rolname, rolcanlogin: index === 0,
    rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, rolinherit: false }));
  let grants = 0, factoryCalls = 0;
  // db-candidate02 harness adaptation only: synthetic lane GUC rows (not image configuration) and a passing attestation.
  const laneGucs = [
    { name: 'local_preload_libraries', setting: '', source: 'default', sourcefile: null, sourceline: null, pending_restart: false },
    { name: 'supautils.reserved_roles', setting: 'synthetic_reserved', source: 'configuration file', sourcefile: null, sourceline: null, pending_restart: false },
  ];
  const clients = Object.fromEntries(['A', 'B', 'C'].map(name => [name, {
    async interactive(callback, options) {
      trace.push([name, 'begin', options]); assert.equal(active.has(name), false);
      if (name === 'A') assert.equal(active.has('B'), true);
      if (name === 'C') assert.deepEqual([...active].sort(), ['A', 'B']);
      active.add(name);
      try {
        const value = await callback({
          async execute(sql, ...parameters) {
            assert.equal(active.has(name), true); trace.push([name, 'execute', sql, parameters]);
            if (change.execute) await change.execute({ name, sql, trace, grants });
            if (sql === SQL.insert) { assert.deepEqual(parameters, [states[name].nonce]); return 1; }
            const probe = [...CONTROLS, ...MATRIX].find(value => value[1] === sql);
            if (probe) {
              assert.equal(name, 'A'); grants++;
              if (change.accept && grants === 1) return 0;
              throw change.error ?? { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: probe[2], message: 'private URL secret' } };
            }
            assert.ok(Object.values(SQL).includes(sql)); return 0;
          },
          async query(sql) {
            assert.equal(active.has(name), true); trace.push([name, 'query', sql]);
            if (sql === SQL.roles) {
              const rows = structuredClone(roles); if (change.extraRole) rows[0].unexpected = 'private-marker'.repeat(20000); return rows;
            }
            if (sql === SQL.gucs) return structuredClone(laneGucs);
            if (sql === SQL.members) return (change.members && grants || change.membersAfterCommit && trace.some(value => value[0] === 'A' && value[1] === 'commit')) ? [{ roleid: 1 }] : [];
            assert.equal(sql, SQL.identity); counters[name] = (counters[name] ?? 0) + 1;
            const state = structuredClone(states[name]);
            if (change.identity) return change.identity({ name, state, grants, count: counters[name] });
            return [state];
          },
        });
        trace.push([name, 'commit']); return value;
      } catch (error) { trace.push([name, 'rollback']); throw error; }
      finally { active.delete(name); }
    },
    async disconnect() { trace.push([name, 'disconnect']); if (change.disconnect === name) throw Error('private'); },
  }]));
  const input = { a: clients.A, b: clients.B, expectedDatabase: 'r3_fixture', nonces,
    createFreshC: async () => { factoryCalls++; assert.equal(grants, 20); return change.reuseC ? clients.A : clients.C; },
    record: async value => { records.push(structuredClone(value)); if (change.record) await change.record(value); },
    attest: async () => true,
  };
  return { run: () => runCandidate(input), trace, records, clients, input, grants: () => grants, factories: () => factoryCalls };
}

test('twenty exact refusals, three pinned sessions and acknowledged commit controls', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.status, 'CANDIDATE_CLIENT_CHECKS_COMPLETED_REVIEW_REQUIRED');
  assert.equal(result.historical_status, 'NOT_REPRODUCED'); assert.equal(result.qualification, false);
  assert.equal(f.grants(), 20); assert.equal(f.factories(), 1); assert.equal(result.cases.length, 20);
  assert.ok(result.cases.every(value => value.expected_sqlstate === value.observed_sqlstate && value.controls_passed));
  for (const [id] of MATRIX) assert.equal(result.cases.filter(value => value.id === id).length, 3);
  assert.deepEqual(f.trace.filter(value => value[1] === 'begin').map(value => value[0]), ['B', 'A', 'C']);
  assert.deepEqual(f.trace.filter(value => value[1] === 'commit').map(value => value[0]), ['C', 'A', 'B']);
  assert.equal(f.trace.filter(value => value[2] === SQL.rollback).length, 20);
  assert.equal(f.trace.filter(value => value[2] === SQL.release).length, 20);
  assert.deepEqual(f.records.map(value => value.sequence), f.records.map((_, index) => index + 1));
  assert.doesNotMatch(JSON.stringify(result), /private URL/);
});

for (const error of [Error('EOF private'), { code: 'P2010' }, { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: '25P02' } },
  { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: '25006' } },
  { name: 'PrismaClientKnownRequestError', code: 'P2028', meta: { code: '42501' } }]) {
  test('wrong or unavailable protocol SQLSTATE stops without reconnect or retry: ' + (error.meta?.code ?? error.code ?? error.name), async () => {
    const f = fixture({ error }), result = await f.run();
    assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED'); assert.equal(f.grants(), 1); assert.equal(f.factories(), 0);
    assert.ok(f.trace.some(value => value[2] === SQL.rollback));
    assert.equal(f.trace.filter(value => value[1] === 'begin').length, 2);
  });
}

test('unexpected success is rolled back before refusal and no next statement', async () => {
  const f = fixture({ accept: true }), result = await f.run();
  assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED'); assert.equal(result.cases[0].unexpected_success, true);
  assert.equal(f.grants(), 1); assert.equal(f.factories(), 0);
  const index = f.trace.findIndex(value => value[2] === CONTROLS[0][1]);
  assert.equal(f.trace[index + 1][2], SQL.rollback); assert.equal(f.trace[index + 2][2], SQL.release);
});

for (const key of ['pid', 'backend_start', 'postmaster_start', 'nonce', 'positive', 'current_user', 'database_name', 'server_version_num']) {
  test('A continuity change refuses: ' + key, async () => {
    const f = fixture({ identity: ({ name, state, grants }) => {
      if (name === 'A' && grants) state[key] = key === 'pid' || key === 'positive' ? 999 : 'changed'; return [state];
    } });
    const result = await f.run(); assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED'); assert.equal(f.grants(), 1);
    assert.equal(result.cases[0].controls_passed, false);
  });
}

for (const name of ['A', 'B']) {
  test('missing/duplicated sentinel cannot be repaired: ' + name, async () => {
    for (const duplicated of [false, true]) {
      const f = fixture({ identity: value => value.name === name && value.grants ? (duplicated ? [value.state, value.state] : []) : [value.state] });
      const result = await f.run(); assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED'); assert.equal(f.grants(), 1);
      assert.equal(f.trace.filter(value => value[0] === name && value[2] === SQL.create).length, 1);
    }
  });
}

for (const failing of [SQL.rollback, SQL.release]) {
  test('savepoint recovery failure retains original refusal: ' + failing, async () => {
    const f = fixture({ execute: ({ sql }) => { if (sql === failing) throw Error('private'); } });
    const result = await f.run(); assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED');
    assert.equal(result.cases[0].observed_sqlstate, '42501'); assert.equal(result.cases[0].recovery_failure, 'SAVEPOINT_RECOVERY_FAILED');
    assert.equal(f.grants(), 1); assert.equal(f.factories(), 0);
  });
}

test('fresh C must be a new adapter and backend', async () => {
  for (const change of [{ reuseC: true }, { identity: ({ name, state }) => [{ ...state, pid: name === 'C' ? 100 : state.pid }] }]) {
    const result = await fixture(change).run(); assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED');
  }
});

test('membership drift and disconnect failure cannot complete the candidate', async () => {
  for (const change of [{ members: true }, { disconnect: 'C' }]) {
    const result = await fixture(change).run(); assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED');
  }
});

test('readonly transactions fail before the first role statement', async () => {
  const f = fixture({ identity: ({ state }) => [{ ...state, transaction_read_only: 'on' }] });
  const result = await f.run(); assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED'); assert.equal(f.grants(), 0);
});

test('invalid database/nonce binding cannot open any transaction', async () => {
  for (const key of ['expectedDatabase', 'nonces']) {
    const f = fixture(); f.input[key] = key === 'expectedDatabase' ? 'dbname; injected' : ['a', 'a', 'a'];
    await assert.rejects(f.run); assert.equal(f.trace.length, 0);
  }
});


for (const name of ['A', 'B', 'C']) {
  test('skipped transaction callback cannot complete: ' + name, async () => {
    const f = fixture(); f.clients[name].interactive = async () => undefined;
    const result = await f.run(); assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED');
  });
  test('repeated transaction callback refuses before repeating its SQL: ' + name, async () => {
    const f = fixture(), original = f.clients[name].interactive;
    f.clients[name].interactive = async (callback, options) => original(async tx => {
      await callback(tx); return callback(tx);
    }, options);
    const result = await f.run(); assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED');
    assert.equal(result.failure.code, 'REPEATED_TRANSACTION_CALLBACK');
    assert.equal(f.trace.filter(value => value[0] === name && value[2] === SQL.create).length, 1);
  });
}


test('unknown role fields are rejected before private record emission or stimuli', async () => {
  const f = fixture({ extraRole: true }), result = await f.run();
  assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED'); assert.equal(result.failure.code, 'ROLE_PRIVILEGE');
  assert.equal(f.grants(), 0); assert.doesNotMatch(JSON.stringify(f.records), /private-marker/);
});

test('every emitted record fits the declared private-record cap', async () => {
  const f = fixture(); await f.run();
  assert.ok(f.records.every(value => Buffer.byteLength(JSON.stringify(value)) <= 16384));
});


test('persisted memberships are rechecked after acknowledged A commit', async () => {
  const f = fixture({ membersAfterCommit: true }), result = await f.run();
  assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED'); assert.equal(result.failure.phase, 'final-B');
  assert.equal(f.grants(), 20); assert.ok(f.trace.some(value => value[0] === 'A' && value[1] === 'commit'));
});
