// db-candidate03/entrypoint.test.mjs — gate tests + mutation-style negatives for entrypoint.mjs.
// Pure: every reader, the PrismaClient factory, and createRequire are injected fakes. No Prisma import,
// no DB, no Docker, no network, no credential file read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  sanitizeEnv, validateOutputDir, validateApproval, validateReceipt, validateSourceManifest,
  validateClientArtifacts, loadBoundPrisma, buildDatasourceUrl, constructClient, buildClients,
  runEntrypoint, EntrypointRefusal, ENV_REQUIRED, APPLICATION_NAMES, CLIENT_VERSION, ENGINE_REVISION,
  LINUX_ENGINE_FILE,
} from '../scripts/r3_db_candidate/entrypoint.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
};
const expectRefusal = (fn, codePrefix) => {
  try { fn(); } catch (e) {
    assert.ok(e instanceof EntrypointRefusal, 'expected EntrypointRefusal, got ' + e);
    if (codePrefix) assert.ok(e.code.startsWith(codePrefix), 'code ' + e.code + ' !~ ' + codePrefix);
    return;
  }
  assert.fail('expected refusal ' + codePrefix);
};

// ---- fixtures ----
const ATTEMPT = 'a'.repeat(32);
const OWNER_DECISION_SHA = 'b'.repeat(64);
const IMAGE = 'supabase/postgres@sha256:' + 'e'.repeat(64);
const CONFIG = 'sha256:' + 'c'.repeat(64);
const goodEnv = () => ({ PATH: ENV_REQUIRED.PATH, HOME: '/home/runner', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', PWD: '/w', SHLVL: '1', _: '/x' });

test('sanitizeEnv accepts the allowlisted shell and strips extras it does not know', () => {
  const out = sanitizeEnv(goodEnv());
  assert.equal(out.PATH, ENV_REQUIRED.PATH);
  assert.ok(Object.isFrozen(out));
});
test('sanitizeEnv rejects ambient DATABASE_URL, engine, proxy, preload', () => {
  for (const name of ['DATABASE_URL', 'DIRECT_URL', 'PRISMA_QUERY_ENGINE_LIBRARY', 'NODE_OPTIONS', 'LD_PRELOAD', 'PGPASSWORD']) {
    expectRefusal(() => sanitizeEnv({ ...goodEnv(), [name]: 'x' }), 'ENV_');
  }
});
test('sanitizeEnv rejects a wrong required value and any unknown name', () => {
  expectRefusal(() => sanitizeEnv({ ...goodEnv(), LC_ALL: 'en_US.UTF-8' }), 'ENV_REQUIRED');
  expectRefusal(() => sanitizeEnv({ ...goodEnv(), SOMETHING: '1' }), 'ENV_NOT_ALLOWED');
  // prefix catch: an unknown PRISMA_* name hits the forbidden-prefix branch
  expectRefusal(() => sanitizeEnv({ ...goodEnv(), PRISMA_FOO: '1' }), 'ENV_FORBIDDEN_PREFIX');
});

test('validateOutputDir requires an owned, empty, 0700 real directory', () => {
  const ok = { isDirectory: true, isSymbolicLink: false, uid: 501, mode: 0o700, entries: [] };
  assert.equal(validateOutputDir('/p', { statDir: () => ok, selfUid: 501 }), '/p');
  expectRefusal(() => validateOutputDir('/p', { statDir: () => ({ ...ok, mode: 0o755 }), selfUid: 501 }), 'OUTPUT_MODE');
  expectRefusal(() => validateOutputDir('/p', { statDir: () => ({ ...ok, uid: 0 }), selfUid: 501 }), 'OUTPUT_OWNER');
  expectRefusal(() => validateOutputDir('/p', { statDir: () => ({ ...ok, entries: ['x'] }), selfUid: 501 }), 'OUTPUT_NOT_EMPTY');
  expectRefusal(() => validateOutputDir('/p', { statDir: () => ({ ...ok, isSymbolicLink: true }), selfUid: 501 }), 'OUTPUT_NOT_DIR');
  expectRefusal(() => validateOutputDir('rel', { statDir: () => ok, selfUid: 501 }), 'OUTPUT_PATH');
});

const goodApproval = (over = {}) => ({
  purpose: 'ONE_ISOLATED_DB_CANDIDATE', attempt_id: ATTEMPT, owner_decision_sha256: OWNER_DECISION_SHA,
  source_manifest_sha256: 'ab'.repeat(32), client_artifacts_sha256: 'd'.repeat(64),
  criterion: 'REPLACEMENT_REGRESSION_NOT_HISTORICAL', historical_status: 'NOT_REPRODUCED', r3_status: 'OPEN',
  issued_at_utc: '2026-10-25T12:00:00Z', single_attempt: true, ...over,
});
const approvalCtx = { attemptId: ATTEMPT, expectSourceManifestSha: 'ab'.repeat(32), expectClientArtifactsSha: 'd'.repeat(64), ownerDecisionSha: OWNER_DECISION_SHA };

test('validateApproval accepts a well-formed fresh approval', () => {
  assert.equal(validateApproval(goodApproval(), approvalCtx), true);
});
test('validateApproval mutation negatives', () => {
  expectRefusal(() => validateApproval(goodApproval({ historical_status: 'REPRODUCED' }), approvalCtx), 'APPROVAL_HISTORICAL');
  expectRefusal(() => validateApproval(goodApproval({ r3_status: 'CLOSED' }), approvalCtx), 'APPROVAL_R3');
  expectRefusal(() => validateApproval(goodApproval({ single_attempt: false }), approvalCtx), 'APPROVAL_SINGLE_ATTEMPT');
  expectRefusal(() => validateApproval(goodApproval({ attempt_id: 'z'.repeat(32) }), approvalCtx), 'APPROVAL_ATTEMPT');
  expectRefusal(() => validateApproval(goodApproval({ criterion: 'HISTORICAL_REPRODUCTION' }), approvalCtx), 'APPROVAL_CRITERION');
  expectRefusal(() => validateApproval(goodApproval({ purpose: 'OTHER' }), approvalCtx), 'APPROVAL_PURPOSE');
  const { single_attempt: _singleAttempt, ...missing } = goodApproval();
  expectRefusal(() => validateApproval(missing, approvalCtx), 'APPROVAL_SHAPE');
  expectRefusal(() => validateApproval({ ...goodApproval(), extra: 1 }, approvalCtx), 'APPROVAL_SHAPE');
});
test('validateApproval binds owner-decision, source-manifest and client-artifacts hashes (kills M1/M2/M3)', () => {
  expectRefusal(() => validateApproval(goodApproval({ owner_decision_sha256: 'c'.repeat(64) }), approvalCtx), 'APPROVAL_OWNER_DECISION');
  expectRefusal(() => validateApproval(goodApproval({ source_manifest_sha256: 'cd'.repeat(32) }), approvalCtx), 'APPROVAL_SOURCE');
  expectRefusal(() => validateApproval(goodApproval({ client_artifacts_sha256: 'ef'.repeat(32) }), approvalCtx), 'APPROVAL_ARTIFACTS');
});

const goodReceipt = (over = {}) => ({
  purpose: 'ONE_ISOLATED_DB_CANDIDATE', attempt_id: ATTEMPT, image: IMAGE, config_digest: CONFIG,
  platform: 'linux/amd64', container_id: 'f'.repeat(64), endpoint_host: '127.0.0.1', endpoint_port: 54329,
  database: 'regress_r3_candidate', probe_role: 'regress_r3_probe', loaded_library_ref: 'loaded-library.json',
  startup_closure_status: 'CLOSED_FROM_RETAINED_EVIDENCE', prepared_at_utc: '2026-10-25T12:05:00Z', ...over,
});
const receiptCtx = { attemptId: ATTEMPT, approvalIssuedAt: '2026-10-25T12:00:00Z', expectImage: IMAGE, expectConfigDigest: CONFIG };

test('validateReceipt accepts a fresh loopback receipt', () => {
  assert.equal(validateReceipt(goodReceipt(), receiptCtx), true);
});
test('validateReceipt mutation negatives', () => {
  expectRefusal(() => validateReceipt(goodReceipt({ endpoint_host: '10.0.0.5' }), receiptCtx), 'RECEIPT_ENDPOINT_HOST');
  expectRefusal(() => validateReceipt(goodReceipt({ platform: 'linux/arm64' }), receiptCtx), 'RECEIPT_PLATFORM');
  expectRefusal(() => validateReceipt(goodReceipt({ prepared_at_utc: '2026-10-25T11:59:59Z' }), receiptCtx), 'RECEIPT_STALE');
  expectRefusal(() => validateReceipt(goodReceipt({ database: 'postgres' }), receiptCtx), 'RECEIPT_DATABASE');
  expectRefusal(() => validateReceipt(goodReceipt({ loaded_library_ref: 'postgres://u:p@h/db' }), receiptCtx), 'RECEIPT_LEAK');
  expectRefusal(() => validateReceipt(goodReceipt({ startup_closure_status: 'MAYBE' }), receiptCtx), 'RECEIPT_STARTUP_CLOSURE');
  expectRefusal(() => validateReceipt(goodReceipt({ image: 'supabase/postgres@sha256:' + '0'.repeat(64) }), { ...receiptCtx, expectImage: IMAGE }), 'RECEIPT_IMAGE');
});
test('validateReceipt accepts the honest OPEN_UNRESOLVED closure value (but entrypoint still gates on approval)', () => {
  assert.equal(validateReceipt(goodReceipt({ startup_closure_status: 'OPEN_UNRESOLVED' }), receiptCtx), true);
});
test('validateReceipt binds attempt_id and config_digest (kills M6/M7)', () => {
  expectRefusal(() => validateReceipt(goodReceipt({ attempt_id: 'z'.repeat(32) }), receiptCtx), 'RECEIPT_ATTEMPT');
  expectRefusal(() => validateReceipt(goodReceipt({ config_digest: 'sha256:' + '0'.repeat(64) }), { ...receiptCtx, expectConfigDigest: CONFIG }), 'RECEIPT_CONFIG');
});

test('validateSourceManifest detects drift, extra and missing files', () => {
  const files = { 'driver.mjs': Buffer.from('X'), 'fixture-sql.mjs': Buffer.from('Y') };
  const expected = Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha(b)]));
  const read = n => files[n];
  assert.equal(validateSourceManifest(expected, { readBytes: read }), sha(canonical(expected)));
  assert.throws(() => validateSourceManifest(expected, { readBytes: n => (n === 'driver.mjs' ? Buffer.from('tampered') : files[n]) }));
  assert.throws(() => validateSourceManifest({ ...expected, extra: sha(Buffer.from('e')) }, { readBytes: n => files[n] ?? undefined }));
});

// ---- client artifacts ----
function artifactFixture() {
  const base = '/r/packages/db/generated/client/';
  const indexBody = 'module.exports={}; // "clientVersion": "' + CLIENT_VERSION + '" "engineVersion": "' +
    ENGINE_REVISION + '" "relativeEnvPaths" "rootEnvPath": null';
  const files = {
    [base + 'index.js']: Buffer.from(indexBody),
    [base + 'package.json']: Buffer.from('{"name":"c"}'),
    [base + 'schema.prisma']: Buffer.from('datasource db {}'),
    [base + 'runtime/library.js']: Buffer.from('runtime'),
    [base + LINUX_ENGINE_FILE]: Buffer.from('ELFLINUX'),
    '/opt/node/bin/node': Buffer.from('NODEBIN'),
  };
  const expected = Object.fromEntries(Object.entries(files).map(([p, b]) => [p, { sha256: sha(b), bytes: b.length }]));
  return { base, files, expected, nodePath: '/opt/node/bin/node', read: p => files[p] };
}

test('validateClientArtifacts verifies bytes, node path, version/engine/env markers', () => {
  const f = artifactFixture();
  const result = validateClientArtifacts(f.expected, { readBytes: f.read, nodeExecPath: f.nodePath });
  assert.ok(/^[a-f0-9]{64}$/.test(result));
});
test('validateClientArtifacts mutation negatives', () => {
  const f = artifactFixture();
  // hash mismatch
  expectRefusal(() => validateClientArtifacts(f.expected, { readBytes: p => (p.endsWith('index.js') ? Buffer.from('other') : f.read(p)), nodeExecPath: f.nodePath }), 'ARTIFACT_');
  // wrong node path (engine substitution analogue)
  expectRefusal(() => validateClientArtifacts(f.expected, { readBytes: f.read, nodeExecPath: '/usr/bin/node' }), 'ARTIFACT_NODE_PATH');
  // missing the Linux engine
  const noEngine = { ...f.expected }; delete noEngine[f.base + LINUX_ENGINE_FILE];
  expectRefusal(() => validateClientArtifacts(noEngine, { readBytes: f.read, nodeExecPath: f.nodePath }), 'ARTIFACT_');
  // index without the pinned engine revision
  const badIndex = { ...f.files, [f.base + 'index.js']: Buffer.from('"clientVersion": "' + CLIENT_VERSION + '" "rootEnvPath": null') };
  const badExpected = { ...f.expected, [f.base + 'index.js']: { sha256: sha(badIndex[f.base + 'index.js']), bytes: badIndex[f.base + 'index.js'].length } };
  expectRefusal(() => validateClientArtifacts(badExpected, { readBytes: p => badIndex[p], nodeExecPath: f.nodePath }), 'ARTIFACT_ENGINE_REVISION');
});
test('validateClientArtifacts requires the clientVersion marker and the rootEnvPath:null .env guard (kills M4/M5)', () => {
  const f = artifactFixture();
  // M4: index.js missing the pinned clientVersion marker (engine + env markers present).
  const noVer = { ...f.files, [f.base + 'index.js']: Buffer.from('"engineVersion": "' + ENGINE_REVISION + '" "relativeEnvPaths" "rootEnvPath": null') };
  const noVerExp = { ...f.expected, [f.base + 'index.js']: { sha256: sha(noVer[f.base + 'index.js']), bytes: noVer[f.base + 'index.js'].length } };
  expectRefusal(() => validateClientArtifacts(noVerExp, { readBytes: p => noVer[p], nodeExecPath: f.nodePath }), 'ARTIFACT_CLIENT_VERSION');
  // M5: index.js missing rootEnvPath:null — would let the generated client side-load a repository .env.
  const noEnv = { ...f.files, [f.base + 'index.js']: Buffer.from('"clientVersion": "' + CLIENT_VERSION + '" "engineVersion": "' + ENGINE_REVISION + '" "relativeEnvPaths"') };
  const noEnvExp = { ...f.expected, [f.base + 'index.js']: { sha256: sha(noEnv[f.base + 'index.js']), bytes: noEnv[f.base + 'index.js'].length } };
  expectRefusal(() => validateClientArtifacts(noEnvExp, { readBytes: p => noEnv[p], nodeExecPath: f.nodePath }), 'ARTIFACT_ENV_PATHS');
});

test('validateClientArtifacts kills a same-length HASH mutant (size passes, hash fails)', () => {
  const f = artifactFixture();
  const original = f.files[f.base + 'package.json'];
  const sameLen = Buffer.alloc(original.length, 0x58); // same byte count, different content
  expectRefusal(() => validateClientArtifacts(f.expected, {
    readBytes: p => (p.endsWith('package.json') ? sameLen : f.read(p)), nodeExecPath: f.nodePath,
  }), 'ARTIFACT_HASH');
});

test('loadBoundPrisma requires an absolute index.js and a PrismaClient export', () => {
  const fakeClient = function () {};
  const req = () => path => { assert.equal(path, '/r/generated/client/index.js'); return { PrismaClient: fakeClient }; };
  assert.equal(loadBoundPrisma('/r/generated/client/index.js', { createRequireFn: req, fromPath: '/r/entry.mjs' }), fakeClient);
  expectRefusal(() => loadBoundPrisma('client/index.js', { createRequireFn: req, fromPath: '/x' }), 'BIND_PATH');
  const reqNoClient = () => () => ({});
  expectRefusal(() => loadBoundPrisma('/r/index.js', { createRequireFn: reqNoClient, fromPath: '/x' }), 'BIND_CLIENT_MISSING');
});

const goodCred = (over = {}) => ({ user: 'regress_r3_probe', password: 'p'.repeat(40), host: '127.0.0.1', port: 54329, database: 'regress_r3_candidate', ...over });
test('buildDatasourceUrl pins conn limit 1, per-lane application_name, loopback, and refuses weak creds', () => {
  const url = buildDatasourceUrl(goodCred(), 'A');
  assert.ok(url.includes('connection_limit=1'));
  assert.ok(url.includes('application_name=' + APPLICATION_NAMES.A));
  assert.ok(url.startsWith('postgresql://regress_r3_probe:'));
  expectRefusal(() => buildDatasourceUrl(goodCred({ password: 'short' }), 'A'), 'CRED_PASSWORD');
  expectRefusal(() => buildDatasourceUrl(goodCred({ host: '8.8.8.8' }), 'A'), 'CRED_HOST');
  expectRefusal(() => buildDatasourceUrl(goodCred({ user: 'postgres' }), 'A'), 'CRED_USER');
  expectRefusal(() => buildDatasourceUrl(goodCred(), 'D'), 'CRED_LANE');
});
test('buildDatasourceUrl brackets an IPv6 loopback and never exposes the url on an object', () => {
  const url = buildDatasourceUrl(goodCred({ host: '::1' }), 'B');
  assert.ok(url.includes('@[::1]:54329/'));
});

// A fake PrismaClient that records its construction options but makes no connection.
function fakePrismaFactory(record) {
  return function FakePrisma(opts) {
    record.push(opts);
    this.$transaction = async () => { throw new Error('not called in this test'); };
    this.$disconnect = async () => {};
  };
}
test('constructClient passes an empty log array, minimal errorFormat, and wraps with the adapter', () => {
  const seen = [];
  const wrapped = constructClient(fakePrismaFactory(seen), goodCred(), 'A', { now: () => 0 });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].log, []);
  assert.equal(seen[0].errorFormat, 'minimal');
  assert.ok(seen[0].datasources.db.url.includes('application_name=' + APPLICATION_NAMES.A));
  assert.equal(typeof wrapped.interactive, 'function');
  assert.equal(typeof wrapped.disconnect, 'function');
  assert.equal(wrapped.url, undefined, 'the url must not be attached to the returned object');
});
test('buildClients builds A and B eagerly and C only once, on demand', () => {
  const seen = [];
  const { a, b, createFreshC } = buildClients(fakePrismaFactory(seen), goodCred(), { now: () => 0 });
  assert.equal(seen.length, 2, 'A and B constructed eagerly, C not yet');
  assert.ok(a && b);
  const c1 = createFreshC();
  assert.equal(seen.length, 3);
  assert.ok(c1);
  expectRefusal(() => createFreshC(), 'C_ALREADY_BUILT');
});

// ---- end-to-end gate chain with a driver that is never reached because a gate fails first ----
test('runEntrypoint aborts before Prisma import when the environment is contaminated', async () => {
  let prismaTouched = false;
  const io = {
    readProcessEnv: () => ({ ...goodEnv(), DATABASE_URL: 'postgres://x' }),
    outputDir: '/out', statDir: () => ({ isDirectory: true, isSymbolicLink: false, uid: 501, mode: 0o700, entries: [] }), selfUid: 501,
    approval: goodApproval(), receipt: goodReceipt(), sourceManifest: {}, clientArtifacts: {},
    binding: { attempt_id: ATTEMPT, owner_decision_sha256: OWNER_DECISION_SHA, image: IMAGE, config_digest: CONFIG, client_artifacts_sha256: 'd'.repeat(64) },
    readSourceBytes: () => Buffer.from(''), readArtifactBytes: () => Buffer.from(''), nodeExecPath: '/opt/node/bin/node',
    createRequireFn: () => { prismaTouched = true; return () => ({}); }, fromPath: '/x',
    credential: goodCred(), record: async () => {}, attest: async () => true,
    nonces: ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)], now: () => 0, deadlineMs: 1000, armDeadline: () => ({ clear() {} }),
  };
  await assert.rejects(() => runEntrypoint(io), e => e instanceof EntrypointRefusal && e.code.startsWith('ENV_'));
  assert.equal(prismaTouched, false, 'Prisma must not be imported after a failed gate');
});

test('runEntrypoint reaches the driver only after every gate passes (driver stubbed via a fake client)', async () => {
  // Build a complete, internally consistent fixture so the chain reaches loadBoundPrisma. We stub the
  // PrismaClient so the driver's first $transaction throws a controlled failure, proving the chain ran
  // without a real DB. This asserts ordering, not a candidate PASS.
  const src = { 'driver.mjs': Buffer.from('A'), 'entrypoint.mjs': Buffer.from('B') };
  const sourceManifest = Object.fromEntries(Object.entries(src).map(([n, b]) => [n, sha(b)]));
  const f = artifactFixture();
  const artifactsSha = (() => {
    const perFile = {}; for (const [p, b] of Object.entries(f.files)) perFile[p] = sha(b);
    return sha(canonical(perFile));
  })();
  let built = 0;
  const FakePrisma = function () {
    built++;
    this.$transaction = async () => { throw new Error('DRIVER_REACHED_NO_DB'); };
    this.$disconnect = async () => {};
  };
  const io = {
    readProcessEnv: () => goodEnv(), outputDir: '/out',
    statDir: () => ({ isDirectory: true, isSymbolicLink: false, uid: 501, mode: 0o700, entries: [] }), selfUid: 501,
    approval: goodApproval({ source_manifest_sha256: sha(canonical(sourceManifest)), client_artifacts_sha256: artifactsSha }),
    receipt: goodReceipt(),
    sourceManifest, readSourceBytes: n => src[n],
    clientArtifacts: f.expected, readArtifactBytes: f.read, nodeExecPath: f.nodePath,
    binding: { attempt_id: ATTEMPT, owner_decision_sha256: OWNER_DECISION_SHA, image: IMAGE, config_digest: CONFIG, client_artifacts_sha256: artifactsSha },
    createRequireFn: () => () => ({ PrismaClient: FakePrisma }), fromPath: '/x',
    credential: goodCred(), record: async () => {}, attest: async () => true,
    nonces: ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)], now: () => 0, deadlineMs: 1000,
    armDeadline: () => ({ clear() {} }),
  };
  const result = await runEntrypoint(io);
  // The driver caught the thrown error and returned a PARTIAL result with NOT_REPRODUCED preserved.
  assert.equal(result.historical_status, 'NOT_REPRODUCED');
  assert.equal(result.status, 'PARTIAL_REVIEW_REQUIRED');
  assert.ok(built >= 2, 'A and B clients were constructed');
});

// Reusable complete, internally-consistent io so a single mutation can be isolated (sec review #1/#2).
function completeIo(over = {}) {
  const src = { 'driver.mjs': Buffer.from('A'), 'entrypoint.mjs': Buffer.from('B') };
  const sourceManifest = Object.fromEntries(Object.entries(src).map(([n, b]) => [n, sha(b)]));
  const f = artifactFixture();
  const perFile = {}; for (const [p, b] of Object.entries(f.files)) perFile[p] = sha(b);
  const artifactsSha = sha(canonical(perFile));
  const FakePrisma = function () { this.$transaction = async () => { throw new Error('NO_DB'); }; this.$disconnect = async () => {}; };
  return {
    readProcessEnv: () => goodEnv(), outputDir: '/out',
    statDir: () => ({ isDirectory: true, isSymbolicLink: false, uid: 501, mode: 0o700, entries: [] }), selfUid: 501,
    approval: goodApproval({ source_manifest_sha256: sha(canonical(sourceManifest)), client_artifacts_sha256: artifactsSha }),
    receipt: goodReceipt(), sourceManifest, readSourceBytes: n => src[n],
    clientArtifacts: f.expected, readArtifactBytes: f.read, nodeExecPath: f.nodePath,
    binding: { attempt_id: ATTEMPT, owner_decision_sha256: OWNER_DECISION_SHA, image: IMAGE, config_digest: CONFIG, client_artifacts_sha256: artifactsSha },
    createRequireFn: () => () => ({ PrismaClient: FakePrisma }), fromPath: '/x',
    credential: goodCred(), record: async () => {}, attest: async () => true,
    nonces: ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)], now: () => 0, deadlineMs: 1000, armDeadline: () => ({ clear() {} }),
    ...over,
  };
}

test('runEntrypoint gates on the LIVE process env, not a separate set (sec #1): contaminated process env is refused before Prisma', async () => {
  let prismaTouched = false;
  const io = completeIo({
    readProcessEnv: () => ({ ...goodEnv(), LD_PRELOAD: '/evil.so' }),
    createRequireFn: () => { prismaTouched = true; return () => ({ PrismaClient: function () {} }); },
  });
  await assert.rejects(() => runEntrypoint(io), e => e instanceof EntrypointRefusal && e.code.startsWith('ENV_'));
  assert.equal(prismaTouched, false, 'a contaminated live process env must abort before Prisma import');
});

test('runEntrypoint collapses a PrismaClient constructor throw to CLIENT_CONSTRUCTION with no URL leak (sec #2)', async () => {
  const Boom = function () { throw new Error('connect ECONNREFUSED postgresql://regress_r3_probe:secretpw@127.0.0.1:5432/regress_r3_candidate'); };
  const io = completeIo({ createRequireFn: () => () => ({ PrismaClient: Boom }) });
  await assert.rejects(() => runEntrypoint(io), e => {
    assert.ok(e instanceof EntrypointRefusal && e.code === 'CLIENT_CONSTRUCTION', 'code ' + e.code);
    assert.ok(!/secretpw/.test(e.message) && !/:\/\//.test(e.message), 'no URL/password may leak into the refusal');
    return true;
  });
});

test('runEntrypoint rejects when the artifacts sha disagrees with the binding', async () => {
  const src = { 'driver.mjs': Buffer.from('A') };
  const sourceManifest = Object.fromEntries(Object.entries(src).map(([n, b]) => [n, sha(b)]));
  const f = artifactFixture();
  const io = {
    readProcessEnv: () => goodEnv(), outputDir: '/out',
    statDir: () => ({ isDirectory: true, isSymbolicLink: false, uid: 501, mode: 0o700, entries: [] }), selfUid: 501,
    approval: goodApproval({ source_manifest_sha256: sha(canonical(sourceManifest)), client_artifacts_sha256: '9'.repeat(64) }),
    receipt: goodReceipt(), sourceManifest, readSourceBytes: n => src[n],
    clientArtifacts: f.expected, readArtifactBytes: f.read, nodeExecPath: f.nodePath,
    binding: { attempt_id: ATTEMPT, owner_decision_sha256: OWNER_DECISION_SHA, image: IMAGE, config_digest: CONFIG, client_artifacts_sha256: '9'.repeat(64) },
    createRequireFn: () => () => ({ PrismaClient: function () {} }), fromPath: '/x',
    credential: goodCred(), record: async () => {}, attest: async () => true,
    nonces: ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)], now: () => 0, deadlineMs: 1000, armDeadline: () => ({ clear() {} }),
  };
  await assert.rejects(() => runEntrypoint(io), e => e instanceof EntrypointRefusal);
});
