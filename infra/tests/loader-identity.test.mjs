import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CA_PATH, loaderUrl, run, verifyLoaderIdentity } from '../scripts/loader-identity.mjs';
import { run as command, FAILURE } from '../scripts/loader-command.mjs';

const project = 'abcdefghijklmnopqrst';
const password = 'a'.repeat(64);
const url = `postgresql://tonyai_factor_loader.${project}:${password}@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require&sslaccept=strict&sslcert=${encodeURIComponent(CA_PATH)}&connection_limit=1&connect_timeout=15`;
const env = { FACTOR_LOADER_DATABASE_URL: url, SUPABASE_PROJECT_REF: project, DATABASE_URL: 'runtime-secret', DIRECT_URL: 'owner-secret', NODE_OPTIONS: '--inspect' };
const loader = { current_user: 'tonyai_factor_loader', session_user: 'tonyai_factor_loader' };

test('chosen endpoint requires project-bound loader session pooler and strict TLS', () => {
  assert.equal(loaderUrl(env), url);
  const changes = [
    ['postgresql:', 'http:'], ['tonyai_factor_loader.', 'postgres.'],
    ['tonyai_factor_loader.', 'tonyai_runtime.'], [project, 'z'.repeat(20)],
    [password, 'weak'], ['eu-central-1', 'eu-west-1'], ['pooler.supabase.com', 'example.com'],
    [':5432/', ':6543/'], ['/postgres?', '/other?'], ['sslmode=require', 'sslmode=disable'],
    ['sslaccept=strict', 'sslaccept=accept_invalid_certs'],
    [encodeURIComponent(CA_PATH), encodeURIComponent('/untrusted/cert')],
    ['connection_limit=1', 'connection_limit=5'], ['connect_timeout=15', 'connect_timeout=0'],
  ];
  for (const [before, after] of changes) {
    assert.throws(() => loaderUrl({ ...env, FACTOR_LOADER_DATABASE_URL: url.replace(before, after) }), undefined, before);
  }
  for (const suffix of ['&host=elsewhere', '&options=-c%20role=postgres', '&pgbouncer=true', '&sslaccept=strict', '#fragment']) {
    assert.throws(() => loaderUrl({ ...env, FACTOR_LOADER_DATABASE_URL: url + suffix }), undefined, suffix);
  }
  for (const key of ['FACTOR_LOADER_DATABASE_URL', 'SUPABASE_PROJECT_REF']) {
    assert.throws(() => loaderUrl({ ...env, DATABASE_URL: url, DIRECT_URL: url, [key]: undefined }));
  }
});

test('identity is exactly one row with both bare loader identities; SET ROLE is insufficient', async () => {
  const queries = [];
  assert.deepEqual(await verifyLoaderIdentity(async (sql) => { queries.push(sql); return [loader]; }), loader);
  assert.deepEqual(queries, ['SELECT current_user, session_user']);
  for (const rows of [[], [loader, loader], ...['current_user', 'session_user'].flatMap((key) =>
    ['postgres', 'tonyai_runtime', 'loader_member', `tonyai_factor_loader.${project}`, null, undefined].map((value) => [{ ...loader, [key]: value }]))]) {
    await assert.rejects(verifyLoaderIdentity(async () => rows), /must both be tonyai_factor_loader/);
  }
});

test('runner checks the dedicated URL, disconnects and only then emits identity evidence', async () => {
  const events = [];
  await run(env, (options) => {
    assert.deepEqual(options, { datasourceUrl: url, log: [] });
    return {
      $queryRawUnsafe: async (sql) => { events.push(sql); return [loader]; },
      $disconnect: async () => { events.push('disconnect'); },
    };
  }, (message) => events.push(message));
  assert.deepEqual(events, ['SELECT current_user, session_user', 'disconnect', 'PASS: current_user=tonyai_factor_loader; session_user=tonyai_factor_loader']);
});

test('runner fails closed on construction, query, identity and disconnect failures', async () => {
  for (const defect of ['construct', 'query', 'identity', 'disconnect', 'missing']) {
    const messages = [];
    let disconnected = false;
    let constructed = false;
    await assert.rejects(run({ ...env, FACTOR_LOADER_DATABASE_URL: defect === 'missing' ? undefined : url }, () => {
      constructed = true;
      if (defect === 'construct') throw new Error(password);
      return {
        $queryRawUnsafe: async () => {
          if (defect === 'query') throw new Error(password);
          return [{ ...loader, session_user: defect === 'identity' ? 'postgres' : loader.session_user }];
        },
        $disconnect: async () => { disconnected = true; if (defect === 'disconnect') throw new Error(password); },
      };
    }, (message) => messages.push(message)));
    assert.deepEqual(messages, []);
    assert.equal(disconnected, !['construct', 'missing'].includes(defect));
    assert.equal(constructed, defect !== 'missing');
  }
});

const report = { command: 'load', outcome: 'would_load', operator: 'Factor operations', release: { publisher: 'approved publisher', edition: 'approved edition' }, factors: 2, conversions: 1, supersedes: null };
const success = { status: 0, signal: null, stdout: JSON.stringify(report), stderr: '' };

test('owner command preserves CLI arguments but passes only the loader credential in a private child', () => {
  const args = ['load', '--file=/private/release.json', '--operator=Factor operations', '--apply', '--allow-remote'];
  const messages = [];
  command(env, args, (binary, argv, options) => {
    assert.equal(binary, process.execPath);
    assert.deepEqual(argv, ['dist/factor-releases/factor-release.cli.js', ...args]);
    assert.ok(options.cwd.endsWith('/apps/api/'));
    assert.deepEqual(options.env, { FACTOR_LOADER_DATABASE_URL: url, NODE_ENV: 'production', NO_COLOR: '1' });
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.timeout, 360_000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.maxBuffer, 4 * 1024 * 1024);
    return success;
  }, (message) => messages.push(message));
  assert.deepEqual(messages.map(JSON.parse), [report]);
  const withdrawn = { ...report, command: 'withdraw', outcome: 'would_withdraw' };
  command(env, ['withdraw'], () => ({ ...success, stdout: JSON.stringify(withdrawn) }), (message) => assert.deepEqual(JSON.parse(message), withdrawn));
});

test('raw diagnostics, refused/unknown/partial outcomes and credentials never become reports', () => {
  for (const result of [
    { ...success, status: 2 }, { ...success, status: null },
    { ...success, signal: 'SIGKILL' }, { ...success, error: new Error(url) },
    { ...success, stderr: password }, { ...success, stdout: `driver error ${url}` },
    ...[{ outcome: 'refused' }, { outcome: 'unexpected' }, { command: 'withdraw' },
      { diagnostic: url }, { diagnostic: password }].map((delta) => ({ ...success, stdout: JSON.stringify({ ...report, ...delta }) })),
  ]) {
    const messages = [];
    assert.throws(() => command(env, ['load'], () => result, (message) => messages.push(message)));
    assert.deepEqual(messages, []);
  }
  let called = false;
  for (const [settings, args] of [[{ ...env, FACTOR_LOADER_DATABASE_URL: undefined }, ['load']], [env, ['bad']]]) {
    assert.throws(() => command(settings, args, () => { called = true; }));
  }
  assert.equal(called, false);
});

test('both executable failure boundaries withhold URL parser errors and return nonzero', () => {
  for (const [script, status, expected] of [['loader-identity.mjs', 1, 'FAIL: loader connection identity was not verified; credentials and driver details withheld.'], ['loader-command.mjs', 2, FAILURE]]) {
    const result = spawnSync(process.execPath, [new URL(`../scripts/${script}`, import.meta.url).pathname, 'load'], {
      env: { SUPABASE_PROJECT_REF: project, FACTOR_LOADER_DATABASE_URL: `invalid:${password} password` }, encoding: 'utf8',
    });
    assert.equal(result.status, status);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), expected);
    assert.ok(!result.stderr.includes(password));
  }
});
