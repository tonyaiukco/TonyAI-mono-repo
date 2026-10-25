/**
 * Real adapters for the R3 Realtime GCM case machine (r3_realtime_gcm.mjs).
 *
 * Nothing is constructed at import time and no third-party module is loaded until
 * resolveLibraries() runs, so CI imports this file and tests every adapter with fakes. The
 * protocol work stays in the pinned libraries: @supabase/realtime-js + @supabase/phoenix encode
 * and decode Phoenix, ws carries the socket, jose signs HS256 tokens, the repo's generated Prisma
 * client runs parameterised SQL. This file only counts, bounds and refuses: one socket per
 * session, one join per topic, frame/byte caps, a fixed hostname-to-address map, exact-name
 * Docker commands with --pull=never and an image ID, and 0600 evidence with a hash chain.
 */
import { createRequire } from 'node:module';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { request as nodeHttpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { closeSync, constants, fsyncSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DB_FIELDS, GCM_FAILURE_TEXT, HarnessError, TENANTS, secretStrings, sha256 } from './r3_realtime_gcm.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const BROADCAST_EVENT = 'gcm-nonce';
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

// ---- libraries ------------------------------------------------------------------------------

/** Hash of a package directory: sorted relative paths with per-file SHA-256, bounded. */
export function treeSha256(dir, { maxFiles = 4000, maxBytes = 128 * 1024 * 1024 } = {}) {
  const entries = [];
  let bytes = 0;
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (name === 'node_modules') continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new HarnessError('LIBRARY_TREE', `symlink inside ${relative(dir, p)}`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        bytes += st.size;
        if (entries.length >= maxFiles || bytes > maxBytes) throw new HarnessError('LIBRARY_TREE', 'library tree over its bound');
        entries.push(`${sha256(readFileSync(p))}  ${relative(dir, p)}`);
      }
    }
  };
  walk(dir);
  return sha256(entries.join('\n'));
}

/** A package's own package.json, also when its exports map hides it (@supabase/phoenix does). */
function packageJsonPath(req, name) {
  try {
    return req.resolve(`${name}/package.json`);
  } catch (e) {
    if (e?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw e;
  }
  for (let d = dirname(req.resolve(name)); d !== dirname(d); d = dirname(d)) {
    const p = join(d, 'package.json');
    try {
      if (JSON.parse(readFileSync(p, 'utf8')).name === name) return p;
    } catch { /* keep walking up */ }
  }
  throw new HarnessError('LIBRARY_MISMATCH', `${name} has no package.json`);
}

/**
 * Resolves the pinned client libraries from this checkout's install (through apps/api, which
 * depends on supabase-js, jose, puppeteer and @tonyai/db), checks each version and directory hash
 * against the manifest and loads them. Called by the runner only, never at import.
 */
export async function resolveLibraries(expected, { root = REPO_ROOT, bindOnly = false } = {}) {
  const fromApi = createRequire(join(root, 'apps/api/package.json'));
  const locate = (req, name) => {
    const pkgPath = packageJsonPath(req, name);
    return { name, req: createRequire(pkgPath), dir: dirname(pkgPath),
      version: JSON.parse(readFileSync(pkgPath, 'utf8')).version, parentReq: req };
  };
  const supabaseJs = locate(fromApi, '@supabase/supabase-js');
  const realtime = locate(supabaseJs.req, '@supabase/realtime-js');
  const phoenix = locate(realtime.req, '@supabase/phoenix');
  const puppeteer = locate(fromApi, 'puppeteer');
  const core = locate(puppeteer.req, 'puppeteer-core');
  const ws = locate(core.req, 'ws');
  const jose = locate(fromApi, 'jose');
  const db = locate(fromApi, '@tonyai/db');
  const prismaRuntime = locate(db.req, '@prisma/client');
  // @tonyai/db is bound by its generated client only (its package dir also holds local .env files).
  const found = { realtimeJs: realtime, phoenix, ws, jose, tonyaiDb: { ...db, dir: join(db.dir, 'generated/client') }, prismaRuntime };
  const bound = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, { version: v.version, treeSha256: treeSha256(v.dir) }]));
  if (bindOnly) return { bound };
  for (const [k, v] of Object.entries(bound)) {
    if (expected?.[k]?.version !== v.version) throw new HarnessError('LIBRARY_MISMATCH', `${k} version ${v.version}`);
    if (!expected[k].treeSha256 || expected[k].treeSha256 !== v.treeSha256) throw new HarnessError('LIBRARY_MISMATCH', `${k} tree hash`);
  }
  const { RealtimeClient } = realtime.parentReq('@supabase/realtime-js');
  const WebSocket = ws.parentReq('ws');
  const joseModule = await import(pathToFileURL(jose.parentReq.resolve('jose')).href);
  const { PrismaClient, Prisma } = db.parentReq('@tonyai/db');
  return { bound, RealtimeClient, WebSocket, jose: joseModule, PrismaClient, Prisma };
}

// ---- name resolution ------------------------------------------------------------------------

/** A dns.lookup replacement that resolves only the fixture's own names, to fixed IPv4 addresses. */
export function pinnedLookup(table) {
  const map = new Map();
  for (const [name, address] of Object.entries(table)) {
    if (!name.endsWith('.invalid') || !IPV4.test(address)) throw new HarnessError('BAD_PLAN', `pin ${name}`);
    map.set(name.toLowerCase(), address);
  }
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    const address = map.get(String(hostname).toLowerCase());
    if (!address) {
      const e = new Error(`unpinned host ${hostname}`);
      e.code = 'ENOTFOUND';
      process.nextTick(cb, e);
    } else if (opts.all) process.nextTick(cb, null, [{ address, family: 4 }]);
    else process.nextTick(cb, null, address, 4);
  };
}

// ---- WebSocket transport --------------------------------------------------------------------

/** Never opens, never fires: what a refused second construction hands back to the SDK. */
function inertSocket() {
  return { readyState: 3, binaryType: 'arraybuffer', timeout: 0, bufferedAmount: 0,
    onopen: null, onclose: null, onerror: null, onmessage: null, send() {}, close() {} };
}

/** Phoenix frames are JSON arrays (vsn 2.0.0) or objects (1.0.0); binary frames are only counted. */
export function parseFrame(text) {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v) && v.length === 5) return { topic: v[2], event: v[3], payload: v[4] };
    if (v && typeof v === 'object') return { topic: v.topic, event: v.event, payload: v.payload };
  } catch { /* not JSON: counted only */ }
  return null;
}

/**
 * A ws subclass bound to one session: the first construction connects through the pinned
 * lookup; any later one (SDK reconnect) is recorded and gets an inert socket, so nothing is sent.
 * A second phx_join for one topic (SDK rejoin) is dropped before sending.
 */
export function makeTransport({ WebSocket, lookup, state, limits, expectedHost, totals }) {
  return class PinnedSocket extends WebSocket {
    constructor(url, protocols) {
      state.constructions += 1;
      const u = new URL(url);
      if (state.constructions > 1 || state.closed) {
        state.violations.push(state.closed ? 'CONSTRUCTION_AFTER_CLOSE' : 'SECOND_SOCKET_CONSTRUCTION');
        return inertSocket();
      }
      if (u.hostname !== expectedHost || u.pathname !== '/socket/websocket' || u.protocol !== 'ws:') {
        state.violations.push('UNEXPECTED_ENDPOINT');
        return inertSocket();
      }
      super(url, protocols, { lookup, handshakeTimeout: limits.handshakeMs, maxPayload: limits.frameBytes,
        perMessageDeflate: false, followRedirects: false });
      this.on('upgrade', () => { state.httpStatus = 101; });
      this.on('open', () => { state.opened = true; });
      this.on('unexpected-response', (_req, res) => {
        state.httpStatus = res.statusCode;
        state.refused = true;
        res.resume();
        this.terminate();
      });
      this.on('close', () => { state.socketClosed = true; });
      this.on('error', (e) => { state.errors.push(String(e?.code ?? 'error')); });
      this.on('message', (data, isBinary) => {
        state.framesIn += 1;
        state.bytesIn += data.length;
        totals.bytes += data.length;
        if (state.framesIn > limits.framesPerSession || totals.bytes > limits.transcriptBytes) {
          state.violations.push('FRAME_LIMIT');
          this.terminate();
          return;
        }
        const f = isBinary ? null : parseFrame(data.toString('utf8'));
        if (f?.event === 'phx_reply' && f.payload?.status === 'error') {
          state.joinErrors.push({ topic: f.topic, reason: String(f.payload?.response?.reason ?? '').slice(0, 200) });
        }
      });
    }

    send(data, ...rest) {
      const f = typeof data === 'string' ? parseFrame(data) : null;
      if (f?.event === 'phx_join') {
        const n = (state.joins.get(f.topic) ?? 0) + 1;
        state.joins.set(f.topic, n);
        if (n > 1) {
          state.violations.push('SECOND_JOIN');
          return undefined;
        }
      }
      state.framesOut += 1;
      if (state.framesOut > limits.framesPerSession) {
        state.violations.push('FRAME_LIMIT');
        return undefined;
      }
      return super.send(data, ...rest);
    }
  };
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
export async function waitUntil(predicate, timeoutMs, stepMs = 25) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(stepMs);
  }
}

/**
 * Sessions over the pinned SDK. Each open() builds a fresh RealtimeClient and transport; the SDK's
 * reconnect is pushed out to a day and any attempt is refused by the transport anyway.
 */
export function createSocketsAdapter({ libs, port, lookup, limits, vsn }) {
  const totals = { bytes: 0 };
  const closedStates = [];
  // Activity on an already closed session (an SDK timer firing late) fails the next close().
  const lateActivity = () => {
    let late = 0;
    for (const s of closedStates) {
      if (s.violations.length > s.reported) { late += 1; s.reported = s.violations.length; }
    }
    return late ? ['LATE_ACTIVITY'] : [];
  };
  return {
    finalCheck: () => ({ violations: lateActivity(), transcriptBytes: totals.bytes }),
    async open({ hostname, token, timeoutMs }) {
      const state = { constructions: 0, closed: false, opened: false, refused: false, socketClosed: false,
        httpStatus: null, errors: [], violations: [], joins: new Map(), joinErrors: [], framesIn: 0,
        framesOut: 0, bytesIn: 0 };
      const Transport = makeTransport({ WebSocket: libs.WebSocket, lookup, state, limits, expectedHost: hostname, totals });
      const client = new libs.RealtimeClient(`ws://${hostname}:${port}/socket`, {
        transport: Transport, params: { apikey: token }, accessToken: async () => token, worker: false, vsn,
        reconnectAfterMs: () => 86_400_000, heartbeatIntervalMs: limits.heartbeatMs, timeout: timeoutMs,
      });
      client.connect();
      const settled = await waitUntil(() => state.opened || state.refused || state.socketClosed, timeoutMs);
      const status = state.opened ? 'open' : state.refused ? 'refused' : settled ? 'closed' : 'timeout';
      const inbox = [];
      const channels = [];
      return {
        status,
        httpStatus: state.httpStatus,
        async join({ topic, schema, table, timeoutMs: ms }) {
          const ch = client.channel(topic, { config: { broadcast: { self: false, ack: false }, private: false } });
          channels.push(ch);
          const seen = { statuses: [], pgReady: false };
          ch.on('broadcast', { event: BROADCAST_EVENT }, (m) => inbox.push({ kind: 'broadcast', nonce: m?.payload?.nonce }));
          ch.on('postgres_changes', { event: 'INSERT', schema, table },
            (p) => inbox.push({ kind: 'insert', id: p?.new?.id, nonce: p?.new?.nonce }));
          ch.on('system', {}, (p) => { if (p?.extension === 'postgres_changes' && p?.status === 'ok') seen.pgReady = true; });
          ch.subscribe((s) => { seen.statuses.push(s); });
          const full = `realtime:${topic}`;
          await waitUntil(() => (seen.statuses.includes('SUBSCRIBED') && seen.pgReady)
            || state.joinErrors.some((e) => e.topic === full) || seen.statuses.some((s) => s !== 'SUBSCRIBED'), ms);
          const err = state.joinErrors.find((e) => e.topic === full);
          if (err) return { status: 'error', reason: err.reason, postgresChangesReady: false };
          if (seen.statuses.includes('SUBSCRIBED')) return { status: 'subscribed', postgresChangesReady: seen.pgReady };
          if (seen.statuses.length) return { status: 'socket-error', postgresChangesReady: false };
          return { status: 'timeout', postgresChangesReady: false };
        },
        async expectBroadcast({ nonce, timeoutMs: ms }) {
          const m = await waitUntil(() => inbox.find((x) => x.kind === 'broadcast' && x.nonce === nonce), ms);
          return { received: Boolean(m), nonce: m?.nonce ?? null };
        },
        async expectInsert({ id, nonce, timeoutMs: ms }) {
          const m = await waitUntil(() => inbox.find((x) => x.kind === 'insert' && x.id === id), ms);
          return { received: Boolean(m), id: m?.id ?? null, nonce: m?.nonce ?? null, expectedNonce: nonce };
        },
        async close() {
          try {
            for (const ch of channels) await Promise.race([client.removeChannel(ch), sleep(1000)]);
            client.disconnect();
          } finally {
            state.closed = true;
          }
          await waitUntil(() => state.socketClosed || state.constructions === 0 || !state.opened, 2000);
          const violations = [...state.violations, ...lateActivity()];
          state.reported = state.violations.length;
          closedStates.push(state);
          return { violations, received: [...inbox], socketConstructions: state.constructions,
            joinAttempts: Math.max(0, ...state.joins.values()), framesIn: state.framesIn, bytesIn: state.bytesIn };
        },
      };
    },
  };
}

// ---- HTTP -----------------------------------------------------------------------------------

/** One bounded HTTP request through the pinned lookup. Never throws for an HTTP outcome. */
export function httpCall({ request = nodeHttpRequest, lookup, hostname, port, method, path, headers = {}, body,
  timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = request({ hostname, port, method, path, lookup, agent: false, timeout: timeoutMs,
      headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } },
    (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); finish({ status: res.statusCode, truncated: true, body: null }); return; }
        chunks.push(c);
      });
      res.on('end', () => finish({ status: res.statusCode, truncated: false, body: Buffer.concat(chunks) }));
      res.on('error', () => finish({ status: 'error', code: 'RESPONSE' }));
    });
    req.on('timeout', () => { req.destroy(); finish({ status: 'timeout' }); });
    req.on('error', (e) => finish({ status: 'error', code: String(e?.code ?? 'REQUEST') }));
    if (payload) req.write(payload);
    req.end();
  });
}

export function createApiAdapter({ call, port, adminHost, tokens, limits }) {
  const base = { port, timeoutMs: limits.outcomeMs, maxBytes: limits.responseBytes };
  const admin = async (method, path, body) => call({ ...base, hostname: adminHost, method, path, body,
    headers: { authorization: `Bearer ${await tokens.admin()}` } });
  return {
    getTenant: (externalId) => admin('GET', `/api/tenants/${encodeURIComponent(externalId)}`),
    // Creation runs the tenant migrations synchronously (up to 50 s, plus a dump load): its own bound.
    createTenant: async (body) => call({ ...base, timeoutMs: limits.createMs ?? limits.outcomeMs, hostname: adminHost, method: 'POST',
      path: '/api/tenants', body, headers: { authorization: `Bearer ${await tokens.admin()}` } }),
    updateJwt: ({ externalId, jwtSecret }) => admin('PUT', `/api/tenants/${encodeURIComponent(externalId)}`,
      { tenant: { jwt_secret: jwtSecret } }),
    broadcast: ({ hostname, token, topic, nonce, timeoutMs }) => call({ ...base, timeoutMs, hostname, method: 'POST',
      path: '/api/broadcast', headers: { authorization: `Bearer ${token}` },
      body: { messages: [{ topic, event: BROADCAST_EVENT, payload: { nonce }, private: false }] } }),
  };
}

// ---- tokens ---------------------------------------------------------------------------------

/** HS256 tokens from jose; tenant tokens carry role and exp (user_socket.ex requires both). */
export function createTokenAdapter({ jose, secrets, clock, role, ttlSeconds = 900 }) {
  const enc = new TextEncoder();
  const sign = (secret, claims) => {
    const now = Math.floor(clock.now() / 1000);
    return new jose.SignJWT(claims).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds).sign(enc.encode(secret));
  };
  return {
    tenant: (t) => sign(secrets.tenants[t].jwtSecret, { role, sub: `gcm-fixture-${t}` }),
    badSignature: (t) => sign(secrets.badJwtSecret, { role, sub: `gcm-fixture-${t}` }),
    admin: () => sign(secrets.apiJwtSecret, { role: 'service_role', sub: 'gcm-fixture-admin' }),
  };
}

// ---- SQL ------------------------------------------------------------------------------------

const SCHEMA_IDENT = /^_?[a-z][a-z0-9_]{0,62}$/;

/** Realtime's metadata rows for one fixture tenant; writes are one exact row and one field. */
export function createMetadataAdapter({ prisma, Prisma, schema }) {
  if (!SCHEMA_IDENT.test(schema)) throw new HarnessError('BAD_PLAN', 'metadata schema');
  const S = Prisma.raw(`"${schema}"`);
  return {
    async readSix(externalId) {
      const tenants = await prisma.$queryRaw`SELECT jwt_secret, jwt_jwks FROM ${S}.tenants WHERE external_id = ${externalId}`;
      const exts = await prisma.$queryRaw`SELECT type, settings FROM ${S}.extensions WHERE tenant_external_id = ${externalId}`;
      const settings = exts[0]?.settings ?? {};
      const values = tenants.length ? { jwt_secret: tenants[0].jwt_secret } : {};
      const otherSettings = {};
      for (const [k, v] of Object.entries(settings)) {
        if (DB_FIELDS.includes(k)) values[k] = v;
        else otherSettings[k] = v;
      }
      return { tenantRows: tenants.length, extensionRows: exts.length, extensionType: exts[0]?.type ?? null,
        jwtJwks: tenants[0]?.jwt_jwks ?? null, values, otherSettings };
    },
    async conditionalReplace({ externalId, field, expected, value }) {
      if (field !== 'jwt_secret' && !DB_FIELDS.includes(field)) throw new HarnessError('BAD_PLAN', 'field');
      // In one transaction: a statement that matched anything but exactly one row is rolled back.
      let rowCount = 0;
      try {
        await prisma.$transaction(async (tx) => {
          rowCount = field === 'jwt_secret'
            ? await tx.$executeRaw`UPDATE ${S}.tenants SET jwt_secret = ${value}
                WHERE external_id = ${externalId} AND jwt_secret = ${expected}`
            : await tx.$executeRaw`UPDATE ${S}.extensions
                SET settings = jsonb_set(settings, ARRAY[${field}]::text[], to_jsonb(${value}::text), false)
                WHERE tenant_external_id = ${externalId} AND type = 'postgres_cdc_rls' AND settings ->> ${field} = ${expected}`;
          if (rowCount !== 1) throw new HarnessError('ROW_COUNT', `matched ${rowCount}`);
        });
      } catch (e) {
        if (!(e instanceof HarnessError)) throw e;
      }
      return { rowCount };
    },
  };
}

/** The synthetic tenant table, through the fixture owner's connection to each tenant database. */
export function createTenantDbAdapter({ clients, Prisma, schema, table, databases }) {
  if (!SCHEMA_IDENT.test(schema) || !SCHEMA_IDENT.test(table)) throw new HarnessError('BAD_PLAN', 'tenant table');
  const T = Prisma.raw(`"${schema}"."${table}"`);
  return {
    async insert(t, { id, caseId, nonce }) {
      const n = await clients[t].$executeRaw`INSERT INTO ${T} (id, case_id, nonce) VALUES (${id}::uuid, ${caseId}, ${nonce})`;
      if (n !== 1) throw new HarnessError('ROW_COUNT', 'insert');
    },
    observeConnections: (t) => clients[t].$queryRaw`SELECT usename, datname, application_name
      FROM pg_stat_activity WHERE datname = ${databases[t]} AND pid <> pg_backend_pid()`,
    async ping(t) {
      const r = await clients[t].$queryRaw`SELECT 1 AS ok`;
      return { ok: r?.[0]?.ok === 1 };
    },
  };
}

// ---- Docker lifecycle -----------------------------------------------------------------------

const NAME = /^[a-z0-9][a-z0-9_.-]{2,62}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

function requireName(n) { if (!NAME.test(n)) throw new HarnessError('BAD_PLAN', `docker name ${n}`); return n; }
function requireImage(id) { if (!IMAGE_ID.test(id ?? '')) throw new HarnessError('BAD_PLAN', 'image must be a sha256 image ID'); return id; }

/** No raw sockets (no forged router advertisements on the dual-stack network), and none accepted. */
const HARDENING = Object.freeze(['--cap-drop', 'NET_RAW', '--sysctl', 'net.ipv6.conf.all.accept_ra=0']);

/** Every object of an attempt carries its attempt label; --teardown removes only labelled objects. */
export const ATTEMPT_LABEL = 'tonyai.r3.gcm.attempt';
const label = (name) => `${ATTEMPT_LABEL}=${requireName(name).replace(/-(rt-\d{2}|pg|pgdata|net)$/, '')}`;

/** Argv for one Realtime process; the image is the local config digest, never a tag. */
export function realtimeRunArgv({ name, network, ip, envFile, image, resources }) {
  return ['run', '--detach', '--pull=never', '--platform', 'linux/amd64', '--name', requireName(name), '--label', label(name),
    '--network', requireName(network), '--ip', ip, '--env-file', envFile, '--restart', 'no',
    '--memory', resources.memory, '--memory-swap', resources.memory, '--cpus', resources.cpus,
    '--pids-limit', String(resources.pids), '--security-opt', 'no-new-privileges', ...HARDENING,
    '--log-driver', 'json-file', '--log-opt', `max-size=${resources.logMaxSize}`, requireImage(image)];
}

/** Argv for the one disposable PostgreSQL; its volume outlives every Realtime restart. */
export function postgresRunArgv({ name, network, ip, envFile, image, volume, resources }) {
  return ['run', '--detach', '--pull=never', '--platform', 'linux/amd64', '--name', requireName(name), '--label', label(name),
    '--network', requireName(network), '--ip', ip, '--env-file', envFile, '--restart', 'no',
    '--volume', `${requireName(volume)}:/var/lib/postgresql/data`, '--memory', resources.memory,
    '--memory-swap', resources.memory, '--cpus', resources.cpus, '--shm-size', resources.shm,
    '--pids-limit', String(resources.pids), '--security-opt', 'no-new-privileges', ...HARDENING,
    '--log-driver', 'json-file', '--log-opt', `max-size=${resources.logMaxSize}`, requireImage(image)];
}

/** Exact-name teardown, in order; no prune, no wildcard. */
export function teardownArgv({ names, volume, network }) {
  return [...names.map((n) => ['rm', '--force', '--volumes', requireName(n)]),
    ['volume', 'rm', requireName(volume)], ['network', 'rm', requireName(network)]];
}

/** KEY=VALUE lines for --env-file; refuses values Docker would misread. */
export function envFileText(env) {
  return Object.entries(env).map(([k, v]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || typeof v !== 'string' || /[\r\n\0]/.test(v)) throw new HarnessError('BAD_PLAN', `env ${k}`);
    return `${k}=${v}`;
  }).join('\n') + '\n';
}

export function realtimeEnv({ plan, secrets, key }) {
  const gcm = key === 'K' ? secrets.gcmKey : key === 'Kbad' ? secrets.gcmKeyBad : null;
  if (!gcm) throw new HarnessError('BAD_PLAN', 'key must be K or Kbad');
  return { ...plan.realtimeEnv, DB_ENC_KEY_GCM: gcm, DB_ENC_KEY: secrets.legacyKey, API_JWT_SECRET: secrets.apiJwtSecret,
    METRICS_JWT_SECRET: secrets.metricsJwtSecret, SECRET_KEY_BASE: secrets.secretKeyBase, DB_PASSWORD: secrets.metaPassword };
}

const DOCKER_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;
// A header starts with a time, or with optional key=value metadata and then a level tag.
const ENTRY_START = /^(?:\d{2}:\d{2}:\d{2}\.\d{3}|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})|^(?![\s*(])(?:[a-z_]+=\S*\s+)*\[(?:emergency|alert|critical|error|warning|warn|notice|info|debug)\]/;

const CONTINUATION = /^(?:\s|\*\*|\(|Server: |Request: |Last message|State: |Client )/;

/**
 * Splits `docker logs --timestamps` output into log entries: a header line (a time or a level
 * tag) plus its continuation lines (indented, `** (…)`, `Server:`, `Request:`, `Last message`,
 * `State:`). A GenServer or Cowboy crash report carries crypto.ex's text on a continuation line,
 * not on its header. A line that is neither starts an UNKNOWN entry, which is counted but never
 * attributed: an unrecognised shape can only lose attribution, never borrow a neighbour's.
 */
export function logEntries(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(DOCKER_TS, '');
    if (!line.trim()) continue;
    if (ENTRY_START.test(line)) entries.push({ known: true, lines: [line] });
    else if (CONTINUATION.test(line) && entries.length) entries.at(-1).lines.push(line);
    else entries.push({ known: false, lines: [line] });
  }
  return entries.map((e) => ({ known: e.known, text: e.lines.join('\n') }));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Counts entries carrying crypto.ex's failure text per fixture tenant. A known entry is attributed
 * by exact `external_id=<id>` metadata tokens or by a crash report's `Server: <id>.<hostSuffix>`
 * line, never by a substring; one naming no tenant, an unknown one or both is unattributed. A
 * `Request:` line tags the entry with its consumer (the socket or the broadcast route).
 */
/**
 * Masks credentials before server logs are stored: Plug.Cowboy's crash report prints the request
 * line (the socket URL carries the tenant JWT as `apikey=`), and a crash dump can print headers,
 * arguments or state. Any JWT-shaped string, the known credential keys, and every form of this
 * attempt's secrets (`forms`, from secretStrings) are replaced.
 */
export function maskLogSecrets(text, forms = []) {
  let out = text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<masked-jwt>')
    .replace(/([?&]apikey=)[^&\s]+/g, '$1<masked>')
    .replace(/((?:authorization|apikey|x-api-key|access_token|tenant_token)["']?\s*(?:[:=,]|=>)\s*["']?(?:Bearer\s+)?)[A-Za-z0-9._~+/=-]{16,}/gi, '$1<masked>');
  for (const f of [...forms].sort((x, y) => y.length - x.length)) if (f) out = out.split(f).join('<masked>');
  return out;
}

export function countLogFailures(text, idByTenant, hostSuffix = 'realtime-gcm.invalid') {
  const tenantOf = new Map(Object.entries(idByTenant).map(([t, id]) => [id, t]));
  const byTenant = Object.fromEntries(Object.keys(idByTenant).map((t) => [t, 0]));
  const byConsumer = Object.fromEntries(Object.keys(idByTenant).map((t) => [t, { socket: 0, broadcast: 0, untagged: 0 }]));
  const server = new RegExp(`(?:^|\\s)Server: ([A-Za-z0-9-]+)\\.${escapeRe(hostSuffix)}(?::\\d+)?(?=\\s|$)`, 'gm');
  let gcmFailures = 0;
  let unattributed = 0;
  for (const { known, text: entry } of logEntries(text)) {
    if (!entry.includes(GCM_FAILURE_TEXT)) continue;
    gcmFailures += 1;
    const ids = known ? [...entry.matchAll(/(?:^|\s)external_id=([A-Za-z0-9_-]+)(?=\s|$)/gm), ...entry.matchAll(server)].map((m) => m[1]) : [];
    const ts = [...new Set(ids.map((id) => tenantOf.get(id) ?? '?'))];
    if (ts.length !== 1 || ts[0] === '?') { unattributed += 1; continue; }
    byTenant[ts[0]] += 1;
    const req = /^Request: (GET \/socket\/websocket|POST \/api\/broadcast)(?=[\s?]|$)/m.exec(entry)?.[1];
    byConsumer[ts[0]][req ? (req.startsWith('GET') ? 'socket' : 'broadcast') : 'untagged'] += 1;
  }
  return { gcmFailures, byTenant, byConsumer, unattributed };
}

/**
 * The docker CLI with a pinned daemon and an empty client config: no user context, proxy or
 * credential helper from ~/.docker applies, and nothing but PATH reaches it from the environment.
 */
export function dockerExec(dockerPath, { dockerHost, configDir }) {
  if (!/^unix:\/\/\/[a-z0-9/._-]+$/.test(dockerHost ?? '') || !configDir) throw new HarnessError('BAD_PLAN', 'docker endpoint');
  const env = { PATH: '/usr/bin:/bin', HOME: configDir, DOCKER_CONFIG: configDir, DOCKER_HOST: dockerHost, DOCKER_CLI_HINTS: 'false' };
  return (args, { timeoutMs = 60_000, maxBytes = 1024 * 1024 } = {}) => new Promise((resolve) => {
    execFile(dockerPath, args, { timeout: timeoutMs, maxBuffer: maxBytes, env },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr),
        truncated: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
  });
}

/** The daemon that answered: must be a linux/x86_64 engine; its ID and version go to evidence. */
export async function dockerIdentity(exec) {
  const r = await exec(['info', '--format', '{{.ID}}|{{.OSType}}|{{.Architecture}}|{{.ServerVersion}}']);
  const [id, os, arch, version] = r.stdout.trim().split('|');
  if (r.code !== 0 || os !== 'linux' || arch !== 'x86_64' || !id || !version) throw new HarnessError('RUNTIME', 'docker daemon is not linux/x86_64');
  return { id, os, arch, version };
}

/**
 * Realtime's lifecycle. Every start is a NEW container (new ID, new start time) from the same
 * image ID; every stop proves the container is gone. The GCM key reaches Docker only through a
 * 0600 env file that is removed again as soon as the container exists.
 */
export function createLifecycleAdapter({ exec, plan, secrets, attempt, files, http, clock, store }) {
  let n = 0;
  let current = null;
  const network = `${attempt}-net`;
  const idByTenant = Object.fromEntries(TENANTS.map((t) => [t, plan.tenants[t].externalId]));
  const forms = secretStrings(secrets);
  const created = [];
  const inspect = async (name) => {
    const r = await exec(['inspect', '--type', 'container', '--format',
      '{{.Id}} {{.State.StartedAt}} {{.State.Pid}} {{.Image}} {{.State.Running}}', name]);
    if (r.code !== 0) return null;
    const [id, startedAt, pid, image, running] = r.stdout.trim().split(' ');
    return { id, startedAt, pid, image, running: running === 'true' };
  };
  return {
    network,
    async start({ key }) {
      if (current) throw new HarnessError('LIFECYCLE', 'already running');
      n += 1;
      const name = `${attempt}-rt-${String(n).padStart(2, '0')}`;
      const envFile = files.writePrivate(`env-${name}`, envFileText(realtimeEnv({ plan, secrets, key })));
      // Owned before the command: a run that fails or times out after the daemon created the
      // container (with the key in its env) is still torn down. The runner proved the name free.
      created.push(name);
      let r;
      try {
        r = await exec(realtimeRunArgv({ name, network, ip: plan.network.realtimeIp, envFile,
          image: plan.images.realtime.config, resources: plan.resources.realtime }));
      } finally {
        files.remove(envFile);
      }
      if (r.code !== 0) throw new HarnessError('START_FAILED', `docker run exited ${r.code}`);
      const info = await inspect(name);
      if (!info?.running || info.image !== plan.images.realtime.config) throw new HarnessError('START_FAILED', 'image or state mismatch');
      current = { name, info };
      let ready = false;
      const until = clock.now() + plan.timeouts.startupMs;
      for (let i = 0; i < plan.limits.readinessProbes && !ready && clock.now() < until; i += 1) {
        const h = await http({ hostname: plan.adminHost, method: 'GET', path: '/healthcheck' });
        ready = h.status === 200;
        if (!ready) await sleep(plan.limits.readinessIntervalMs);
      }
      if (!ready) throw new HarnessError('START_FAILED', 'healthcheck not ready within its bound');
      return { identity: `${info.id}@${info.startedAt}#${info.pid}`, key, image: info.image, name };
    },
    async stop() {
      if (!current) throw new HarnessError('LIFECYCLE', 'nothing running');
      const { name, info } = current;
      const s = await exec(['stop', '--time', '10', name]);
      const logs = await exec(['logs', '--timestamps', name], { maxBytes: plan.limits.serverLogBytes });
      store.appendLog(name, maskLogSecrets(logs.stdout + logs.stderr, forms));
      const rm = await exec(['rm', name]);
      const after = await inspect(name);
      current = null;
      return { gone: s.code === 0 && rm.code === 0 && after === null, logsComplete: logs.code === 0 && !logs.truncated,
        identity: `${info.id}@${info.startedAt}#${info.pid}` };
    },
    logMark: async () => new Date(clock.now()).toISOString(),
    async logsSince(mark) {
      if (!current) throw new HarnessError('LIFECYCLE', 'no process for logs');
      const r = await exec(['logs', '--timestamps', '--since', mark, current.name], { maxBytes: plan.limits.logReadBytes });
      const text = r.stdout + r.stderr;
      store.appendLog(`${current.name}-since`, maskLogSecrets(text, forms));
      return { ...countLogFailures(text, idByTenant, plan.hostSuffix), truncated: r.code !== 0 || r.truncated === true };
    },
    /** Exactly the containers this attempt created, for the runner's teardown. */
    created: () => [...created],
    liveness: async () => http({ hostname: plan.adminHost, method: 'GET', path: '/healthcheck' }),
  };
}

// ---- private files and evidence -------------------------------------------------------------

/** Private files in one 0700 directory: created exclusively, mode 0600, fsynced, bounded. */
export function createPrivateStore({ dir, fs = { openSync, writeSync, fsyncSync, closeSync, lstatSync }, unlink,
  maxBytes = 64 * 1024 * 1024 }) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0) throw new HarnessError('CUSTODY', 'evidence directory must be 0700');
  let total = 0;
  let chain = '0'.repeat(64);
  let records = 0;
  const write = (name, text, flags) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(name)) throw new HarnessError('CUSTODY', `file name ${name}`);
    total += Buffer.byteLength(text);
    if (total > maxBytes) throw new HarnessError('CAP_EXCEEDED', 'private evidence over its bound');
    const p = join(dir, name);
    const fd = fs.openSync(p, flags, 0o600);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } catch (e) {
      // A partly written file that this call created (it may hold a key) does not stay behind.
      if (flags & constants.O_EXCL) { try { unlink(p); } catch { /* reported by the rethrow */ } }
      throw e;
    } finally {
      fs.closeSync(fd);
    }
    return p;
  };
  const exclusive = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const appendFlags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  return {
    writePrivate: (name, text) => write(name, text, exclusive),
    remove: (p) => unlink(p),
    appendLog: (name, text) => write(`log-${name}.txt`, text, appendFlags),
    async append(record) {
      const line = JSON.stringify({ ...record, prev: chain });
      chain = sha256(line);
      records += 1;
      write('records.jsonl', `${line}\n`, records === 1 ? exclusive : appendFlags);
    },
    async sealPrivate(name, obj) { write(`${name}.json`, JSON.stringify(obj), exclusive); },
    head: () => ({ records, chain }),
  };
}

/**
 * A per-attempt 0700 directory OUTSIDE the evidence directory (tmpfs on the runner) for the env
 * files that carry keys; destroy() removes exactly this directory.
 */
export const SECRET_DIR_PREFIX = 'tonyai-gcm-';
export function createSecretDir(parent, { unlink, attempt = 'x', mkdtemp = mkdtempSync, rm = rmSync } = {}) {
  const dir = mkdtemp(join(parent, `${SECRET_DIR_PREFIX}${attempt}-`));
  const store = createPrivateStore({ dir, unlink, maxBytes: 1024 * 1024 });
  return { dir, writePrivate: store.writePrivate, remove: store.remove, destroy: () => rm(dir, { recursive: true, force: true }) };
}

// ---- secrets --------------------------------------------------------------------------------

/**
 * Synthetic secrets for one attempt. K and Kbad are Base64 of 24 random bytes: 32 ASCII bytes,
 * as runtime.exs requires, carrying 192 bits of entropy (not 256).
 */
export function generateSecrets(plan, rand = randomBytes) {
  const b64 = (n) => rand(n).toString('base64');
  const hex = (n) => rand(n).toString('hex');
  const tenants = {};
  for (const t of TENANTS) {
    const p = plan.tenants[t];
    tenants[t] = { jwtSecret: hex(32), db: { db_host: plan.network.postgresIp, db_port: '5432', db_name: p.database,
      db_user: p.dbUser, db_password: hex(32) } };
  }
  return { gcmKey: b64(24), gcmKeyBad: b64(24), legacyKey: b64(12), apiJwtSecret: hex(32), badJwtSecret: hex(32),
    metricsJwtSecret: hex(32), secretKeyBase: hex(64), ownerPassword: hex(32), metaPassword: hex(32), tenants };
}

/**
 * A PostgreSQL SCRAM-SHA-256 verifier (RFC 5802/7677, the server's stored form): the bootstrap
 * creates roles from it, so no plaintext password ever reaches a SQL statement or server log.
 */
export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const hmac = (k, m) => createHmac('sha256', k).update(m).digest();
  const stored = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored.toString('base64')}:${hmac(salted, 'Server Key').toString('base64')}`;
}
const SCRAM = /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/;

/** Bootstrap statements with {{name}} placeholders filled only by SCRAM verifiers or fixed identifiers. */
export function renderBootstrap(statements, values) {
  return statements.map(({ database, sql }) => ({
    database,
    sql: sql.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
      const v = values[key];
      if (typeof v !== 'string' || !(SCRAM.test(v) || SCHEMA_IDENT.test(v))) {
        throw new HarnessError('BAD_PLAN', `bootstrap value ${key}`);
      }
      return v;
    }),
  }));
}

export const fileSha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
