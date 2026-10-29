import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, checkHistory, execute, safeCode } from '../scripts/migration-engine.mjs';

const names = ['001_first', '002_second'];
const current = { hasMigrationsTable: true, history: null, failedMigrationNames: [], editedMigrationNames: [] };
const behind = { ...current, history: { diagnostic: 'databaseIsBehind', unappliedMigrationNames: names } };
const bundle = { schema: 'public schema fixture', lockfile: 'provider = "postgresql"', migrations: names.map((name) => ({ name, sql: 'SELECT 1;' })) };

test('history rejects failure, edits, divergence, missing fields and non-suffixes', () => {
  for (const value of [null, {}, { ...current, hasMigrationsTable: false },
    { ...current, failedMigrationNames: ['x'] }, { ...current, editedMigrationNames: ['x'] },
    { ...current, history: {} }, { ...current, history: { diagnostic: 'historiesDiverge' } },
    { ...behind, history: { diagnostic: 'databaseIsBehind', unappliedMigrationNames: [names[0]] } },
    { ...current, errorInUnappliedMigration: {} }, { ...current, drift: {} }]) {
    assert.throws(() => checkHistory(value, names));
  }
  assert.deepEqual(checkHistory(current, names, true), []);
  assert.deepEqual(checkHistory(behind, names), names);
  assert.throws(() => checkHistory(behind, names, true));
});

test('probe cannot dispatch apply, status, arbitrary SQL or shadow database work', async () => {
  const calls = [];
  const result = await execute({ request: async (...args) => { calls.push(args); } }, bundle, 'probe');
  assert.equal(result.status, 'READ_ONLY_QUERY_SUCCEEDED');
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'dbExecute');
  assert.equal(calls[0][1].script, 'BEGIN READ ONLY; SELECT 1; ROLLBACK;');
  await assert.rejects(execute({}, bundle, 'reset'));
});

test('apply requires exact pending list, preserves SQL, and verifies final history', async () => {
  const calls = []; const results = [behind, { appliedMigrationNames: names }, current];
  const result = await execute({ request: async (...args) => { calls.push(args); return results.shift(); } }, bundle, 'migrate');
  assert.deepEqual(calls.map(([method]) => method), ['diagnoseMigrationHistory', 'applyMigrations', 'diagnoseMigrationHistory']);
  assert.equal(result.applied_count, 2);
  assert.equal(calls[0][1].optInToShadowDatabase, false);
  assert.equal(calls[1][1].migrationsList.migrationDirectories[0].migrationFile.content.value, 'SELECT 1;');
  for (const applied of [[], [names[0]], [...names, names[0]], ['unknown']]) {
    const responses = [behind, { appliedMigrationNames: applied }, current];
    await assert.rejects(execute({ request: async () => responses.shift() }, bundle, 'migrate'));
  }
});

test('failed history prevents apply; failed apply is never retried', async () => {
  const calls = [];
  await assert.rejects(execute({ request: async (method) => { calls.push(method); return { ...current, failedMigrationNames: ['x'] }; } }, bundle, 'migrate'));
  assert.deepEqual(calls, ['diagnoseMigrationHistory']);
  let count = 0;
  await assert.rejects(execute({ request: async () => { if (++count === 1) return behind; throw new Error('fixture'); } }, bundle, 'migrate'));
  assert.equal(count, 2);
});

test('engine child argv is secret-free; stderr and print callbacks never escape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-engine-test-'));
  const binary = join(dir, 'fake-engine');
  writeFileSync(binary, `#!${process.execPath}\nimport('node:readline').then(({createInterface}) => {
    const lines=createInterface({input:process.stdin});
    lines.on('line', line => { const r=JSON.parse(line); if(!r.method)return;
      console.error('SECRET_FIXTURE');
      console.log(JSON.stringify({jsonrpc:'2.0',id:900,method:'print',params:{content:'SECRET_FIXTURE'}}));
      console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{ok:true}}));
    });
  });\n`, { mode: 0o755 });
  const engine = new Engine(binary, '/public/schema.prisma', 'SECRET_FIXTURE');
  try {
    assert.deepEqual(engine.child.spawnargs, [binary, '--datamodels', '/public/schema.prisma']);
    assert.deepEqual(await engine.request('probe', {}), { ok: true });
  } finally { await engine.stop(); rmSync(dir, { recursive: true }); }
});

test('structured error classifier accepts only finite Prisma code format', () => {
  assert.equal(safeCode({ data: { error_code: 'P1011' } }), 'P1011');
  for (const error_code of ['P1011 postgresql://secret', 'secret', null, 1011]) assert.equal(safeCode({ data: { error_code } }), null);
});

test('privilege checker pins identity and uses read-only transaction, preserving findings', async () => {
  const { checkRoles } = await import('../scripts/migration-role-check.mjs');
  const calls = [];
  let identity = 'postgres';
  const client = { $transaction: async (fn, options) => {
    assert.equal(options.timeout, 120_000);
    return fn({ $executeRawUnsafe: async (sql) => calls.push(sql),
      $queryRawUnsafe: async (sql) => { calls.push(sql); return [{ current_user: identity, session_user: identity }]; } });
  } };
  const good = { problems: [], exposures: [], platformDefaults: ['finding'], library: { notices: [], skipped: [] } };
  const result = await checkRoles(client, async () => good, 'owner-check');
  assert.equal(calls[0], 'SET TRANSACTION READ ONLY');
  assert.equal(result.identity, 'postgres');
  assert.equal(result.platform_default_findings, 1);
  assert.equal(result.findings_require_owner_review, true);
  identity = 'tonyai_runtime';
  await assert.rejects(checkRoles(client, async () => good, 'owner-check'));
  assert.equal((await checkRoles(client, async () => ({ ...good, library: { notices: [], skipped: ['owner reconciliation required'] } }), 'runtime-check')).library_skipped, 1);
  identity = 'postgres';
  for (const report of [{ ...good, problems: ['bad'] }, { ...good, exposures: ['public'] },
    { ...good, library: { notices: ['factor fixture'], skipped: [] } },
    { ...good, library: { notices: [], skipped: ['owner incomplete'] } }]) {
    await assert.rejects(checkRoles(client, async () => report, 'owner-check'));
  }
});
