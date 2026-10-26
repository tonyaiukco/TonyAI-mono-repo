// Tests for run_candidate.mjs — descriptor gate, real-reader wiring with injected deps, the attest file
// handshake, gate-refusal-before-Prisma, and the direct-invocation failure path. Uses only a private temp
// directory on the local filesystem; no DB, Docker or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDescriptor, buildIo, runFromDescriptor, HarnessRefusal, statDirReal } from '../scripts/r3_db_candidate/run_candidate.mjs';
import { EntrypointRefusal } from '../scripts/r3_db_candidate/entrypoint.mjs';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'r3_db_candidate');
const N = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];
const descriptor = (over = {}) => ({
  outputDir: '/w/candidate', sourceRoot: '/src', approvalPath: '/w/inputs/approval.json',
  receiptPath: '/w/inputs/receipt.json', bindingPath: '/w/inputs/binding.json',
  sourceManifestPath: '/w/inputs/manifest.json', clientArtifactsPath: '/w/inputs/client-artifacts.json',
  credentialPath: '/w/inputs/credential.json', nonces: N, deadlineMs: 120000, attestTimeoutMs: 8000, ...over,
});
const refusal = (fn, prefix) => {
  try { fn(); } catch (e) {
    assert.ok(e instanceof HarnessRefusal, 'expected HarnessRefusal, got ' + e);
    assert.ok(e.code.startsWith(prefix), e.code + ' !~ ' + prefix);
    return;
  }
  assert.fail('expected refusal ' + prefix);
};

test('validateDescriptor accepts the executor-built shape', () => {
  assert.ok(validateDescriptor(descriptor()));
});

test('validateDescriptor mutation negatives', () => {
  refusal(() => validateDescriptor({ ...descriptor(), extra: 1 }), 'DESCRIPTOR_KEYS');
  const { credentialPath: _credentialPath, ...missing } = descriptor();
  refusal(() => validateDescriptor(missing), 'DESCRIPTOR_KEYS');
  refusal(() => validateDescriptor(descriptor({ credentialPath: 'inputs/credential.json' })), 'DESCRIPTOR_PATH');
  refusal(() => validateDescriptor(descriptor({ outputDir: '/w/\0x' })), 'DESCRIPTOR_PATH');
  refusal(() => validateDescriptor(descriptor({ nonces: [N[0], N[0], N[2]] })), 'DESCRIPTOR_NONCES');
  refusal(() => validateDescriptor(descriptor({ nonces: [N[0], N[1]] })), 'DESCRIPTOR_NONCES');
  refusal(() => validateDescriptor(descriptor({ deadlineMs: 9 * 60 * 1000 })), 'DESCRIPTOR_DEADLINE');
  refusal(() => validateDescriptor(descriptor({ attestTimeoutMs: 0 })), 'DESCRIPTOR_ATTEST_TIMEOUT');
  refusal(() => validateDescriptor(descriptor({ attestTimeoutMs: 30001 })), 'DESCRIPTOR_ATTEST_TIMEOUT');
  refusal(() => validateDescriptor(descriptor({ deadlineMs: 0 })), 'DESCRIPTOR_DEADLINE');
  refusal(() => validateDescriptor(descriptor({ deadlineMs: -5 })), 'DESCRIPTOR_DEADLINE');
  assert.ok(validateDescriptor(descriptor({ attestTimeoutMs: 30000, deadlineMs: 8 * 60 * 1000 })));
});

test('buildIo wires injected readers, reads the credential only from its file, and passes nonces through', () => {
  const reads = [];
  const io = buildIo(descriptor(), {
    getuid: () => 501, readJson: p => { reads.push(p); return p.endsWith('credential.json') ? { user: 'regress_r3_probe' } : { p }; },
    readBytes: p => Buffer.from(p), statDir: () => ({}), readProcessEnv: () => ({ PATH: 'x' }),
    createRequireFn: () => () => ({}), fromPath: '/x', record: async () => {}, attest: async () => true,
    now: () => 0, armDeadline: () => ({ clear() {} }), nodeExecPath: '/node',
  });
  assert.equal(io.selfUid, 501);
  assert.deepEqual(io.credential, { user: 'regress_r3_probe' });
  assert.equal(io.readSourceBytes('driver.mjs').toString(), '/src/driver.mjs');
  assert.deepEqual(io.nonces, N);
  assert.ok(reads.includes('/w/inputs/credential.json'));
  assert.equal(io.outputDir, '/w/candidate');
});

function tempDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'r3c05-'));
  chmodSync(d, 0o700);
  return d;
}

test('attest handshake writes pid+nonce only, waits for the parent ack, then returns true', async () => {
  const d = tempDir();
  try {
    const io = buildIo(descriptor({ outputDir: d, attestTimeoutMs: 2000 }), {
      getuid: () => 501, readJson: () => ({}), sleep: async () => {
        if (existsSync(path.join(d, 'attest-B.request.json'))) writeFileSync(path.join(d, 'attest-B.ack'), '1');
      },
    });
    const ok = await io.attest({ lane: 'B', phase: 'baseline-B', identity: { pid: 77, nonce: N[1] }, gucs: [{ name: 'x' }] });
    assert.equal(ok, true);
    assert.equal(existsSync(path.join(d, 'attest-B.request.json.tmp')), false);       // renamed into place
    const req = JSON.parse(readFileSync(path.join(d, 'attest-B.request.json'), 'utf8'));
    assert.deepEqual(Object.keys(req).sort(), ['lane', 'nonce', 'phase', 'pid']);
    assert.equal(req.pid, 77);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attest refuses on timeout, bad lane and bad identity (fail closed, transaction never proceeds)', async () => {
  const d = tempDir();
  try {
    const io = buildIo(descriptor({ outputDir: d, attestTimeoutMs: 1 }), {
      getuid: () => 501, readJson: () => ({}), sleep: async () => new Promise(r => setTimeout(r, 5)),
    });
    await assert.rejects(io.attest({ lane: 'A', phase: 'baseline-A', identity: { pid: 5, nonce: N[0] } }),
      e => e instanceof HarnessRefusal && e.code === 'ATTEST_TIMEOUT:A');
    await assert.rejects(io.attest({ lane: 'D', identity: { pid: 5, nonce: N[0] } }), e => e.code === 'ATTEST_LANE');
    await assert.rejects(io.attest({ lane: 'A', identity: { pid: 0, nonce: N[0] } }), e => e.code === 'ATTEST_IDENTITY');
    await assert.rejects(io.attest({ lane: 'A', identity: { pid: 5, nonce: 'nope' } }), e => e.code === 'ATTEST_IDENTITY');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('event sink is bounded and append-only', async () => {
  const d = tempDir();
  try {
    const io = buildIo(descriptor({ outputDir: d }), { getuid: () => 501, readJson: () => ({}) });
    await io.record({ sequence: 1, kind: 'x', data: {} });
    await assert.rejects(io.record({ sequence: 2, kind: 'x', data: { big: 'y'.repeat(20000) } }), e => e.code === 'EVENT_SIZE');
    assert.equal(readFileSync(path.join(d, 'candidate-events.jsonl'), 'utf8').trim().split('\n').length, 1);
    for (let i = 3; i <= 256; i++) await io.record({ sequence: i, kind: 'x', data: {} });   // 255 accepted in total
    await assert.rejects(io.record({ sequence: 257, kind: 'x', data: {} }), e => e.code === 'EVENT_BOUND');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('runFromDescriptor: a contaminated live env is refused by entrypoint before Prisma is touched', async () => {
  let prismaTouched = false;
  await assert.rejects(runFromDescriptor(descriptor(), {
    getuid: () => 501, readJson: () => ({}), readProcessEnv: () => ({ PATH: 'x', DATABASE_URL: 'postgres://u:p@h/d' }),
    createRequireFn: () => { prismaTouched = true; return () => ({}); }, writeResult: () => assert.fail('no result on refusal'),
  }), e => e instanceof EntrypointRefusal && e.code.startsWith('ENV_'));
  assert.equal(prismaTouched, false);
});

test('direct invocation without a descriptor exits 1 and prints a code only', () => {
  const r = spawnSync(process.execPath, [path.join(HERE, 'run_candidate.mjs')], {
    env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr.trim(), /^[A-Z_:]+$/);
});

test('direct invocation with a credential-bearing failure never echoes the secret', () => {
  const d = tempDir();
  try {
    const out = path.join(d, 'candidate');
    const desc = descriptor({ outputDir: d, credentialPath: path.join(d, 'credential.json') });
    writeFileSync(path.join(d, 'credential.json'), JSON.stringify({ password: 'hunter2-hunter2-hunter2-hunter2' }), { mode: 0o600 });
    const descPath = path.join(d, 'desc.json');
    writeFileSync(descPath, JSON.stringify(desc), { mode: 0o600 });
    const r = spawnSync(process.execPath, [path.join(HERE, 'run_candidate.mjs'), descPath], {
      env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(r.status, 1);
    assert.ok(!/hunter2/.test(r.stderr + r.stdout));
    const failure = readFileSync(path.join(d, 'candidate-failure.json'), 'utf8');
    assert.ok(!/hunter2/.test(failure));
    assert.match(JSON.parse(failure).code, /^[A-Za-z_:]+$/);
    void out;
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('statDirReal reports the real owner/mode/emptiness and never follows a symlink', () => {
  const d = tempDir();
  try {
    const info = statDirReal(d);
    assert.equal(info.isDirectory, true);
    assert.equal(info.isSymbolicLink, false);
    assert.equal(info.mode, 0o700);
    assert.equal(info.uid, process.getuid());
    assert.deepEqual(info.entries, []);
    writeFileSync(path.join(d, 'x'), '1');
    assert.deepEqual(statDirReal(d).entries, ['x']);
    const link = d + '-link';
    symlinkSync(d, link);
    try {
      const l = statDirReal(link);
      assert.equal(l.isSymbolicLink, true);
      assert.equal(l.entries, null);
    } finally { rmSync(link, { force: true }); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a failure whose error MESSAGE carries the secret never reaches stderr, stdout or the failure file', () => {
  const d = tempDir();
  try {
    // Not JSON: Node 22's JSON.parse error message quotes the input, i.e. the secret itself.
    writeFileSync(path.join(d, 'credential.json'), 'hunter2-hunter2-hunter2-hunter2 not json', { mode: 0o600 });
    const probe = (() => { try { JSON.parse(readFileSync(path.join(d, 'credential.json'), 'utf8')); } catch (e) { return e.message; } })();
    assert.match(probe, /hunter2/, 'precondition: the raw error message really carries the secret');
    const descPath = path.join(d, 'desc.json');
    writeFileSync(descPath, JSON.stringify(descriptor({ outputDir: d, credentialPath: path.join(d, 'credential.json') })), { mode: 0o600 });
    const r = spawnSync(process.execPath, [path.join(HERE, 'run_candidate.mjs'), descPath], {
      env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(r.status, 1);
    assert.ok(!/hunter2/.test(r.stderr + r.stdout), 'secret leaked to stdio');
    const failure = readFileSync(path.join(d, 'candidate-failure.json'), 'utf8');
    assert.ok(!/hunter2/.test(failure), 'secret leaked to the failure record');
    assert.deepEqual(Object.keys(JSON.parse(failure)), ['code']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
