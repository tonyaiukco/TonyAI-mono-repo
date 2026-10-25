import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync, closeSync as closeReal, existsSync, mkdirSync, mkdtempSync, openSync, openSync as openReal, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync as writeSyncReal,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessError, assertNoSecrets, secretForms, secretStrings, sha256, validateSecrets } from '../scripts/r3_realtime_gcm.mjs';
import {
  ATTEMPT_LABEL, countLogFailures, createApiAdapter, maskLogSecrets, createLifecycleAdapter, createMetadataAdapter, createPrivateStore, createSecretDir,
  createSocketsAdapter, createTenantDbAdapter, createTokenAdapter, dockerExec, dockerIdentity, envFileText, generateSecrets,
  httpCall, logEntries, makeTransport, parseFrame, pinnedLookup, postgresRunArgv, realtimeEnv, realtimeRunArgv, renderBootstrap,
  scramVerifier, teardownArgv,
} from '../scripts/r3_realtime_clients.mjs';
import {
  APPROVAL_KEYS, HARNESS_FILES, MANIFEST_PATH, attemptNames, canonicalJson, checkEvidenceDir, consumeAttempt, execute,
  executionRefusals, harnessHashes, main, manifestRefusals, parseApproval, runtimeRefusals, teardownAttempt,
} from '../scripts/r3_realtime_gcm_run.mjs';
import { manifest } from './r3_realtime_gcm_fake.mjs';
import { REPO_ROOT as REPO_ROOT_FOR_TEST } from '../scripts/r3_realtime_clients.mjs';

const GCM_TEXT = 'GCM decryption failed: ciphertext or authentication tag is invalid';
const lookupOnce = (lookup, host, opts) => new Promise((r) => { lookup(host, opts, (...a) => r(a)); });
const scratch = (t, prefix) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

test('pinnedLookup resolves only the fixture names to their fixed IPv4 address', async () => {
  const lookup = pinnedLookup({ 'a.realtime-gcm.invalid': '172.31.250.10' });
  assert.deepEqual(await lookupOnce(lookup, 'A.realtime-gcm.invalid', {}), [null, '172.31.250.10', 4]);
  assert.deepEqual(await lookupOnce(lookup, 'a.realtime-gcm.invalid', { all: true }), [null, [{ address: '172.31.250.10', family: 4 }]]);
  const [err] = await lookupOnce(lookup, 'registry-1.docker.io', {});
  assert.equal(err.code, 'ENOTFOUND');
  assert.throws(() => pinnedLookup({ 'a.example.com': '172.31.250.10' }), /BAD_PLAN/);
  assert.throws(() => pinnedLookup({ 'a.realtime-gcm.invalid': 'localhost' }), /BAD_PLAN/);
});

test('parseFrame reads both Phoenix serialisations and ignores non-JSON', () => {
  assert.deepEqual(parseFrame(JSON.stringify(['1', '1', 'realtime:t', 'phx_join', { a: 1 }])),
    { topic: 'realtime:t', event: 'phx_join', payload: { a: 1 } });
  assert.deepEqual(parseFrame(JSON.stringify({ topic: 't', event: 'phx_reply', payload: {}, ref: '1' })),
    { topic: 't', event: 'phx_reply', payload: {} });
  assert.equal(parseFrame('not json'), null);
});

class FakeWs extends EventEmitter {
  constructor(url, protocols, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    this.readyState = 0;
    FakeWs.instances.push(this);
  }
  send(d) { this.sent.push(d); }
  terminate() { this.readyState = 3; this.emit('close'); }
}
FakeWs.instances = [];
const newState = () => ({ constructions: 0, closed: false, opened: false, refused: false, socketClosed: false,
  httpStatus: null, errors: [], violations: [], joins: new Map(), joinErrors: [], framesIn: 0, framesOut: 0, bytesIn: 0 });
const limits = { handshakeMs: 1000, frameBytes: 16384, framesPerSession: 4, transcriptBytes: 1 << 20, heartbeatMs: 15000 };

test('the transport connects once through the pinned lookup and refuses SDK reconnects and rejoins', () => {
  const state = newState();
  const lookup = () => {};
  const T = makeTransport({ WebSocket: FakeWs, lookup, state, limits, expectedHost: 'a.realtime-gcm.invalid', totals: { bytes: 0 } });
  const url = 'ws://a.realtime-gcm.invalid:4000/socket/websocket?apikey=x&vsn=2.0.0';
  const first = new T(url);
  assert.equal(first.options.lookup, lookup);
  assert.equal(first.options.followRedirects, false);
  assert.equal(first.options.perMessageDeflate, false);
  const second = new T(url);
  assert.equal(second.readyState, 3);
  assert.equal(typeof second.send, 'function');
  assert.ok(!(second instanceof FakeWs));
  assert.deepEqual(state.violations, ['SECOND_SOCKET_CONSTRUCTION']);
  const join = JSON.stringify(['1', '1', 'realtime:t', 'phx_join', {}]);
  first.send(join);
  first.send(join);
  assert.deepEqual(first.sent, [join], 'the second phx_join never reaches the wire');
  assert.ok(state.violations.includes('SECOND_JOIN'));
  first.emit('message', Buffer.from(JSON.stringify(['1', '1', 'realtime:t', 'phx_reply', { status: 'error', response: { reason: 'boom' } }])), false);
  assert.deepEqual(state.joinErrors, [{ topic: 'realtime:t', reason: 'boom' }]);
  for (let i = 0; i < 4; i += 1) first.emit('message', Buffer.from('x'), true);
  assert.ok(state.violations.includes('FRAME_LIMIT'));
  state.closed = true;
  new T(url);
  assert.ok(state.violations.includes('CONSTRUCTION_AFTER_CLOSE'));
});

test('the transport refuses an unexpected endpoint and records a handshake refusal status', () => {
  const state = newState();
  const T = makeTransport({ WebSocket: FakeWs, lookup: () => {}, state, limits, expectedHost: 'a.realtime-gcm.invalid', totals: { bytes: 0 } });
  const wrong = new T('ws://b.realtime-gcm.invalid:4000/socket/websocket');
  assert.equal(wrong.readyState, 3);
  assert.deepEqual(state.violations, ['UNEXPECTED_ENDPOINT']);
  const s2 = newState();
  const T2 = makeTransport({ WebSocket: FakeWs, lookup: () => {}, state: s2, limits, expectedHost: 'a.realtime-gcm.invalid', totals: { bytes: 0 } });
  const ws = new T2('ws://a.realtime-gcm.invalid:4000/socket/websocket');
  ws.emit('unexpected-response', {}, { statusCode: 401, resume() {} });
  assert.equal(s2.httpStatus, 401);
  assert.equal(s2.refused, true);
  assert.equal(s2.socketClosed, true);
});

/** A minimal stand-in for RealtimeClient: it constructs the transport the way Phoenix does. */
class FakeRealtimeClient {
  constructor(endpoint, opts) {
    this.endpoint = endpoint;
    this.opts = opts;
    FakeRealtimeClient.last = this;
  }
  connect() { this.conn = new this.opts.transport(`${this.endpoint}/websocket?apikey=${this.opts.params.apikey}&vsn=${this.opts.vsn}`); }
  channel(topic) {
    const handlers = [];
    const ch = { topic, handlers, on: (type, filter, cb) => { handlers.push({ type, filter, cb }); return ch; },
      subscribe: (cb) => { ch.cb = cb; this.onSubscribe?.(ch); return ch; } };
    return ch;
  }
  removeChannel() { return Promise.resolve('ok'); }
  disconnect() { this.conn?.terminate?.(); }
}

test('a socket session opens once, classifies joins, matches exact nonces and reports late SDK activity', async () => {
  FakeWs.instances = [];
  const adapter = createSocketsAdapter({ libs: { RealtimeClient: FakeRealtimeClient, WebSocket: FakeWs }, port: 4000,
    lookup: () => {}, limits, vsn: '2.0.0' });
  const pending = adapter.open({ hostname: 'a.realtime-gcm.invalid', token: 'jwt', timeoutMs: 500 });
  await new Promise((r) => { setTimeout(r, 10); });
  const client = FakeRealtimeClient.last;
  assert.equal(client.opts.worker, false);
  assert.equal(client.opts.params.apikey, 'jwt');
  assert.ok(client.opts.reconnectAfterMs(1) >= 86_400_000);
  FakeWs.instances[0].emit('open');
  const s = await pending;
  assert.equal(s.status, 'open');
  client.onSubscribe = (ch) => {
    ch.cb('SUBSCRIBED');
    ch.handlers.find((h) => h.type === 'system').cb({ extension: 'postgres_changes', status: 'ok' });
    ch.handlers.find((h) => h.type === 'broadcast').cb({ payload: { nonce: 'stale' } });
    ch.handlers.find((h) => h.type === 'broadcast').cb({ payload: { nonce: 'n1' } });
    ch.handlers.find((h) => h.type === 'postgres_changes').cb({ new: { id: 'r1', nonce: 'n2' } });
  };
  const j = await s.join({ topic: 'gcm-t', schema: 'gcm_fixture', table: 'events', timeoutMs: 200 });
  assert.deepEqual(j, { status: 'subscribed', postgresChangesReady: true });
  assert.deepEqual(await s.expectBroadcast({ nonce: 'n1', timeoutMs: 50 }), { received: true, nonce: 'n1' });
  assert.equal((await s.expectBroadcast({ nonce: 'n9', timeoutMs: 30 })).received, false);
  assert.equal((await s.expectInsert({ id: 'r1', nonce: 'n2', timeoutMs: 50 })).nonce, 'n2');
  const closed = await s.close();
  assert.deepEqual(closed.violations, []);
  assert.deepEqual(closed.received.map((m) => m.nonce), ['stale', 'n1', 'n2'], 'the orchestrator sees the stale one');
  client.connect(); // an SDK reconnect timer firing after close
  const p2 = adapter.open({ hostname: 'a.realtime-gcm.invalid', token: 'jwt', timeoutMs: 100 });
  await new Promise((r) => { setTimeout(r, 10); });
  FakeRealtimeClient.last.conn.emit('unexpected-response', {}, { statusCode: 500, resume() {} });
  const s2 = await p2;
  assert.deepEqual([s2.status, s2.httpStatus], ['refused', 500]);
  assert.deepEqual((await s2.close()).violations, ['LATE_ACTIVITY']);
  assert.deepEqual(adapter.finalCheck().violations, []);
});

test('an explicit join error frame is a refusal; a channel error without one is not', async () => {
  for (const [frame, expected] of [[true, 'error'], [false, 'socket-error']]) {
    FakeWs.instances = [];
    const adapter = createSocketsAdapter({ libs: { RealtimeClient: FakeRealtimeClient, WebSocket: FakeWs }, port: 4000,
      lookup: () => {}, limits, vsn: '2.0.0' });
    const pending = adapter.open({ hostname: 'a.realtime-gcm.invalid', token: 'jwt', timeoutMs: 500 });
    await new Promise((r) => { setTimeout(r, 10); });
    FakeWs.instances[0].emit('open');
    const s = await pending;
    FakeRealtimeClient.last.onSubscribe = (ch) => {
      if (frame) {
        FakeWs.instances[0].emit('message', Buffer.from(JSON.stringify(['1', '1', `realtime:${ch.topic}`, 'phx_reply',
          { status: 'error', response: { reason: 'UnableToConnectToProject' } }])), false);
      }
      ch.cb('CHANNEL_ERROR');
    };
    const j = await s.join({ topic: 'gcm-x', schema: 's', table: 't', timeoutMs: 200 });
    assert.equal(j.status, expected);
    await s.close();
  }
});

const fakeRequest = (script) => (options, onResponse) => {
  const req = new EventEmitter();
  req.options = options;
  req.written = [];
  req.write = (b) => req.written.push(b);
  req.destroy = () => { req.destroyed = true; };
  req.end = () => setImmediate(() => script(req, onResponse));
  fakeRequest.last = req;
  return req;
};
const respond = (status, chunks) => (req, cb) => {
  const res = new EventEmitter();
  res.statusCode = status;
  cb(res);
  for (const c of chunks) res.emit('data', Buffer.from(c));
  res.emit('end');
};

test('httpCall bounds the response and maps timeouts and errors to outcomes', async () => {
  const lookup = () => {};
  const base = { lookup, hostname: 'a.realtime-gcm.invalid', port: 4000, method: 'POST', path: '/api/broadcast', timeoutMs: 100, maxBytes: 8 };
  const ok = await httpCall({ ...base, request: fakeRequest(respond(202, [''])), body: { x: 1 } });
  assert.equal(ok.status, 202);
  assert.equal(fakeRequest.last.options.lookup, lookup);
  assert.equal(fakeRequest.last.options.agent, false);
  assert.equal(fakeRequest.last.options.headers['content-type'], 'application/json');
  assert.equal(String(fakeRequest.last.written[0]), '{"x":1}');
  const big = await httpCall({ ...base, request: fakeRequest(respond(200, ['12345', '67890'])) });
  assert.deepEqual([big.status, big.truncated], [200, true]);
  assert.equal((await httpCall({ ...base, request: fakeRequest((req) => req.emit('timeout')) })).status, 'timeout');
  const err = await httpCall({ ...base, request: fakeRequest((req) => req.emit('error', Object.assign(new Error('x'), { code: 'ENOTFOUND' }))) });
  assert.deepEqual(err, { status: 'error', code: 'ENOTFOUND' });
});

test('the API adapter sends the admin token to admin routes and the tenant token to broadcast only', async () => {
  const calls = [];
  const api = createApiAdapter({ call: async (o) => { calls.push(o); return { status: 200 }; }, port: 4000,
    adminHost: 'admin.realtime-gcm.invalid', tokens: { admin: async () => 'ADMIN' }, limits: { outcomeMs: 10, responseBytes: 99 } });
  await api.getTenant('gcm-fixture-a');
  await api.updateJwt({ externalId: 'gcm-fixture-a', jwtSecret: 'S' });
  await api.broadcast({ hostname: 'gcm-fixture-a.realtime-gcm.invalid', token: 'TENANT', topic: 't', nonce: 'n', timeoutMs: 7 });
  assert.deepEqual(calls.map((c) => [c.method, c.hostname, c.path, c.headers.authorization]), [
    ['GET', 'admin.realtime-gcm.invalid', '/api/tenants/gcm-fixture-a', 'Bearer ADMIN'],
    ['PUT', 'admin.realtime-gcm.invalid', '/api/tenants/gcm-fixture-a', 'Bearer ADMIN'],
    ['POST', 'gcm-fixture-a.realtime-gcm.invalid', '/api/broadcast', 'Bearer TENANT'],
  ]);
  assert.deepEqual(calls[1].body, { tenant: { jwt_secret: 'S' } }, 'the JWT update omits extensions');
  assert.deepEqual(calls[2].body, { messages: [{ topic: 't', event: 'gcm-nonce', payload: { nonce: 'n' }, private: false }] });
  assert.equal(calls[2].timeoutMs, 7);
});

test('tokens are HS256 with role and exp, signed by the right secret for each purpose', async () => {
  const signed = [];
  class SignJWT {
    constructor(claims) { this.claims = claims; }
    setProtectedHeader(h) { this.h = h; return this; }
    setIssuedAt(t) { this.iat = t; return this; }
    setExpirationTime(t) { this.exp = t; return this; }
    async sign(key) { signed.push({ ...this, key: Buffer.from(key).toString() }); return 'jwt'; }
  }
  const secrets = { tenants: { a: { jwtSecret: 'TA' } }, badJwtSecret: 'BAD', apiJwtSecret: 'API' };
  const tokens = createTokenAdapter({ jose: { SignJWT }, secrets, clock: { now: () => 1_000_000 }, role: 'authenticated' });
  await tokens.tenant('a');
  await tokens.badSignature('a');
  await tokens.admin();
  assert.deepEqual(signed.map((s) => [s.key, s.h.alg, s.claims.role, s.exp - s.iat]),
    [['TA', 'HS256', 'authenticated', 900], ['BAD', 'HS256', 'authenticated', 900], ['API', 'HS256', 'service_role', 900]]);
});

const fakePrisma = (rows, counts = []) => {
  const seen = [];
  const tag = (kind) => (strings, ...values) => {
    seen.push({ kind, sql: strings.join('?'), values });
    return Promise.resolve(kind === 'query' ? rows.shift() : counts.shift());
  };
  const client = { seen, rolledBack: 0, $queryRaw: tag('query'), $executeRaw: tag('exec'),
    async $transaction(fn) { try { return await fn(client); } catch (e) { client.rolledBack += 1; throw e; } } };
  return client;
};
const Prisma = { raw: (s) => ({ raw: s, toString: () => s }) };

test('metadata reads split the five DB fields from plaintext settings and writes are one exact row', async () => {
  const p = fakePrisma([[{ jwt_secret: 'g1:J', jwt_jwks: null }], [{ type: 'postgres_cdc_rls', settings: {
    db_host: 'g1:H', db_port: 'g1:P', db_name: 'g1:N', db_user: 'g1:U', db_password: 'g1:W', region: 'local',
    publication: 'gcm_pub_a', slot_name: 'gcm_slot_a' } }]], [1, 2]);
  const m = createMetadataAdapter({ prisma: p, Prisma, schema: '_realtime' });
  const s = await m.readSix('gcm-fixture-a');
  assert.deepEqual(s.values, { jwt_secret: 'g1:J', db_host: 'g1:H', db_port: 'g1:P', db_name: 'g1:N', db_user: 'g1:U', db_password: 'g1:W' });
  assert.deepEqual(s.otherSettings, { region: 'local', publication: 'gcm_pub_a', slot_name: 'gcm_slot_a' });
  assert.ok(p.seen.every((q) => !q.sql.includes('gcm-fixture-a')), 'the tenant id is a parameter');
  assert.deepEqual(await m.conditionalReplace({ externalId: 'gcm-fixture-a', field: 'jwt_secret', expected: 'old', value: 'new' }), { rowCount: 1 });
  assert.deepEqual(p.seen[2].values.slice(1), ['new', 'gcm-fixture-a', 'old']);
  assert.deepEqual(await m.conditionalReplace({ externalId: 'gcm-fixture-a', field: 'db_password', expected: 'o', value: 'n' }), { rowCount: 2 });
  assert.equal(p.rolledBack, 1, 'a two-row match is rolled back');
  assert.ok(p.seen[3].sql.includes('jsonb_set') && p.seen[3].values.includes('db_password'));
  await assert.rejects(m.conditionalReplace({ externalId: 'x', field: 'region', expected: 'a', value: 'b' }), /BAD_PLAN/);
  assert.throws(() => createMetadataAdapter({ prisma: p, Prisma, schema: 'x"; drop' }), /BAD_PLAN/);
});

test('tenant DB writes go to the fixed table with parameters and observe only the tenant database', async () => {
  const a = fakePrisma([[{ usename: 'u', datname: 'gcm_tenant_a', application_name: 'realtime_connect' }], [{ ok: 1 }]], [1]);
  const db = createTenantDbAdapter({ clients: { a }, Prisma, schema: 'gcm_fixture', table: 'events', databases: { a: 'gcm_tenant_a' } });
  await db.insert('a', { id: 'id', caseId: 'c', nonce: 'n' });
  assert.deepEqual(a.seen[0].values.slice(1), ['id', 'c', 'n']);
  assert.equal((await db.observeConnections('a'))[0].datname, 'gcm_tenant_a');
  assert.deepEqual(a.seen[1].values, ['gcm_tenant_a']);
  assert.deepEqual(await db.ping('a'), { ok: true });
});

test('docker argv pins the image ID, never pulls and refuses tags or odd names', () => {
  const plan = manifest();
  const argv = realtimeRunArgv({ name: 'gcm-20261025-abcdef-rt-01', network: 'gcm-20261025-abcdef-net', ip: '172.31.250.10',
    envFile: '/x/env', image: plan.images.realtime.config, resources: plan.resources.realtime });
  assert.ok(argv.includes('--pull=never'));
  assert.equal(argv.at(-1), plan.images.realtime.config);
  assert.deepEqual(argv.slice(argv.indexOf('--platform'), argv.indexOf('--platform') + 2), ['--platform', 'linux/amd64']);
  for (const flag of ['--memory', '--cpus', '--pids-limit', '--env-file', '--ip']) assert.ok(argv.includes(flag), flag);
  assert.ok(!argv.some((a) => /:latest|supabase\/realtime/.test(a)));
  assert.throws(() => realtimeRunArgv({ name: 'n-ok-1', network: 'net-1', ip: 'x', envFile: 'e', image: 'supabase/realtime:v2', resources: plan.resources.realtime }), /BAD_PLAN/);
  assert.throws(() => realtimeRunArgv({ name: '--privileged', network: 'net-1', ip: 'x', envFile: 'e', image: plan.images.realtime.config, resources: plan.resources.realtime }), /BAD_PLAN/);
  const pg = postgresRunArgv({ name: 'gcm-x-pg', network: 'gcm-x-net', ip: '172.31.250.20', envFile: '/e', image: `sha256:${'a'.repeat(64)}`,
    volume: 'gcm-x-pgdata', resources: plan.resources.postgres });
  assert.ok(pg.includes('--pull=never') && pg.includes('gcm-x-pgdata:/var/lib/postgresql/data'));
  assert.deepEqual(pg.slice(pg.indexOf('--log-driver'), pg.indexOf('--log-driver') + 4), ['--log-driver', 'json-file', '--log-opt', 'max-size=16m'],
    'no daemon-default driver that could ship PostgreSQL logs off the host');
  assert.deepEqual(teardownArgv({ names: ['gcm-x-rt-01', 'gcm-x-pg'], volume: 'gcm-x-pgdata', network: 'gcm-x-net' }), [
    ['rm', '--force', '--volumes', 'gcm-x-rt-01'], ['rm', '--force', '--volumes', 'gcm-x-pg'],
    ['volume', 'rm', 'gcm-x-pgdata'], ['network', 'rm', 'gcm-x-net']]);
});

test('env files refuse injection and carry K or Kbad only through the secret set', () => {
  assert.equal(envFileText({ A: '1', B_C: 'x y' }), 'A=1\nB_C=x y\n');
  for (const env of [{ A: 'x\nB=1' }, { a: '1' }, { A: 1 }]) assert.throws(() => envFileText(env), /BAD_PLAN/);
  const plan = manifest();
  const secrets = generateSecrets(plan);
  assert.equal(realtimeEnv({ plan, secrets, key: 'K' }).DB_ENC_KEY_GCM, secrets.gcmKey);
  assert.equal(realtimeEnv({ plan, secrets, key: 'Kbad' }).DB_ENC_KEY_GCM, secrets.gcmKeyBad);
  assert.throws(() => realtimeEnv({ plan, secrets, key: 'legacy' }), /BAD_PLAN/);
});

test('generated secrets satisfy the case machine: 32-byte keys from 24 random bytes', () => {
  const plan = manifest();
  const s = generateSecrets(plan);
  validateSecrets(s);
  assert.equal(Buffer.byteLength(s.gcmKey), 32);
  assert.equal(Buffer.from(s.gcmKey, 'base64').length, 24);
  assert.equal(Buffer.byteLength(s.legacyKey), 16);
  assert.equal(s.tenants.a.db.db_user, plan.tenants.a.dbUser);
  assert.notEqual(generateSecrets(plan).gcmKey, s.gcmKey);
});

test('log entries group a crash report header with its continuation lines', () => {
  const ts = '2026-10-25T12:00:00.000000000Z';
  const text = [`${ts} 12:00:00.001 [info] boot`, `${ts} 12:00:00.002 [error] GenServer x terminating external_id=gcm-fixture-a`,
    `${ts} ** (RuntimeError) ${GCM_TEXT}`, `${ts}     (realtime) lib/realtime/crypto.ex:1`, `${ts} [error] next`].join('\n');
  assert.deepEqual(logEntries(text).map((e) => [e.known, e.text.split('\n').length]), [[true, 1], [true, 3], [true, 1]]);
  // A line that is neither a header nor a continuation starts an unknown entry; it never borrows.
  const odd = [`${ts} 12:00:00.002 [error] crash external_id=gcm-fixture-a`, `${ts} something else ${GCM_TEXT}`,
    `${ts} request_id=F1 external_id=gcm-fixture-b [error] crash`, `${ts} ** (RuntimeError) ${GCM_TEXT}`].join('\n');
  assert.deepEqual(logEntries(odd).map((e) => e.known), [true, false, true]);
  assert.deepEqual(countLogFailures(odd, { a: 'gcm-fixture-a', b: 'gcm-fixture-b' }), { gcmFailures: 2, byTenant: { a: 0, b: 1 },
    byConsumer: { a: { socket: 0, broadcast: 0, untagged: 0 }, b: { socket: 0, broadcast: 0, untagged: 1 } }, unattributed: 1 });
});

test('log counting attributes a failure entry only by exact external_id metadata or its Server host', () => {
  const ids = { a: 'gcm-fixture-a', b: 'gcm-fixture-b' };
  const entry = (...lines) => lines.map((l) => `2026-10-25T12:00:00Z ${l}`).join('\n');
  const text = [
    entry('12:00:00.000 [error] GenServer {Connect, "x"} terminating external_id=gcm-fixture-a', `** (RuntimeError) ${GCM_TEXT}`),
    entry('12:00:00.001 [error] #PID<0.1.0> running RealtimeWeb.Endpoint terminated', 'Server: gcm-fixture-b.realtime-gcm.invalid:4000 (http)',
      '** (exit) an exception was raised:', `    ** (RuntimeError) ${GCM_TEXT}`),
    entry('12:00:00.002 [error] crash', `** (RuntimeError) ${GCM_TEXT}`),
    entry('12:00:00.003 [error] crash external_id=gcm-fixture-ab', `** (RuntimeError) ${GCM_TEXT}`),
    entry('12:00:00.004 [error] crash tenant_external_id=gcm-fixture-b', `** (RuntimeError) ${GCM_TEXT}`),
    entry('12:00:00.005 [error] crash external_id=gcm-fixture-a', 'Server: gcm-fixture-b.realtime-gcm.invalid:4000 (http)', `** ${GCM_TEXT}`),
    entry('12:00:00.006 [error] crash', 'Server: gcm-fixture-a.example.com:4000 (http)', `** ${GCM_TEXT}`),
    entry('12:00:00.007 [error] decryption failed external_id=gcm-fixture-b'),
  ].join('\n');
  assert.deepEqual(countLogFailures(text, ids, 'realtime-gcm.invalid'), { gcmFailures: 7, byTenant: { a: 1, b: 1 },
    byConsumer: { a: { socket: 0, broadcast: 0, untagged: 1 }, b: { socket: 0, broadcast: 0, untagged: 1 } }, unattributed: 5 });
  const tagged = [entry('12:00:00.000 [error] #PID<0.1.0> running RealtimeWeb.Endpoint terminated', 'Server: gcm-fixture-a.realtime-gcm.invalid:4000 (http)',
    'Request: GET /socket/websocket?apikey=x', `    ** (RuntimeError) ${GCM_TEXT}`),
  entry('12:00:00.001 [error] #PID<0.1.0> running RealtimeWeb.Endpoint terminated', 'Server: gcm-fixture-a.realtime-gcm.invalid:4000 (http)',
    'Request: POST /api/broadcast', `    ** (RuntimeError) ${GCM_TEXT}`)].join('\n');
  assert.deepEqual(countLogFailures(tagged, ids).byConsumer.a, { socket: 1, broadcast: 1, untagged: 0 });
});

test('the lifecycle starts a new container per start, removes the key file and proves the stop', async () => {
  const plan = manifest();
  const secrets = generateSecrets(plan);
  const calls = [];
  const files = new Map();
  let inspectAfterRm = false;
  const exec = async (args) => {
    calls.push(args);
    if (args[0] === 'inspect') {
      if (inspectAfterRm) return { code: 1, stdout: '', stderr: 'No such object' };
      return { code: 0, stdout: `cid-${calls.length} 2026-10-25T12:00:00Z 42 ${plan.images.realtime.config} true\n` };
    }
    if (args[0] === 'rm') inspectAfterRm = true;
    if (args[0] === 'logs') return { code: 0, stdout: `12:00:00.000 [error] crash external_id=gcm-fixture-a\n** (RuntimeError) ${GCM_TEXT}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const store = { logs: [], appendLog(n, t) { this.logs.push([n, t]); } };
  const life = createLifecycleAdapter({ exec, plan, secrets, attempt: 'gcm-20261025-abcdef', store, clock: { now: () => 0 },
    files: { writePrivate: (n, t) => { files.set(n, t); return `/p/${n}`; }, remove: (p) => files.delete(p.slice(3)) },
    http: async () => ({ status: 200 }) });
  const started = await life.start({ key: 'Kbad' });
  assert.equal(started.key, 'Kbad');
  assert.equal(files.size, 0, 'the env file holding the key is gone once the container exists');
  const run = calls.find((c) => c[0] === 'run');
  assert.equal(run[run.indexOf('--name') + 1], 'gcm-20261025-abcdef-rt-01');
  assert.equal(run.at(-1), plan.images.realtime.config);
  assert.deepEqual(await life.logsSince('2026-10-25T12:00:00.000Z'), { gcmFailures: 1, byTenant: { a: 1, b: 0 },
    byConsumer: { a: { socket: 0, broadcast: 0, untagged: 1 }, b: { socket: 0, broadcast: 0, untagged: 0 } }, unattributed: 0, truncated: false });
  const stopped = await life.stop();
  assert.deepEqual([stopped.gone, stopped.logsComplete, stopped.identity], [true, true, started.identity]);
  inspectAfterRm = false;
  const again = await life.start({ key: 'K' });
  assert.notEqual(again.identity, started.identity);
  assert.deepEqual(life.created(), ['gcm-20261025-abcdef-rt-01', 'gcm-20261025-abcdef-rt-02']);
  assert.equal(calls.filter((c) => c[0] === 'run').at(-1)[calls.filter((c) => c[0] === 'run').at(-1).indexOf('--name') + 1], 'gcm-20261025-abcdef-rt-02');
});

test('the lifecycle removes the key file even when docker run fails, and refuses a wrong image', async () => {
  const plan = manifest();
  const secrets = generateSecrets(plan);
  const files = new Map();
  const mk = (exec) => createLifecycleAdapter({ exec, plan, secrets, attempt: 'gcm-20261025-abcdef', store: { appendLog() {} },
    clock: { now: () => 0 }, http: async () => ({ status: 200 }),
    files: { writePrivate: (n, t) => { files.set(n, t); return `/p/${n}`; }, remove: (p) => files.delete(p.slice(3)) } });
  await assert.rejects(mk(async () => ({ code: 125, stdout: '', stderr: 'no such image' })).start({ key: 'K' }), /START_FAILED/);
  assert.equal(files.size, 0);
  const wrongImage = async (args) => (args[0] === 'inspect' ? { code: 0, stdout: `c 2026 1 sha256:${'b'.repeat(64)} true` } : { code: 0, stdout: '' });
  await assert.rejects(mk(wrongImage).start({ key: 'K' }), /START_FAILED/);
});

test('the private store requires a 0700 directory, writes exclusively at 0600 and chains records', async (t) => {
  const dir = scratch(t, 'gcm-store-');
  chmodSync(dir, 0o700);
  const store = createPrivateStore({ dir, unlink: unlinkSync, maxBytes: 4096 });
  await store.append({ a: 1 });
  await store.append({ b: 2 });
  const [r1, r2] = readFileSync(join(dir, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(r1.prev, '0'.repeat(64));
  assert.equal(r2.prev, (await import('../scripts/r3_realtime_gcm.mjs')).sha256(readFileSync(join(dir, 'records.jsonl'), 'utf8').split('\n')[0]));
  await store.sealPrivate('baseline-a', { v: 1 });
  await assert.rejects(store.sealPrivate('baseline-a', { v: 2 }), /EEXIST/);
  for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  assert.throws(() => store.writePrivate('../escape', 'x'), /CUSTODY/);
  await assert.rejects(store.sealPrivate('big', { x: 'y'.repeat(5000) }), /CAP_EXCEEDED/);
  assert.throws(() => createPrivateStore({ dir, unlink: unlinkSync, fs: { lstatSync: () => ({ isDirectory: () => true, mode: 0o40755 }) } }), /CUSTODY/);
});

test('bootstrap rendering admits only SCRAM verifiers or fixed identifiers, never a plaintext password', () => {
  const stmts = [{ database: 'postgres', sql: "CREATE ROLE r LOGIN PASSWORD '{{pw}}'" }];
  const v = scramVerifier('ab'.repeat(32));
  assert.equal(renderBootstrap(stmts, { pw: v })[0].sql, `CREATE ROLE r LOGIN PASSWORD '${v}'`);
  for (const pw of ["x'; DROP ROLE postgres; --", 'ab'.repeat(32), `${v}'`, undefined]) assert.throws(() => renderBootstrap(stmts, { pw }), /BAD_PLAN/);
  const plan = manifest();
  const s = generateSecrets(plan);
  const rendered = renderBootstrap(plan.bootstrap.statements, { meta_verifier: scramVerifier(s.metaPassword),
    tenant_a_verifier: scramVerifier(s.tenants.a.db.db_password), tenant_b_verifier: scramVerifier(s.tenants.b.db.db_password) });
  assert.ok(rendered.every((r) => !r.sql.includes('{{')));
  const text = rendered.map((r) => r.sql).join('\n');
  for (const pw of [s.metaPassword, s.tenants.a.db.db_password, s.tenants.b.db.db_password]) assert.ok(!text.includes(pw));
  assert.ok(text.includes('REVOKE CONNECT, TEMPORARY ON DATABASE gcm_tenant_a FROM PUBLIC'));
});

test('scramVerifier matches the RFC 7677 test vector shape and PostgreSQL derivation', () => {
  // RFC 7677 section 3: user "user", password "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ==, i=4096.
  const v = scramVerifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'));
  const [, rest] = v.split('$4096:');
  const [salt, keys] = rest.split('$');
  assert.equal(salt, 'W22ZaJ0SNY7soEsUEjb6gQ==');
  // ServerKey from the RFC's ServerSignature derivation: HMAC(SaltedPassword, "Server Key").
  assert.equal(keys.split(':')[1], 'wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=');
  // A server holding only the verifier accepts the RFC's client proof (StoredKey check) and
  // answers with the RFC's server signature (ServerKey).
  const [storedKey, serverKey] = keys.split(':').map((k) => Buffer.from(k, 'base64'));
  const authMessage = 'n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,'
    + 's=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
  const hmac = (k) => createHmac('sha256', k).update(authMessage).digest();
  const clientSignature = hmac(storedKey);
  const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
  const clientKey = Buffer.from(proof.map((b, i) => b ^ clientSignature[i]));
  assert.ok(createHash('sha256').update(clientKey).digest().equals(storedKey));
  assert.equal(hmac(serverKey).toString('base64'), '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
});

const boundManifest = () => {
  const m = manifest();
  m.executable = true;
  m.blockedBy = [];
  for (const b of [...m.source.requiredBindings, ...m.source.pendingBindings]) b.sha256 = 'c'.repeat(64);
  m.images.postgres.manifest = `sha256:${'d'.repeat(64)}`;
  m.images.postgres.config = `sha256:${'e'.repeat(64)}`;
  for (const l of Object.values(m.libraries)) l.treeSha256 = 'f'.repeat(64);
  m.bootstrap.reviewed = true;
  return m;
};
const approvalFor = (hashes, now, evidenceDir = '/srv/evidence') => ({ purpose: 'R3_REALTIME_GCM_CONSUMER_SINGLE_ATTEMPT', singleAttempt: true,
  attemptId: 'gcm-20261025-abcdef', manifestSha256: hashes[MANIFEST_PATH], evidenceDir, runBinding: null,
  harness: Object.fromEntries(HARNESS_FILES.map((f) => [f, hashes[f]])),
  issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() });

test('the committed manifest is self-consistent but cannot execute', () => {
  const m = manifest();
  assert.deepEqual(manifestRefusals(m), []);
  const refusals = executionRefusals({ manifest: m, approval: null, hashes: harnessHashes(), now: Date.now() });
  for (const r of ['manifest is not executable', 'bootstrap not reviewed', 'image postgres config unbound', 'library realtimeJs unbound',
    'unbound source rel/overlays/bin/migrate', 'blocked: SOURCE_BINDINGS', 'no approval']) assert.ok(refusals.includes(r), r);
  assert.ok(!refusals.some((r) => r.startsWith('unbound source run.sh')), 'the 30 retained bindings are bound');
  assert.ok(!refusals.includes('expected.dbJoinReasons unbound'));
});

test('execution needs a fully bound manifest and an approval naming its exact hashes in its window', () => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  const hashes = Object.fromEntries(HARNESS_FILES.map((f, i) => [f, String(i).repeat(64)]));
  const m = boundManifest();
  const ok = { manifest: m, hashes, now, evidenceDir: '/srv/evidence' };
  assert.deepEqual(executionRefusals({ ...ok, approval: approvalFor(hashes, now) }), []);
  assert.ok(executionRefusals({ ...ok, evidenceDir: '/srv/other', approval: approvalFor(hashes, now) })
    .includes('approval names another evidence directory'));
  const edits = [
    (a) => { a.manifestSha256 = '9'.repeat(64); },
    (a) => { a.harness['infra/scripts/r3_realtime_gcm.mjs'] = '9'.repeat(64); },
    (a) => { a.singleAttempt = false; },
    (a) => { a.attemptId = 'reuse'; },
    (a) => { a.expiresAt = new Date(now - 1).toISOString(); },
    (a) => { a.issuedAt = new Date(now - 25 * 3_600_000).toISOString(); a.expiresAt = new Date(now + 1000).toISOString(); },
  ];
  for (const edit of edits) {
    const a = approvalFor(hashes, now);
    edit(a);
    assert.ok(executionRefusals({ ...ok, approval: a }).length > 0);
  }
  const envLeak = boundManifest();
  envLeak.realtimeEnv.DB_ENC_KEY_GCM = 'x'.repeat(32);
  assert.ok(manifestRefusals(envLeak).includes('realtimeEnv must not carry DB_ENC_KEY_GCM'));
  const drift = boundManifest();
  drift.realtimeEnv.DB_AFTER_CONNECT_QUERY = 'SET search_path TO public';
  assert.ok(manifestRefusals(drift).includes('metadata schema and search_path differ'));
  const seed = boundManifest();
  seed.realtimeEnv.SEED_SELF_HOST = 'true';
  assert.ok(manifestRefusals(seed).length);
});

test('an approval is consumed once in the fixed ledger, whatever evidence directory is used', (t) => {
  const ledger = join(scratch(t, 'gcm-ledger-'), 'ledger');
  consumeAttempt(ledger, 'gcm-20261025-abcdef');
  assert.equal(statSync(ledger).mode & 0o777, 0o700);
  assert.throws(() => consumeAttempt(ledger, 'gcm-20261025-abcdef'), (e) => e instanceof HarnessError && e.code === 'REPLAY');
  assert.equal(statSync(join(ledger, 'attempt-gcm-20261025-abcdef.consumed')).mode & 0o777, 0o600);
  assert.throws(() => consumeAttempt(ledger, '../x'), /CUSTODY/);
  chmodSync(ledger, 0o755);
  assert.throws(() => consumeAttempt(ledger, 'gcm-20261025-zzzzzz'), /CUSTODY/);
});

test('the evidence directory must be canonical, private, owned and empty', (t) => {
  const d = scratch(t, 'gcm-evidence-');
  chmodSync(d, 0o700);
  assert.doesNotThrow(() => checkEvidenceDir(d));
  assert.throws(() => checkEvidenceDir(`${d}/../${d.split('/').at(-1)}`), /CUSTODY/);
  writeFileSync(join(d, 'old'), 'x');
  assert.throws(() => checkEvidenceDir(d), /must be empty/);
  unlinkSync(join(d, 'old'));
  chmodSync(d, 0o750);
  assert.throws(() => checkEvidenceDir(d), /0700/);
});

test('an approval is read from its exact canonical bytes with exactly the expected keys', () => {
  const hashes = Object.fromEntries(HARNESS_FILES.map((f, i) => [f, String(i).repeat(64)]));
  const a = approvalFor(hashes, Date.parse('2026-10-26T10:00:00Z'));
  const text = canonicalJson(a);
  assert.deepEqual(Object.keys(JSON.parse(text)), APPROVAL_KEYS);
  assert.deepEqual(parseApproval(text, sha256(text)).refusals, []);
  assert.ok(parseApproval(text, sha256(`${text} `)).refusals.includes('approval bytes differ from the out-of-band hash'));
  const dup = text.replace('"purpose"', '"purpose": "OTHER",\n  "purpose"');
  assert.ok(parseApproval(dup, sha256(dup)).refusals.includes('approval is not in canonical form'));
  const extra = canonicalJson({ ...a, retry: true });
  assert.ok(parseApproval(extra, sha256(extra)).refusals.includes('approval keys'));
  const harnessExtra = canonicalJson({ ...a, harness: { ...a.harness, 'x.mjs': '0'.repeat(64) } });
  assert.ok(parseApproval(harnessExtra, sha256(harnessExtra)).refusals.includes('approval harness keys'));
  assert.ok(parseApproval('{', sha256('{')).refusals.includes('approval is not JSON'));
});

test('manifest values that reach URLs, SQL or the network are refused unless fixed and inside the subnet', () => {
  const edits = [
    [(m) => { m.metadata.database = 'gcm_meta?host=203.0.113.9'; }, 'metadata.database must be a fixed identifier'],
    [(m) => { m.images.postgres.ownerUser = 'x@y'; }, 'images.postgres.ownerUser must be a fixed identifier'],
    [(m) => { m.network.postgresIp = '203.0.113.9'; m.realtimeEnv.DB_HOST = '203.0.113.9'; }, 'network.postgresIp must be a host address inside the subnet'],
    [(m) => { m.network.subnet = '8.8.8.0/24'; }, 'network.subnet must be one private /24'],
    [(m) => { m.network.realtimeIp = m.network.postgresIp; }, 'network addresses must differ'],
    [(m) => { m.bootstrap.statements[0].database = 'template1'; }, 'bootstrap targets template1'],
    [(m) => { m.runtime.dockerHost = 'tcp://203.0.113.9:2375'; }, 'runtime.dockerHost must be a unix socket'],
    [(m) => { m.runtime.ledgerDir = 'relative'; }, 'runtime paths must be absolute'],
  ];
  for (const [edit, refusal] of edits) {
    const m = manifest();
    edit(m);
    assert.ok(manifestRefusals(m).includes(refusal), refusal);
  }
});

test('the runner without --execute only reports; with --execute it refuses the committed manifest', async () => {
  const out = [];
  assert.equal(await main([], (m) => out.push(m)), 0);
  const report = JSON.parse(out[0]);
  assert.equal(report.planned.processStarts, 27);
  assert.ok(report.refusals.includes('manifest is not executable'));
  assert.equal(await main(['--execute', '--evidence-dir', '/nonexistent'], (m) => out.push(m)), 2);
  assert.match(out.at(-1), /^REFUSED: /);
});

// ---- guards the first mutation pass found untested ------------------------------------------

const newSession = async (onSubscribe, { open = true, timeoutMs = 300 } = {}) => {
  FakeWs.instances = [];
  const adapter = createSocketsAdapter({ libs: { RealtimeClient: FakeRealtimeClient, WebSocket: FakeWs }, port: 4000,
    lookup: () => {}, limits: { ...limits, framesPerSession: 128 }, vsn: '2.0.0' });
  const pending = adapter.open({ hostname: 'a.realtime-gcm.invalid', token: 'jwt', timeoutMs });
  await new Promise((r) => { setTimeout(r, 10); });
  if (open) FakeWs.instances[0].emit('open');
  const s = await pending;
  FakeRealtimeClient.last.onSubscribe = onSubscribe;
  return { s, adapter };
};

test('an open that never settles is a timeout, not a close', async () => {
  const { s } = await newSession(() => {}, { open: false, timeoutMs: 60 });
  assert.equal(s.status, 'timeout');
  await s.close();
});

test('only the postgres_changes ok system message marks the subscription ready', async () => {
  const { s } = await newSession((ch) => {
    ch.cb('SUBSCRIBED');
    ch.handlers.find((h) => h.type === 'system').cb({ extension: 'presence', status: 'ok' });
    ch.handlers.find((h) => h.type === 'system').cb({ extension: 'postgres_changes', status: 'error' });
  });
  assert.deepEqual(await s.join({ topic: 't', schema: 's', table: 't', timeoutMs: 80 }), { status: 'subscribed', postgresChangesReady: false });
  await s.close();
});

test('an INSERT is matched by its row id', async () => {
  const { s } = await newSession((ch) => {
    ch.cb('SUBSCRIBED');
    ch.handlers.find((h) => h.type === 'postgres_changes').cb({ new: { id: 'r1', nonce: 'n' } });
  });
  await s.join({ topic: 't', schema: 's', table: 't', timeoutMs: 50 });
  assert.equal((await s.expectInsert({ id: 'r9', nonce: 'n', timeoutMs: 40 })).received, false);
  await s.close();
});

test('the run-wide transcript cap terminates a session', () => {
  const state = newState();
  const totals = { bytes: 0 };
  const T = makeTransport({ WebSocket: FakeWs, lookup: () => {}, state, limits: { ...limits, framesPerSession: 1000, transcriptBytes: 10 },
    expectedHost: 'a.realtime-gcm.invalid', totals });
  const ws = new T('ws://a.realtime-gcm.invalid:4000/socket/websocket');
  ws.emit('message', Buffer.alloc(6), true);
  assert.deepEqual(state.violations, []);
  ws.emit('message', Buffer.alloc(6), true);
  assert.deepEqual(state.violations, ['FRAME_LIMIT']);
  assert.equal(ws.readyState, 3);
});

test('a conditional DB-field write matches the old value as a parameter', async () => {
  const p = fakePrisma([], [1]);
  const m = createMetadataAdapter({ prisma: p, Prisma, schema: '_realtime' });
  await m.conditionalReplace({ externalId: 'e', field: 'db_host', expected: 'OLD', value: 'NEW' });
  assert.match(p.seen[0].sql, /settings ->> \? = \?/);
  assert.deepEqual(p.seen[0].values.slice(-2), ['db_host', 'OLD']);
});

test('a tenant INSERT that affects no row is refused', async () => {
  const db = createTenantDbAdapter({ clients: { a: fakePrisma([], [0]) }, Prisma, schema: 'gcm_fixture', table: 'events', databases: { a: 'd' } });
  await assert.rejects(db.insert('a', { id: 'i', caseId: 'c', nonce: 'n' }), /ROW_COUNT/);
});

const lifecycleWith = (overrides, planEdit = (p) => p) => {
  const plan = planEdit(manifest());
  let removed = false;
  const exec = async (args) => {
    if (overrides[args[0]]) return overrides[args[0]](args, removed);
    if (args[0] === 'inspect') return removed ? { code: 1, stdout: '' } : { code: 0, stdout: `cid 2026 7 ${plan.images.realtime.config} true` };
    if (args[0] === 'rm') removed = true;
    return { code: 0, stdout: '', stderr: '' };
  };
  return createLifecycleAdapter({ exec, plan, secrets: generateSecrets(plan), attempt: 'gcm-20261025-abcdef', store: { appendLog() {} },
    clock: { now: () => 0 }, http: overrides.http ?? (async () => ({ status: 200 })),
    files: { writePrivate: (n) => `/p/${n}`, remove: () => {} } });
};

test('a stop is gone only when the container no longer inspects, and complete only with whole logs', async () => {
  const stillThere = lifecycleWith({ inspect: () => ({ code: 0, stdout: `cid 2026 7 ${manifest().images.realtime.config} true` }) });
  await stillThere.start({ key: 'K' });
  assert.equal((await stillThere.stop()).gone, false);
  const truncated = lifecycleWith({ logs: () => ({ code: 0, stdout: 'x', stderr: '', truncated: true }) });
  await truncated.start({ key: 'K' });
  assert.equal((await truncated.stop()).logsComplete, false);
});

test('logsSince reports truncation and failed reads', async () => {
  for (const r of [{ code: 0, stdout: '', stderr: '', truncated: true }, { code: 1, stdout: '', stderr: '' }]) {
    const life = lifecycleWith({ logs: () => r });
    await life.start({ key: 'K' });
    assert.equal((await life.logsSince('2026-10-25T00:00:00Z')).truncated, true);
  }
});

test('a start is refused until its healthcheck answers 200 within the probe bound', async () => {
  let probes = 0;
  const life = lifecycleWith({ http: async () => { probes += 1; return { status: 503 }; } },
    (p) => ({ ...p, limits: { ...p.limits, readinessProbes: 3, readinessIntervalMs: 1 } }));
  await assert.rejects(life.start({ key: 'K' }), /START_FAILED/);
  assert.equal(probes, 3);
});

test('a private file whose write fails is removed, so no partial key file stays behind', (t) => {
  const d = scratch(t, 'gcm-store-fail-');
  chmodSync(d, 0o700);
  const realFs = { openSync: (...a) => openReal(...a), writeSync: () => { throw Object.assign(new Error('nospace'), { code: 'ENOSPC' }); },
    fsyncSync: () => {}, closeSync: (fd) => closeReal(fd), lstatSync: (p) => statSync(p) };
  const store = createPrivateStore({ dir: d, unlink: unlinkSync, fs: realFs });
  assert.throws(() => store.writePrivate('env-x', 'DB_ENC_KEY_GCM=k\n'), /nospace/);
  assert.deepEqual(readdirSync(d), []);
});

test('the secret directory is a fresh 0700 directory removed whole by destroy()', (t) => {
  const parent = scratch(t, 'gcm-secret-parent-');
  const sd = createSecretDir(parent, { unlink: unlinkSync });
  assert.equal(statSync(sd.dir).mode & 0o777, 0o700);
  sd.writePrivate('env-a', 'K=v\n');
  sd.destroy();
  assert.equal(existsSync(sd.dir), false);
  assert.deepEqual(readdirSync(parent), []);
});

test('the docker CLI runs with a pinned daemon, an empty config and nothing else from the environment', async () => {
  assert.throws(() => dockerExec('/usr/bin/docker', { dockerHost: 'tcp://1.2.3.4:2375', configDir: '/x' }), /BAD_PLAN/);
  const exec = dockerExec(process.execPath, { dockerHost: 'unix:///var/run/docker.sock', configDir: '/nonexistent-config' });
  const r = await exec(['-e', 'process.stdout.write(JSON.stringify(process.env))']);
  const env = JSON.parse(r.stdout);
  delete env.__CF_USER_TEXT_ENCODING; // macOS adds this to every child
  assert.deepEqual(env, { PATH: '/usr/bin:/bin', HOME: '/nonexistent-config', DOCKER_CONFIG: '/nonexistent-config',
    DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CLI_HINTS: 'false' });
});

test('dockerIdentity accepts only a linux/x86_64 daemon', async () => {
  assert.deepEqual(await dockerIdentity(async () => ({ code: 0, stdout: 'ID1|linux|x86_64|28.5.1\n' })),
    { id: 'ID1', os: 'linux', arch: 'x86_64', version: '28.5.1' });
  for (const out of ['ID1|linux|aarch64|28', 'ID1|windows|x86_64|28', '']) {
    await assert.rejects(dockerIdentity(async () => ({ code: 0, stdout: out })), /RUNTIME/);
  }
});

test('the secret guard sees every secret at every Base64 alignment, in hex and URL-encoded', () => {
  const plan = manifest();
  const s = generateSecrets(plan);
  const list = secretStrings(s);
  for (const secret of [s.ownerPassword, s.metaPassword, s.metricsJwtSecret, s.secretKeyBase, s.gcmKey]) {
    for (const k of [0, 1, 2]) {
      const embedded = Buffer.concat([Buffer.from('xy'.slice(0, k)), Buffer.from(secret), Buffer.from('tail')]).toString('base64');
      assert.throws(() => assertNoSecrets(embedded, list), /SECRET_IN_EVIDENCE/, `offset ${k}`);
    }
    assert.throws(() => assertNoSecrets(Buffer.from(secret).toString('hex').toUpperCase(), list), /SECRET_IN_EVIDENCE/);
    assert.throws(() => assertNoSecrets(encodeURIComponent(secret), list), /SECRET_IN_EVIDENCE/);
    assert.throws(() => assertNoSecrets(`cut:${secret.slice(0, 20)}`, list), /SECRET_IN_EVIDENCE/);
  }
  assert.doesNotThrow(() => assertNoSecrets(JSON.stringify({ db_host: s.tenants.a.db.db_host, db_user: s.tenants.a.db.db_user }), list));
  assert.ok(secretForms('short').length === 0 || secretForms('short').every((f) => f.length >= 12));
});

// ---- execute() with fake dependencies -------------------------------------------------------

const executeFixture = (t, { exec: execOverride = {}, deps: depOverride = {} } = {}) => {
  const base = scratch(t, 'gcm-exec-');
  const evidenceDir = join(base, 'evidence');
  mkdirSync(evidenceDir, { mode: 0o700 });
  const m = boundManifest();
  mkdirSync(join(base, 'shm'), { mode: 0o700 });
  m.runtime = { ...m.runtime, ledgerDir: join(base, 'ledger'), secretParent: join(base, 'shm') };
  const hashes = Object.fromEntries(HARNESS_FILES.map((f, i) => [f, String(i).repeat(64)]));
  const approval = approvalFor(hashes, Date.now(), evidenceDir);
  const events = [];
  const secretDirs = [];
  const handlers = new Map();
  const exits = [];
  const shm = join(base, 'shm');
  const fs = { openSync, writeSync: writeSyncReal, closeSync: closeReal, fsyncSync: () => {}, lstatSync: (p) => statSync(p), mkdirSync,
    readdirSync, realpathSync, statfsSync: (p) => ({ type: p === shm || p.startsWith(`${shm}/`) ? 0x01021994 : 0xef53 }) };
  const exec = async (args) => {
    events.push(`docker ${args.slice(0, 2).join(' ')}`);
    const o = execOverride[args[0]];
    if (o) return o(args);
    if (args[1] === 'inspect' && args[0] === 'image') return { code: 0, stdout: `${args.at(-1)} linux/amd64\n` };
    if (args[1] === 'inspect') return { code: 1, stdout: '' };
    return { code: 0, stdout: '' };
  };
  const deps = {
    resolveLibraries: async () => {
      events.push(`libraries ledger=${existsSync(join(m.runtime.ledgerDir, `attempt-${approval.attemptId}.consumed`))}`);
      return { bound: {}, PrismaClient: class { $queryRaw() { return Promise.resolve([{ ok: 1 }]); } $executeRawUnsafe() { events.push('sql'); return Promise.resolve(0); } $disconnect() { return Promise.resolve(); } }, Prisma, jose: {} };
    },
    dockerExec: () => exec,
    dockerIdentity: async () => { events.push('identity'); return { id: 'D', os: 'linux', arch: 'x86_64', version: '28' }; },
    createSecretDir: (parent, o) => { const d = createSecretDir(parent, o); secretDirs.push(d.dir); return d; },
    runQualification: async () => { events.push('run'); return { verdict: 'CONSUMER_CASES_PASSED', cases: [] }; },
    harnessHashes: () => hashes,
    nodeVersion: m.node.version,
    signals: { on: (s, f) => handlers.set(s, f), removeListener: (s) => handlers.delete(s), exit: (c) => exits.push(c) },
    fs,
    env: {},
    ...depOverride,
  };
  return { m, approval, evidenceDir, deps, events, secretDirs, handlers, hashes, exits, base };
};

test('execute consumes the ledger before any effect, then tears down only what it created', async (t) => {
  const f = executeFixture(t);
  const r = await execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps });
  assert.equal(r.verdict, 'CONSUMER_CASES_PASSED');
  assert.equal(f.events[0], 'libraries ledger=true');
  assert.ok(f.events.indexOf('identity') < f.events.indexOf('docker image inspect'));
  assert.ok(f.events.indexOf('docker network create') > f.events.lastIndexOf('docker container inspect'));
  const removals = f.events.filter((e) => /^docker (rm|volume rm|network rm)/.test(e));
  assert.deepEqual(removals, ['docker rm --force', 'docker volume rm', 'docker network rm'], 'pg container, volume, network only');
  assert.ok(f.secretDirs.every((d) => !existsSync(d)), 'secret and config directories are gone');
  assert.equal(f.handlers.size, 0, 'signal handlers removed');
  assert.ok(!readdirSync(f.evidenceDir).some((n) => n.startsWith('env-')), 'no env file in the evidence directory');
  await assert.rejects(execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps }), /CUSTODY|REPLAY/);
});

test('execute refuses a wrong node, a wrong image or a name already in use before creating anything', async (t) => {
  const cases = [
    [{ deps: { nodeVersion: 'v20.0.0' } }, /RUNTIME/],
    [{ exec: { image: () => ({ code: 0, stdout: 'sha256:other linux/amd64' }) } }, /IMAGE_MISMATCH/],
    [{ exec: { volume: (a) => ({ code: a[1] === 'inspect' ? 0 : 0, stdout: '' }) } }, /NAME_IN_USE/],
  ];
  for (const [o, err] of cases) {
    const f = executeFixture(t, o);
    await assert.rejects(execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps }), err);
    assert.ok(!f.events.some((e) => /create|docker run/.test(e)), String(err));
    assert.ok(!f.events.some((e) => /^docker (rm|volume rm|network rm)/.test(e)), 'nothing to tear down');
    assert.ok(f.secretDirs.every((d) => !existsSync(d)));
  }
});

test('execute aborts a run whose harness files changed while it ran', async (t) => {
  const f = executeFixture(t);
  f.deps.harnessHashes = () => ({ ...f.hashes, 'infra/scripts/r3_realtime_gcm.mjs': 'f'.repeat(64) });
  const r = await execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps });
  assert.deepEqual([r.verdict, r.stopReason], ['ABORTED', 'HARNESS_CHANGED_DURING_RUN']);
});

test('--teardown removes only objects carrying this attempt\'s label, and its tmpfs secret directories', async (t) => {
  const base = scratch(t, 'gcm-td-');
  const m = manifest();
  m.runtime = { ...m.runtime, secretParent: base };
  const attempt = 'gcm-20261025-abcdef';
  mkdirSync(join(base, `tonyai-gcm-${attempt}-AbC123`));
  mkdirSync(join(base, 'tonyai-gcm-gcm-20261025-zzzzzz-Q'));
  const calls = [];
  const labelled = new Set([`${attempt}-rt-03`, `${attempt}-pg`, `${attempt}-pgdata`]);
  const r = await teardownAttempt({ manifest: m, attempt, deps: { dockerExec: () => async (a) => {
    calls.push(a);
    if (a[1] === 'inspect') return labelled.has(a.at(-1)) ? { code: 0, stdout: `${attempt}\n` } : { code: 1, stdout: '' };
    return { code: 0 };
  } } });
  assert.deepEqual(r.map((x) => x.args), [`rm --force --volumes ${attempt}-rt-03`, `rm --force --volumes ${attempt}-pg`, `volume rm ${attempt}-pgdata`]);
  assert.ok(calls.filter((a) => a[1] === 'inspect').every((a) => a.includes(`{{index ${a[0] === 'container' ? '.Config.Labels' : '.Labels'} "${ATTEMPT_LABEL}"}}`)));
  assert.deepEqual(readdirSync(base).sort(), ['tonyai-gcm-gcm-20261025-zzzzzz-Q'], 'only this attempt\'s secret dirs; the config dir too is gone');
  assert.deepEqual(attemptNames(attempt, m).realtime.at(-1), `${attempt}-rt-27`);
  for (const bad of ['*', 'gcm-20261025-ABCDEF', 'gcm-20261025-abcdefghijklm', 'gcm-2026102-abcdef']) {
    await assert.rejects(teardownAttempt({ manifest: m, attempt: bad, deps: { dockerExec: () => async () => ({ code: 0 }) } }), /BAD_PLAN/);
  }
});

test('a signal tears the attempt down once, waits for it, then exits 130', async (t) => {
  const f = executeFixture(t);
  let teardowns = 0;
  f.deps.runQualification = async () => {
    const h = f.handlers.get('SIGTERM');
    assert.ok(f.handlers.has('SIGINT') && f.handlers.has('SIGHUP'));
    h();
    f.handlers.get('SIGINT')();
    await new Promise((r) => { setTimeout(r, 20); });
    return { verdict: 'ABORTED', cases: [] };
  };
  const exec0 = f.deps.dockerExec();
  f.deps.dockerExec = () => async (a) => { if (a[0] === 'rm') teardowns += 1; return exec0(a); };
  await execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps });
  assert.deepEqual(f.exits, [130, 130], 'both signals exit only after the one teardown');
  assert.equal(teardowns, 1, 'the pg container is removed once');
  assert.ok(f.secretDirs.every((d) => !existsSync(d)));
  assert.equal(f.handlers.size, 0);
});

test('execute never starts a new docker command once a teardown began', async (t) => {
  const f = executeFixture(t);
  const exec0 = f.deps.dockerExec();
  let signalled = false;
  const late = [];
  f.deps.dockerExec = () => async (a) => { if (signalled) late.push(a.slice(0, 2).join(' ')); return exec0(a); };
  f.deps.runQualification = async ({ adapters }) => {
    f.handlers.get('SIGINT')();
    signalled = true;
    await assert.rejects(adapters.lifecycle.start({ key: 'K' }));
    return { verdict: 'ABORTED', cases: [] };
  };
  await execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps });
  assert.ok(!late.some((c) => c.startsWith('run ')), `no container started after the signal: ${late.join(', ')}`);
});

test('runtime facts: canonical tmpfs key files, a persistent ledger, the exact workflow run on its first attempt', (t) => {
  const base = scratch(t, 'gcm-rt-');
  mkdirSync(join(base, 'shm'));
  mkdirSync(join(base, 'disk'));
  const m = manifest();
  m.runtime = { ...m.runtime, secretParent: join(base, 'shm'), ledgerDir: join(base, 'disk', 'ledger', 'nested') };
  const types = { [join(base, 'shm')]: 0x01021994, [join(base, 'disk')]: 0xef53 };
  const fs = { realpathSync, lstatSync: (p) => statSync(p), statfsSync: (p) => ({ type: types[p] ?? 0xef53 }) };
  const run = { repository: 'tonyaiukco/TonyAI-mono-repo', runId: '123' };
  const gh = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: run.repository, GITHUB_RUN_ID: run.runId };
  assert.deepEqual(runtimeRefusals({ manifest: m, approval: { runBinding: null }, env: {}, fs }), []);
  assert.deepEqual(runtimeRefusals({ manifest: m, approval: { runBinding: run }, env: gh, fs }), []);
  assert.deepEqual(runtimeRefusals({ manifest: m, approval: { runBinding: run }, env: { ...gh, GITHUB_RUN_ATTEMPT: '2' }, fs }),
    ['a re-run of a workflow run never executes an approval']);
  assert.deepEqual(runtimeRefusals({ manifest: m, approval: { runBinding: run }, env: { ...gh, GITHUB_RUN_ID: '124' }, fs }),
    ['approval names another workflow run'], 'a new dispatch cannot replay an approval');
  assert.deepEqual(runtimeRefusals({ manifest: m, approval: { runBinding: null }, env: gh, fs }), ['approval names another workflow run']);
  assert.deepEqual(runtimeRefusals({ manifest: m, approval: { runBinding: run }, env: {}, fs }), ['approval is bound to a workflow run']);
  const viaDots = { ...m, runtime: { ...m.runtime, secretParent: `${join(base, 'shm')}/../disk` } };
  assert.ok(runtimeRefusals({ manifest: viaDots, approval: { runBinding: null }, env: {}, fs }).includes('runtime.secretParent must be a canonical tmpfs directory'));
  for (const type of [0x01021994, 0x858458f6, 0x794c7630]) {
    const f2 = { ...fs, statfsSync: (p) => ({ type: p === join(base, 'disk') ? type : types[p] ?? 0xef53 }) };
    assert.ok(runtimeRefusals({ manifest: m, approval: { runBinding: null }, env: {}, fs: f2 }).includes('runtime.ledgerDir must be on canonical persistent storage'));
  }
});

test('execute refuses the runtime before consuming the approval', async (t) => {
  const f = executeFixture(t, { deps: { env: { GITHUB_ACTIONS: 'true', GITHUB_RUN_ATTEMPT: '1' } } });
  await assert.rejects(execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps }), /RUNTIME/);
  assert.equal(existsSync(join(f.m.runtime.ledgerDir, `attempt-${f.approval.attemptId}.consumed`)), false);
});

test('execute checks the evidence directory before consuming the approval', async (t) => {
  const f = executeFixture(t);
  writeFileSync(join(f.evidenceDir, 'stale'), 'x');
  await assert.rejects(execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps }), /must be empty/);
  assert.equal(existsSync(join(f.m.runtime.ledgerDir, `attempt-${f.approval.attemptId}.consumed`)), false);
});

test('execute creates an internal, labelled network, removes the pg key file and records its teardown', async (t) => {
  const f = executeFixture(t);
  const args = [];
  const exec0 = f.deps.dockerExec();
  let disconnects = 0;
  const libs0 = f.deps.resolveLibraries;
  f.deps.resolveLibraries = async () => {
    const l = await libs0();
    return { ...l, PrismaClient: class extends l.PrismaClient { $disconnect() { disconnects += 1; return Promise.resolve(); } } };
  };
  f.deps.dockerExec = () => async (a) => { args.push(a); return exec0(a); };
  await execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps });
  const net = args.find((a) => a[0] === 'network' && a[1] === 'create');
  assert.ok(net.includes('--internal'));
  assert.deepEqual(net.slice(net.indexOf('--ipv6'), net.indexOf('--ipv6') + 3), ['--ipv6', '--subnet', f.m.network.subnet6], 'dual-stack for IPv4-mapped tenant DB dials');
  assert.deepEqual(net.slice(net.indexOf('--label'), net.indexOf('--label') + 2), ['--label', `${ATTEMPT_LABEL}=${f.approval.attemptId}`]);
  const pgRun = args.find((a) => a[0] === 'run');
  const envFile = pgRun[pgRun.indexOf('--env-file') + 1];
  assert.ok(envFile.startsWith(join(f.base, 'shm', `tonyai-gcm-${f.approval.attemptId}-`)), 'the key file lives under the tmpfs parent');
  assert.equal(existsSync(envFile), false);
  assert.ok(disconnects >= 1);
  assert.equal(JSON.parse(readFileSync(join(f.evidenceDir, 'teardown.json'), 'utf8')).complete, true);
});

test('execute refuses an image of the wrong platform and a taken Realtime name', async (t) => {
  for (const [o, err] of [
    [{ exec: { image: (a) => ({ code: 0, stdout: `${a.at(-1)} linux/arm64` }) } }, /IMAGE_MISMATCH/],
    [{ exec: { container: (a) => ({ code: a.at(-1).endsWith('-rt-05') ? 0 : 1, stdout: '' }) } }, /NAME_IN_USE/],
  ]) {
    const f = executeFixture(t, o);
    await assert.rejects(execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps }), err);
  }
});

test('a container whose docker run failed is still owned and torn down', async () => {
  const plan = manifest();
  const life = createLifecycleAdapter({ exec: async (a) => (a[0] === 'run' ? { code: 125 } : { code: 0, stdout: '' }), plan,
    secrets: generateSecrets(plan), attempt: 'gcm-20261025-abcdef', store: { appendLog() {} }, clock: { now: () => 0 },
    http: async () => ({ status: 200 }), files: { writePrivate: (n) => `/p/${n}`, remove: () => {} } });
  await assert.rejects(life.start({ key: 'K' }), /START_FAILED/);
  assert.deepEqual(life.created(), ['gcm-20261025-abcdef-rt-01']);
});

test('main reports the approval\'s own refusals and never trusts an approval without its out-of-band hash', async (t) => {
  const d = scratch(t, 'gcm-main-');
  const hashes = harnessHashes();
  const a = approvalFor(hashes, Date.now(), d);
  const file = join(d, 'approval.json');
  writeFileSync(file, `${JSON.stringify(a)}\n`);
  const out = [];
  await main(['--approval', file, '--approval-sha256', sha256(readFileSync(file, 'utf8'))], (x) => out.push(x));
  const report = JSON.parse(out.at(-1));
  assert.ok(report.refusals.includes('approval is not in canonical form'));
  writeFileSync(file, canonicalJson(a));
  await main(['--approval', file, '--approval-sha256', '0'.repeat(64), '--evidence-dir', d], (x) => out.push(x));
  assert.ok(JSON.parse(out.at(-1)).refusals.includes('approval bytes differ from the out-of-band hash'));
  await main(['--approval', file, '--evidence-dir', d], (x) => out.push(x));
  assert.ok(JSON.parse(out.at(-1)).refusals.includes('approval bytes differ from the out-of-band hash'), 'no hash given: refused');
  assert.equal(await main(['--execute', '--approval', file, '--approval-sha256', sha256(canonicalJson(a)), '--evidence-dir', d], (x) => out.push(x)), 2);
  assert.match(out.at(-1), /^REFUSED: .*manifest is not executable/);
});

test('every approval field is enforced: purpose, future issue, each harness file', () => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  const hashes = Object.fromEntries(HARNESS_FILES.map((f, i) => [f, String(i).repeat(64)]));
  const ok = { manifest: boundManifest(), hashes, now, evidenceDir: '/srv/evidence' };
  const edits = [(a) => { a.purpose = 'OTHER'; }, (a) => { a.issuedAt = new Date(now + 60_000).toISOString(); },
    ...HARNESS_FILES.map((f) => (a) => { a.harness[f] = 'f'.repeat(64); })];
  for (const edit of edits) {
    const a = approvalFor(hashes, now);
    edit(a);
    assert.ok(executionRefusals({ ...ok, approval: a }).length > 0, edit.toString());
  }
});

test('the ledger is fsynced and must belong to this user', (t) => {
  const ledger = join(scratch(t, 'gcm-ledger2-'), 'l');
  const fsyncs = [];
  const fs = { openSync, writeSync: (...a) => writeSyncReal(...a), closeSync: closeReal, fsyncSync: (fd) => { fsyncs.push(fd); },
    lstatSync: (p) => statSync(p), mkdirSync, readdirSync, realpathSync };
  consumeAttempt(ledger, 'gcm-20261025-abcdef', fs);
  assert.equal(fsyncs.length, 3, 'new ledger parent, marker file, ledger directory');
  const foreign = { ...fs, lstatSync: (p) => ({ ...statSync(p), isDirectory: () => true, mode: 0o40700, uid: 12345 }) };
  assert.throws(() => consumeAttempt(ledger, 'gcm-20261025-bbbbbb', foreign), /CUSTODY/);
});

test('adapter details: extension type in the WHERE, real errors rethrown, no-new-privileges, metadata password', async () => {
  const p = fakePrisma([], [1]);
  await createMetadataAdapter({ prisma: p, Prisma, schema: '_realtime' }).conditionalReplace({ externalId: 'e', field: 'db_port', expected: 'o', value: 'n' });
  assert.match(p.seen[0].sql, /type = 'postgres_cdc_rls'/);
  const broken = { $transaction: async () => { throw new Error('connection reset'); } };
  await assert.rejects(createMetadataAdapter({ prisma: broken, Prisma, schema: '_realtime' })
    .conditionalReplace({ externalId: 'e', field: 'jwt_secret', expected: 'o', value: 'n' }), /connection reset/);
  const plan = manifest();
  for (const argv of [realtimeRunArgv({ name: 'gcm-x-rt-01', network: 'gcm-x-net', ip: '172.31.250.10', envFile: '/e', image: plan.images.realtime.config, resources: plan.resources.realtime }),
    postgresRunArgv({ name: 'gcm-x-pg', network: 'gcm-x-net', ip: '172.31.250.20', envFile: '/e', image: plan.images.realtime.config, volume: 'gcm-x-pgdata', resources: plan.resources.postgres })]) {
    assert.deepEqual(argv.slice(argv.indexOf('--security-opt'), argv.indexOf('--security-opt') + 2), ['--security-opt', 'no-new-privileges']);
    assert.deepEqual(argv.slice(argv.indexOf('--label'), argv.indexOf('--label') + 2), ['--label', `${ATTEMPT_LABEL}=gcm-x`]);
  }
  const s = generateSecrets(plan);
  assert.equal(realtimeEnv({ plan, secrets: s, key: 'K' }).DB_PASSWORD, s.metaPassword);
});

test('manifest addresses refuse leading zeros and PostgreSQL env refuses auth overrides', () => {
  const m = manifest();
  m.network.postgresIp = '172.31.250.020';
  m.realtimeEnv.DB_HOST = m.network.postgresIp;
  assert.ok(manifestRefusals(m).includes('network.postgresIp must be a host address inside the subnet'));
  const m2 = manifest();
  m2.images.postgres.env.POSTGRES_HOST_AUTH_METHOD = 'trust';
  assert.ok(manifestRefusals(m2).includes('images.postgres.env must not carry POSTGRES_HOST_AUTH_METHOD'));
});

// ---- third review pass: pins for the teardown, abort and ownership fixes ---------------------

const noFailSecretDir = (dirs) => (parent, o) => {
  const d = createSecretDir(parent, o);
  dirs.push(d.dir);
  return { ...d, writePrivate: (n, txt) => (existsSync(d.dir) ? d.writePrivate(n, txt) : `${d.dir}/${n}`), remove: (p) => { if (existsSync(p)) d.remove(p); } };
};

test('a signal with a failing removal reports TEARDOWN_INCOMPLETE before exiting, and records the signal', async (t) => {
  const f = executeFixture(t, { exec: { rm: () => ({ code: 1 }) } });
  const order = [];
  f.deps.onTeardownIncomplete = () => order.push('incomplete');
  f.deps.signals.exit = (c) => order.push(`exit ${c}`);
  f.deps.runQualification = async () => {
    f.handlers.get('SIGTERM')('SIGTERM');
    await new Promise((r) => { setTimeout(r, 20); });
    return { verdict: 'CONSUMER_CASES_PASSED', cases: [] };
  };
  const r = await execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps });
  assert.deepEqual(order, ['incomplete', 'exit 130']);
  const td = JSON.parse(readFileSync(join(f.evidenceDir, 'teardown.json'), 'utf8'));
  assert.deepEqual([td.complete, td.signal], [false, 'SIGTERM']);
  assert.deepEqual([r.verdict, r.stopReason], ['ABORTED', 'INTERRUPTED'], 'a pass after a signal is never reported as a pass');
});

test('one teardown step failing never skips the docker removals after it', async (t) => {
  const f = executeFixture(t);
  let thrown = false;
  f.deps.createSecretDir = (parent, o) => {
    const d = createSecretDir(parent, o);
    f.secretDirs.push(d.dir);
    return { ...d, destroy: () => { if (!thrown) { thrown = true; throw new Error('EBUSY'); } d.destroy(); } };
  };
  await execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps });
  assert.ok(f.events.includes('docker network rm'));
  const td = JSON.parse(readFileSync(join(f.evidenceDir, 'teardown.json'), 'utf8'));
  assert.deepEqual([td.complete, td.failures], [false, ['secret-dir']]);
});

test('after a signal the exec latch refuses a docker run even when the key file could be written', async (t) => {
  const f = executeFixture(t);
  f.deps.createSecretDir = noFailSecretDir(f.secretDirs);
  const exec0 = f.deps.dockerExec();
  const seen = [];
  f.deps.dockerExec = () => async (a) => { seen.push(a[0]); return exec0(a); };
  f.deps.runQualification = async ({ adapters }) => {
    f.handlers.get('SIGINT')('SIGINT');
    const before = seen.length;
    await assert.rejects(adapters.lifecycle.start({ key: 'K' }), /START_FAILED/);
    assert.ok(!seen.slice(before).includes('run'));
    return { verdict: 'ABORTED', cases: [] };
  };
  await execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps });
});

test('teardown waits for every docker command in flight before removing', async (t) => {
  const f = executeFixture(t);
  const order = [];
  const exec0 = f.deps.dockerExec();
  f.deps.dockerExec = () => async (a) => {
    if (a[0] === 'run') {
      f.handlers.get('SIGINT')('SIGINT');
      await new Promise((r) => { setTimeout(r, 30); });
      order.push('run done');
      return { code: 0, stdout: '' };
    }
    if (a[0] === 'rm') order.push(`rm ${a.at(-1).split('-').at(-1)}`);
    return exec0(a);
  };
  await assert.rejects(execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps }));
  assert.deepEqual(order, ['run done', 'rm pg']);
});

test('the network, volume and pg are owned before their create commands', async (t) => {
  for (const [failing, removal] of [['network', 'docker network rm'], ['volume', 'docker volume rm'], ['run', 'docker rm --force']]) {
    const f = executeFixture(t, { exec: { [failing]: (a) => (a[1] === 'inspect' ? { code: 1, stdout: '' } : { code: 125, stdout: '' }) } });
    await assert.rejects(execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps }), /START_FAILED/);
    assert.ok(f.events.includes(removal), `${failing}: ${removal}`);
  }
});

test('the pg key file is gone as soon as docker run returns', async (t) => {
  const f = executeFixture(t);
  let pgEnv = null;
  const exec0 = f.deps.dockerExec();
  f.deps.dockerExec = () => async (a) => { if (a[0] === 'run') pgEnv = a[a.indexOf('--env-file') + 1]; return exec0(a); };
  f.deps.runQualification = async () => {
    assert.equal(existsSync(pgEnv), false);
    return { verdict: 'CONSUMER_CASES_PASSED', cases: [] };
  };
  await execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps });
});

test('--teardown leaves an object labelled for another attempt alone', async (t) => {
  const base = scratch(t, 'gcm-td2-');
  const m = manifest();
  m.runtime = { ...m.runtime, secretParent: base };
  const attempt = 'gcm-20261025-abcdef';
  const r = await teardownAttempt({ manifest: m, attempt, deps: { dockerExec: () => async (a) => {
    if (a[1] === 'inspect') return { code: 0, stdout: a.at(-1).endsWith('-pg') ? `${attempt}x\n` : '<no value>\n' };
    return { code: 0 };
  } } });
  assert.deepEqual(r, []);
});

test('a start is bounded by startupMs even with probes left', async () => {
  let now = 0;
  let probes = 0;
  const plan = manifest();
  const life = createLifecycleAdapter({ exec: async (a) => (a[0] === 'inspect' ? { code: 0, stdout: `c 1 1 ${plan.images.realtime.config} true` } : { code: 0, stdout: '' }),
    plan: { ...plan, limits: { ...plan.limits, readinessIntervalMs: 1 } }, secrets: generateSecrets(plan), attempt: 'gcm-20261025-abcdef',
    store: { appendLog() {} }, clock: { now: () => (now += 25_000) }, http: async () => { probes += 1; return { status: 503 }; },
    files: { writePrivate: (n) => `/p/${n}`, remove: () => {} } });
  await assert.rejects(life.start({ key: 'K' }), /START_FAILED/);
  assert.ok(probes < plan.limits.readinessProbes && probes <= 3, `probes ${probes}`);
});

test('main refuses --execute while a single refusal remains', async (t) => {
  const d = scratch(t, 'gcm-main2-');
  chmodSync(d, 0o700);
  const bound = boundManifest();
  bound.blockedBy = [];
  const text = `${JSON.stringify(bound, null, 2)}\n`;
  const hashes = harnessHashes(REPO_ROOT_FOR_TEST, text);
  const a = approvalFor(hashes, Date.now(), `${d}/other`);
  const file = join(d, 'approval.json');
  writeFileSync(file, canonicalJson(a));
  const out = [];
  const code = await main(['--execute', '--approval', file, '--approval-sha256', sha256(canonicalJson(a)), '--evidence-dir', d],
    (x) => out.push(x), { readManifest: () => text });
  assert.equal(code, 2);
  assert.equal(out.at(-1), 'REFUSED: approval names another evidence directory');
});

test('outgoing frames over the per-session cap never reach the wire', () => {
  const state = newState();
  const T = makeTransport({ WebSocket: FakeWs, lookup: () => {}, state, limits: { ...limits, framesPerSession: 2 },
    expectedHost: 'a.realtime-gcm.invalid', totals: { bytes: 0 } });
  const ws = new T('ws://a.realtime-gcm.invalid:4000/socket/websocket');
  for (let i = 0; i < 3; i += 1) ws.send(JSON.stringify([null, String(i), 'phoenix', 'heartbeat', {}]));
  assert.equal(ws.sent.length, 2);
  assert.deepEqual(state.violations, ['FRAME_LIMIT']);
});

test('a canonical secret parent that is not tmpfs is refused', (t) => {
  const base = scratch(t, 'gcm-rt2-');
  const m = manifest();
  m.runtime = { ...m.runtime, secretParent: base, ledgerDir: join(base, 'ledger') };
  const fs = { realpathSync, lstatSync: (p) => statSync(p), statfsSync: () => ({ type: 0xef53 }) };
  assert.deepEqual(runtimeRefusals({ manifest: m, approval: { runBinding: null }, env: {}, fs }), ['runtime.secretParent must be a canonical tmpfs directory']);
});

test('an unknown-shape entry naming a tenant is still never attributed', () => {
  const ts = '2026-10-25T12:00:00Z';
  const text = [`${ts} weird external_id=gcm-fixture-a ${GCM_TEXT}`].join('\n');
  assert.deepEqual(countLogFailures(text, { a: 'gcm-fixture-a', b: 'gcm-fixture-b' }).byTenant, { a: 0, b: 0 });
});

test('the fixture network needs one ULA /64 next to its private /24', () => {
  for (const v of [undefined, '2001:db8::/64', 'fd42:7a1b:3c5d:1::/48']) {
    const m = manifest();
    m.network.subnet6 = v;
    assert.ok(manifestRefusals(m).includes('network.subnet6 must be one ULA /64'), String(v));
  }
});

test('every required binding of the committed manifest is bound to the retained source', () => {
  const m = manifest();
  assert.equal(m.source.requiredBindings.length, 30);
  assert.ok(m.source.requiredBindings.every((b) => /^[0-9a-f]{64}$/.test(b.sha256) && /^[0-9a-f]{40}$/.test(b.gitSha1)));
  assert.ok(m.source.pendingBindings.length > 0 && m.source.pendingBindings.every((b) => b.sha256 === null && /^[0-9a-f]{40}$/.test(b.gitSha1)));
  assert.deepEqual(m.expected.dbJoinReasons, ['UnableToConnectToProject: Realtime was unable to connect to the project database']);
});

test('stored server logs never keep a token from the request line or headers', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.c2lnbmF0dXJlLXZhbHVlLTAx';
  const text = [`Request: GET /socket/websocket?apikey=${jwt}&vsn=2.0.0`, `authorization: Bearer ${jwt}`, `{"apikey": "${jwt}"}`].join('\n');
  const masked = maskLogSecrets(text);
  assert.ok(!masked.includes(jwt));
  assert.match(masked, /apikey=<masked>&vsn=2\.0\.0/);
  assert.equal(countLogFailures(maskLogSecrets(`12:00:00.000 [error] x\nServer: gcm-fixture-a.realtime-gcm.invalid:4000 (http)\n  ** (RuntimeError) ${GCM_TEXT}`),
    { a: 'gcm-fixture-a', b: 'gcm-fixture-b' }).byTenant.a, 1, 'masking keeps attribution');
});

// ---- review pass 04 pins ---------------------------------------------------------------------

test('subnet6 must be a ULA /64 from its first character', () => {
  for (const v of ['2001:db8:fd42:7a1b:3c5d:1::/64', 'fe80:1:2:3::/64', 'ff02:1:2:3::/64']) {
    const m = manifest();
    m.network.subnet6 = v;
    assert.ok(manifestRefusals(m).includes('network.subnet6 must be one ULA /64'), v);
  }
});

test('stored server logs are masked on stop and on every window read, with every secret form', async () => {
  const plan = manifest();
  const secrets = generateSecrets(plan);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJlLXZhbHVlLTAy';
  const stored = [];
  let removed = false;
  const exec = async (a) => {
    if (a[0] === 'inspect') return removed ? { code: 1, stdout: '' } : { code: 0, stdout: `cid 2026 7 ${plan.images.realtime.config} true` };
    if (a[0] === 'rm') removed = true;
    if (a[0] === 'logs') return { code: 0, stdout: `x ${jwt} ${secrets.gcmKey} ${secrets.tenants.a.db.db_password}\n`, stderr: '' };
    return { code: 0, stdout: '' };
  };
  const life = createLifecycleAdapter({ exec, plan, secrets, attempt: 'gcm-20261025-abcdef', clock: { now: () => 0 },
    store: { appendLog: (n, t) => stored.push(t) }, http: async () => ({ status: 200 }), files: { writePrivate: (n) => `/p/${n}`, remove: () => {} } });
  await life.start({ key: 'K' });
  await life.logsSince('2026-10-25T00:00:00Z');
  await life.stop();
  assert.equal(stored.length, 2);
  for (const t of stored) for (const leak of [jwt, secrets.gcmKey, secrets.tenants.a.db.db_password]) assert.ok(!t.includes(leak));
});

test('maskLogSecrets covers Elixir maps, access tokens, bare JWTs and supplied secret forms', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
  const text = `%{"apikey" => "${jwt}"} %{"access_token" => "${'z'.repeat(40)}"} token:${jwt} plain-SECRETVALUE1234567`;
  const out = maskLogSecrets(text, ['SECRETVALUE1234567']);
  assert.ok(!out.includes(jwt) && !out.includes('z'.repeat(40)) && !out.includes('SECRETVALUE1234567'), out);
});

test('both containers drop NET_RAW and refuse router advertisements', () => {
  const plan = manifest();
  for (const argv of [realtimeRunArgv({ name: 'gcm-x-rt-01', network: 'gcm-x-net', ip: '172.31.250.10', envFile: '/e', image: plan.images.realtime.config, resources: plan.resources.realtime }),
    postgresRunArgv({ name: 'gcm-x-pg', network: 'gcm-x-net', ip: '172.31.250.20', envFile: '/e', image: plan.images.realtime.config, volume: 'gcm-x-pgdata', resources: plan.resources.postgres })]) {
    assert.deepEqual(argv.slice(argv.indexOf('--cap-drop'), argv.indexOf('--cap-drop') + 4), ['--cap-drop', 'NET_RAW', '--sysctl', 'net.ipv6.conf.all.accept_ra=0']);
  }
});

test('tenant creation gets its own longer bound', async () => {
  const calls = [];
  const api = createApiAdapter({ call: async (o) => { calls.push(o); return { status: 201 }; }, port: 4000, adminHost: 'admin.realtime-gcm.invalid',
    tokens: { admin: async () => 'A' }, limits: { outcomeMs: 30_000, createMs: 90_000, responseBytes: 99 } });
  await api.createTenant({ tenant: {} });
  assert.equal(calls[0].timeoutMs, 90_000);
});

test('runtime refusals: symlinked tmpfs parent, symlinked ledger ancestor, unreadable statfs, non-normalised ledger', (t) => {
  const base = scratch(t, 'gcm-rt3-');
  mkdirSync(join(base, 'shm'));
  mkdirSync(join(base, 'disk'));
  symlinkSync(join(base, 'shm'), join(base, 'shm-link'));
  symlinkSync(join(base, 'disk'), join(base, 'disk-link'));
  const typeOf = (p) => (realpathSync(p).startsWith(join(base, 'shm')) ? 0x01021994 : 0xef53);
  const fs = { realpathSync, lstatSync: (p) => statSync(p), statfsSync: (p) => ({ type: typeOf(p) }) };
  const m = manifest();
  const at2 = (secretParent, ledgerDir, f = fs) => runtimeRefusals({ manifest: { ...m, runtime: { ...m.runtime, secretParent, ledgerDir } },
    approval: { runBinding: null }, env: {}, fs: f });
  assert.deepEqual(at2(join(base, 'shm'), join(base, 'disk', 'l')), []);
  assert.deepEqual(at2(join(base, 'shm-link'), join(base, 'disk', 'l')), ['runtime.secretParent must be a canonical tmpfs directory']);
  assert.deepEqual(at2(join(base, 'shm'), join(base, 'disk-link', 'l')), ['runtime.ledgerDir must be on canonical persistent storage']);
  assert.deepEqual(at2(join(base, 'shm'), join(base, 'disk', 'l'), { ...fs, statfsSync: (p) => { if (p.includes('disk')) throw new Error('EIO'); return { type: typeOf(p) }; } }),
    ['runtime.ledgerDir must be on canonical persistent storage']);
  assert.ok(at2(join(base, 'shm'), `${join(base, 'disk')}/x/../l`).includes('runtime.ledgerDir must be a normalised path'));
});

test('run binding: repository and run id both compared, exact keys, a falsy binding is not null, runners need GITHUB_ACTIONS', (t) => {
  const base = scratch(t, 'gcm-rb-');
  mkdirSync(join(base, 'shm'));
  const m = manifest();
  m.runtime = { ...m.runtime, secretParent: join(base, 'shm'), ledgerDir: join(base, 'l') };
  const fs = { realpathSync, lstatSync: (p) => statSync(p), statfsSync: (p) => ({ type: p.endsWith('shm') ? 0x01021994 : 0xef53 }) };
  const gh = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' };
  const rr = (runBinding, env) => runtimeRefusals({ manifest: m, approval: { runBinding }, env, fs });
  assert.deepEqual(rr({ repository: 'o/other', runId: '9' }, gh), ['approval names another workflow run']);
  assert.deepEqual(rr(0, {}), ['approval is bound to a workflow run']);
  assert.deepEqual(rr(null, { GITHUB_RUN_ID: '9' }), ['a runner without GITHUB_ACTIONS=true never executes an unbound approval']);
  const now = Date.parse('2026-10-26T10:00:00Z');
  const hashes = Object.fromEntries(HARNESS_FILES.map((f, i) => [f, String(i).repeat(64)]));
  for (const rb of [{ repository: 'o/r', runId: '9', extra: 1 }, 0, '', { repository: 'o/r', runId: 9 }]) {
    const a = { ...approvalFor(hashes, now), runBinding: rb };
    assert.ok(executionRefusals({ manifest: boundManifest(), approval: a, hashes, now, evidenceDir: '/srv/evidence' })
      .includes('approval runBinding must be null or {repository, runId}'), JSON.stringify(rb));
  }
  const empty = boundManifest();
  empty.expected.dbJoinReasons = [];
  assert.ok(executionRefusals({ manifest: empty, approval: approvalFor(hashes, now), hashes, now, evidenceDir: '/srv/evidence' })
    .includes('expected.dbJoinReasons unbound'));
});

test('teardown removes docker objects before disconnecting Prisma, and survives failing non-docker steps', async (t) => {
  const f = executeFixture(t);
  const order = [];
  const libs0 = f.deps.resolveLibraries;
  f.deps.resolveLibraries = async () => {
    const l = await libs0();
    return { ...l, PrismaClient: class extends l.PrismaClient { $disconnect() { order.push('prisma'); return Promise.reject(new Error('reset')); } } };
  };
  const exec0 = f.deps.dockerExec();
  f.deps.dockerExec = () => async (a) => { if (a[0] === 'rm' || a[1] === 'rm') order.push(a.slice(0, 2).join(' ')); return exec0(a); };
  let configThrows = true;
  f.deps.createSecretDir = (parent, o) => {
    const d = createSecretDir(parent, o);
    f.secretDirs.push(d.dir);
    if (f.secretDirs.length !== 2) return d;
    return { ...d, destroy: () => { if (configThrows) { configThrows = false; throw new Error('EBUSY'); } d.destroy(); } };
  };
  const r = await execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps });
  assert.deepEqual(order.slice(0, 3), ['rm --force', 'volume rm', 'network rm']);
  assert.ok(order.indexOf('prisma') > order.indexOf('network rm'));
  const td = JSON.parse(readFileSync(join(f.evidenceDir, 'teardown.json'), 'utf8'));
  assert.deepEqual(td.failures.sort(), ['config-dir', 'prisma']);
  assert.equal(r.teardownComplete, false);
});

test('a teardown record that cannot be written makes the teardown incomplete and is reported', async (t) => {
  const f = executeFixture(t);
  let noticed = 0;
  f.deps.onTeardownIncomplete = () => { noticed += 1; };
  f.deps.runQualification = async () => {
    writeFileSync(join(f.evidenceDir, 'teardown.json'), 'occupied');
    return { verdict: 'CONSUMER_CASES_PASSED', cases: [] };
  };
  const r = await execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps });
  assert.deepEqual([r.teardownComplete, noticed], [false, 1]);
});

test('a second signal during a slow teardown reports and exits at once', async (t) => {
  const f = executeFixture(t);
  const events = [];
  f.deps.onTeardownIncomplete = () => events.push('notice');
  f.deps.signals.exit = (c) => events.push(`exit ${c}`);
  const exec0 = f.deps.dockerExec();
  f.deps.dockerExec = () => async (a) => {
    if (a[0] === 'rm') { f.handlers.get('SIGINT')('SIGINT'); await new Promise((r) => { setTimeout(r, 20); }); }
    return exec0(a);
  };
  f.deps.runQualification = async () => { f.handlers.get('SIGTERM')('SIGTERM'); await new Promise((r) => { setTimeout(r, 60); }); return { verdict: 'ABORTED', cases: [] }; };
  await execute({ manifest: f.m, approval: f.approval, evidenceDir: f.evidenceDir, deps: f.deps });
  assert.deepEqual(events.slice(0, 2), ['notice', 'exit 130'], 'the second signal does not wait for the teardown');
});

test('main exits 3 when the teardown is incomplete, after printing the notice', async (t) => {
  const d = scratch(t, 'gcm-main3-');
  chmodSync(d, 0o700);
  const bound = boundManifest();
  const text = `${JSON.stringify(bound, null, 2)}\n`;
  const a = approvalFor(harnessHashes(REPO_ROOT_FOR_TEST, text), Date.now(), d);
  const file = join(d, 'approval.json');
  writeFileSync(file, canonicalJson(a));
  const out = [];
  const code = await main(['--execute', '--approval', file, '--approval-sha256', sha256(canonicalJson(a)), '--evidence-dir', d], (x) => out.push(x), {
    readManifest: () => text,
    execute: async ({ deps }) => { deps.onTeardownIncomplete(); return { verdict: 'CONSUMER_CASES_PASSED', cases: [], teardownComplete: false }; },
  });
  assert.equal(code, 3);
  assert.match(out[0], /^TEARDOWN_INCOMPLETE/);
});
