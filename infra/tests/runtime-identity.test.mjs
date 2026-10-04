import test from 'node:test';
import assert from 'node:assert/strict';
import { run, verifyRuntimeIdentity } from '../scripts/runtime-identity.mjs';

test('privilege evidence requires both actual session identities to be runtime', async () => {
  const runtime = { current_user: 'tonyai_runtime', session_user: 'tonyai_runtime' };
  const queries = [];
  assert.deepEqual(await verifyRuntimeIdentity(async (sql) => { queries.push(sql); return [runtime]; }), runtime);
  assert.deepEqual(queries, ['SELECT current_user, session_user']);
  for (const rows of [[], [{ ...runtime, current_user: 'postgres' }], [{ ...runtime, session_user: 'postgres' }]]) {
    await assert.rejects(verifyRuntimeIdentity(async () => rows), /must both be tonyai_runtime/);
  }
  await assert.rejects(verifyRuntimeIdentity(async () => { throw new Error('login refused'); }), /login refused/);
});

test('runner uses only DATABASE_URL and prints PASS after checking and disconnecting', async () => {
  const env = { DATABASE_URL: 'synthetic-runtime-url', DIRECT_URL: 'synthetic-owner-url' };
  const events = [];
  await run(env, async (options) => {
    assert.deepEqual(options, { datasourceUrl: env.DATABASE_URL, log: [] });
    return {
      $queryRawUnsafe: async (sql) => {
        events.push(sql);
        return [{ current_user: 'tonyai_runtime', session_user: 'tonyai_runtime' }];
      },
      $disconnect: async () => { events.push('disconnect'); },
    };
  }, (message) => { events.push(message); });
  assert.deepEqual(events, [
    'SELECT current_user, session_user', 'disconnect',
    'PASS: current_user=tonyai_runtime; session_user=tonyai_runtime',
  ]);
});

test('runner never prints PASS for a refused identity, failed query or failed disconnect', async () => {
  for (const defect of ['owner', 'query', 'disconnect']) {
    const messages = [];
    let disconnected = false;
    await assert.rejects(run({ DATABASE_URL: 'synthetic-runtime-url' }, () => ({
      $queryRawUnsafe: async () => {
        if (defect === 'query') throw new Error('synthetic query failure');
        return [{ current_user: defect === 'owner' ? 'postgres' : 'tonyai_runtime', session_user: 'tonyai_runtime' }];
      },
      $disconnect: async () => {
        disconnected = true;
        if (defect === 'disconnect') throw new Error('synthetic disconnect failure');
      },
    }), (message) => { messages.push(message); }));
    assert.equal(disconnected, true, defect);
    assert.deepEqual(messages, [], defect);
  }
});

test('runner refuses missing DATABASE_URL even when DIRECT_URL is present', async () => {
  let constructed = false;
  const messages = [];
  await assert.rejects(run({ DIRECT_URL: 'synthetic-owner-url' }, () => {
    constructed = true;
  }, (message) => { messages.push(message); }), /DATABASE_URL is required/);
  assert.equal(constructed, false);
  assert.deepEqual(messages, []);
});
