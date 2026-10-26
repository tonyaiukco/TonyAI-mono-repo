// db-candidate02: adapter allowlist amendment tests. Injected fake clients only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapCandidatePrisma } from '../scripts/r3_db_candidate/prisma-adapter.mjs';
import { SQL, MATRIX } from '../scripts/r3_db_candidate/driver.mjs';
import { GUC_QUERY, SETUP_STATEMENTS, COLLISION_QUERY, DB_ROLE_SETTING_QUERY } from '../scripts/r3_db_candidate/fixture-sql.mjs';
import * as original from './r3_db_candidate01_driver.mjs';

const opts = lane => ({ maxWait: 5000, timeout: { A: 60000, B: 90000, C: 10000 }[lane], isolationLevel: 'ReadCommitted' });
const fake = () => {
  const calls = [];
  const tx = {
    $queryRawUnsafe: async (...args) => { calls.push(['query', ...args]); return []; },
    $executeRawUnsafe: async (...args) => { calls.push(['execute', ...args]); return 0; },
  };
  return { calls, $transaction: async (fn, options) => { calls.push(['transaction', options]); return fn(tx); }, $disconnect: async () => {} };
};
async function refused(lane, run, pattern) {
  const client = fake(), adapter = wrapCandidatePrisma(client, lane);
  await assert.rejects(adapter.interactive(async tx => { await assert.rejects(run(tx), pattern); }, opts(lane)), /UNFINISHED_OR_CONCURRENT_CALL/);
  assert.equal(client.calls.length, 1);
}

for (const lane of ['A', 'B', 'C']) {
  test('exact GUC query is allowed as a query on lane ' + lane, async () => {
    const client = fake(), adapter = wrapCandidatePrisma(client, lane);
    await adapter.interactive(tx => tx.query(SQL.gucs), opts(lane));
    assert.deepEqual(client.calls.slice(1), [['query', GUC_QUERY]]);
  });
  test('GUC query via execute or with parameters is refused on lane ' + lane, async () => {
    await refused(lane, tx => tx.execute(SQL.gucs), /SQL_NOT_ALLOWED/);
    await refused(lane, tx => tx.query(SQL.gucs, 'x'), /SQL_PARAMETERS/);
  });
}

const variants = {
  'trailing space': GUC_QUERY + ' ',
  'trailing semicolon': GUC_QUERY + ';',
  'larger limit': GUC_QUERY.replace('LIMIT 10', 'LIMIT 11'),
  'no limit': GUC_QUERY.replace(' LIMIT 10', ''),
  'extra column': GUC_QUERY.replace('pending_restart FROM', 'pending_restart, boot_val FROM'),
  'select all settings': 'SELECT name, setting, source, sourcefile, sourceline, pending_restart FROM pg_settings',
  'show all': 'SHOW ALL',
  'pre-amendment identity without LIMIT 2': original.SQL.identity,
  'pre-amendment members without LIMIT 1': original.SQL.members,
  'uppercase variant': GUC_QUERY.toUpperCase(),
};
for (const [name, statement] of Object.entries(variants)) {
  test('near-miss query is refused before the raw client: ' + name, async () => {
    await refused('A', tx => tx.query(statement), /SQL_NOT_ALLOWED/);
  });
}

for (const statement of [...SETUP_STATEMENTS, COLLISION_QUERY, DB_ROLE_SETTING_QUERY]) {
  test('bootstrap-only SQL can never pass the probe adapter: ' + statement.slice(0, 40), async () => {
    await refused('A', tx => tx.execute(statement), /SQL_NOT_ALLOWED/);
    await refused('A', tx => tx.query(statement), /SQL_NOT_ALLOWED/);
  });
}

test('stimulus remains lane A only after the allowlist amendment', async () => {
  for (const lane of ['B', 'C']) await refused(lane, tx => tx.execute(MATRIX[0][1]), /STIMULUS_LANE/);
});
