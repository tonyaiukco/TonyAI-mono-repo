import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  Budget, FIELDS, HarnessError, SCHEDULE, TAMPER_CASES, assertNoSecrets, parseGcm, plannedCounts, runQualification,
  secretStrings, sha256, tamper, validatePlan, validateSecrets,
} from '../scripts/r3_realtime_gcm.mjs';
import { createFakeWorld, fakeSecrets, manifest } from './r3_realtime_gcm_fake.mjs';

const gcm = (key, text) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `g1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
};
const opens = (key, value) => {
  const raw = Buffer.from(value.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
};

/** The committed manifest; its refusal shapes are bound from the retained source. */
const boundPlan = () => manifest();
const run = async (faults = {}, planEdit = (p) => p) => {
  const plan = planEdit(boundPlan());
  const secrets = fakeSecrets(plan);
  const world = createFakeWorld({ plan, secrets, faults });
  const result = await runQualification({ plan, secrets, adapters: world.adapters });
  return { result, world, secrets };
};

test('the committed fixture plan validates and its caps cover the exact planned counts', () => {
  const plan = validatePlan(manifest());
  const planned = plannedCounts();
  assert.deepEqual(planned, { processStarts: 27, sockets: 31, httpCalls: 27, inserts: 17, sqlOps: 103, logReads: 37, liveness: 12 });
  for (const [k, v] of Object.entries(planned)) assert.ok(plan.caps[k] >= v, k);
  assert.equal(SCHEDULE.length, 4 + 10);
  assert.equal(TAMPER_CASES.length, 10);
  assert.deepEqual(TAMPER_CASES.filter((c) => c.region === 'tag').map((c) => c.field), FIELDS);
});

test('validatePlan refuses a plan whose caps, names or identities would weaken the run', () => {
  const bad = [
    (p) => { p.caps.processStarts = 26; },
    (p) => { p.caps.sockets = 30; },
    (p) => { delete p.caps.liveness; },
    (p) => { p.source.commit = '0'.repeat(40); },
    (p) => { p.hostSuffix = 'example.com'; },
    (p) => { p.tenants.b.externalId = p.tenants.a.externalId; },
    (p) => { p.tenants.a.publication = 'supabase_realtime'; },
    (p) => { p.tenants.a.slotName = 'supabase_realtime_replication_slot'; },
    (p) => { p.tenants.a.externalId = 'Bad.Label'; },
    (p) => { p.unknownTenantId = p.tenants.a.externalId; },
    (p) => { p.tenantTable.table = 'events; drop'; },
    (p) => { p.timeouts.outcomeMs = 0; },
  ];
  for (const edit of bad) {
    const p = manifest();
    edit(p);
    assert.throws(() => validatePlan(p), (e) => e instanceof HarnessError && e.code === 'BAD_PLAN');
  }
});

test('validateSecrets requires 32-byte distinct keys and distinct synthetic secrets', () => {
  const plan = manifest();
  assert.doesNotThrow(() => validateSecrets(fakeSecrets(plan)));
  const bad = [
    (s) => { s.gcmKey = s.gcmKey.slice(1); },
    (s) => { s.gcmKeyBad = `${s.gcmKeyBad}x`; },
    (s) => { s.gcmKeyBad = s.gcmKey; },
    (s) => { s.tenants.b.jwtSecret = s.tenants.a.jwtSecret; },
    (s) => { s.badJwtSecret = s.tenants.a.jwtSecret; },
    (s) => { s.tenants.a.db.db_port = 5432; },
    (s) => { s.tenants.a.db.db_port = '54x2'; },
    (s) => { s.tenants.a.db.db_password = 'short'; },
    (s) => { delete s.tenants.b.db.db_name; },
  ];
  for (const edit of bad) {
    const s = fakeSecrets(plan);
    edit(s);
    assert.throws(() => validateSecrets(s), (e) => e.code === 'BAD_SECRETS');
  }
});

test('parseGcm accepts only the exact g1 layout for the plaintext length', () => {
  const key = randomBytes(32);
  const v = gcm(key, 'hello-plaintext');
  const p = parseGcm(v, 15);
  assert.equal(p.iv.length, 12);
  assert.equal(p.tag.length, 16);
  assert.equal(p.body.length, 15);
  const refused = [
    [v.slice(3), 15], // legacy ECB shape: bare Base64
    ['hello-plaintext', 15],
    [v, 14],
    [v, 16],
    [`${v}=`, 15],
    [v.slice(0, -4), 15],
    [`g1:${Buffer.alloc(28).toString('base64')}`, 1],
    [v.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')).replace(/=$/, 'B'), 15],
  ];
  for (const [value, len] of refused) assert.throws(() => parseGcm(value, len), (e) => e.code === 'NOT_GCM', value);
  // A non-canonical encoding (non-zero padding bits) decodes to the same bytes but is refused.
  const raw = Buffer.from(gcm(key, 'ab').slice(3), 'base64');
  const canonical = raw.toString('base64');
  if (canonical.endsWith('=')) {
    const last = canonical.at(-canonical.match(/=+$/)[0].length - 1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const bumped = alphabet[alphabet.indexOf(last) + 1];
    const noncanonical = canonical.replace(new RegExp(`${last.replace(/[+/]/, '\\$&')}(=+)$`), `${bumped}$1`);
    if (Buffer.from(noncanonical, 'base64').equals(raw)) assert.throws(() => parseGcm(`g1:${noncanonical}`, 2), /NOT_GCM/);
  }
});

test('each of the ten tamper cases flips one byte, keeps the encoding and fails real GCM authentication', () => {
  const key = randomBytes(32);
  for (const c of TAMPER_CASES) {
    const plain = c.field === 'db_port' ? '5432' : `value-of-${c.field}-0123456789`;
    const v = gcm(key, plain);
    assert.equal(opens(key, v), plain);
    const t = tamper(v, c.region, Buffer.byteLength(plain));
    assert.ok(t.startsWith('g1:'));
    assert.equal(t.length, v.length);
    const a = Buffer.from(v.slice(3), 'base64');
    const b = Buffer.from(t.slice(3), 'base64');
    const diff = [...a].map((x, i) => (x !== b[i] ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(diff, [{ iv: 0, tag: 12, body: 28 }[c.region]], c.id);
    assert.throws(() => opens(key, t), /Unsupported state|unable to authenticate/, c.id);
  }
  assert.throws(() => tamper(gcm(key, 'x'), 'prefix', 1), /BAD_PLAN/);
});

test('Budget refuses before an operation would exceed its cap', () => {
  const caps = Object.fromEntries(Object.keys(plannedCounts()).map((k) => [k, 2]));
  const b = new Budget(caps);
  b.take('sockets', 2);
  assert.throws(() => b.take('sockets'), (e) => e.code === 'CAP_EXCEEDED');
  assert.equal(b.used.sockets, 2);
  assert.throws(() => b.take('unknown'), /BAD_PLAN/);
  assert.throws(() => new Budget({ ...caps, inserts: -1 }), /BAD_PLAN/);
});

test('assertNoSecrets catches raw and Base64 forms of every synthetic secret', () => {
  const s = fakeSecrets(manifest());
  const list = secretStrings(s);
  assert.doesNotThrow(() => assertNoSecrets(JSON.stringify({ ok: true }), list));
  for (const secret of [s.gcmKey, s.gcmKeyBad, s.tenants.b.db.db_password, s.tenants.a.jwtSecret]) {
    assert.throws(() => assertNoSecrets(`x${secret}y`, list), /SECRET_IN_EVIDENCE/);
    assert.throws(() => assertNoSecrets(Buffer.from(secret).toString('base64'), list), /SECRET_IN_EVIDENCE/);
  }
});

test('an honest model passes every case with exactly the planned operations and clean evidence', async () => {
  const { result, world, secrets } = await run();
  assert.equal(result.verdict, 'CONSUMER_CASES_PASSED', JSON.stringify(result.cases));
  assert.deepEqual(result.cases.map((c) => c.id), SCHEDULE);
  assert.ok(result.cases.every((c) => c.status === 'PASS'));
  assert.deepEqual(result.used, result.planned);
  assert.equal(result.processIdentities, 27);
  assert.equal(result.qualification, 'NOT_QUALIFIED_PENDING_INDEPENDENT_REVIEW');
  assert.equal(world.state.running, false);
  assert.equal(world.state.liveSessions, 0);
  const text = JSON.stringify(world.state.records);
  assertNoSecrets(text, secretStrings(secrets));
  assert.ok(!text.includes('g1:'), 'records carry ciphertext fingerprints, not ciphertext');
  assert.deepEqual(Object.keys(world.state.sealed).sort(), ['baseline-a', 'baseline-b']);
  const seq = world.state.records.map((r) => r.seq);
  assert.deepEqual(seq, seq.map((_, i) => i + 1));
  // Every tamper case observed its refusal, restored the exact value and recovered.
  for (const c of TAMPER_CASES) {
    const steps = world.state.records.filter((r) => r.caseId === c.id).map((r) => r.step);
    assert.deepEqual(steps, ['case-start', 'stop', 'replace', 'stored', 'start', 'liveness',
      c.consumer === 'jwt' ? 'negative-jwt' : 'negative-db', 'stop', 'replace', 'stored', 'start', 'positive', 'case-pass']);
  }
  // Stored values end exactly where the API wrote them.
  for (const t of ['a', 'b']) {
    const final = world.state.records.filter((r) => r.caseId === 'final' && r.tenant === t).at(-1);
    const base = world.state.records.find((r) => r.step === 'baseline' && r.tenant === t);
    assert.deepEqual(final.fingerprints, base.fingerprints);
  }
});

const FAULTS = [
  // Skipping the tag check everywhere turns Kbad into a garbled secret: a 401, not the raise's 500.
  ['ignoreTag', 'INCONCLUSIVE', 'UNEXPECTED_REFUSAL_STATUS', 'wrong-key-global'],
  ['ignoreTagUnderK', 'FAIL', 'JWT_CONSUMED_DESPITE_FAULT', 'tamper-tag-jwt_secret'],
  ['warmCache', 'FAIL', 'DB_CONSUMED_DESPITE_FAULT', 'wrong-key-db-only'],
  ['plaintextStorage', 'ABORTED', 'PLAINTEXT_STORED', 'abort'],
  ['reconcilerRewrite', 'ABORTED', 'UNPLANNED_REWRITE', 'abort'],
  ['adminUpdateRewritesDb', 'ABORTED', 'JWT_UPDATE_TOUCHED_DB', 'abort'],
  ['broadcastNoDelivery', 'INCONCLUSIVE', 'BROADCAST_NOT_DELIVERED', 'initial'],
  ['staleReplay', 'INCONCLUSIVE', 'BROADCAST_NOT_DELIVERED', 'initial'],
  ['laxMatch+staleReplay', 'FAIL', 'STALE_OR_FOREIGN_MESSAGE', 'initial'],
  ['sameIdentity', 'ABORTED', 'PROCESS_NOT_REPLACED', 'abort'],
  ['stopNotGone', 'ABORTED', 'PROCESS_NOT_GONE', 'abort'],
  ['noLogs', 'INCONCLUSIVE', 'NO_ATTRIBUTABLE_DECRYPT_FAILURE', 'wrong-key-global'],
  ['joinTimeout', 'INCONCLUSIVE', 'JOIN_OUTCOME_UNKNOWN', 'wrong-key-db-only'],
  ['rowCountTwo', 'ABORTED', 'ROW_COUNT', 'abort'],
  ['tenantPreexists', 'ABORTED', 'TENANT_PRESENT', 'abort'],
  ['secretInReason', 'ABORTED', 'SECRET_IN_EVIDENCE', 'abort'],
  ['sdkRetry', 'FAIL', 'CLIENT_VIOLATION', 'initial'],
  ['badSignatureAccepted', 'FAIL', 'BAD_SIGNATURE_ACCEPTED', 'initial'],
  ['unknownTenantAccepted', 'FAIL', 'UNKNOWN_TENANT_ACCEPTED', 'initial'],
  ['noDbSession', 'FAIL', 'NO_TENANT_DB_SESSION', 'initial'],
  ['reuseNonce', 'ABORTED', 'NONCE_REUSED', 'abort'],
  ['slowClock', 'ABORTED', 'OVERALL_DEADLINE', 'abort'],
  // The security seat's reproductions: a join refused for another reason, a failure logged
  // against the other tenant, a broadcast refused with a status the source does not produce.
  ['unrelatedJoinRefusal', 'INCONCLUSIVE', 'UNEXPECTED_JOIN_REASON', 'wrong-key-db-only'],
  ['foreignTenantLog', 'INCONCLUSIVE', 'NO_ATTRIBUTABLE_DECRYPT_FAILURE', 'wrong-key-db-only'],
  ['broadcast400', 'INCONCLUSIVE', 'UNEXPECTED_REFUSAL_STATUS', 'wrong-key-global'],
  ['socket401OnDecrypt', 'INCONCLUSIVE', 'UNEXPECTED_REFUSAL_STATUS', 'wrong-key-global'],
  // The QA seat's reproduction: a late second entry of the socket refusal and a broadcast 500 that
  // never decrypted. Settling window 1 before the broadcast keeps the late entry out of window 2.
  ['lateSocketLine+broadcastNoDecrypt', 'INCONCLUSIVE', 'NO_ATTRIBUTABLE_DECRYPT_FAILURE', 'wrong-key-global'],
  // A socket entry later than any settle still names its route, so it cannot satisfy the broadcast leg.
  ['veryLateSocketLine+broadcastNoDecrypt', 'INCONCLUSIVE', 'NO_ATTRIBUTABLE_DECRYPT_FAILURE', 'wrong-key-global'],
  // A JWT-consumer failure entry can never stand in for the DB consumer's.
  ['dbFailureLoggedAsSocket', 'INCONCLUSIVE', 'NO_ATTRIBUTABLE_DECRYPT_FAILURE', 'wrong-key-db-only'],
];

for (const [fault, verdict, code, caseId] of FAULTS) {
  test(`a model with ${fault} never passes (${verdict} ${code})`, async () => {
    const { result, world, secrets } = await run(Object.fromEntries(fault.split('+').map((f) => [f, true])));
    assert.equal(result.verdict, verdict, JSON.stringify(result.cases));
    assert.equal(result.stopReason, code);
    assert.equal(result.cases.at(-1).id, caseId);
    assert.equal(world.state.running, false, 'Realtime is stopped on every exit path');
    assertNoSecrets(JSON.stringify(world.state.records), secretStrings(secrets));
    for (const kind of Object.keys(result.used)) assert.ok(result.used[kind] <= result.planned[kind], kind);
  });
}

test('a run that stops never starts a later case', async () => {
  const { result, world } = await run({ noLogs: true });
  const started = new Set(world.state.records.filter((r) => r.step === 'case-start').map((r) => r.caseId));
  assert.deepEqual([...started], ['initial', 'restart-persistence', 'wrong-key-global']);
  assert.equal(result.cases.length, 3);
});

test('the DB-only case authenticates under Kbad before its DB refusal and restores the exact JWT ciphertext', async () => {
  const { world } = await run();
  const steps = world.state.records.filter((r) => r.caseId === 'wrong-key-db-only');
  const neg = steps.find((r) => r.step === 'negative-db');
  assert.equal(neg.tenant, 'b');
  assert.ok(neg.gcmFailures >= 1);
  const kbad = steps.find((r) => r.step === 'jwt-under-kbad');
  const restore = steps.find((r) => r.step === 'replace');
  assert.equal(restore.field, 'jwt_secret');
  assert.equal(restore.from, kbad.jwt);
  assert.deepEqual(steps.filter((r) => r.step === 'start').map((r) => r.key), ['Kbad', 'Kbad', 'K']);
});

// ---- one guard at a time -------------------------------------------------------------------
//
// Each row perturbs ONE adapter result in ONE case of the honest model, chosen so that only the
// guard it names can catch it. `hook` returns undefined (no change), a function (transform the
// real result) or a value (replace the call). The verdict, code and stopping case must match.

const perturbed = async (hook, extra = () => {}) => {
  const plan = boundPlan();
  const secrets = fakeSecrets(plan);
  const world = createFakeWorld({ plan, secrets });
  const ctx = { caseId: null, counts: {}, world, plan, secrets, opened: 0, closed: 0 };
  const wrap = (obj, prefix) => Object.fromEntries(Object.entries(obj).map(([k, fn]) => [k, typeof fn !== 'function' ? fn
    : async (...args) => {
      const path = `${prefix}.${k}`;
      const key = `${ctx.caseId}|${path}`;
      const n = (ctx.counts[key] = (ctx.counts[key] ?? 0) + 1);
      const h = hook({ path, n, caseId: ctx.caseId, args, ctx });
      if (h !== undefined && typeof h !== 'function') return h;
      let r = await fn(...args);
      if (path === 'sockets.open') { ctx.opened += 1; r = wrap(r, 'session'); }
      if (path === 'session.close') ctx.closed += 1;
      return typeof h === 'function' ? h(r) : r;
    }]));
  const a = world.adapters;
  const adapters = { ...a, api: wrap(a.api, 'api'), sockets: wrap(a.sockets, 'sockets'), metadata: wrap(a.metadata, 'metadata'),
    tenantDb: wrap(a.tenantDb, 'tenantDb'), lifecycle: wrap(a.lifecycle, 'lifecycle'),
    evidence: { ...a.evidence, append: async (r) => { if (r.step === 'case-start') ctx.caseId = r.caseId; return a.evidence.append(r); } } };
  ctx.adapters = adapters;
  extra(adapters, ctx);
  const result = await runQualification({ plan, secrets, adapters });
  return { result, world, ctx };
};
const at = (path, caseId, n, h) => (x) => (x.path === path && x.caseId === caseId && [n].flat().includes(x.n) ? h(x) : undefined);
const ext = (x, t = 'a') => x.ctx.plan.tenants[t].externalId;
const refusedSession = (status, httpStatus) => (r) => ({ ...r, status, httpStatus });

const GUARDS = [
  ['positive socket must open', at('sockets.open', 'initial', 1, () => refusedSession('refused', 401)), 'FAIL', 'POSITIVE_SOCKET_REFUSED', 'initial'],
  ['positive join error stops, unattributed', at('session.join', 'initial', 1, () => () => ({ status: 'error', reason: 'x' })), 'INCONCLUSIVE', 'POSITIVE_JOIN_REFUSED', 'initial'],
  ['positive socket timeout is not a FAIL', at('sockets.open', 'initial', 1, () => refusedSession('timeout', null)), 'INCONCLUSIVE', 'POSITIVE_SOCKET_OUTCOME_UNKNOWN', 'initial'],
  ['positive broadcast timeout is not a FAIL', at('api.broadcast', 'initial', 2, () => ({ status: 'timeout' })), 'INCONCLUSIVE', 'POSITIVE_BROADCAST_OUTCOME_UNKNOWN', 'initial'],
  ['bad-signature broadcast must be exactly 401', at('api.broadcast', 'initial', 1, () => () => ({ status: 403 })), 'FAIL', 'BAD_SIGNATURE_BROADCAST_ACCEPTED', 'initial'],
  ['the join reason must be the bound one exactly', at('session.join', 'wrong-key-db-only', 1, () => (r) => ({ ...r, reason: `${r.reason}.` })), 'INCONCLUSIVE', 'UNEXPECTED_JOIN_REASON', 'wrong-key-db-only'],
  ['an orphan extension row is a present tenant', at('metadata.readSix', 'initial', 1, () => (r) => ({ ...r, extensionRows: 1 })), 'ABORTED', 'TENANT_PRESENT', 'initial'],
  ['admin JWT update must be exactly 200', at('api.updateJwt', 'wrong-key-db-only', 1, () => () => ({ status: 204 })), 'FAIL', 'ADMIN_UPDATE_REFUSED', 'wrong-key-db-only'],
  ['window 1 that never settles stops the case', (x) => (x.path === 'lifecycle.logsSince' && x.caseId === 'wrong-key-global' && x.n <= 3
    ? (r) => ({ ...r, gcmFailures: r.gcmFailures + x.n }) : undefined), 'INCONCLUSIVE', 'LOG_WINDOW_NOT_SETTLED', 'wrong-key-global'],
  ['positive needs the postgres_changes ack', at('session.join', 'initial', 1, () => () => ({ status: 'subscribed', postgresChangesReady: false })), 'INCONCLUSIVE', 'POSTGRES_CHANGES_NOT_READY', 'initial'],
  ['bad-signature socket must be 401', at('sockets.open', 'initial', 2, () => refusedSession('refused', 403)), 'FAIL', 'BAD_SIGNATURE_ACCEPTED', 'initial'],
  ['unknown tenant must be 404', at('sockets.open', 'initial', 3, () => refusedSession('refused', 401)), 'FAIL', 'UNKNOWN_TENANT_ACCEPTED', 'initial'],
  ['bad-signature broadcast must be 401', at('api.broadcast', 'initial', 1, () => ({ status: 202 })), 'FAIL', 'BAD_SIGNATURE_BROADCAST_ACCEPTED', 'initial'],
  ['positive broadcast must be 202', at('api.broadcast', 'initial', 2, () => () => ({ status: 200 })), 'FAIL', 'POSITIVE_BROADCAST_REFUSED', 'initial'],
  ['a control socket timeout is not an acceptance', at('sockets.open', 'initial', 2, () => refusedSession('timeout', null)), 'INCONCLUSIVE', 'CONTROL_OUTCOME_UNKNOWN', 'initial'],
  ['an unknown-tenant close is not an acceptance', at('sockets.open', 'initial', 3, () => refusedSession('closed', null)), 'INCONCLUSIVE', 'CONTROL_OUTCOME_UNKNOWN', 'initial'],
  ['a bad-broadcast timeout is not an acceptance', at('api.broadcast', 'initial', 1, () => ({ status: 'timeout' })), 'INCONCLUSIVE', 'CONTROL_OUTCOME_UNKNOWN', 'initial'],
  ['DB case socket timeout is not an auth failure', at('sockets.open', 'wrong-key-db-only', 1, () => refusedSession('timeout', null)), 'INCONCLUSIVE', 'DB_CASE_SOCKET_OUTCOME_UNKNOWN', 'wrong-key-db-only'],
  ['a positive DB-decrypt failure under K is a FAIL', at('session.join', 'restart-persistence', 1, (x) => {
    x.ctx.world.logs.push(...x.ctx.world.crash('connect', ext(x)));
    return { status: 'error', reason: 'UnableToConnectToProject: Realtime was unable to connect to the project database' };
  }), 'FAIL', 'POSITIVE_DB_DECRYPT_FAILED', 'restart-persistence'],
  ['broadcast nonce must be exact', at('session.expectBroadcast', 'initial', 1, () => (r) => ({ ...r, nonce: 'e'.repeat(32) })), 'FAIL', 'STALE_OR_FOREIGN_MESSAGE', 'initial'],
  ['INSERT must be delivered', at('session.expectInsert', 'initial', 1, () => () => ({ received: false })), 'INCONCLUSIVE', 'INSERT_NOT_DELIVERED', 'initial'],
  ['INSERT nonce must be exact', at('session.expectInsert', 'initial', 1, () => (r) => ({ ...r, nonce: 'e'.repeat(32) })), 'FAIL', 'STALE_OR_FOREIGN_MESSAGE', 'initial'],
  ['tenant DB session must be the tenant role', at('tenantDb.observeConnections', 'initial', 1,
    (x) => [{ usename: 'other', datname: x.ctx.secrets.tenants.a.db.db_name, application_name: 'x' }]), 'FAIL', 'NO_TENANT_DB_SESSION', 'initial'],
  ['a positive window must hold no decrypt failure', at('lifecycle.logsSince', 'initial', 1, () => (r) => ({ ...r, gcmFailures: 1 })), 'FAIL', 'UNEXPECTED_DECRYPT_FAILURE', 'initial'],
  ['truncated logs abort', at('lifecycle.logsSince', 'initial', 1, () => (r) => ({ ...r, truncated: true })), 'ABORTED', 'LOG_CAPTURE', 'initial'],
  ['a session with two constructions fails', at('session.close', 'initial', 1, () => (r) => ({ ...r, socketConstructions: 2 })), 'FAIL', 'SDK_RETRY', 'initial'],
  ['a message with an unissued nonce fails', at('session.close', 'initial', 1, () => (r) => ({ ...r, received: [...r.received, { kind: 'broadcast', nonce: 'e'.repeat(32) }] })), 'FAIL', 'STALE_OR_FOREIGN_MESSAGE', 'initial'],
  ['admin GET must be 404 before create', at('api.getTenant', 'initial', 1, () => ({ status: 200 })), 'ABORTED', 'TENANT_PRESENT', 'initial'],
  ['create must be 201', at('api.createTenant', 'initial', 1, () => () => ({ status: 200 })), 'ABORTED', 'CREATE_NOT_FRESH', 'initial'],
  ['baseline must be GCM layout', at('metadata.readSix', 'initial', 3, () => (r) => ({ ...r, values: { ...r.values, db_host: r.values.db_host.slice(3) } })), 'ABORTED', 'NOT_GCM', 'initial'],
  ['baseline IVs must differ', at('metadata.readSix', 'initial', 3, () => (r) => {
    const jwt = Buffer.from(r.values.jwt_secret.slice(3), 'base64');
    const pw = Buffer.from(r.values.db_password.slice(3), 'base64');
    jwt.copy(pw, 0, 0, 12);
    return { ...r, values: { ...r.values, db_password: `g1:${pw.toString('base64')}` } };
  }), 'ABORTED', 'IV_REUSED', 'initial'],
  ['one tenant row and one extension row', at('metadata.readSix', 'restart-persistence', 1, () => (r) => ({ ...r, tenantRows: 2 })), 'ABORTED', 'METADATA_SHAPE', 'restart-persistence'],
  ['jwt_jwks stays absent', at('metadata.readSix', 'restart-persistence', 1, () => (r) => ({ ...r, jwtJwks: {} })), 'ABORTED', 'METADATA_SHAPE', 'restart-persistence'],
  ['publication and slot stay the planned ones', at('metadata.readSix', 'restart-persistence', 1, () => (r) => ({ ...r, otherSettings: { ...r.otherSettings, publication: 'supabase_realtime' } })), 'ABORTED', 'METADATA_SHAPE', 'restart-persistence'],
  ['other settings may not change', at('metadata.readSix', 'restart-persistence', 1, () => (r) => ({ ...r, otherSettings: { ...r.otherSettings, poll_interval_ms: 200 } })), 'ABORTED', 'UNPLANNED_REWRITE', 'restart-persistence'],
  ['stop must prove the same identity', at('lifecycle.stop', 'restart-persistence', 1, () => (r) => ({ ...r, identity: 'other' })), 'ABORTED', 'PROCESS_NOT_GONE', 'restart-persistence'],
  ['stop must capture complete logs', at('lifecycle.stop', 'restart-persistence', 1, () => (r) => ({ ...r, logsComplete: false })), 'ABORTED', 'LOG_CAPTURE', 'restart-persistence'],
  ['start must use the requested key', at('lifecycle.start', 'wrong-key-global', 1, () => (r) => ({ ...r, key: 'K' })), 'ABORTED', 'LIFECYCLE', 'wrong-key-global'],
  ['wrong-key socket timeout is not a refusal', at('sockets.open', 'wrong-key-global', 1, () => refusedSession('timeout', null)), 'INCONCLUSIVE', 'SOCKET_OUTCOME_UNKNOWN', 'wrong-key-global'],
  ['wrong-key socket close is not a refusal', at('sockets.open', 'wrong-key-global', 1, () => refusedSession('closed', null)), 'INCONCLUSIVE', 'SOCKET_OUTCOME_UNKNOWN', 'wrong-key-global'],
  ['wrong-key broadcast 2xx is a FAIL', at('api.broadcast', 'wrong-key-global', 1, () => ({ status: 202 })), 'FAIL', 'BROADCAST_AUTHORISED_DESPITE_FAULT', 'wrong-key-global'],
  ['wrong-key broadcast timeout is not a refusal', at('api.broadcast', 'wrong-key-global', 1, () => ({ status: 'timeout' })), 'INCONCLUSIVE', 'BROADCAST_OUTCOME_UNKNOWN', 'wrong-key-global'],
  // Window 1 is read twice (settling), so the socket leg is reads 1-2 and the broadcast leg read 3.
  ['socket leg needs its own attribution', at('lifecycle.logsSince', 'wrong-key-global', [1, 2], () => (r) => ({ ...r, byTenant: { a: 0, b: 0 }, byConsumer: { a: { socket: 0, broadcast: 0, untagged: 0 }, b: { socket: 0, broadcast: 0, untagged: 0 } } })), 'INCONCLUSIVE', 'NO_ATTRIBUTABLE_DECRYPT_FAILURE', 'wrong-key-global'],
  ['broadcast leg needs its own attribution', at('lifecycle.logsSince', 'wrong-key-global', 3, () => (r) => ({ ...r, byTenant: { a: 0, b: 0 }, byConsumer: { a: { socket: 0, broadcast: 0, untagged: 0 }, b: { socket: 0, broadcast: 0, untagged: 0 } } })), 'INCONCLUSIVE', 'NO_ATTRIBUTABLE_DECRYPT_FAILURE', 'wrong-key-global'],
  ['attribution to the other tenant too is not clean', at('lifecycle.logsSince', 'wrong-key-global', [1, 2], () => (r) => ({ ...r, byTenant: { a: 1, b: 1 } })), 'INCONCLUSIVE', 'NO_ATTRIBUTABLE_DECRYPT_FAILURE', 'wrong-key-global'],
  ['negative cases check control liveness', at('lifecycle.liveness', 'wrong-key-global', 1, () => ({ status: 503 })), 'ABORTED', 'CONTROL_DOWN', 'wrong-key-global'],
  ['DB case must authenticate first', at('sockets.open', 'wrong-key-db-only', 1, () => refusedSession('refused', 500)), 'FAIL', 'DB_CASE_AUTH_FAILED', 'wrong-key-db-only'],
  ['admin JWT update must be 200', at('api.updateJwt', 'wrong-key-db-only', 1, () => () => ({ status: 500 })), 'FAIL', 'ADMIN_UPDATE_REFUSED', 'wrong-key-db-only'],
  ['admin JWT update must rewrite the JWT', at('api.updateJwt', 'wrong-key-db-only', 1, () => ({ status: 200 })), 'FAIL', 'JWT_NOT_REWRITTEN', 'wrong-key-db-only'],
  ['the Kbad JWT must be GCM layout', at('api.updateJwt', 'wrong-key-db-only', 1, (x) => (r) => {
    const rec = x.ctx.world.meta.get(ext(x, 'b'));
    rec.jwt_secret = rec.jwt_secret.slice(3);
    return r;
  }), 'ABORTED', 'NOT_GCM', 'wrong-key-db-only'],
  ['a restore must be re-verified', at('metadata.conditionalReplace', 'tamper-tag-jwt_secret', 2, () => ({ rowCount: 1 })), 'ABORTED', 'UNPLANNED_REWRITE', 'tamper-tag-jwt_secret'],
];

for (const [name, hook, verdict, code, stoppedIn] of GUARDS) {
  test(`guard: ${name}`, async () => {
    const { result, world, ctx } = await perturbed(hook);
    assert.equal(ctx.opened, ctx.closed, 'every session opened is closed, refused ones included');
    assert.equal(result.verdict, verdict, JSON.stringify(result.cases.at(-1)));
    assert.equal(result.stopReason, code);
    assert.equal(result.stoppedIn, stoppedIn);
    assert.equal(world.state.running, false);
  });
}

test('guard: a start that rewrites a setting is caught in the restart case itself', async () => {
  const { result } = await perturbed(at('lifecycle.start', 'restart-persistence', 1, (x) => (r) => {
    x.ctx.world.meta.get(ext(x)).settings.poll_interval_ms = 250;
    return r;
  }));
  assert.deepEqual([result.verdict, result.stopReason, result.stoppedIn], ['ABORTED', 'UNPLANNED_REWRITE', 'restart-persistence']);
});

test('guard: late SDK activity after the last case fails the run', async () => {
  const { result } = await perturbed(() => undefined, (adapters) => {
    adapters.sockets.finalCheck = () => ({ violations: ['LATE_ACTIVITY'] });
  });
  assert.deepEqual([result.verdict, result.stopReason], ['FAIL', 'LATE_CLIENT_ACTIVITY']);
});

test('guard: a nonce shorter than 16 characters is refused', async () => {
  const { result } = await perturbed(() => undefined, (adapters) => {
    let i = 0;
    adapters.ids = { ...adapters.ids, nonce: () => `n${(i += 1)}` };
  });
  assert.deepEqual([result.verdict, result.stopReason], ['ABORTED', 'NONCE_REUSED']);
});

test('guard: an issued token echoed back by an adapter never reaches evidence', async () => {
  const { result } = await perturbed(at('session.join', 'initial', 1, (x) => () => ({ status: 'error',
    reason: `bad token tok.${sha256(x.ctx.secrets.tenants.a.jwtSecret)}.a` })));
  assert.deepEqual([result.verdict, result.stopReason], ['ABORTED', 'SECRET_IN_EVIDENCE']);
});

test('guard: an overall deadline passing during a start stops before any consumer is touched', async () => {
  const { result, world } = await perturbed(at('lifecycle.start', 'tamper-tag-db_host', 1, (x) => (r) => {
    x.ctx.world.state.jump = 10 * 60 * 60 * 1000;
    return r;
  }));
  assert.deepEqual([result.verdict, result.stopReason, result.stoppedIn], ['ABORTED', 'OVERALL_DEADLINE', 'tamper-tag-db_host']);
  const steps = world.state.records.filter((r) => r.caseId === 'tamper-tag-db_host').map((r) => r.step);
  assert.deepEqual(steps, ['case-start', 'stop', 'replace', 'stored', 'start'], 'no socket, liveness or write after the deadline');
});

test('guard: an admin token the API adapter minted never reaches evidence', async () => {
  const { result } = await perturbed(at('session.join', 'initial', 1, (x) => async () => ({ status: 'error',
    reason: `admin ${await x.ctx.adapters.tokens.admin()}` })));
  assert.deepEqual([result.verdict, result.stopReason], ['ABORTED', 'SECRET_IN_EVIDENCE']);
});

test('guard: the create request sends ssl_enforced=false and the planned publication and slot', async () => {
  const bodies = [];
  await perturbed((x) => { if (x.path === 'api.createTenant') bodies.push(x.args[0]); return undefined; });
  const settings = bodies.map((b) => b.tenant.extensions[0].settings);
  assert.deepEqual(settings.map((st) => [st.ssl_enforced, st.publication, st.slot_name]), [[false, 'gcm_pub_a', 'gcm_slot_a'], [false, 'gcm_pub_b', 'gcm_slot_b']]);
  assert.ok(bodies.every((b) => b.tenant.jwt_jwks === undefined && b.tenant.postgres_cdc_default === 'postgres_cdc_rls'));
});

test('validatePlan ties the settle bounds and the log-read cap together and checks refusal shapes', () => {
  const bad = [
    (p) => { p.limits.settleReads = 1; },
    (p) => { p.timeouts.settleMs = 0; },
    (p) => { p.caps.logReads = 40; },
    (p) => { p.limits.settleReads = 4; },
    (p) => { delete p.expected; },
    (p) => { p.expected.jwtSocketStatus = '500'; },
    (p) => { p.expected.jwtBroadcastStatus = null; },
    (p) => { p.expected.dbJoinReasons = 'UnableToConnectToProject'; },
    (p) => { p.expected.dbJoinReasons = ['']; },
  ];
  for (const edit of bad) {
    const p = boundPlan();
    edit(p);
    assert.throws(() => validatePlan(p), /BAD_PLAN/, edit.toString());
  }
});

test('the secret guard catches an upper-cased secret', () => {
  const s = fakeSecrets(manifest());
  assert.throws(() => assertNoSecrets(s.tenants.a.jwtSecret.toUpperCase(), secretStrings(s)), /SECRET_IN_EVIDENCE/);
});

test('crash entries without a Request: line still count for the JWT legs (untagged entries count anywhere)', async () => {
  const { result } = await run({ untaggedCrash: true });
  assert.equal(result.verdict, 'CONSUMER_CASES_PASSED', JSON.stringify(result.cases.at(-1)));
});

const BOUND = 'UnableToConnectToProject: Realtime was unable to connect to the project database';
const INIT = 'InitializingProjectConnection: Realtime is initializing the project connection';

test('positive join errors: FAIL only with an attributed untagged Connect entry, whatever the reason', async () => {
  const cases = [
    [() => ({ status: 'error', reason: BOUND }), 'INCONCLUSIVE', 'POSITIVE_JOIN_REFUSED'],
    [(x) => { x.ctx.world.logs.push(...x.ctx.world.crash('connect', ext(x))); return { status: 'error', reason: INIT }; }, 'FAIL', 'POSITIVE_DB_DECRYPT_FAILED'],
    [(x) => { x.ctx.world.logs.push(...x.ctx.world.crash('socket', ext(x))); return { status: 'error', reason: BOUND }; }, 'INCONCLUSIVE', 'POSITIVE_JOIN_REFUSED'],
  ];
  for (const [h, verdict, code] of cases) {
    const { result, ctx } = await perturbed(at('session.join', 'restart-persistence', 1, h));
    assert.deepEqual([result.verdict, result.stopReason], [verdict, code]);
    assert.equal(ctx.opened, ctx.closed);
  }
});

test('a connect-path reason with the attributed Connect crash is an accepted DB refusal', async () => {
  const { result } = await perturbed(at('session.join', 'wrong-key-db-only', 1, () => (r) => ({ ...r, reason: INIT })));
  assert.equal(result.verdict, 'CONSUMER_CASES_PASSED', JSON.stringify(result.cases.at(-1)));
});

test('validatePlan checks the connect-path reasons too', () => {
  for (const v of ['x', [''], [1]]) {
    const p = boundPlan();
    p.expected.dbConnectPathReasons = v;
    assert.throws(() => validatePlan(p), /BAD_PLAN/);
  }
});

test('a refused positive join is closed before its log window is read (no SDK rejoin meanwhile)', async () => {
  const order = [];
  await perturbed((x) => {
    if (x.caseId === 'restart-persistence' && (x.path === 'session.close' || x.path === 'lifecycle.logsSince')) order.push(x.path);
    if (x.path === 'session.join' && x.caseId === 'restart-persistence' && x.n === 1) return { status: 'error', reason: BOUND };
    return undefined;
  });
  assert.deepEqual(order.slice(0, 2), ['session.close', 'lifecycle.logsSince']);
});
