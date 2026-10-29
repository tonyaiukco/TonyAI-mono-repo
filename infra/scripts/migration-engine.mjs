/** Version-bound Prisma 6.19.3 schema-engine transport. Never invoke CLI preflights. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runRoleCheck } from './migration-role-check.mjs';

const fail = () => new Error('Migration transport refused; raw details withheld.');
export const safeCode = (value) => {
  const code = value?.data?.error_code;
  return typeof code === 'string' && /^P[1-3][0-9]{3}$/.test(code) ? code : null;
};

export class Engine {
  constructor(binary, schema, url) {
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    this.child = spawn(binary, ['--datamodels', schema], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
        DATABASE_URL: url, DIRECT_URL: url, RUST_LOG: 'off', RUST_BACKTRACE: '0' },
    });
    this.child.stderr.resume(); // Discard: engine errors can contain credentials/SQL.
    this.child.stdout.on('data', (data) => this.receive(data.toString()));
    this.child.on('error', () => this.rejectAll());
    this.child.on('exit', () => this.rejectAll());
    this.child.stdin.on('error', () => this.rejectAll());
  }
  rejectAll() {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(fail()); }
    this.pending.clear();
  }
  receive(data) {
    this.buffer += data;
    if (this.buffer.length > 2_000_000) { this.rejectAll(); this.child.kill('SIGKILL'); return; }
    while (this.buffer.includes('\n')) {
      const end = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { this.rejectAll(); this.child.kill(); return; }
      // Engine print notifications are acknowledged without reflecting their content.
      if (message.method === 'print' && message.id !== undefined) {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
        continue;
      }
      const entry = this.pending.get(message.id);
      if (!entry || message.jsonrpc !== '2.0') { this.rejectAll(); this.child.kill(); return; }
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) {
        const error = fail(); error.prismaCode = safeCode(message.error); entry.reject(error);
      } else if (Object.hasOwn(message, 'result')) entry.resolve(message.result);
      else entry.reject(fail());
    }
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.rejectAll(); this.child.kill('SIGKILL'); }, 900_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async stop() {
    this.rejectAll();
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 3000);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
      this.child.kill('SIGTERM');
    });
  }
}

export const checkHistory = (result, expected, complete = false) => {
  if (!result || !Array.isArray(result.failedMigrationNames) || result.failedMigrationNames.length
      || !Array.isArray(result.editedMigrationNames) || result.editedMigrationNames.length
      || typeof result.hasMigrationsTable !== 'boolean') throw fail();
  if (result.errorInUnappliedMigration != null || result.drift != null) throw fail();
  if ((complete || result.history === null) && !result.hasMigrationsTable) throw fail();
  if (complete && result.history !== null) throw fail();
  if (result.history !== null) {
    const history = result.history;
    if (history.diagnostic !== 'databaseIsBehind' || !Array.isArray(history.unappliedMigrationNames)
        || !history.unappliedMigrationNames.length
        || history.unappliedMigrationNames.some((name) => !expected.includes(name))
        || JSON.stringify(history.unappliedMigrationNames) !== JSON.stringify(expected.slice(-history.unappliedMigrationNames.length))) throw fail();
    return history.unappliedMigrationNames;
  }
  return [];
};

export const execute = async (engine, bundle, operation) => {
  if (!['probe', 'migrate'].includes(operation)) throw fail();
  if (operation === 'probe') {
    await engine.request('dbExecute', {
      datasourceType: { tag: 'schema', files: [{ path: '/migration/schema.prisma',
        content: bundle.schema }], configDir: '/migration' },
      script: 'BEGIN READ ONLY; SELECT 1; ROLLBACK;',
    });
    return { status: 'READ_ONLY_QUERY_SUCCEEDED', applied_count: 0 };
  }
  const migrationsList = { baseDir: '/migration/migrations',
    lockfile: { path: 'migration_lock.toml', content: bundle.lockfile }, shadowDbInitScript: '',
    migrationDirectories: bundle.migrations.map(({ name, sql }) => ({ path: name,
      migrationFile: { path: 'migration.sql', content: { tag: 'ok', value: sql } } })) };
  const params = { migrationsList, filters: { externalTables: [], externalEnums: [] } };
  const names = bundle.migrations.map(({ name }) => name);
  const diagnostic = { ...params, optInToShadowDatabase: false };
  const pending = checkHistory(await engine.request('diagnoseMigrationHistory', diagnostic), names);
  const applied = await engine.request('applyMigrations', params);
  if (!Array.isArray(applied?.appliedMigrationNames)
      || applied.appliedMigrationNames.some((name) => !names.includes(name))
      || JSON.stringify(applied.appliedMigrationNames) !== JSON.stringify(pending)) throw fail();
  checkHistory(await engine.request('diagnoseMigrationHistory', diagnostic), names, true);
  return { status: 'MIGRATIONS_CURRENT', applied_count: applied.appliedMigrationNames.length };
};

const main = async () => {
  let engine;
  const interrupted = () => { engine?.child.kill('SIGKILL'); process.exit(1); };
  process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
  try {
    if (process.versions.node.split('.')[0] !== '22') throw fail();
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 32_768) throw fail(); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof input.url !== 'string' || !['probe', 'migrate', 'owner-check', 'runtime-check'].includes(input.operation)) throw fail();
    if (input.operation.endsWith('-check')) {
      console.log(JSON.stringify(await runRoleCheck(input.url, input.operation))); return;
    }
    const bundle = JSON.parse(readFileSync('/migration/bundle.json', 'utf8'));
    engine = new Engine('/engine/schema-engine', '/migration/schema.prisma', input.url);
    console.log(JSON.stringify(await execute(engine, bundle, input.operation)));
  } catch (error) {
    console.log(JSON.stringify({ status: 'STOPPED', prisma_code: error.prismaCode ?? null, retry: false }));
    process.exitCode = 1;
  } finally { await engine?.stop(); }
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
