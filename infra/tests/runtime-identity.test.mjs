import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRuntimeIdentity } from '../scripts/runtime-identity.mjs';

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
