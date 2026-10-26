// db-candidate03/entrypoint.mjs — private offline preparation. NOT an execution authorization.
//
// This is the executable gate that must run BEFORE any generated Prisma client is imported or any
// client is constructed. Every function here is pure and dependency-injected; the only side effects
// come from injected readers/factories supplied by the owner-approved runtime adapter. Importing this
// module does nothing. Nothing in this file connects to a database, reads credentials from disk by
// itself, starts Docker, or performs network I/O. Historical status stays NOT_REPRODUCED; the native
// runtime stays NOT_EXECUTED; R3 stays OPEN.
//
// Reuses by exact hash (see binding03.json): driver.mjs (runCandidate), prisma-adapter.mjs
// (wrapCandidatePrisma), fixture-sql.mjs, manifest.mjs. This module adds ONLY the gate chain and the
// three-client construction wiring.
//
// Gate order (all must pass, in this order, before Prisma is touched):
//   1. sanitizeEnv         — allowlisted env only; reject ambient DB/engine/proxy/preload overrides.
//   2. validateOutputDir   — private 0700 output directory, owned, canonical, empty.
//   3. validateApproval    — fresh owner runtime approval bound to THIS attempt id + criterion hash.
//   4. validateReceipt     — fresh disposable-runtime receipt (from runtime-contract.py) bound to the
//                            same attempt, with the resolved endpoint and loaded-library evidence ref.
//   5. validateSourceManifest — the exact db-candidate03 harness bytes.
//   6. validateClientArtifacts — the exact generated Prisma client + Linux engine + Node binary bytes.
//   7. loadBoundPrisma     — createRequire the ONE bound generated index.js (CommonJS); no aliases.
//   8. buildClients        — three PrismaClient objects, conn limit 1, fixed application_name per lane.
// A failure at any gate throws EntrypointRefusal(code) and the caller must NOT proceed. The datasource
// URL is constructed only here, only from the injected private credential handle, never logged.

import { createHash } from 'node:crypto';
import { compareManifest, observeManifest } from './manifest.mjs';
import { wrapCandidatePrisma } from './prisma-adapter.mjs';
import { runCandidate } from './driver.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export class EntrypointRefusal extends Error {
  constructor(code) { super(code); this.name = 'EntrypointRefusal'; this.code = code; }
}
const refuse = code => { throw new EntrypointRefusal(code); };
const check = (condition, code) => { if (!condition) refuse(code); };
const HEX64 = /^[a-f0-9]{64}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const NAME = /^[a-z0-9_]{1,63}$/;

// ---------------------------------------------------------------------------------------------------
// Fixed, reviewed constants. The attempt id, approval hash and artifact hashes are supplied per attempt
// through the bound binding file; nothing here is a wildcard.
// ---------------------------------------------------------------------------------------------------
export const CLIENT_VERSION = '6.19.3';
export const ENGINE_REVISION = 'c2990dca591cba766e3b7ef5d9e8a84796e47ab7';
export const LINUX_ENGINE_FILE = 'libquery_engine-debian-openssl-3.0.x.so.node';
export const NODE_VERSION = 'v22.23.3';
export const LANES = Object.freeze(['A', 'B', 'C']);
export const APPLICATION_NAMES = Object.freeze({ A: 'r3_candidate_a', B: 'r3_candidate_b', C: 'r3_candidate_c' });
export const LANE_TIMEOUTS = Object.freeze({ A: 60000, B: 90000, C: 10000 });

// Only these environment names may be present when the entrypoint runs. Everything else must be absent.
// These are fixed, non-secret shells; the datasource URL never comes from the environment.
export const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'PWD', 'SHLVL', '_',
]);
export const ENV_REQUIRED = Object.freeze({
  PATH: '/usr/lib/postgresql/17/bin:/usr/bin:/bin',
  LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
});
// Any of these present (exact name, or by prefix) means the environment is contaminated: fail closed.
export const ENV_FORBIDDEN_EXACT = Object.freeze([
  'DATABASE_URL', 'DIRECT_URL', 'PRISMA_QUERY_ENGINE_LIBRARY', 'PRISMA_QUERY_ENGINE_BINARY',
  'PRISMA_CLIENT_ENGINE_TYPE', 'PRISMA_CLI_QUERY_ENGINE_TYPE', 'PRISMA_ACCELERATE_URL',
  'PRISMA_GENERATE_DATAPROXY', 'PRISMA_CLIENT_DATA_PROXY_CLIENT_VERSION', 'NODE_OPTIONS',
  'NODE_PATH', 'ESM_OPTIONS', 'DOTENV_CONFIG_PATH', 'DOTENV_KEY', 'PGHOST', 'PGPORT', 'PGUSER',
  'PGPASSWORD', 'PGDATABASE', 'PGSERVICE', 'PGSSLMODE', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
]);
export const ENV_FORBIDDEN_PREFIX = Object.freeze(['PRISMA_', 'PG', 'NODE_', 'DOTENV_', 'DATABASE', 'DIRECT_', 'LD_']);

// ---------------------------------------------------------------------------------------------------
// 1. Environment
// ---------------------------------------------------------------------------------------------------
export function sanitizeEnv(env) {
  check(env && typeof env === 'object', 'ENV_INPUT');
  const names = Object.keys(env);
  for (const name of names) {
    // Allowlisted exact names only.
    if (!ENV_ALLOWLIST.includes(name)) {
      // A forbidden name is reported with its own code; an unexpected-but-not-dangerous name still fails.
      if (ENV_FORBIDDEN_EXACT.includes(name)) refuse('ENV_FORBIDDEN:' + name);
      for (const prefix of ENV_FORBIDDEN_PREFIX) if (name.startsWith(prefix)) refuse('ENV_FORBIDDEN_PREFIX:' + name);
      refuse('ENV_NOT_ALLOWED:' + name);
    }
  }
  for (const [name, value] of Object.entries(ENV_REQUIRED)) {
    check(env[name] === value, 'ENV_REQUIRED:' + name);
  }
  // Return a frozen copy with only the allowlisted names; the caller passes this to the runtime.
  const sanitized = {};
  for (const name of ENV_ALLOWLIST) if (name in env) sanitized[name] = env[name];
  return Object.freeze(sanitized);
}

// ---------------------------------------------------------------------------------------------------
// 2. Output directory — injected stat function (returns {uid, mode, isDirectory, isSymbolicLink, entries}).
// ---------------------------------------------------------------------------------------------------
export function validateOutputDir(path, { statDir, selfUid }) {
  check(typeof path === 'string' && path.startsWith('/') && !path.includes('\0'), 'OUTPUT_PATH');
  check(typeof statDir === 'function' && Number.isInteger(selfUid), 'OUTPUT_STAT');
  const info = statDir(path);
  check(info && info.isDirectory === true && info.isSymbolicLink === false, 'OUTPUT_NOT_DIR');
  check(info.uid === selfUid, 'OUTPUT_OWNER');
  check(info.mode === 0o700, 'OUTPUT_MODE');
  check(Array.isArray(info.entries) && info.entries.length === 0, 'OUTPUT_NOT_EMPTY');
  return path;
}

// ---------------------------------------------------------------------------------------------------
// 3. Owner runtime approval. The approval JSON is produced by the owner for THIS attempt. It must
//    acknowledge that the historical incident stays NOT_REPRODUCED and that this is the replacement
//    criterion, must bind the attempt id, the criterion-decision hash, the source-manifest hash, and
//    must NOT claim qualification/closure.
// ---------------------------------------------------------------------------------------------------
const APPROVAL_KEYS = ['purpose', 'attempt_id', 'owner_decision_sha256', 'source_manifest_sha256',
  'client_artifacts_sha256', 'criterion', 'historical_status', 'r3_status', 'issued_at_utc', 'single_attempt'];
export function validateApproval(approval, { attemptId, expectSourceManifestSha, expectClientArtifactsSha, ownerDecisionSha }) {
  check(approval && typeof approval === 'object', 'APPROVAL_INPUT');
  check(sameKeys(approval, APPROVAL_KEYS), 'APPROVAL_SHAPE');
  check(approval.purpose === 'ONE_ISOLATED_DB_CANDIDATE', 'APPROVAL_PURPOSE');
  check(approval.attempt_id === attemptId && HEX32.test(attemptId), 'APPROVAL_ATTEMPT');
  check(approval.owner_decision_sha256 === ownerDecisionSha && HEX64.test(ownerDecisionSha), 'APPROVAL_OWNER_DECISION');
  check(approval.source_manifest_sha256 === expectSourceManifestSha && HEX64.test(expectSourceManifestSha), 'APPROVAL_SOURCE');
  check(approval.client_artifacts_sha256 === expectClientArtifactsSha && HEX64.test(expectClientArtifactsSha), 'APPROVAL_ARTIFACTS');
  check(approval.criterion === 'REPLACEMENT_REGRESSION_NOT_HISTORICAL', 'APPROVAL_CRITERION');
  check(approval.historical_status === 'NOT_REPRODUCED', 'APPROVAL_HISTORICAL');
  check(approval.r3_status === 'OPEN', 'APPROVAL_R3');
  check(approval.single_attempt === true, 'APPROVAL_SINGLE_ATTEMPT');
  check(typeof approval.issued_at_utc === 'string' && isIso(approval.issued_at_utc), 'APPROVAL_ISSUED');
  return true;
}

// ---------------------------------------------------------------------------------------------------
// 4. Fresh disposable-runtime receipt — produced by runtime-contract.py after it prepared the DB-only
//    composition. Binds the same attempt, the resolved image/config/platform, the container id, the
//    probe endpoint host/port (loopback only), and the loaded-library evidence reference. The receipt
//    must be newer than the approval and must not carry any credential material.
// ---------------------------------------------------------------------------------------------------
const RECEIPT_KEYS = ['purpose', 'attempt_id', 'image', 'config_digest', 'platform', 'container_id',
  'endpoint_host', 'endpoint_port', 'database', 'probe_role', 'loaded_library_ref', 'startup_closure_status',
  'prepared_at_utc'];
export function validateReceipt(receipt, { attemptId, approvalIssuedAt, expectImage, expectConfigDigest }) {
  check(receipt && typeof receipt === 'object', 'RECEIPT_INPUT');
  check(sameKeys(receipt, RECEIPT_KEYS), 'RECEIPT_SHAPE');
  check(receipt.purpose === 'ONE_ISOLATED_DB_CANDIDATE', 'RECEIPT_PURPOSE');
  check(receipt.attempt_id === attemptId, 'RECEIPT_ATTEMPT');
  check(receipt.image === expectImage && /^supabase\/postgres@sha256:[a-f0-9]{64}$/.test(expectImage), 'RECEIPT_IMAGE');
  check(receipt.config_digest === expectConfigDigest && /^sha256:[a-f0-9]{64}$/.test(expectConfigDigest), 'RECEIPT_CONFIG');
  check(receipt.platform === 'linux/amd64', 'RECEIPT_PLATFORM');
  check(typeof receipt.container_id === 'string' && /^[a-f0-9]{12,64}$/.test(receipt.container_id), 'RECEIPT_CONTAINER');
  // Endpoint must be loopback-only; no externally routable host is accepted.
  check(['127.0.0.1', '::1'].includes(receipt.endpoint_host), 'RECEIPT_ENDPOINT_HOST');
  check(Number.isInteger(receipt.endpoint_port) && receipt.endpoint_port > 0 && receipt.endpoint_port <= 65535, 'RECEIPT_ENDPOINT_PORT');
  check(NAME.test(receipt.database) && receipt.database === 'regress_r3_candidate', 'RECEIPT_DATABASE');
  check(NAME.test(receipt.probe_role) && receipt.probe_role === 'regress_r3_probe', 'RECEIPT_PROBE');
  check(typeof receipt.loaded_library_ref === 'string' && receipt.loaded_library_ref.length > 0, 'RECEIPT_LOADED_LIBRARY');
  // The startup closure is the known blocker; the receipt must declare it honestly. An accepted value
  // only means the runtime adapter proved the closure from retained bytes — see runtime-contract.py.
  check(['CLOSED_FROM_RETAINED_EVIDENCE', 'OPEN_UNRESOLVED'].includes(receipt.startup_closure_status), 'RECEIPT_STARTUP_CLOSURE');
  check(typeof receipt.prepared_at_utc === 'string' && isIso(receipt.prepared_at_utc), 'RECEIPT_PREPARED');
  // Freshness: receipt prepared at or after the approval, never before.
  check(Date.parse(receipt.prepared_at_utc) >= Date.parse(approvalIssuedAt), 'RECEIPT_STALE');
  // A receipt must never leak a URL/password; reject any field value that looks like a connection string.
  for (const value of Object.values(receipt)) {
    if (typeof value === 'string') check(!/:\/\//.test(value) && !/password=/i.test(value), 'RECEIPT_LEAK');
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------
// 5. Source manifest — the exact db-candidate03 harness bytes. readBytes(name) returns a Buffer.
// ---------------------------------------------------------------------------------------------------
export function validateSourceManifest(expected, { readBytes }) {
  check(expected && typeof expected === 'object' && typeof readBytes === 'function', 'SOURCE_INPUT');
  const names = Object.keys(expected).sort();
  check(names.length > 0, 'SOURCE_EMPTY');
  const observed = observeManifest(names, readBytes);
  compareManifest(expected, observed); // throws ManifestRefusal on any drift
  return sha(canonical(expected));
}

// ---------------------------------------------------------------------------------------------------
// 6. Client artifacts — the generated Prisma client + Linux engine + Node binary. readBytes(path) must
//    return the exact bytes of each absolute path. The config block inside index.js is NOT trusted; we
//    verify bytes. The expected map is { path: {sha256, bytes} }.
// ---------------------------------------------------------------------------------------------------
export const REQUIRED_ARTIFACT_BASENAMES = Object.freeze([
  'index.js', 'package.json', 'schema.prisma', 'runtime/library.js', LINUX_ENGINE_FILE,
]);
export function validateClientArtifacts(expected, { readBytes, nodeExecPath }) {
  check(expected && typeof expected === 'object' && typeof readBytes === 'function', 'ARTIFACT_INPUT');
  const paths = Object.keys(expected);
  check(paths.length >= REQUIRED_ARTIFACT_BASENAMES.length + 1, 'ARTIFACT_COUNT'); // +1 for the node binary
  // Exactly one entry must be the Node binary, matching the running interpreter's path.
  check(typeof nodeExecPath === 'string' && paths.includes(nodeExecPath), 'ARTIFACT_NODE_PATH');
  // Each required basename must be represented exactly once among the generated-client paths.
  for (const base of REQUIRED_ARTIFACT_BASENAMES) {
    const matches = paths.filter(p => p === nodeExecPath ? false : p.endsWith('/generated/client/' + base) || p.endsWith('/client/' + base));
    check(matches.length === 1, 'ARTIFACT_MISSING:' + base);
  }
  const perFile = {};
  for (const [path, meta] of Object.entries(expected)) {
    check(meta && HEX64.test(meta.sha256) && Number.isInteger(meta.bytes) && meta.bytes > 0, 'ARTIFACT_META:' + path);
    const bytes = readBytes(path);
    check(Buffer.isBuffer(bytes) && bytes.length === meta.bytes, 'ARTIFACT_SIZE:' + path);
    const digest = sha(bytes);
    check(digest === meta.sha256, 'ARTIFACT_HASH:' + path);
    perFile[path] = digest;
  }
  // The generated index.js must declare the pinned client version and engine revision (byte-verified file).
  const indexPath = paths.find(p => p.endsWith('index.js'));
  const indexText = readBytes(indexPath).toString('utf8');
  check(indexText.includes('"clientVersion": "' + CLIENT_VERSION + '"'), 'ARTIFACT_CLIENT_VERSION');
  check(indexText.includes('"engineVersion": "' + ENGINE_REVISION + '"'), 'ARTIFACT_ENGINE_REVISION');
  // relativeEnvPaths must have a null rootEnvPath so no repository .env is read as a side effect.
  check(indexText.includes('"relativeEnvPaths"') && indexText.includes('"rootEnvPath": null'), 'ARTIFACT_ENV_PATHS');
  return sha(canonical(perFile));
}

// ---------------------------------------------------------------------------------------------------
// 7. Bind the generated Prisma client. createRequire is injected; the path is the ONE verified index.js.
//    We import only that exact CommonJS entry — never a package alias or a search-path fallback.
// ---------------------------------------------------------------------------------------------------
export function loadBoundPrisma(indexPath, { createRequireFn, fromPath }) {
  check(typeof indexPath === 'string' && indexPath.endsWith('/index.js') && indexPath.startsWith('/'), 'BIND_PATH');
  check(typeof createRequireFn === 'function' && typeof fromPath === 'string', 'BIND_REQUIRE');
  const require = createRequireFn(fromPath);
  // Require the exact absolute file; createRequire resolves it directly, not via node_modules lookup.
  const mod = require(indexPath);
  check(mod && typeof mod.PrismaClient === 'function', 'BIND_CLIENT_MISSING');
  return mod.PrismaClient;
}

// ---------------------------------------------------------------------------------------------------
// 8. Datasource URL + clients. The credential handle is an object { user, password, host, port, database }
//    supplied by the runtime adapter through a private descriptor. The URL is assembled here and never
//    returned, logged, or stored; only the three wrapped adapters leave this function.
// ---------------------------------------------------------------------------------------------------
export function buildDatasourceUrl(credential, lane) {
  check(credential && typeof credential === 'object', 'CRED_INPUT');
  check(NAME.test(credential.user) && credential.user === 'regress_r3_probe', 'CRED_USER');
  check(typeof credential.password === 'string' && credential.password.length >= 24, 'CRED_PASSWORD');
  check(['127.0.0.1', '::1'].includes(credential.host), 'CRED_HOST');
  check(Number.isInteger(credential.port) && credential.port > 0 && credential.port <= 65535, 'CRED_PORT');
  check(NAME.test(credential.database) && credential.database === 'regress_r3_candidate', 'CRED_DATABASE');
  check(LANES.includes(lane), 'CRED_LANE');
  const host = credential.host === '::1' ? '[::1]' : credential.host;
  const app = APPLICATION_NAMES[lane];
  const params = [
    'connection_limit=1',
    'pool_timeout=10',
    'connect_timeout=10',
    'application_name=' + app,
    'sslmode=disable',
    'socket_timeout=15',
  ].join('&');
  return 'postgresql://' + encodeURIComponent(credential.user) + ':' + encodeURIComponent(credential.password) +
    '@' + host + ':' + credential.port + '/' + encodeURIComponent(credential.database) + '?' + params;
}

// Construct one PrismaClient with no log event sinks (so no raw URL/SQL ever reaches a listener).
export function constructClient(PrismaClient, credential, lane, { now }) {
  const url = buildDatasourceUrl(credential, lane);
  const client = new PrismaClient({
    datasources: { db: { url } },
    log: [], // no 'query'/'error'/'warn' event emitters: no raw URL or SQL exception is surfaced
    errorFormat: 'minimal',
  });
  // The URL local is dropped here; it is never attached to the returned object.
  return wrapCandidatePrisma(client, lane);
}

// Build A and B eagerly; C is a factory that constructs only when the driver calls it (post-matrix).
export function buildClients(PrismaClient, credential, { now }) {
  check(typeof PrismaClient === 'function', 'CLIENTS_FACTORY');
  const a = constructClient(PrismaClient, credential, 'A', { now });
  const b = constructClient(PrismaClient, credential, 'B', { now });
  let cBuilt = 0;
  const createFreshC = () => {
    check(++cBuilt === 1, 'C_ALREADY_BUILT');
    return constructClient(PrismaClient, credential, 'C', { now });
  };
  return { a, b, createFreshC };
}

// ---------------------------------------------------------------------------------------------------
// Orchestration. All inputs are injected. Returns the driver result; never flips historical status.
// A hard deadline + process-group kill custody is the runtime adapter's responsibility (Python side);
// this function additionally arms a JS-level deadline that rejects, but does NOT claim it stops DB work.
// ---------------------------------------------------------------------------------------------------
export async function runEntrypoint(io) {
  const {
    readProcessEnv, outputDir, approval, receipt, sourceManifest, clientArtifacts, binding,
    statDir, selfUid, readSourceBytes, readArtifactBytes, nodeExecPath,
    createRequireFn, fromPath, credential, record, attest, nonces, now, deadlineMs, armDeadline,
  } = io;

  // Gate chain. Any throw aborts before Prisma is imported.
  // The Prisma native engine loads from THIS process's live environment, so the gate must run on the
  // real process env — not on a separately-supplied set a caller claims it will hand a child. The parent
  // is expected to spawn node with exactly the sanitized allowlist; if it did not, this fails closed.
  // (security review #1: sanitize process.env directly.) readProcessEnv is injectable only for tests.
  const liveEnv = (typeof readProcessEnv === 'function' ? readProcessEnv : defaultReadProcessEnv)();
  const sanitizedEnv = sanitizeEnv(liveEnv);
  validateOutputDir(outputDir, { statDir, selfUid });
  const sourceManifestSha = sha(canonical(sourceManifest));
  validateApproval(approval, {
    attemptId: binding.attempt_id,
    expectSourceManifestSha: sourceManifestSha,
    expectClientArtifactsSha: binding.client_artifacts_sha256,
    ownerDecisionSha: binding.owner_decision_sha256,
  });
  validateReceipt(receipt, {
    attemptId: binding.attempt_id,
    approvalIssuedAt: approval.issued_at_utc,
    expectImage: binding.image,
    expectConfigDigest: binding.config_digest,
  });
  validateSourceManifest(sourceManifest, { readBytes: readSourceBytes });
  const artifactsSha = validateClientArtifacts(clientArtifacts, { readBytes: readArtifactBytes, nodeExecPath });
  check(artifactsSha === binding.client_artifacts_sha256, 'ARTIFACTS_BINDING');

  // Only now may Prisma be imported and clients built. A PrismaClient constructor throw is collapsed to
  // a constant refusal so a datasource URL in an engine-level error can never propagate raw. (sec #2)
  const indexPath = Object.keys(clientArtifacts).find(p => p.endsWith('index.js'));
  const PrismaClient = loadBoundPrisma(indexPath, { createRequireFn, fromPath });
  let a, b, createFreshC;
  try { ({ a, b, createFreshC } = buildClients(PrismaClient, credential, { now })); }
  catch (error) { throw error instanceof EntrypointRefusal ? error : new EntrypointRefusal('CLIENT_CONSTRUCTION'); }

  // Arm the hard deadline (injected; the Python parent owns real process-group kill custody).
  const deadline = typeof armDeadline === 'function' ? armDeadline(deadlineMs) : null;
  try {
    const result = await runCandidate({
      a, b, createFreshC,
      expectedDatabase: receipt.database,
      nonces, record, attest,
    });
    return result;
  } finally {
    if (deadline && typeof deadline.clear === 'function') deadline.clear();
    void sanitizedEnv; // the sanitized env is handed to the runtime by the Python parent, not used here
  }
}

// ---------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------
// A plain snapshot of the live process environment. The gate sanitizes this, so the running node
// process (the one whose Prisma engine reads the environment) must itself carry only the allowlist.
function defaultReadProcessEnv() { return { ...process.env }; }

function sameKeys(object, keys) {
  const actual = Object.keys(object).sort();
  const want = [...keys].sort();
  return actual.length === want.length && actual.every((k, i) => k === want[i]);
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function isIso(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

// No main(). This module is imported by the owner-approved runtime adapter, which supplies every
// injected reader, the private credential handle, and the real deadline/kill custody. Running `node
// entrypoint.mjs` directly performs nothing.
