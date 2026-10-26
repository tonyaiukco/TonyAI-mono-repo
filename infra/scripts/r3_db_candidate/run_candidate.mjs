// db-candidate05/run_candidate.mjs — private offline preparation. NOT an execution authorization.
//
// The Node harness the owner-approved runtime executor (runtime_executor.py) spawns to actually run the
// candidate. It builds the REAL filesystem-backed injected readers that entrypoint.mjs's gate chain
// requires, then calls runEntrypoint. It performs NOTHING on its own: with no valid inputs descriptor it
// errors; every path it touches comes from that descriptor, and the one secret (the probe datasource
// credential) is read from a private 0600 file named by the descriptor — never from argv, never logged.
//
// Loaded-library handshake: entrypoint.mjs/driver.mjs call an injected `attest(snapshot)` INSIDE each
// lane's open transaction (before any stimulus for A/B). This harness turns that into a bounded file
// handshake so the Python parent can read /proc/<backend pid>/maps WHILE the lane is live: it writes
// attest-<lane>.request.json (carrying the backend pid + nonce from the snapshot), waits for the parent
// to drop attest-<lane>.ack, then returns true. No DB work proceeds until the observer has its snapshot.
//
// Historical status stays NOT_REPRODUCED; the native runtime stays NOT_EXECUTED until the owner runs
// this under runtime_executor with a real approval. Importing this module does nothing.

import { readFileSync, writeFileSync, appendFileSync, existsSync, lstatSync, readdirSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runEntrypoint, EntrypointRefusal } from './entrypoint.mjs';

export class HarnessRefusal extends Error {
  constructor(code) { super(code); this.name = 'HarnessRefusal'; this.code = code; }
}
const need = (cond, code) => { if (!cond) throw new HarnessRefusal(code); };

// The descriptor is paths + non-secret scalars only. The probe credential lives in its own 0600 file.
const DESCRIPTOR_KEYS = [
  'outputDir', 'sourceRoot', 'approvalPath', 'receiptPath', 'bindingPath', 'sourceManifestPath',
  'clientArtifactsPath', 'credentialPath', 'nonces', 'deadlineMs', 'attestTimeoutMs',
];

export function validateDescriptor(descriptor) {
  need(descriptor && typeof descriptor === 'object', 'DESCRIPTOR_SHAPE');
  const keys = Object.keys(descriptor).sort();
  need(keys.length === DESCRIPTOR_KEYS.length && keys.every((k, i) => k === [...DESCRIPTOR_KEYS].sort()[i]), 'DESCRIPTOR_KEYS');
  for (const p of ['outputDir', 'sourceRoot', 'approvalPath', 'receiptPath', 'bindingPath',
    'sourceManifestPath', 'clientArtifactsPath', 'credentialPath']) {
    need(typeof descriptor[p] === 'string' && descriptor[p].startsWith('/') && !descriptor[p].includes('\0'), 'DESCRIPTOR_PATH:' + p);
  }
  need(Array.isArray(descriptor.nonces) && descriptor.nonces.length === 3 &&
    new Set(descriptor.nonces).size === 3 && descriptor.nonces.every(n => /^[a-f0-9]{32}$/.test(n)), 'DESCRIPTOR_NONCES');
  need(Number.isInteger(descriptor.deadlineMs) && descriptor.deadlineMs > 0 && descriptor.deadlineMs <= 8 * 60 * 1000, 'DESCRIPTOR_DEADLINE');
  need(Number.isInteger(descriptor.attestTimeoutMs) && descriptor.attestTimeoutMs > 0 && descriptor.attestTimeoutMs <= 30000, 'DESCRIPTOR_ATTEST_TIMEOUT');
  return descriptor;
}

const readJson = p => JSON.parse(readFileSync(p, 'utf8'));

// A real stat for the output dir gate: {uid, mode, isDirectory, isSymbolicLink, entries}.
function statDirReal(p) {
  const l = lstatSync(p);
  const entries = l.isDirectory() && !l.isSymbolicLink() ? readdirSync(p) : null;
  return {
    uid: l.uid, mode: l.mode & 0o777, isDirectory: l.isDirectory(),
    isSymbolicLink: l.isSymbolicLink(), entries,
  };
}

// Bounded, append-only event sink: canonical records, no secret fields (the driver already redacts).
function makeRecord(outputDir, limits = { max: 256, bytes: 16384 }) {
  const file = path.join(outputDir, 'candidate-events.jsonl');
  let count = 0;
  return async event => {
    need(++count <= limits.max, 'EVENT_BOUND');
    const line = JSON.stringify(event);
    need(Buffer.byteLength(line) <= limits.bytes, 'EVENT_SIZE');
    appendFileSync(file, line + '\n', { mode: 0o600 });
  };
}

// The file-handshake attest: write the request (pid+nonce, no secrets), wait for the parent's .ack,
// return true so the open transaction continues. Blocking is bounded; a timeout refuses (fails closed).
function makeAttest(outputDir, attestTimeoutMs, { sleep } = {}) {
  const wait = sleep || (ms => new Promise(r => setTimeout(r, ms)));
  return async snapshot => {
    const lane = snapshot && snapshot.lane;
    need(['A', 'B', 'C'].includes(lane), 'ATTEST_LANE');
    const pid = snapshot.identity && snapshot.identity.pid;
    const nonce = snapshot.identity && snapshot.identity.nonce;
    need(Number.isInteger(pid) && pid > 0 && /^[a-f0-9]{32}$/.test(nonce || ''), 'ATTEST_IDENTITY');
    const req = path.join(outputDir, 'attest-' + lane + '.request.json');
    const ack = path.join(outputDir, 'attest-' + lane + '.ack');
    // Atomic: the parent never sees a half-written request (write a temp name, then rename into place).
    writeFileSync(req + '.tmp', JSON.stringify({ lane, pid, nonce, phase: snapshot.phase }), { mode: 0o600, flag: 'wx' });
    renameSync(req + '.tmp', req);
    const deadline = Date.now() + attestTimeoutMs;
    while (!existsSync(ack)) {
      need(Date.now() < deadline, 'ATTEST_TIMEOUT:' + lane);
      await wait(100);
    }
    return true;
  };
}

// Build the complete runEntrypoint io from a validated descriptor + the real filesystem.
export { statDirReal };

export function buildIo(descriptor, deps = {}) {
  validateDescriptor(descriptor);
  const selfUid = (deps.getuid || process.getuid)();
  const credential = (deps.readJson || readJson)(descriptor.credentialPath); // the only secret; never logged
  return {
    readProcessEnv: deps.readProcessEnv || (() => ({ ...process.env })),
    outputDir: descriptor.outputDir,
    statDir: deps.statDir || statDirReal,
    selfUid,
    approval: (deps.readJson || readJson)(descriptor.approvalPath),
    receipt: (deps.readJson || readJson)(descriptor.receiptPath),
    binding: (deps.readJson || readJson)(descriptor.bindingPath),
    sourceManifest: (deps.readJson || readJson)(descriptor.sourceManifestPath),
    clientArtifacts: (deps.readJson || readJson)(descriptor.clientArtifactsPath),
    readSourceBytes: name => (deps.readBytes || readFileSync)(path.join(descriptor.sourceRoot, name)),
    readArtifactBytes: abs => (deps.readBytes || readFileSync)(abs),
    nodeExecPath: deps.nodeExecPath || process.execPath,
    createRequireFn: deps.createRequireFn || createRequire,
    fromPath: deps.fromPath || fileURLToPath(import.meta.url),
    credential,
    record: deps.record || makeRecord(descriptor.outputDir),
    attest: deps.attest || makeAttest(descriptor.outputDir, descriptor.attestTimeoutMs, deps),
    nonces: descriptor.nonces,
    now: deps.now || Date.now,
    deadlineMs: descriptor.deadlineMs,
    armDeadline: deps.armDeadline || (ms => {
      // The Python parent owns the real process-group kill; this timer only forces a hard stop if the
      // parent somehow does not. It never claims to stop in-flight DB work.
      const t = setTimeout(() => { try { writeFileSync(path.join(descriptor.outputDir, 'deadline-exceeded'), String(ms), { mode: 0o600 }); } catch {} process.exit(75); }, ms);
      if (typeof t.unref === 'function') t.unref();
      return { clear: () => clearTimeout(t) };
    }),
  };
}

export async function runFromDescriptor(descriptor, deps = {}) {
  const io = buildIo(descriptor, deps);
  const result = await runEntrypoint(io);
  // runEntrypoint returns the driver result (PARTIAL or the review-ceiling) with NOT_REPRODUCED preserved.
  (deps.writeResult || ((p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 })))(
    path.join(descriptor.outputDir, 'candidate-result.json'), result);
  return result;
}

// Executed only when the Python orchestrator spawns it with a descriptor path as argv[2]. Running
// `node run_candidate.mjs` with no descriptor errors; it connects to nothing by itself.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  const descriptorPath = process.argv[2];
  (async () => {
    try {
      need(typeof descriptorPath === 'string' && descriptorPath.length > 0, 'NO_DESCRIPTOR');
      const descriptor = readJson(descriptorPath);
      await runFromDescriptor(descriptor);
      process.exit(0);
    } catch (error) {
      const code = error instanceof HarnessRefusal || error instanceof EntrypointRefusal ? error.code : 'HARNESS_FAILURE';
      try {
        const out = JSON.parse(readFileSync(descriptorPath, 'utf8')).outputDir;
        writeFileSync(path.join(out, 'candidate-failure.json'), JSON.stringify({ code }) + '\n', { mode: 0o600 });
      } catch {}
      process.stderr.write(code + '\n'); // code only — never the message (may carry a URL/secret)
      process.exit(1);
    }
  })();
}
