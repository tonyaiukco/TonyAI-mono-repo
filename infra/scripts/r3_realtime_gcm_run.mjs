/**
 * Single-attempt runner for the R3 Realtime GCM consumer fixture.
 *
 *   node infra/scripts/r3_realtime_gcm_run.mjs                    plan + gate refusals, no effect
 *   node infra/scripts/r3_realtime_gcm_run.mjs --bind-libraries   library tree hashes, no effect
 *   node infra/scripts/r3_realtime_gcm_run.mjs --execute --approval <file> --approval-sha256 <hex>
 *        --evidence-dir <empty 0700 dir named in the approval>
 *   node infra/scripts/r3_realtime_gcm_run.mjs --teardown --attempt <attemptId>
 *
 * --execute refuses unless the manifest is executable (nothing blocked, every binding filled,
 * bootstrap reviewed) and an owner approval — byte-identical to the hash given out of band, in
 * canonical form with exactly the expected keys — names this manifest's and harness's hashes,
 * the evidence directory, and an unexpired window. The attempt is consumed in a fixed ledger
 * directory BEFORE any effect, so an approval never runs twice on this machine, whatever
 * evidence directory is passed. Images must already be present under their config digest: every
 * docker run uses --pull=never. Key-bearing env files live in a tmpfs directory outside the
 * evidence; SIGINT/SIGTERM tear the attempt down, and --teardown removes one attempt's exact names.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CAP_KINDS, HarnessError, TENANTS, plannedCounts, runQualification, sha256, validatePlan } from './r3_realtime_gcm.mjs';
import {
  ATTEMPT_LABEL, REPO_ROOT, SECRET_DIR_PREFIX, createApiAdapter, createLifecycleAdapter, createMetadataAdapter, createPrivateStore, createSecretDir,
  createSocketsAdapter, createTenantDbAdapter, createTokenAdapter, dockerExec, dockerIdentity, envFileText, fileSha256,
  generateSecrets, httpCall, pinnedLookup, postgresRunArgv, renderBootstrap, resolveLibraries, scramVerifier, teardownArgv,
} from './r3_realtime_clients.mjs';

export const MANIFEST_PATH = 'infra/selfhost/r3-realtime-gcm.fixture.json';
export const HARNESS_FILES = Object.freeze(['infra/scripts/r3_realtime_gcm.mjs', 'infra/scripts/r3_realtime_clients.mjs',
  'infra/scripts/r3_realtime_gcm_run.mjs', MANIFEST_PATH]);
export const APPROVAL_KEYS = Object.freeze(['attemptId', 'evidenceDir', 'expiresAt', 'harness', 'issuedAt', 'manifestSha256',
  'purpose', 'runBinding', 'singleAttempt']);
const ATTEMPT_ID = /^gcm-[0-9]{8}-[a-z0-9]{6,12}$/;
const SECRET_ENV = /^(DB_ENC_KEY|DB_ENC_KEY_GCM|API_JWT_SECRET|API_JWT_SECRET_NEXT|METRICS_JWT_SECRET|SECRET_KEY_BASE|DB_PASSWORD)$/;
const IDENT = /^_?[a-z][a-z0-9_]{0,62}$/;
const MAX_APPROVAL_MS = 24 * 60 * 60 * 1000;

const OCTET = '(0|[1-9]\\d{0,2})';
const ipv4 = (s) => (new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`).exec(s ?? '') ?? []).slice(1).map(Number);
/** The fixture subnet: one private /24; both addresses inside it, distinct, not network/gateway/broadcast. */
function networkRefusals(n) {
  const out = [];
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.0\/24$/.exec(n?.subnet ?? '');
  const [a, b] = ipv4(`${m?.[1]}.0`);
  const privateNet = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!m || !privateNet) return ['network.subnet must be one private /24'];
  for (const k of ['realtimeIp', 'postgresIp']) {
    const ip = ipv4(n[k]);
    if (ip.length !== 4 || ip.some((x) => x > 255) || n[k].slice(0, m[1].length + 1) !== `${m[1]}.` || [0, 1, 255].includes(ip[3])) {
      out.push(`network.${k} must be a host address inside the subnet`);
    }
  }
  if (n.realtimeIp === n.postgresIp) out.push('network addresses must differ');
  if (!/^fd[0-9a-f]{2}(:[0-9a-f]{1,4}){3}::\/64$/.test(n.subnet6 ?? '')) out.push('network.subnet6 must be one ULA /64');
  return out;
}

/** Structural checks of the manifest beyond validatePlan: config that must agree with itself. */
export function manifestRefusals(m) {
  const out = [];
  try { validatePlan(m); } catch (e) { out.push(e.message); return out; }
  const env = m.realtimeEnv ?? {};
  for (const k of Object.keys(env)) if (SECRET_ENV.test(k)) out.push(`realtimeEnv must not carry ${k}`);
  if (env.DB_ENC_WRITE_GCM !== 'true') out.push('DB_ENC_WRITE_GCM must be true');
  if (env.DB_AFTER_CONNECT_QUERY !== `SET search_path TO ${m.metadata?.schema}`) out.push('metadata schema and search_path differ');
  if (env.DB_NAME !== m.metadata?.database || env.DB_USER !== m.metadata?.user) out.push('metadata database/user differ');
  if (env.DB_HOST !== m.network?.postgresIp || env.PORT !== String(m.realtimePort)) out.push('realtime env and network differ');
  if (env.SEED_SELF_HOST !== 'false') out.push('SEED_SELF_HOST must be false (no default tenant)');
  if (!m.adminHost?.endsWith(`.${m.hostSuffix}`)) out.push('adminHost must sit under hostSuffix');
  if (m.images?.realtime?.platform !== 'linux/amd64' || m.images?.postgres?.platform !== 'linux/amd64') out.push('platform');
  for (const [k, v] of [['metadata.database', m.metadata?.database], ['metadata.user', m.metadata?.user],
    ['metadata.schema', m.metadata?.schema], ['images.postgres.ownerUser', m.images?.postgres?.ownerUser]]) {
    if (!IDENT.test(v ?? '')) out.push(`${k} must be a fixed identifier`);
  }
  const databases = new Set(['postgres', m.metadata?.database, ...TENANTS.map((t) => m.tenants?.[t]?.database)]);
  for (const s of m.bootstrap?.statements ?? []) if (!databases.has(s.database)) out.push(`bootstrap targets ${s.database}`);
  out.push(...networkRefusals(m.network));
  for (const k of Object.keys(m.images?.postgres?.env ?? {})) {
    if (!['POSTGRES_HOST', 'PGPORT', 'POSTGRES_PORT', 'POSTGRES_DB'].includes(k)) out.push(`images.postgres.env must not carry ${k}`);
  }
  const rt = m.runtime ?? {};
  if (!isAbsolute(rt.dockerPath ?? '') || !isAbsolute(rt.secretParent ?? '') || !isAbsolute(rt.ledgerDir ?? '')) out.push('runtime paths must be absolute');
  if (!/^unix:\/\/\/[a-z0-9/._-]+$/.test(rt.dockerHost ?? '')) out.push('runtime.dockerHost must be a unix socket');
  return out;
}

/** Sorted-key, two-space JSON plus newline: the only form an approval may take. */
export function canonicalJson(v) {
  const sort = (x) => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
  return `${JSON.stringify(sort(v), null, 2)}\n`;
}

/**
 * Reads the owner's approval from its exact bytes: the SHA-256 given out of band must match, the
 * text must be canonical (so no duplicate or reordered key survives), and the key sets are exact.
 */
export function parseApproval(text, expectedSha256) {
  const refusals = [];
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? '') || sha256(text) !== expectedSha256) refusals.push('approval bytes differ from the out-of-band hash');
  let approval;
  try { approval = JSON.parse(text); } catch { return { approval: null, refusals: [...refusals, 'approval is not JSON'] }; }
  if (text !== canonicalJson(approval)) refusals.push('approval is not in canonical form');
  if (JSON.stringify(Object.keys(approval ?? {}).sort()) !== JSON.stringify(APPROVAL_KEYS)) refusals.push('approval keys');
  if (JSON.stringify(Object.keys(approval?.harness ?? {}).sort()) !== JSON.stringify([...HARNESS_FILES].sort())) refusals.push('approval harness keys');
  return { approval, refusals };
}

/** Everything that must be true before --execute may run; an empty list means allowed. */
export function executionRefusals({ manifest, approval, hashes, now, evidenceDir }) {
  const out = manifestRefusals(manifest);
  if (manifest.executable !== true) out.push('manifest is not executable');
  for (const b of manifest.blockedBy ?? []) out.push(`blocked: ${String(b).split(':')[0]}`);
  for (const b of [...manifest.source?.requiredBindings ?? [], ...manifest.source?.pendingBindings ?? []]) {
    if (!/^[0-9a-f]{64}$/.test(b.sha256 ?? '')) out.push(`unbound source ${b.path}`);
  }
  for (const [k, img] of Object.entries(manifest.images ?? {})) {
    for (const f of ['manifest', 'config']) if (!/^sha256:[0-9a-f]{64}$/.test(img[f] ?? '')) out.push(`image ${k} ${f} unbound`);
  }
  for (const [k, lib] of Object.entries(manifest.libraries ?? {})) if (!/^[0-9a-f]{64}$/.test(lib.treeSha256 ?? '')) out.push(`library ${k} unbound`);
  if (!manifest.expected?.dbJoinReasons?.length) out.push('expected.dbJoinReasons unbound');
  if (manifest.bootstrap?.reviewed !== true) out.push('bootstrap not reviewed');
  if (!approval) { out.push('no approval'); return out; }
  if (approval.purpose !== 'R3_REALTIME_GCM_CONSUMER_SINGLE_ATTEMPT' || approval.singleAttempt !== true) out.push('approval purpose');
  if (!ATTEMPT_ID.test(approval.attemptId ?? '')) out.push('approval attemptId');
  if (approval.manifestSha256 !== hashes[MANIFEST_PATH]) out.push('approval names another manifest');
  for (const f of HARNESS_FILES) if (approval.harness?.[f] !== hashes[f]) out.push(`approval names another ${f}`);
  if (!evidenceDir || approval.evidenceDir !== evidenceDir) out.push('approval names another evidence directory');
  const rb = approval.runBinding;
  if (rb !== null && !(rb && typeof rb.repository === 'string' && typeof rb.runId === 'string'
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(rb.repository) && /^[1-9][0-9]{0,19}$/.test(rb.runId)
    && Object.keys(rb).length === 2)) out.push('approval runBinding must be null or {repository, runId}');
  const issued = Date.parse(approval.issuedAt);
  const expires = Date.parse(approval.expiresAt);
  if (!(issued <= now && now < expires && expires - issued <= MAX_APPROVAL_MS)) out.push('approval outside its window');
  return out;
}

const FS = { openSync, writeSync, closeSync, fsyncSync, lstatSync, mkdirSync, readdirSync, realpathSync, statfsSync };
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);

/** A directory this user owns, mode 0700, at its canonical path (no symlink on the way). */
function ownedPrivateDir(dir, fs, label) {
  if (!isAbsolute(dir ?? '') || fs.realpathSync(dir) !== dir) throw new HarnessError('CUSTODY', `${label} must be a canonical absolute path`);
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== uid()) throw new HarnessError('CUSTODY', `${label} must be a 0700 directory of this user`);
}

export function checkEvidenceDir(dir, fs = FS) {
  ownedPrivateDir(dir, fs, 'evidence directory');
  if (fs.readdirSync(dir).length) throw new HarnessError('CUSTODY', 'evidence directory must be empty');
}

/**
 * Consumes the attempt in the fixed ledger directory: exclusive marker, fsynced with its
 * directory (and the parent of a newly created ledger). A second consumption of one approval on
 * this machine is refused before any effect.
 */
export function consumeAttempt(ledgerDir, attemptId, fs = FS, now = Date.now()) {
  if (!ATTEMPT_ID.test(attemptId ?? '')) throw new HarnessError('CUSTODY', 'attempt id');
  const fsyncDir = (d) => {
    const dfd = fs.openSync(d, constants.O_RDONLY);
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  };
  const made = fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  if (made !== undefined) fsyncDir(dirname(made));
  ownedPrivateDir(ledgerDir, fs, 'ledger directory');
  let fd;
  try {
    fd = fs.openSync(join(ledgerDir, `attempt-${attemptId}.consumed`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (e) {
    if (e?.code === 'EEXIST') throw new HarnessError('REPLAY', 'this approval was already consumed');
    throw e;
  }
  try { fs.writeSync(fd, `${new Date(now).toISOString()}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fsyncDir(ledgerDir);
}

const TMPFS_MAGIC = 0x01021994; // tmpfs and devtmpfs
const RAMFS_MAGIC = 0x858458f6;
const OVERLAY_MAGIC = 0x794c7630;

/** The nearest existing ancestor of `p` (the ledger may not exist yet). */
function existingAncestor(p, fs) {
  for (let d = p; ; d = dirname(d)) {
    try { fs.lstatSync(d); return d; } catch { if (d === dirname(d)) return d; }
  }
}

/**
 * Runtime facts a manifest cannot prove, read with statfs on canonical paths (no `..`, no
 * symlink): key files on tmpfs, the ledger on persistent storage (not tmpfs, ramfs or an
 * overlay), and on GitHub Actions the exact run the approval names, on its first attempt.
 */
export function runtimeRefusals({ manifest, approval, env, fs }) {
  const out = [];
  const canonical = (p) => { try { return normalize(p) === p && fs.realpathSync(p) === p; } catch { return false; } };
  const type = (p) => { try { return fs.statfsSync(p).type; } catch { return null; } };
  const secret = manifest.runtime.secretParent;
  if (!canonical(secret) || type(secret) !== TMPFS_MAGIC) out.push('runtime.secretParent must be a canonical tmpfs directory');
  if (normalize(manifest.runtime.ledgerDir) !== manifest.runtime.ledgerDir) out.push('runtime.ledgerDir must be a normalised path');
  const anc = existingAncestor(manifest.runtime.ledgerDir, fs);
  const ledgerType = type(anc);
  if (!canonical(anc) || ledgerType === null || [TMPFS_MAGIC, RAMFS_MAGIC, OVERLAY_MAGIC].includes(ledgerType)) {
    out.push('runtime.ledgerDir must be on canonical persistent storage');
  }
  const rb = approval?.runBinding ?? null;
  if (env.GITHUB_ACTIONS === 'true') {
    if (env.GITHUB_RUN_ATTEMPT !== '1') out.push('a re-run of a workflow run never executes an approval');
    if (!rb || rb.repository !== env.GITHUB_REPOSITORY || rb.runId !== env.GITHUB_RUN_ID) out.push('approval names another workflow run');
  } else if (rb !== null) {
    out.push('approval is bound to a workflow run');
  } else if (env.GITHUB_RUN_ID || env.RUNNER_NAME) {
    out.push('a runner without GITHUB_ACTIONS=true never executes an unbound approval');
  }
  return out;
}

export function harnessHashes(root = REPO_ROOT, manifestText = readFileSync(join(root, MANIFEST_PATH), 'utf8')) {
  return Object.fromEntries(HARNESS_FILES.map((f) => [f, f === MANIFEST_PATH ? sha256(manifestText) : fileSha256(join(root, f))]));
}

export function planSummary(manifest) {
  return { planned: plannedCounts(), caps: Object.fromEntries(CAP_KINDS.map((k) => [k, manifest.caps?.[k] ?? null])) };
}

export function attemptNames(attempt, manifest) {
  if (!ATTEMPT_ID.test(attempt ?? '')) throw new HarnessError('BAD_PLAN', 'attempt id');
  return { pg: `${attempt}-pg`, volume: `${attempt}-pgdata`, network: `${attempt}-net`,
    realtime: Array.from({ length: manifest.caps.processStarts }, (_, i) => `${attempt}-rt-${String(i + 1).padStart(2, '0')}`) };
}

/** Removes exactly the named objects, containers first; never a prune or wildcard. */
async function removeExact(exec, { containers, volume, network }) {
  const steps = teardownArgv({ names: containers, volume: volume ?? 'unused-volume', network: network ?? 'unused-network' })
    .filter((a) => (a[0] === 'volume' ? volume : a[0] === 'network' ? network : true));
  const results = [];
  for (const args of steps) results.push({ args: args.join(' '), code: (await exec(args, { timeoutMs: 30_000 })).code });
  return results;
}

/** The default real dependencies; tests replace them. */
export const DEFAULT_DEPS = Object.freeze({
  fs: FS, resolveLibraries, runQualification, dockerExec, dockerIdentity, createSecretDir, generateSecrets,
  now: () => Date.now(), harnessHashes, signals: process, nodeVersion: process.version, env: process.env,
  rmDir: (d) => rmSync(d, { recursive: true, force: true }),
});
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export async function execute({ manifest, approval, evidenceDir, deps: given = {} }) {
  const deps = { ...DEFAULT_DEPS, ...given };
  const refused = runtimeRefusals({ manifest, approval, env: deps.env, fs: deps.fs });
  if (refused.length) throw new HarnessError('RUNTIME', refused.join('; '));
  checkEvidenceDir(evidenceDir, deps.fs);
  consumeAttempt(manifest.runtime.ledgerDir, approval.attemptId, deps.fs, deps.now());
  const attempt = approval.attemptId;
  const store = createPrivateStore({ dir: evidenceDir, unlink: unlinkSync, maxBytes: manifest.limits.evidenceBytes });
  const secretDir = deps.createSecretDir(manifest.runtime.secretParent, { unlink: unlinkSync, attempt });
  const configDir = deps.createSecretDir(manifest.runtime.secretParent, { unlink: unlinkSync, attempt });
  const rawExec = deps.dockerExec(manifest.runtime.dockerPath, { dockerHost: manifest.runtime.dockerHost, configDir: configDir.dir });
  // Once aborting, no new docker command starts except the teardown's; teardown waits for the one in flight.
  let aborting = false;
  const inFlight = new Set();
  const exec = (args, o) => {
    if (aborting) return Promise.resolve({ code: 'ABORTED', stdout: '', stderr: '' });
    const p = rawExec(args, o);
    const settled = p.then(() => {}, () => {});
    inFlight.add(settled);
    settled.then(() => inFlight.delete(settled));
    return p;
  };
  const names = attemptNames(attempt, manifest);
  const created = { network: null, volume: null, containers: [] };
  const prismaClients = [];
  let lifecycle = null;
  let teardownPromise = null;
  let signal = null;
  const teardown = () => {
    teardownPromise ??= (async () => {
      aborting = true;
      // Every step is guarded: one failing step never skips the removals after it.
      const failures = [];
      // Bounded: a wedged step is recorded as failed instead of holding the teardown forever.
      const within = (ms, p) => Promise.race([p, new Promise((_, rej) => { setTimeout(() => rej(new Error('timeout')), ms).unref?.(); })]);
      const step = async (name, fn, ms = 10_000) => {
        try { await within(ms, Promise.resolve().then(fn)); } catch { if (!failures.includes(name)) failures.push(name); }
      };
      await step('secret-dir', () => secretDir.destroy());
      // docker commands carry their own 60 s timeout; wait for them, then remove before anything else.
      await step('in-flight', () => Promise.all([...inFlight]), 90_000);
      let results = [];
      await step('docker', async () => {
        const containers = [...new Set([...(lifecycle?.created() ?? []), ...created.containers])];
        results = await removeExact(rawExec, { containers, volume: created.volume, network: created.network });
      }, 30_000 * (2 + manifest.caps.processStarts + 1));
      for (const c of prismaClients) await step('prisma', () => c.$disconnect(), 5_000);
      await step('config-dir', () => configDir.destroy());
      let complete = failures.length === 0 && results.every((r) => r.code === 0);
      await step('record', () => store.sealPrivate('teardown', { complete, signal, failures, results }));
      if (failures.includes('record')) complete = false;
      if (!complete) deps.onTeardownIncomplete?.();
      return complete;
    })();
    return teardownPromise;
  };
  // Every signal waits for the one teardown (which reports an incomplete one first), then exits.
  const onSignal = (sig) => {
    if (teardownPromise && signal) {
      // A second interrupt while the teardown runs: say what may be left, and exit now.
      deps.onTeardownIncomplete?.();
      deps.signals.exit?.(130);
      return;
    }
    signal ??= typeof sig === 'string' ? sig : 'signal';
    teardown().finally(() => deps.signals.exit?.(130));
  };
  for (const sig of SIGNALS) deps.signals.on(sig, onSignal);
  let teardownComplete;
  let final;
  try {
    const libs = await deps.resolveLibraries(manifest.libraries);
    if (deps.nodeVersion !== manifest.node.version) throw new HarnessError('RUNTIME', `node ${deps.nodeVersion}`);
    const daemon = await deps.dockerIdentity(exec);
    await store.sealPrivate('runtime', { daemon, node: deps.nodeVersion, libraries: libs.bound });
    for (const img of Object.values(manifest.images)) {
      const r = await exec(['image', 'inspect', '--format', '{{.Id}} {{.Os}}/{{.Architecture}}', img.config]);
      if (r.code !== 0 || r.stdout.trim() !== `${img.config} ${img.platform}`) throw new HarnessError('IMAGE_MISMATCH', img.lockRoot);
    }
    // Nothing of this attempt may already exist: a name collision is refused, never reused. That
    // proof is what lets every name below be owned BEFORE its create command runs.
    for (const [kind, name] of [['network', names.network], ['volume', names.volume], ['container', names.pg],
      ...names.realtime.map((n) => ['container', n])]) {
      if ((await exec([kind, 'inspect', name])).code === 0) throw new HarnessError('NAME_IN_USE', `${kind} ${name}`);
    }
    const secrets = deps.generateSecrets(manifest);
    await store.sealPrivate('key-fingerprints', { gcmKey: sha256(secrets.gcmKey), gcmKeyBad: sha256(secrets.gcmKeyBad),
      bytes: Buffer.byteLength(secrets.gcmKey), entropyBits: 192 });
    const clock = { now: deps.now, sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }) };
    const pins = { [manifest.adminHost]: manifest.network.realtimeIp,
      [`${manifest.unknownTenantId}.${manifest.hostSuffix}`]: manifest.network.realtimeIp };
    for (const t of TENANTS) pins[`${manifest.tenants[t].externalId}.${manifest.hostSuffix}`] = manifest.network.realtimeIp;
    const lookup = pinnedLookup(pins);
    const call = (o) => httpCall({ ...o, lookup, port: manifest.realtimePort,
      timeoutMs: o.timeoutMs ?? manifest.timeouts.outcomeMs, maxBytes: manifest.limits.responseBytes });
    const owner = (database) => {
      const c = new libs.PrismaClient({ log: [], datasourceUrl: `postgresql://${manifest.images.postgres.ownerUser}:${
        secrets.ownerPassword}@${manifest.network.postgresIp}:5432/${database}` });
      prismaClients.push(c);
      return c;
    };
    lifecycle = createLifecycleAdapter({ exec, plan: manifest, secrets, attempt, store, clock,
      files: { writePrivate: secretDir.writePrivate, remove: secretDir.remove },
      http: (o) => call({ ...o, timeoutMs: 2000 }) });
    const label = `${ATTEMPT_LABEL}=${attempt}`;
    created.network = names.network;
    // Dual-stack: Realtime resolves a tenant DB host through :inet6_tcp first (database.ex
    // detect_ip_version), so an IPv4 literal is dialled IPv4-mapped and needs IPv6 in the container.
    if ((await exec(['network', 'create', '--internal', '--driver', 'bridge', '--label', label, '--subnet', manifest.network.subnet,
      '--ipv6', '--subnet', manifest.network.subnet6, names.network])).code !== 0) throw new HarnessError('START_FAILED', 'network');
    created.volume = names.volume;
    if ((await exec(['volume', 'create', '--label', label, names.volume])).code !== 0) throw new HarnessError('START_FAILED', 'volume');
    const pgEnv = secretDir.writePrivate(`env-${names.pg}`, envFileText({ ...manifest.images.postgres.env, POSTGRES_PASSWORD: secrets.ownerPassword }));
    created.containers.push(names.pg);
    let pg;
    try {
      pg = await exec(postgresRunArgv({ name: names.pg, network: names.network, ip: manifest.network.postgresIp, envFile: pgEnv,
        image: manifest.images.postgres.config, volume: names.volume, resources: manifest.resources.postgres }));
    } finally { secretDir.remove(pgEnv); }
    if (pg.code !== 0) throw new HarnessError('START_FAILED', 'postgres');
    const root = owner('postgres');
    let ready = false;
    for (let i = 0; i < manifest.limits.readinessProbes && !ready; i += 1) {
      ready = await root.$queryRaw`SELECT 1 AS ok`.then(() => true, () => false);
      if (!ready) await clock.sleep(manifest.limits.readinessIntervalMs);
    }
    if (!ready) throw new HarnessError('START_FAILED', 'postgres not ready');
    const byDb = { postgres: root };
    const statements = renderBootstrap(manifest.bootstrap.statements, { meta_verifier: scramVerifier(secrets.metaPassword),
      tenant_a_verifier: scramVerifier(secrets.tenants.a.db.db_password), tenant_b_verifier: scramVerifier(secrets.tenants.b.db.db_password) });
    for (const s of statements) {
      byDb[s.database] ??= owner(s.database);
      await byDb[s.database].$executeRawUnsafe(s.sql);
    }
    await store.append({ step: 'bootstrap', statements: statements.length });
    const tokens = createTokenAdapter({ jose: libs.jose, secrets, clock, role: manifest.client.role });
    const adapters = {
      clock, lifecycle, evidence: store, tokens,
      api: createApiAdapter({ call, port: manifest.realtimePort, adminHost: manifest.adminHost, tokens,
        limits: { outcomeMs: manifest.timeouts.outcomeMs, createMs: manifest.timeouts.createMs, responseBytes: manifest.limits.responseBytes } }),
      sockets: createSocketsAdapter({ libs, port: manifest.realtimePort, lookup, vsn: manifest.client.vsn, limits: manifest.limits }),
      metadata: createMetadataAdapter({ prisma: owner(manifest.metadata.database), Prisma: libs.Prisma, schema: manifest.metadata.schema }),
      tenantDb: createTenantDbAdapter({ Prisma: libs.Prisma, schema: manifest.tenantTable.schema, table: manifest.tenantTable.table,
        clients: Object.fromEntries(TENANTS.map((t) => [t, byDb[manifest.tenants[t].database] ?? owner(manifest.tenants[t].database)])),
        databases: Object.fromEntries(TENANTS.map((t) => [t, manifest.tenants[t].database])) }),
      ids: { nonce: () => randomBytes(16).toString('hex'), rowId: () => randomUUID() },
    };
    const result = await deps.runQualification({ plan: manifest, secrets, adapters });
    const after = deps.harnessHashes();
    const changed = HARNESS_FILES.filter((f) => after[f] !== approval.harness[f]);
    final = signal ? { ...result, verdict: 'ABORTED', stopReason: 'INTERRUPTED' }
      : changed.length ? { ...result, verdict: 'ABORTED', stopReason: 'HARNESS_CHANGED_DURING_RUN' } : result;
    await store.sealPrivate('result', { ...final, chain: store.head() });
  } finally {
    teardownComplete = await teardown();
    for (const sig of SIGNALS) deps.signals.removeListener(sig, onSignal);
  }
  return { ...final, teardownComplete };
}

/**
 * --teardown: removes one attempt's objects after a hard kill — only those that carry this
 * attempt's label — and its tmpfs secret directories. Prints only exit codes.
 */
export async function teardownAttempt({ manifest, attempt, deps: given = {} }) {
  const deps = { ...DEFAULT_DEPS, ...given };
  const names = attemptNames(attempt, manifest);
  const configDir = deps.createSecretDir(manifest.runtime.secretParent, { unlink: unlinkSync, attempt: 'teardown' });
  try {
    const exec = deps.dockerExec(manifest.runtime.dockerPath, { dockerHost: manifest.runtime.dockerHost, configDir: configDir.dir });
    const labelled = async (kind, name) => {
      const r = await exec([kind, 'inspect', '--format', `{{index ${kind === 'container' ? '.Config.Labels' : '.Labels'} "${ATTEMPT_LABEL}"}}`, name]);
      return r.code === 0 && r.stdout.trim() === attempt;
    };
    const containers = [];
    for (const n of [...names.realtime, names.pg]) if (await labelled('container', n)) containers.push(n);
    const volume = (await labelled('volume', names.volume)) ? names.volume : null;
    const network = (await labelled('network', names.network)) ? names.network : null;
    const results = await removeExact(exec, { containers, volume, network });
    for (const d of deps.fs.readdirSync(manifest.runtime.secretParent)) {
      if (d.startsWith(`${SECRET_DIR_PREFIX}${attempt}-`)) deps.rmDir(join(manifest.runtime.secretParent, d));
    }
    return results;
  } finally {
    configDir.destroy();
  }
}

export async function main(argv = process.argv.slice(2), out = console.log, deps = {}) {
  const manifestText = (deps.readManifest ?? (() => readFileSync(join(REPO_ROOT, MANIFEST_PATH), 'utf8')))();
  const manifest = JSON.parse(manifestText);
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--bind-libraries')) {
    out(JSON.stringify((await resolveLibraries(manifest.libraries, { bindOnly: true })).bound, null, 2));
    return 0;
  }
  if (argv.includes('--teardown')) {
    const results = await teardownAttempt({ manifest, attempt: at('--attempt'), deps });
    out(JSON.stringify(results.map((r) => r.code)));
    return 0;
  }
  const hashes = harnessHashes(REPO_ROOT, manifestText);
  let approval = null;
  const parseRefusals = [];
  if (at('--approval')) {
    const parsed = parseApproval(readFileSync(at('--approval'), 'utf8'), at('--approval-sha256'));
    approval = parsed.approval;
    parseRefusals.push(...parsed.refusals);
  }
  const evidenceDir = at('--evidence-dir');
  const refusals = [...parseRefusals, ...executionRefusals({ manifest, approval, hashes, now: Date.now(), evidenceDir })];
  if (!argv.includes('--execute')) {
    out(JSON.stringify({ ...planSummary(manifest), hashes, refusals }, null, 2));
    return 0;
  }
  if (refusals.length) {
    out(`REFUSED: ${refusals.join('; ')}`);
    return 2;
  }
  const r = await (deps.execute ?? execute)({ manifest, approval, evidenceDir,
    deps: { onTeardownIncomplete: () => out('TEARDOWN_INCOMPLETE: run --teardown --attempt for this attempt'), ...deps } });
  out(JSON.stringify({ verdict: r.verdict, stopReason: r.stopReason, cases: r.cases, used: r.used,
    qualification: r.qualification, limitations: r.limitations }, null, 2));
  if (r.teardownComplete === false) return 3;
  return r.verdict === 'CONSUMER_CASES_PASSED' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(e instanceof HarnessError ? e.message : 'UNEXPECTED_ERROR');
    process.exitCode = 1;
  });
}
