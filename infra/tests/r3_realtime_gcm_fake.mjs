/**
 * An in-memory model of the Realtime consumers the GCM harness drives, for CI-safe tests only.
 * It encrypts and decrypts with real AES-256-GCM in crypto.ex's `g1:` layout, so tamper and
 * wrong-key behaviour come from the cipher, not from a flag. `faults` turn on one defect each,
 * the way a broken server, adapter or fixture would behave; the harness must never PASS them.
 * Passing against this model is NOT consumer evidence. Its log entries are RECONSTRUCTED crash
 * shapes (Cowboy request crash for the socket and broadcast consumers, a Connect GenServer crash for
 * the DB fields) and are read by the real countLogFailures; the real shapes are a pending binding.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DB_FIELDS, GCM_FAILURE_TEXT, TENANTS, sha256 } from '../scripts/r3_realtime_gcm.mjs';
import { countLogFailures } from '../scripts/r3_realtime_clients.mjs';

export const manifest = () => JSON.parse(readFileSync(new URL('../selfhost/r3-realtime-gcm.fixture.json', import.meta.url), 'utf8'));

export function fakeSecrets(plan) {
  const hex = (n) => randomBytes(n).toString('hex');
  const tenants = {};
  for (const t of TENANTS) {
    tenants[t] = { jwtSecret: hex(32), db: { db_host: plan.network.postgresIp, db_port: '5432',
      db_name: plan.tenants[t].database, db_user: plan.tenants[t].dbUser, db_password: hex(32) } };
  }
  return { gcmKey: randomBytes(24).toString('base64'), gcmKeyBad: randomBytes(24).toString('base64'),
    legacyKey: randomBytes(12).toString('base64'), apiJwtSecret: hex(32), badJwtSecret: hex(32), tenants };
}

export function createFakeWorld({ plan, secrets, faults = {} }) {
  const meta = new Map();
  const logs = [];
  const sessions = new Set();
  const warm = new Map();
  const state = { key: null, running: false, starts: 0, lastNonce: null, liveSessions: 0, records: [], sealed: {}, jump: 0 };
  const ext = (t) => plan.tenants[t].externalId;
  const tenantOf = (externalId) => TENANTS.find((t) => ext(t) === externalId);

  const encrypt = (text) => {
    if (faults.plaintextStorage) return text;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', state.key, iv);
    const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return `g1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
  };
  const pending = [];
  const veryLate = [];
  const other = (id) => ext(TENANTS.find((t) => ext(t) !== id));
  const crash = (consumer, id) => (consumer === 'connect'
    // config.exs: "$time $metadata[$level] $message", metadata before the level; Connect.init sets
    // project/external_id. Plug.Cowboy's request crash carries no request metadata, only Server:.
    ? [`12:00:00.000 project=${id} external_id=${id} [error] GenServer {Realtime.Tenants.Connect, "${id}", %{conn: nil}} terminating`,
      `** (RuntimeError) ${GCM_FAILURE_TEXT}`, '    (realtime 2.134.10) lib/realtime/crypto.ex:104: Realtime.Crypto.decrypt_gcm!/1',
      'Last message: {:continue, :db_connect}']
    : [`12:00:00.000 [error] #PID<0.9.0> running RealtimeWeb.Endpoint (connection #PID<0.8.0>, stream id 1) terminated`,
      `Server: ${id}.${plan.hostSuffix}:4000 (http)`,
      ...(faults.untaggedCrash ? [] : [`Request: ${consumer === 'socket' ? 'GET /socket/websocket?apikey=<token>&vsn=2.0.0' : 'POST /api/broadcast'}`]),
      '** (exit) an exception was raised:', `    ** (RuntimeError) ${GCM_FAILURE_TEXT}`]);
  const decrypt = (value, externalId, consumer = 'connect') => {
    const raw = Buffer.from(value.slice(3), 'base64');
    const iv = raw.subarray(0, 12);
    try {
      const d = createDecipheriv('aes-256-gcm', state.key, iv);
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch (e) {
      if (faults.ignoreTag || (faults.ignoreTagUnderK && state.key.equals(Buffer.from(secrets.gcmKey)))) {
        // A server that skips the tag check: GCM's keystream is CTR from counter 2.
        const ctr = createDecipheriv('aes-256-ctr', state.key, Buffer.concat([iv, Buffer.from([0, 0, 0, 2])]));
        return Buffer.concat([ctr.update(raw.subarray(28)), ctr.final()]).toString('utf8');
      }
      const who = faults.foreignTenantLog && consumer === 'connect' ? other(externalId) : externalId;
      if (faults.dbFailureLoggedAsSocket && consumer === 'connect') { logs.push(...crash('socket', who)); throw e; }
      if (faults.broadcastNoDecrypt && consumer === 'broadcast') throw e;
      if (!faults.noLogs) logs.push(...crash(consumer, who));
      // A second, late entry of the same refusal arrives only once time passes — or, very late,
      // only after the broadcast leg began.
      if (faults.lateSocketLine && consumer === 'socket') pending.push(...crash(consumer, who));
      if (faults.veryLateSocketLine && consumer === 'socket') veryLate.push(...crash(consumer, who));
      throw e;
    }
  };
  const token = (secret, t) => `tok.${sha256(secret)}.${t}`;
  const tokenValid = (tok, secret) => typeof tok === 'string' && tok.startsWith(`tok.${sha256(secret)}.`);

  const refused = (httpStatus) => ({ status: 'refused', httpStatus, join: async () => ({ status: 'socket-error' }),
    close: async () => ({ violations: faults.sdkRetry ? ['SECOND_SOCKET_CONSTRUCTION'] : [], received: [],
      socketConstructions: 1, joinAttempts: 0 }) });

  const sockets = {
    async open({ hostname, token: tok }) {
      if (!state.running) return { ...refused(null), status: 'timeout' };
      const id = hostname.split('.')[0];
      const rec = meta.get(id);
      if (!rec) return faults.unknownTenantAccepted ? openSession(id) : refused(404);
      let secret;
      try { secret = decrypt(rec.jwt_secret, id, 'socket'); } catch { return refused(faults.socket401OnDecrypt ? 401 : 500); }
      if (!faults.badSignatureAccepted && !tokenValid(tok, secret)) return refused(401);
      return openSession(id);
    },
  };
  function openSession(id) {
    const s = { id, topic: null, inbox: [], subscribed: false };
    sessions.add(s);
    state.liveSessions += 1;
    return {
      status: 'open',
      httpStatus: 101,
      async join({ topic }) {
        const rec = meta.get(id);
        try {
          if (!(faults.warmCache && warm.has(id))) {
            for (const f of DB_FIELDS) decrypt(rec.settings[f], id);
            warm.set(id, true);
          }
        } catch {
          if (faults.unrelatedJoinRefusal) return { status: 'error', reason: 'TooManyJoins', postgresChangesReady: false };
          if (faults.joinTimeout) return { status: 'timeout' };
          const bound = 'UnableToConnectToProject: Realtime was unable to connect to the project database';
          const reason = faults.secretInReason ? `${bound} ${secrets.tenants.a.jwtSecret}` : bound;
          return { status: 'error', reason, postgresChangesReady: false };
        }
        s.topic = topic;
        s.subscribed = true;
        return { status: 'subscribed', postgresChangesReady: true };
      },
      async expectBroadcast({ nonce }) {
        const m = s.inbox.find((x) => x.kind === 'broadcast' && (faults.laxMatch || x.nonce === nonce));
        return { received: Boolean(m), nonce: m?.nonce ?? null };
      },
      async expectInsert({ id: rowId }) {
        const m = s.inbox.find((x) => x.kind === 'insert' && x.id === rowId);
        return { received: Boolean(m), id: m?.id ?? null, nonce: m?.nonce ?? null };
      },
      async close() {
        sessions.delete(s);
        state.liveSessions -= 1;
        return { violations: faults.sdkRetry ? ['SECOND_SOCKET_CONSTRUCTION'] : [], received: [...s.inbox],
          socketConstructions: 1, joinAttempts: s.topic ? 1 : 0 };
      },
    };
  }

  const api = {
    async getTenant(externalId) { return { status: meta.has(externalId) ? 200 : 404 }; },
    async createTenant({ tenant }) {
      if (meta.has(tenant.external_id)) return { status: 200 };
      const ext0 = tenant.extensions[0];
      const settings = { poll_interval_ms: 100, poll_max_changes: 100, poll_max_record_bytes: 1048576, ...ext0.settings };
      for (const f of DB_FIELDS) settings[f] = encrypt(settings[f]);
      meta.set(tenant.external_id, { jwt_secret: encrypt(tenant.jwt_secret), jwt_jwks: null, type: ext0.type, settings });
      return { status: 201 };
    },
    async updateJwt({ externalId, jwtSecret }) {
      const rec = meta.get(externalId);
      rec.jwt_secret = encrypt(jwtSecret);
      if (faults.adminUpdateRewritesDb) {
        const t = tenantOf(externalId);
        for (const f of DB_FIELDS) rec.settings[f] = encrypt(secrets.tenants[t].db[f]);
      }
      return { status: 200 };
    },
    async broadcast({ hostname, token: tok, topic, nonce }) {
      logs.push(...pending.splice(0), ...veryLate.splice(0));
      const id = hostname.split('.')[0];
      const rec = meta.get(id);
      if (!rec) return { status: 404 };
      let secret;
      try { secret = decrypt(rec.jwt_secret, id, 'broadcast'); } catch { return { status: faults.broadcast400 ? 400 : 500 }; }
      if (!tokenValid(tok, secret)) return { status: 401 };
      const delivered = faults.staleReplay && state.lastNonce ? state.lastNonce : nonce;
      state.lastNonce = nonce;
      if (!faults.broadcastNoDelivery) {
        for (const s of sessions) if (s.id === id && s.topic === topic) s.inbox.push({ kind: 'broadcast', nonce: delivered });
      }
      return { status: 202 };
    },
  };

  const metadata = {
    async readSix(externalId) {
      const rec = meta.get(externalId);
      if (faults.tenantPreexists && externalId === ext('a') && !rec) {
        return { tenantRows: 1, extensionRows: 1, extensionType: 'postgres_cdc_rls', jwtJwks: null, values: {}, otherSettings: {} };
      }
      if (!rec) return { tenantRows: 0, extensionRows: 0, extensionType: null, jwtJwks: null, values: {}, otherSettings: {} };
      const values = { jwt_secret: rec.jwt_secret };
      const otherSettings = {};
      for (const [k, v] of Object.entries(rec.settings)) (DB_FIELDS.includes(k) ? values : otherSettings)[k] = v;
      return { tenantRows: 1, extensionRows: 1, extensionType: rec.type, jwtJwks: rec.jwt_jwks, values, otherSettings };
    },
    async conditionalReplace({ externalId, field, expected, value }) {
      const rec = meta.get(externalId);
      const holder = field === 'jwt_secret' ? rec : rec.settings;
      if (holder[field] !== expected) return { rowCount: 0 };
      if (faults.rowCountTwo) return { rowCount: 2 };
      holder[field] = value;
      return { rowCount: 1 };
    },
  };

  const tenantDb = {
    async insert(t, { id, nonce }) {
      for (const s of sessions) if (s.id === ext(t) && s.subscribed) s.inbox.push({ kind: 'insert', id, nonce });
    },
    async observeConnections(t) {
      if (faults.noDbSession) return [];
      const db = secrets.tenants[t].db;
      return [{ usename: db.db_user, datname: db.db_name, application_name: 'realtime_connect' },
        { usename: 'other', datname: db.db_name, application_name: 'psql' }];
    },
    async ping() { return { ok: true }; },
  };

  let mark = 0;
  const lifecycle = {
    async start({ key }) {
      state.key = Buffer.from(key === 'K' ? secrets.gcmKey : secrets.gcmKeyBad);
      state.running = true;
      state.starts += 1;
      if (!faults.warmCache) warm.clear();
      if (faults.reconcilerRewrite && state.starts === 2) {
        const rec = meta.get(ext('a'));
        rec.jwt_secret = encrypt(decrypt(rec.jwt_secret, ext('a')));
      }
      const identity = faults.sameIdentity && state.starts > 1 ? 'rt-1' : `rt-${state.starts}`;
      return { identity, key, image: 'sha256:fake' };
    },
    async stop() {
      state.running = false;
      sessions.clear();
      return { gone: !(faults.stopNotGone && state.starts > 1), logsComplete: true, identity: faults.sameIdentity ? 'rt-1' : `rt-${state.starts}` };
    },
    async logMark() { mark = logs.length; return mark; },
    async logsSince(m) {
      const text = logs.slice(m).map((l) => `2026-10-25T12:00:00.000000000Z ${l}`).join('\n');
      return { ...countLogFailures(text, Object.fromEntries(TENANTS.map((t) => [t, ext(t)])), plan.hostSuffix), truncated: false };
    },
    async liveness() { return { status: 200 }; },
  };

  let i = 0;
  let now = Date.parse('2026-10-25T12:00:00Z');
  return {
    state,
    meta,
    logs,
    crash,
    adapters: {
      api, sockets, metadata, tenantDb, lifecycle,
      tokens: {
        tenant: async (t) => token(secrets.tenants[t].jwtSecret, t),
        badSignature: async (t) => token(secrets.badJwtSecret, t),
        admin: async () => token(secrets.apiJwtSecret, 'admin'),
      },
      ids: { nonce: () => (faults.reuseNonce ? 'f'.repeat(32) : sha256(`nonce-${(i += 1)}`).slice(0, 32)),
        rowId: () => `00000000-0000-4000-8000-${String((i += 1)).padStart(12, '0')}` },
      clock: { now: () => (now += faults.slowClock ? 60_000 : 1) + state.jump, sleep: async () => { logs.push(...pending.splice(0)); } },
      evidence: {
        append: async (r) => { state.records.push(r); },
        sealPrivate: async (name, obj) => { state.sealed[name] = obj; },
      },
    },
  };
}
