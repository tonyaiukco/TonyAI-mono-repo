import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapCandidatePrisma } from '../scripts/r3_db_candidate/prisma-adapter.mjs';
import { SQL, MATRIX } from '../scripts/r3_db_candidate/driver.mjs';
const opts = lane => ({ maxWait: 5000, timeout: { A: 60000, B: 90000, C: 10000 }[lane], isolationLevel: 'ReadCommitted' });
const fake = (behavior = {}) => {
  const calls = [];
  const tx = {
    $queryRawUnsafe: async (...args) => { calls.push(['query', ...args]); return behavior.query ? behavior.query(...args) : [{ positive: 1 }]; },
    $executeRawUnsafe: async (...args) => { calls.push(['execute', ...args]); return behavior.execute ? behavior.execute(...args) : 1; },
  };
  return { calls, $transaction: async (fn, options) => { calls.push(['transaction', options]); return behavior.transaction ? behavior.transaction(fn, tx) : fn(tx); },
    $disconnect: async () => { calls.push(['disconnect']); if (behavior.disconnect) throw behavior.disconnect; } };
};
test('import and wrapper construction invoke no client methods', () => {
  const client = fake(); const adapter = wrapCandidatePrisma(client, 'A');
  assert.deepEqual(client.calls, []); assert.deepEqual(Object.keys(adapter).sort(), ['disconnect', 'interactive']);
});
test('fixed SQL/parameter and transaction options reach the same tx', async () => {
  const client = fake(), adapter = wrapCandidatePrisma(client, 'A');
  const result = await adapter.interactive(async tx => {
    assert.deepEqual(Object.keys(tx).sort(), ['execute', 'query']);
    await tx.execute(SQL.insert, 'a'.repeat(32)); return tx.query(SQL.identity);
  }, opts('A'));
  assert.deepEqual(result, [{ positive: 1 }]);
  assert.deepEqual(client.calls, [['transaction', opts('A')], ['execute', SQL.insert, 'a'.repeat(32)], ['query', SQL.identity]]);
  await adapter.disconnect();
});
test('SQLSTATE-bearing Prisma error is preserved by identity', async () => {
  const error = Object.assign(new Error('private error'), { code: 'P2010', meta: { code: '42501' } });
  const adapter = wrapCandidatePrisma(fake({ execute: () => { throw error; } }), 'A');
  await adapter.interactive(async tx => { await assert.rejects(tx.execute(MATRIX[0][1]), value => value === error); }, opts('A'));
});
for (const [name, run] of [
  ['arbitrary query', tx => tx.query('SELECT secret')],
  ['query/execute substitution', tx => tx.execute(SQL.identity)],
  ['unexpected parameters', tx => tx.query(SQL.identity, 'secret')],
  ['invalid sentinel', tx => tx.execute(SQL.insert, 'invalid')],
  ['missing sentinel', tx => tx.execute(SQL.insert)],
]) test(name + ' refuses before raw call and poisons caught violation', async () => {
  const client = fake(), adapter = wrapCandidatePrisma(client, 'A');
  await assert.rejects(adapter.interactive(async tx => { await assert.rejects(run(tx)); }, opts('A')), /UNFINISHED_OR_CONCURRENT_CALL/);
  assert.equal(client.calls.length, 1);
});
for (const lane of ['B', 'C']) test(lane + ' cannot issue stimulus', async () => {
  const client = fake(), adapter = wrapCandidatePrisma(client, lane);
  await assert.rejects(adapter.interactive(tx => tx.execute(MATRIX[0][1]), opts(lane)), /STIMULUS_LANE/);
  assert.equal(client.calls.length, 1);
});
test('client and transaction cannot be reused', async () => {
  const client = fake(), adapter = wrapCandidatePrisma(client, 'A');
  assert.throws(() => wrapCandidatePrisma(client, 'B'), /CLIENT_REUSE/);
  await adapter.interactive(async () => {}, opts('A'));
  await assert.rejects(adapter.interactive(async () => {}, opts('A')), /TRANSACTION_REUSE/);
});
test('transaction failure does not permit retry', async () => {
  const adapter = wrapCandidatePrisma(fake({ transaction: () => { throw new Error('failure'); } }), 'A');
  await assert.rejects(adapter.interactive(async () => {}, opts('A')), /failure/);
  await assert.rejects(adapter.interactive(async () => {}, opts('A')), /TRANSACTION_REUSE/);
});
test('wrong options refuse before entering client', async () => {
  const client = fake(), adapter = wrapCandidatePrisma(client, 'A');
  await assert.rejects(adapter.interactive(async () => {}, { ...opts('A'), timeout: 1 }), /TRANSACTION_OPTIONS/);
  assert.equal(client.calls.length, 0);
});
test('skipped or repeated callback cannot complete', async () => {
  for (const transaction of [async () => undefined, async (fn, tx) => { await fn(tx); return fn(tx); }]) {
    const adapter = wrapCandidatePrisma(fake({ transaction }), 'A');
    await assert.rejects(adapter.interactive(async () => {}, opts('A')), /CALLBACK/);
  }
});
test('tx use after callback lifetime cannot reach raw client', async () => {
  const client = fake(), adapter = wrapCandidatePrisma(client, 'A'); let retained;
  await adapter.interactive(async tx => { retained = tx; }, opts('A'));
  await assert.rejects(retained.query(SQL.identity), /TRANSACTION_CALL_STATE/);
  assert.equal(client.calls.length, 1);
});
test('parallel operation refuses and makes transaction incomplete even if caught', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const client = fake({ query: () => pending }), adapter = wrapCandidatePrisma(client, 'A');
  await assert.rejects(adapter.interactive(async tx => {
    const first = tx.query(SQL.identity);
    await assert.rejects(tx.query(SQL.identity), /TRANSACTION_CALL_STATE/);
    release([]); await first;
  }, opts('A')), /UNFINISHED_OR_CONCURRENT_CALL/);
  assert.equal(client.calls.filter(row => row[0] === 'query').length, 1);
});
test('disconnect during active transaction is refused; cleanup error remains visible', async () => {
  const error = new Error('disconnect failure'), adapter = wrapCandidatePrisma(fake({ disconnect: error }), 'A');
  await adapter.interactive(async () => { await assert.rejects(adapter.disconnect(), /DISCONNECT_STATE/); }, opts('A'));
  await assert.rejects(adapter.disconnect(), value => value === error);
  await assert.rejects(adapter.disconnect(), /DISCONNECT_STATE/);
});
test('disconnected client cannot start transaction', async () => {
  const adapter = wrapCandidatePrisma(fake(), 'A'); await adapter.disconnect();
  await assert.rejects(adapter.interactive(async () => {}, opts('A')), /TRANSACTION_REUSE/);
});

test('a caught contract violation blocks every later raw call', async () => {
  const client = fake(), adapter = wrapCandidatePrisma(client, 'A');
  await assert.rejects(adapter.interactive(async tx => {
    await assert.rejects(tx.query('SELECT secret'), /SQL_NOT_ALLOWED/);
    await assert.rejects(tx.execute(MATRIX[0][1]), /TRANSACTION_CALL_STATE/);
    await assert.rejects(tx.query(SQL.identity), /TRANSACTION_CALL_STATE/);
  }, opts('A')), /UNFINISHED_OR_CONCURRENT_CALL/);
  assert.equal(client.calls.length, 1);
});
test('retained callback cannot enter after outer transaction settles', async () => {
  let invoke; const client = fake({ transaction: (fn, tx) => { invoke = () => fn(tx); } });
  const adapter = wrapCandidatePrisma(client, 'A');
  await assert.rejects(adapter.interactive(tx => tx.query(SQL.identity), opts('A')), /MISSING_TRANSACTION_CALLBACK/);
  await adapter.disconnect();
  await assert.rejects(invoke(), /TRANSACTION_CALLBACK/);
  assert.equal(client.calls.filter(row => row[0] === 'query').length, 0);
});
test('suspended callback loses SQL authority when outer transaction settles', async () => {
  let resume, work; const suspended = new Promise(resolve => { resume = resolve; });
  const client = fake({ transaction: (fn, tx) => { work = fn(tx); } });
  const adapter = wrapCandidatePrisma(client, 'A');
  await assert.rejects(adapter.interactive(async tx => { await suspended; return tx.query(SQL.identity); }, opts('A')), /MISSING_TRANSACTION_CALLBACK/);
  await adapter.disconnect(); resume();
  await assert.rejects(work, /TRANSACTION_CALL_STATE/);
  assert.equal(client.calls.filter(row => row[0] === 'query').length, 0);
});
