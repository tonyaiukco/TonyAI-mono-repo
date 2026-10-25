/**
 * R3 Realtime GCM consumer qualification: the pure case machine.
 *
 * Proves, against one disposable fixture, that self-hosted Realtime (source
 * ef866244e88428bbd286f3e4ac88eb5e54a41bd4, v2.134.10) consumes the JWT secret and the five
 * DB fields it encrypted with AES-256-GCM: real API writes, the socket/broadcast/postgres_changes
 * consumers, cold-restart persistence, a global wrong-key case, a DB-only wrong-key case and ten
 * validly encoded tamper cases, each followed by a positive recovery.
 *
 * Nothing here performs I/O. Every effect goes through injected adapters (api, sockets, metadata,
 * tenantDb, lifecycle, evidence, tokens, ids, clock); r3_realtime_clients.mjs builds the real
 * ones. Every case either PASSes or stops the run: no automatic retry, no second attempt. A
 * passing run is consumer evidence for this fixture only — never R3 qualification by itself.
 */
import { createHash } from 'node:crypto';

export const SOURCE_COMMIT = 'ef866244e88428bbd286f3e4ac88eb5e54a41bd4';
export const SOURCE_VERSION = 'v2.134.10';
export const GCM_PREFIX = 'g1:';
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;
/** lib/realtime/crypto.ex decrypt_gcm!/1 raises exactly this on an authentication failure. */
export const GCM_FAILURE_TEXT = 'GCM decryption failed: ciphertext or authentication tag is invalid';
/** extensions.ex encrypts these (db_settings.ex marks them sensitive); region stays plaintext. */
export const DB_FIELDS = Object.freeze(['db_host', 'db_port', 'db_name', 'db_user', 'db_password']);
export const FIELDS = Object.freeze(['jwt_secret', ...DB_FIELDS]);
export const TENANTS = Object.freeze(['a', 'b']);
export const CAP_KINDS = Object.freeze(['processStarts', 'sockets', 'httpCalls', 'inserts', 'sqlOps',
  'logReads', 'liveness']);
export const LIMITATIONS = Object.freeze([
  'Consumer evidence for this disposable fixture only; R3 and CL-P2-3 stay OPEN.',
  'Needs an independent evidence review and a provenance disposition before it counts.',
  'The image source assertion is unsigned; source files are not proven to be the compiled modules.',
]);

/** One byte flipped in one region of one stored value: prefix, canonical Base64 and length kept. */
export const TAMPER_CASES = Object.freeze([
  ...FIELDS.map((field) => ({ field, region: 'tag' })),
  { field: 'jwt_secret', region: 'iv' },
  { field: 'jwt_secret', region: 'body' },
  { field: 'db_password', region: 'iv' },
  { field: 'db_password', region: 'body' },
].map((c) => Object.freeze({ ...c, id: `tamper-${c.region}-${c.field}`,
  consumer: c.field === 'jwt_secret' ? 'jwt' : 'db' })));

export const SCHEDULE = Object.freeze(['initial', 'restart-persistence', 'wrong-key-global',
  'wrong-key-db-only', ...TAMPER_CASES.map((c) => c.id)]);

export class HarnessError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Strictly parses one stored value as crypto.ex's GCM layout: `g1:` + canonical
 * Base64(12-byte IV || 16-byte tag || ciphertext), the ciphertext exactly as long as the UTF-8
 * plaintext (GCM does not pad). Anything else — bare Base64 (legacy ECB), plaintext, a
 * non-canonical or truncated encoding — is refused.
 */
export function parseGcm(value, plaintextBytes) {
  if (typeof value !== 'string' || !value.startsWith(GCM_PREFIX)) {
    throw new HarnessError('NOT_GCM', 'stored value lacks the g1: prefix');
  }
  const encoded = value.slice(GCM_PREFIX.length);
  if (!BASE64.test(encoded)) throw new HarnessError('NOT_GCM', 'stored value is not canonical Base64');
  const raw = Buffer.from(encoded, 'base64');
  if (raw.toString('base64') !== encoded) throw new HarnessError('NOT_GCM', 'stored value is not canonical Base64');
  if (!Number.isInteger(plaintextBytes) || plaintextBytes < 1) {
    throw new HarnessError('BAD_PLAN', 'plaintext length must be a positive integer');
  }
  if (raw.length !== IV_BYTES + TAG_BYTES + plaintextBytes) {
    throw new HarnessError('NOT_GCM', `decoded length ${raw.length} != ${IV_BYTES + TAG_BYTES + plaintextBytes}`);
  }
  return { iv: raw.subarray(0, IV_BYTES), tag: raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    body: raw.subarray(IV_BYTES + TAG_BYTES) };
}

/** Flips the low bit of the first byte of `region`; the result still parses as GCM layout. */
export function tamper(value, region, plaintextBytes) {
  parseGcm(value, plaintextBytes);
  const offset = { iv: 0, tag: IV_BYTES, body: IV_BYTES + TAG_BYTES }[region];
  if (offset === undefined) throw new HarnessError('BAD_PLAN', `unknown tamper region ${region}`);
  const raw = Buffer.from(value.slice(GCM_PREFIX.length), 'base64');
  raw[offset] ^= 0x01;
  const out = GCM_PREFIX + raw.toString('base64');
  parseGcm(out, plaintextBytes);
  if (out === value || out.length !== value.length) throw new HarnessError('BAD_TAMPER', 'tamper did not change one byte');
  return out;
}

/** The most log reads a complete run can take: every JWT negative's window 1 needs all its settle reads. */
export function worstCaseLogReads(settleReads) {
  const tamperJwt = TAMPER_CASES.filter((c) => c.consumer === 'jwt').length;
  const positives = 2 + 2 + 2 + 1 + TAMPER_CASES.length;
  return positives + (settleReads + 1) * (1 + tamperJwt) + (1 + TAMPER_CASES.length - tamperJwt);
}

/** Exact operation counts of a complete run; the caps must cover them before anything starts. */
export function plannedCounts() {
  const tamperJwt = TAMPER_CASES.filter((c) => c.consumer === 'jwt').length;
  const tamperDb = TAMPER_CASES.length - tamperJwt;
  // positive(t): 1 socket, 1 broadcast, 1 insert; sql = insert + connection observation.
  // The initial positive on tenant a adds 2 control sockets and 1 bad-signature broadcast.
  const positives = 2 + 2 + 2 + 1 + TAMPER_CASES.length;
  return {
    processStarts: 1 + 1 + 2 + 3 + 2 * TAMPER_CASES.length,
    sockets: positives + 2 + 1 + 1 + TAMPER_CASES.length,
    httpCalls: 2 + 2 + positives + 1 + 1 + 1 + tamperJwt,
    inserts: positives,
    // readSix: preflight 2, baseline 2, restart 2, global 4, db-only 4, tamper 2 each, final 2;
    // conditional writes: db-only 1, tamper 2 each; positives 2 each; negatives ping 1 each.
    sqlOps: 2 + 2 + 2 + 4 + 4 + 2 * TAMPER_CASES.length + 2 + 1 + 2 * TAMPER_CASES.length
      + 2 * positives + (1 + 1 + TAMPER_CASES.length),
    // positives read logs once; jwt negatives three times (window 1 until two reads agree, then
    // the broadcast window) when window 1 is already settled; db negatives once.
    logReads: positives + 3 * (1 + tamperJwt) + (1 + tamperDb),
    liveness: 1 + 1 + TAMPER_CASES.length,
  };
}

export class Budget {
  constructor(caps) {
    this.caps = {};
    this.used = {};
    for (const kind of CAP_KINDS) {
      if (!Number.isInteger(caps?.[kind]) || caps[kind] < 0) throw new HarnessError('BAD_PLAN', `cap ${kind} missing`);
      this.caps[kind] = caps[kind];
      this.used[kind] = 0;
    }
  }

  /** Refuses BEFORE the operation would exceed its cap, so the over-cap effect never happens. */
  take(kind, n = 1) {
    if (!(kind in this.caps)) throw new HarnessError('BAD_PLAN', `unknown cap ${kind}`);
    if (this.used[kind] + n > this.caps[kind]) throw new HarnessError('CAP_EXCEEDED', `${kind} cap ${this.caps[kind]}`);
    this.used[kind] += n;
  }
}

const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
const LABEL = /^[a-z][a-z0-9-]{2,30}[a-z0-9]$/;

/** Validates the fixture plan's identities and limits; returns a frozen copy. */
export function validatePlan(plan) {
  const fail = (m) => { throw new HarnessError('BAD_PLAN', m); };
  if (plan?.source?.commit !== SOURCE_COMMIT) fail('source commit differs from the reviewed one');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(plan.hostSuffix ?? '') || !plan.hostSuffix.endsWith('.invalid')) {
    fail('hostSuffix must be a reserved .invalid name');
  }
  const ids = new Set();
  for (const t of TENANTS) {
    const tenant = plan.tenants?.[t];
    if (!LABEL.test(tenant?.externalId ?? '')) fail(`tenant ${t} externalId must be one DNS label`);
    for (const key of ['publication', 'slotName', 'database', 'dbUser']) {
      if (!IDENT.test(tenant[key] ?? '')) fail(`tenant ${t} ${key} must be a fixed identifier`);
    }
    if (tenant.publication === 'supabase_realtime' || tenant.slotName === 'supabase_realtime_replication_slot') {
      fail('publication and slot must not be the upstream defaults');
    }
    for (const v of [tenant.externalId, tenant.publication, tenant.slotName, tenant.database, tenant.dbUser]) {
      if (ids.has(v)) fail(`identity ${v} reused`);
      ids.add(v);
    }
  }
  if (!LABEL.test(plan.unknownTenantId ?? '') || ids.has(plan.unknownTenantId)) fail('unknownTenantId must be a distinct label');
  if (!IDENT.test(plan.tenantTable?.schema ?? '') || !IDENT.test(plan.tenantTable?.table ?? '')) fail('tenantTable');
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(plan.topicPrefix ?? '')) fail('topicPrefix');
  if (!/^[a-z0-9-]{2,32}$/.test(plan.region ?? '')) fail('region');
  // Refusal shapes the source produces (user_socket.ex / auth_tenant.ex raise → 500; the join's
  // error reason). Bound from the retained source before execution; anything else is INCONCLUSIVE.
  const ex = plan.expected;
  const reasons = (list) => Array.isArray(list) && list.every((r) => typeof r === 'string' && r);
  if (!Number.isInteger(ex?.jwtSocketStatus) || !Number.isInteger(ex.jwtBroadcastStatus) || !reasons(ex.dbJoinReasons)
    || !reasons(ex.dbConnectPathReasons ?? [])) fail('expected refusal shapes');
  for (const key of ['outcomeMs', 'overallMs', 'settleMs']) {
    if (!Number.isInteger(plan.timeouts?.[key]) || plan.timeouts[key] <= 0) fail(`timeouts.${key}`);
  }
  if (!Number.isInteger(plan.limits?.settleReads) || plan.limits.settleReads < 2) fail('limits.settleReads');
  const planned = plannedCounts();
  const budget = new Budget(plan.caps);
  for (const kind of CAP_KINDS) {
    if (budget.caps[kind] < planned[kind]) fail(`cap ${kind}=${budget.caps[kind]} below planned ${planned[kind]}`);
  }
  if (budget.caps.logReads < worstCaseLogReads(plan.limits.settleReads)) fail('cap logReads below the settle worst case');
  return Object.freeze(structuredClone(plan));
}

/**
 * Validates the run's synthetic secrets. K and Kbad are exactly 32 raw bytes (runtime.exs
 * requires that and does not Base64-decode); all secrets are distinct from one another.
 */
export function validateSecrets(secrets) {
  const fail = (m) => { throw new HarnessError('BAD_SECRETS', m); };
  for (const key of ['gcmKey', 'gcmKeyBad']) {
    if (typeof secrets?.[key] !== 'string' || Buffer.byteLength(secrets[key]) !== KEY_BYTES) fail(`${key} must be 32 bytes`);
  }
  for (const key of ['badJwtSecret', 'apiJwtSecret']) {
    if (typeof secrets[key] !== 'string' || secrets[key].length < 32) fail(`${key} must be at least 32 characters`);
  }
  const all = [secrets.gcmKey, secrets.gcmKeyBad, secrets.badJwtSecret, secrets.apiJwtSecret];
  for (const t of TENANTS) {
    const s = secrets.tenants?.[t];
    if (typeof s?.jwtSecret !== 'string' || s.jwtSecret.length < 32) fail(`tenant ${t} jwtSecret`);
    for (const field of DB_FIELDS) {
      if (typeof s.db?.[field] !== 'string' || s.db[field].length < 1) fail(`tenant ${t} ${field}`);
    }
    if (!/^[0-9]{1,5}$/.test(s.db.db_port)) fail('db_port must be a decimal string');
    if (s.db.db_password.length < 32) fail(`tenant ${t} db_password`);
    all.push(s.jwtSecret, s.db.db_password);
  }
  if (new Set(all).size !== all.length) fail('secrets must be pairwise distinct');
  return secrets;
}

/** Non-secret DB settings: the fixture's own address, port, database and role names. */
const PUBLIC_DB_FIELDS = new Set(['db_host', 'db_port', 'db_name', 'db_user']);

/**
 * The forms of one secret that could leak into text: raw, a 16-character prefix (a cut-off
 * copy), lower/upper hex, URL-encoding, and Base64 at each of the three byte alignments (the
 * stable inner part, so a secret embedded in a longer encoded value is still found).
 */
export function secretForms(secret) {
  const raw = Buffer.from(secret);
  const forms = [secret, secret.toUpperCase(), secret.slice(0, 16), raw.toString('hex'), raw.toString('hex').toUpperCase(),
    encodeURIComponent(secret)];
  for (let k = 0; k < 3; k += 1) {
    const b64 = Buffer.concat([Buffer.alloc(k), raw]).toString('base64');
    forms.push(b64.slice(k ? 4 : 0, -4));
  }
  return forms.filter((f) => f.length >= 12);
}

/** Every secret string of the attempt (all of `secrets` except the public DB fields), in every form. */
export function secretStrings(secrets) {
  const out = [];
  const walk = (v, key) => {
    if (typeof v === 'string') { if (!PUBLIC_DB_FIELDS.has(key)) out.push(v); } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(secrets, '');
  return [...new Set(out.flatMap(secretForms))];
}

export function assertNoSecrets(text, secrets) {
  for (const s of secrets) {
    if (s && text.includes(s)) throw new HarnessError('SECRET_IN_EVIDENCE', 'a secret reached an evidence record');
  }
}

const short = (v) => (typeof v === 'string' ? v.slice(0, 200) : v ?? null);
class CaseResult extends Error {
  constructor(status, code, details = {}) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const fail = (code, details) => { throw new CaseResult('FAIL', code, details); };
const inconclusive = (code, details) => { throw new CaseResult('INCONCLUSIVE', code, details); };

class Run {
  constructor({ plan, secrets, adapters }) {
    this.plan = plan;
    this.secrets = secrets;
    this.a = adapters;
    this.budget = new Budget(plan.caps);
    this.secretList = secretStrings(secrets);
    this.seq = 0;
    this.identities = new Set();
    this.running = null;
    this.baseline = {};
    this.nonces = new Set();
    this.deadline = adapters.clock.now() + plan.timeouts.overallMs;
    // The API adapter mints admin tokens from this same tokens object; each one joins the guard.
    const admin = adapters.tokens.admin;
    if (typeof admin === 'function') {
      adapters.tokens.admin = async (...args) => {
        const tok = await admin.apply(adapters.tokens, args);
        this.secretList.push(...secretForms(String(tok)));
        return tok;
      };
    }
  }

  host(id) { return `${id}.${this.plan.hostSuffix}`; }
  tenant(t) { return this.plan.tenants[t]; }
  plaintext(t, field) {
    const s = this.secrets.tenants[t];
    return field === 'jwt_secret' ? s.jwtSecret : s.db[field];
  }
  bytes(t, field) { return Buffer.byteLength(this.plaintext(t, field)); }

  checkDeadline() {
    if (this.a.clock.now() > this.deadline) throw new HarnessError('OVERALL_DEADLINE', 'overall execution limit reached');
  }

  async record(caseId, step, data = {}) {
    const rec = { seq: ++this.seq, at: new Date(this.a.clock.now()).toISOString(), caseId, step, ...data };
    assertNoSecrets(JSON.stringify(rec), this.secretList);
    await this.a.evidence.append(rec);
  }

  /** Tokens are secrets too: every issued one joins the evidence guard before it is used. */
  async token(kind, t) {
    const tok = await this.a.tokens[kind](t);
    this.secretList.push(...secretForms(String(tok)));
    return tok;
  }

  nonce() {
    const n = this.a.ids.nonce();
    if (typeof n !== 'string' || n.length < 16 || this.nonces.has(n)) throw new HarnessError('NONCE_REUSED', 'nonce not fresh');
    this.nonces.add(n);
    return n;
  }

  async start(caseId, key) {
    this.checkDeadline();
    if (this.running) throw new HarnessError('LIFECYCLE', 'a Realtime process is already running');
    this.budget.take('processStarts');
    // Dirty from here: even a start whose result is refused below leaves a process to tear down.
    this.dirty = true;
    const started = await this.a.lifecycle.start({ caseId, key });
    if (typeof started?.identity !== 'string' || this.identities.has(started.identity)) {
      throw new HarnessError('PROCESS_NOT_REPLACED', 'start did not produce a new process identity');
    }
    if (started.key !== key) throw new HarnessError('LIFECYCLE', 'started with a different key than requested');
    this.identities.add(started.identity);
    this.running = started.identity;
    await this.record(caseId, 'start', { key, identity: started.identity, image: short(started.image) });
  }

  async stop(caseId) {
    if (!this.running) throw new HarnessError('LIFECYCLE', 'no Realtime process to stop');
    const stopped = await this.a.lifecycle.stop({ caseId });
    if (stopped?.gone !== true || stopped.identity !== this.running) {
      throw new HarnessError('PROCESS_NOT_GONE', 'the stopped process is not proven gone');
    }
    if (stopped.logsComplete !== true) throw new HarnessError('LOG_CAPTURE', 'server log capture incomplete');
    await this.record(caseId, 'stop', { identity: this.running });
    this.running = null;
    this.dirty = false;
  }

  async readSix(caseId, t) {
    this.budget.take('sqlOps');
    const s = await this.a.metadata.readSix(this.tenant(t).externalId);
    if (s?.tenantRows !== 1 || s.extensionRows !== 1 || s.extensionType !== 'postgres_cdc_rls') {
      throw new HarnessError('METADATA_SHAPE', `tenant ${t} must have exactly one tenant and one postgres_cdc_rls row`);
    }
    if (s.jwtJwks !== null) throw new HarnessError('METADATA_SHAPE', 'jwt_jwks must stay absent');
    for (const field of FIELDS) {
      if (typeof s.values?.[field] !== 'string') throw new HarnessError('METADATA_SHAPE', `${field} missing`);
    }
    const other = s.otherSettings ?? {};
    if (other.publication !== this.tenant(t).publication || other.slot_name !== this.tenant(t).slotName) {
      throw new HarnessError('METADATA_SHAPE', 'publication/slot differ from the plan');
    }
    return { values: { ...s.values }, otherHash: sha256(JSON.stringify(Object.keys(other).sort().map((k) => [k, other[k]]))) };
  }

  fingerprints(values) { return Object.fromEntries(FIELDS.map((f) => [f, sha256(values[f])])); }

  /** Requires the stored six values to be exactly the baseline, apart from declared overrides. */
  async expectStored(caseId, t, overrides = {}) {
    const s = await this.readSix(caseId, t);
    for (const field of FIELDS) {
      const expected = overrides[field] ?? this.baseline[t].values[field];
      if (s.values[field] !== expected) throw new HarnessError('UNPLANNED_REWRITE', `tenant ${t} ${field} changed`);
    }
    if (s.otherHash !== this.baseline[t].otherHash) throw new HarnessError('UNPLANNED_REWRITE', `tenant ${t} settings changed`);
    await this.record(caseId, 'stored', { tenant: t, fingerprints: this.fingerprints(s.values) });
    return s;
  }

  /** One exact-row, one-field conditional write; the re-read must show only that change. */
  async replaceOne(caseId, t, field, expected, value, overridesAfter) {
    this.budget.take('sqlOps');
    const r = await this.a.metadata.conditionalReplace({ externalId: this.tenant(t).externalId, field, expected, value });
    if (r?.rowCount !== 1) throw new HarnessError('ROW_COUNT', `conditional write on ${field} affected ${r?.rowCount}`);
    await this.record(caseId, 'replace', { tenant: t, field, from: sha256(expected), to: sha256(value) });
    await this.expectStored(caseId, t, overridesAfter);
  }

  async logs(mark) {
    this.budget.take('logReads');
    const l = await this.a.lifecycle.logsSince(mark);
    if (!Number.isInteger(l?.gcmFailures) || l.truncated || !l.byTenant) throw new HarnessError('LOG_CAPTURE', 'log capture incomplete');
    return l;
  }

  /**
   * Reads one window until two reads, settleMs apart, agree — so a late line of the socket leg
   * cannot land in the broadcast leg's window. Bounded by limits.settleReads; never settled is
   * INCONCLUSIVE.
   */
  async settled(mark) {
    let prev = await this.logs(mark);
    for (let i = 1; i < this.plan.limits.settleReads; i += 1) {
      await this.a.clock.sleep(this.plan.timeouts.settleMs);
      const next = await this.logs(mark);
      if (next.gcmFailures === prev.gcmFailures && JSON.stringify(next.byTenant) === JSON.stringify(prev.byTenant)) return next;
      prev = next;
    }
    inconclusive('LOG_WINDOW_NOT_SETTLED', { gcmFailures: prev.gcmFailures });
    return prev;
  }

  /**
   * A refusal counts only with a decrypt failure attributed exactly to the target tenant in its
   * own window, and none attributed to the other fixture tenant. An entry tagged with another
   * consumer (a crash report's `Request:` line naming the socket or the broadcast route) never
   * counts for this leg: a late socket entry cannot satisfy the broadcast leg, and neither can a
   * JWT-consumer failure satisfy the DB leg. Untagged entries count for any leg.
   */
  attributed(l, t, leg) {
    const other = TENANTS.find((x) => x !== t);
    if ((l.byTenant[other] ?? 0) !== 0) return false;
    const c = l.byConsumer?.[t];
    if (!c) return (l.byTenant[t] ?? 0) >= 1;
    return (c.untagged ?? 0) + (leg === 'db' ? 0 : c[leg] ?? 0) >= 1;
  }

  async liveness(caseId, t) {
    this.budget.take('liveness');
    const live = await this.a.lifecycle.liveness();
    this.budget.take('sqlOps');
    const ping = await this.a.tenantDb.ping(t);
    if (live?.status !== 200 || ping?.ok !== true) throw new HarnessError('CONTROL_DOWN', 'control plane or fixture DB not live');
    await this.record(caseId, 'liveness', { tenant: t });
  }

  async openSocket(caseId, t, hostId, token) {
    this.checkDeadline();
    this.budget.take('sockets');
    return this.a.sockets.open({ caseId, tenant: t, hostname: this.host(hostId), token,
      timeoutMs: this.plan.timeouts.outcomeMs });
  }

  /** Closes a session and refuses evidence from SDK retries, stale or foreign messages. */
  async closeSession(caseId, session, issued) {
    const closed = await session.close();
    if (!Array.isArray(closed?.violations) || closed.violations.length) {
      fail('CLIENT_VIOLATION', { violations: (closed?.violations ?? ['unknown']).map(short) });
    }
    for (const m of closed.received ?? []) {
      if (!issued.has(m.nonce)) fail('STALE_OR_FOREIGN_MESSAGE', { kind: short(m.kind) });
    }
    if (closed.socketConstructions > 1 || closed.joinAttempts > 1) fail('SDK_RETRY', {});
    return closed;
  }

  async broadcast(t, hostId, token, topic, nonce) {
    this.checkDeadline();
    this.budget.take('httpCalls');
    return this.a.api.broadcast({ hostname: this.host(hostId), token, topic, nonce, timeoutMs: this.plan.timeouts.outcomeMs });
  }

  async positive(caseId, t, { controls = false } = {}) {
    const { externalId } = this.tenant(t);
    const token = await this.token('tenant', t);
    const mark = await this.a.lifecycle.logMark();
    const s = await this.openSocket(caseId, t, externalId, token);
    if (s.status !== 'open') {
      await this.closeSession(caseId, s, new Set());
      if (s.status === 'refused') fail('POSITIVE_SOCKET_REFUSED', { tenant: t, httpStatus: s.httpStatus ?? null });
      inconclusive('POSITIVE_SOCKET_OUTCOME_UNKNOWN', { tenant: t, status: short(s.status) });
    }
    const issued = new Set();
    let ok = false;
    let closedEarly = false;
    try {
      const topic = `${this.plan.topicPrefix}-${caseId}-${this.nonce()}`;
      const j = await s.join({ topic, schema: this.plan.tenantTable.schema, table: this.plan.tenantTable.table,
        timeoutMs: this.plan.timeouts.outcomeMs });
      // A refused join after a cold start can be transient (Connect still initialising): stop, unattributed.
      if (j.status === 'error') {
        // Close first, so no SDK rejoin happens while the logs are read. A refusal whose window holds
        // this tenant's attributed, untagged (Connect) decrypt failure is a real defect — K no longer
        // opens the stored DB fields — whichever connect-path reason answered; anything else may be
        // transient.
        closedEarly = true;
        await this.closeSession(caseId, s, issued);
        const l = await this.logs(mark);
        if (l.gcmFailures >= 1 && this.attributed(l, t, 'db')) fail('POSITIVE_DB_DECRYPT_FAILED', { tenant: t, reason: short(j.reason) });
        inconclusive('POSITIVE_JOIN_REFUSED', { tenant: t, reason: short(j.reason) });
      }
      if (j.status !== 'subscribed') inconclusive('POSITIVE_JOIN_OUTCOME_UNKNOWN', { tenant: t, status: short(j.status) });
      if (j.postgresChangesReady !== true) inconclusive('POSTGRES_CHANGES_NOT_READY', { tenant: t });
      if (controls) await this.controls(caseId, t, topic);
      const n1 = this.nonce();
      issued.add(n1);
      const b = await this.broadcast(t, externalId, token, topic, n1);
      if (!Number.isInteger(b.status)) inconclusive('POSITIVE_BROADCAST_OUTCOME_UNKNOWN', { tenant: t, status: short(b.status) });
      if (b.status !== 202) fail('POSITIVE_BROADCAST_REFUSED', { tenant: t, httpStatus: b.status });
      const m = await s.expectBroadcast({ nonce: n1, timeoutMs: this.plan.timeouts.outcomeMs });
      if (!m.received) inconclusive('BROADCAST_NOT_DELIVERED', { tenant: t });
      if (m.nonce !== n1) fail('STALE_OR_FOREIGN_MESSAGE', { tenant: t });
      const n2 = this.nonce();
      issued.add(n2);
      const rowId = this.a.ids.rowId();
      this.budget.take('inserts');
      this.budget.take('sqlOps');
      await this.a.tenantDb.insert(t, { id: rowId, caseId, nonce: n2 });
      const c = await s.expectInsert({ id: rowId, nonce: n2, timeoutMs: this.plan.timeouts.outcomeMs });
      if (!c.received) inconclusive('INSERT_NOT_DELIVERED', { tenant: t });
      if (c.id !== rowId || c.nonce !== n2) fail('STALE_OR_FOREIGN_MESSAGE', { tenant: t });
      this.budget.take('sqlOps');
      const sessions = await this.a.tenantDb.observeConnections(t);
      const db = this.secrets.tenants[t].db;
      const own = (sessions ?? []).filter((x) => x.usename === db.db_user && x.datname === db.db_name);
      if (!own.length) fail('NO_TENANT_DB_SESSION', { tenant: t });
      ok = true;
      await this.record(caseId, 'positive', { tenant: t, topicHash: sha256(topic), applicationNames:
        [...new Set(own.map((x) => short(x.application_name)))].sort() });
    } finally {
      const closed = closedEarly ? null : await this.closeSession(caseId, s, issued).catch((e) => { if (ok) throw e; return null; });
      if (ok && closed) {
        const l = await this.logs(mark);
        if (l.gcmFailures !== 0) fail('UNEXPECTED_DECRYPT_FAILURE', { tenant: t, gcmFailures: l.gcmFailures });
      }
    }
  }

  /** Negative controls on the live positive session: a bad signature and an unknown tenant. */
  async controls(caseId, t, topic) {
    const { externalId } = this.tenant(t);
    const bad = await this.token('badSignature', t);
    // Only an observed outcome is a FAIL; a timeout or a close without a status stops unattributed.
    const observed = (status) => status === 'open' || status === 'refused';
    const s1 = await this.openSocket(caseId, t, externalId, bad);
    await this.closeSession(caseId, s1, new Set());
    if (!observed(s1.status)) inconclusive('CONTROL_OUTCOME_UNKNOWN', { control: 'bad-signature', status: short(s1.status) });
    if (s1.status !== 'refused' || s1.httpStatus !== 401) fail('BAD_SIGNATURE_ACCEPTED', { httpStatus: s1.httpStatus ?? null });
    const s2 = await this.openSocket(caseId, t, this.plan.unknownTenantId, await this.token('tenant', t));
    await this.closeSession(caseId, s2, new Set());
    if (!observed(s2.status)) inconclusive('CONTROL_OUTCOME_UNKNOWN', { control: 'unknown-tenant', status: short(s2.status) });
    if (s2.status !== 'refused' || s2.httpStatus !== 404) fail('UNKNOWN_TENANT_ACCEPTED', { httpStatus: s2.httpStatus ?? null });
    const b = await this.broadcast(t, externalId, bad, topic, this.nonce());
    if (!Number.isInteger(b.status)) inconclusive('CONTROL_OUTCOME_UNKNOWN', { control: 'bad-broadcast', status: short(b.status) });
    if (b.status !== 401) fail('BAD_SIGNATURE_BROADCAST_ACCEPTED', { httpStatus: b.status });
    await this.record(caseId, 'controls', { tenant: t, badSignature: 401, unknownTenant: 404, badBroadcast: 401 });
  }

  /** The tenant's JWT consumers (socket connect, AuthTenant) must refuse with a GCM failure. */
  async negativeJwt(caseId, t) {
    const { externalId } = this.tenant(t);
    const token = await this.token('tenant', t);
    const mark1 = await this.a.lifecycle.logMark();
    const s = await this.openSocket(caseId, t, externalId, token);
    const closed = await this.closeSession(caseId, s, new Set());
    if (s.status === 'open') fail('JWT_CONSUMED_DESPITE_FAULT', { tenant: t });
    if (s.status !== 'refused') inconclusive('SOCKET_OUTCOME_UNKNOWN', { tenant: t, status: short(s.status) });
    if (s.httpStatus !== this.plan.expected.jwtSocketStatus) inconclusive('UNEXPECTED_REFUSAL_STATUS', { leg: 'socket', httpStatus: s.httpStatus ?? null });
    const l1 = await this.settled(mark1);
    const mark2 = await this.a.lifecycle.logMark();
    const b = await this.broadcast(t, externalId, token, `${this.plan.topicPrefix}-${caseId}-neg`, this.nonce());
    if (Number.isInteger(b.status) && b.status >= 200 && b.status < 300) fail('BROADCAST_AUTHORISED_DESPITE_FAULT', { tenant: t });
    if (!Number.isInteger(b.status)) inconclusive('BROADCAST_OUTCOME_UNKNOWN', { tenant: t });
    if (b.status !== this.plan.expected.jwtBroadcastStatus) inconclusive('UNEXPECTED_REFUSAL_STATUS', { leg: 'broadcast', httpStatus: b.status });
    const l2 = await this.logs(mark2);
    if (!this.attributed(l1, t, 'socket') || !this.attributed(l2, t, 'broadcast')) {
      inconclusive('NO_ATTRIBUTABLE_DECRYPT_FAILURE', { socket: l1.byTenant, broadcast: l2.byTenant });
    }
    await this.liveness(caseId, t);
    await this.record(caseId, 'negative-jwt', { tenant: t, socketStatus: s.httpStatus ?? null, broadcastStatus: b.status,
      gcmFailures: [l1.gcmFailures, l2.gcmFailures], tenantAttributed: [l1.byTenant[t], l2.byTenant[t]],
      unattributed: [l1.unattributed ?? 0, l2.unattributed ?? 0],
      socketConstructions: closed.socketConstructions });
  }

  /** Authentication must SUCCEED, then the DB consumer (channel join) must refuse with a GCM failure. */
  async negativeDb(caseId, t) {
    const { externalId } = this.tenant(t);
    const mark = await this.a.lifecycle.logMark();
    const s = await this.openSocket(caseId, t, externalId, await this.token('tenant', t));
    if (s.status !== 'open') {
      await this.closeSession(caseId, s, new Set());
      if (s.status === 'refused') fail('DB_CASE_AUTH_FAILED', { tenant: t, httpStatus: s.httpStatus ?? null });
      inconclusive('DB_CASE_SOCKET_OUTCOME_UNKNOWN', { tenant: t, status: short(s.status) });
    }
    let j;
    try {
      j = await s.join({ topic: `${this.plan.topicPrefix}-${caseId}-${this.nonce()}`, schema: this.plan.tenantTable.schema,
        table: this.plan.tenantTable.table, timeoutMs: this.plan.timeouts.outcomeMs });
    } finally {
      await this.closeSession(caseId, s, new Set());
    }
    if (j.status === 'subscribed') fail('DB_CONSUMED_DESPITE_FAULT', { tenant: t });
    if (j.status !== 'error') inconclusive('JOIN_OUTCOME_UNKNOWN', { tenant: t, status: short(j.status) });
    // The bound reason, or a connect-path reply to the same Connect crash; either needs the attributed
    // untagged crash entry below.
    const accepted = [...this.plan.expected.dbJoinReasons, ...this.plan.expected.dbConnectPathReasons ?? []];
    if (!accepted.includes(j.reason)) inconclusive('UNEXPECTED_JOIN_REASON', { tenant: t, reason: short(j.reason) });
    const l = await this.logs(mark);
    if (!this.attributed(l, t, 'db')) inconclusive('NO_ATTRIBUTABLE_DECRYPT_FAILURE', { byTenant: l.byTenant });
    await this.liveness(caseId, t);
    await this.record(caseId, 'negative-db', { tenant: t, joinReason: short(j.reason), gcmFailures: l.gcmFailures,
      tenantAttributed: l.byTenant[t], unattributed: l.unattributed ?? 0 });
  }

  async createTenant(caseId, t) {
    this.checkDeadline();
    this.budget.take('httpCalls');
    const tenant = this.tenant(t);
    const s = this.secrets.tenants[t];
    const r = await this.a.api.createTenant({
      tenant: {
        external_id: tenant.externalId,
        jwt_secret: s.jwtSecret,
        postgres_cdc_default: 'postgres_cdc_rls',
        // ssl_enforced=false: the disposable fixture DB has no TLS, and database.ex defaults to on.
        extensions: [{ type: 'postgres_cdc_rls', settings: { region: this.plan.region, ...s.db,
          publication: tenant.publication, slot_name: tenant.slotName, ssl_enforced: false } }],
      },
    });
    // 201 only: the route is an upsert, and 200 would mean the tenant already existed.
    if (r?.status !== 201) throw new HarnessError('CREATE_NOT_FRESH', `create returned ${r?.status}`);
    await this.record(caseId, 'create', { tenant: t, status: 201 });
  }

  async snapshotBaseline(caseId, t) {
    const s = await this.readSix(caseId, t);
    for (const field of FIELDS) {
      const value = s.values[field];
      const plain = this.plaintext(t, field);
      // A short plaintext (db_port) can occur inside Base64 by chance; only long ones are searched.
      if (value === plain || (plain.length >= 12 && value.includes(plain))) {
        throw new HarnessError('PLAINTEXT_STORED', `${field} stored in plaintext`);
      }
      parseGcm(value, this.bytes(t, field));
    }
    if (new Set(FIELDS.map((f) => parseGcm(s.values[f], this.bytes(t, f)).iv.toString('hex'))).size !== FIELDS.length) {
      throw new HarnessError('IV_REUSED', `tenant ${t} reuses a GCM nonce`);
    }
    this.baseline[t] = s;
    await this.a.evidence.sealPrivate(`baseline-${t}`, { values: s.values });
    await this.record(caseId, 'baseline', { tenant: t, fingerprints: this.fingerprints(s.values) });
  }

  // ---- cases -------------------------------------------------------------------------------

  async initial(id) {
    await this.start(id, 'K');
    for (const t of TENANTS) {
      this.budget.take('sqlOps');
      const absent = await this.a.metadata.readSix(this.tenant(t).externalId);
      if (absent?.tenantRows !== 0 || absent.extensionRows !== 0) throw new HarnessError('TENANT_PRESENT', `tenant ${t} exists before create`);
      this.budget.take('httpCalls');
      const g = await this.a.api.getTenant(this.tenant(t).externalId);
      if (g?.status !== 404) throw new HarnessError('TENANT_PRESENT', `admin API shows tenant ${t}`);
    }
    for (const t of TENANTS) await this.createTenant(id, t);
    for (const t of TENANTS) await this.snapshotBaseline(id, t);
    await this.positive(id, 'a', { controls: true });
    await this.positive(id, 'b');
  }

  async ['restart-persistence'](id) {
    await this.stop(id);
    await this.start(id, 'K');
    for (const t of TENANTS) await this.expectStored(id, t);
    for (const t of TENANTS) await this.positive(id, t);
  }

  async ['wrong-key-global'](id) {
    await this.stop(id);
    await this.start(id, 'Kbad');
    for (const t of TENANTS) await this.expectStored(id, t);
    await this.negativeJwt(id, 'a');
    await this.stop(id);
    await this.start(id, 'K');
    for (const t of TENANTS) await this.expectStored(id, t);
    for (const t of TENANTS) await this.positive(id, t);
  }

  async ['wrong-key-db-only'](id) {
    const t = 'b';
    await this.stop(id);
    await this.start(id, 'Kbad');
    this.budget.take('httpCalls');
    const u = await this.a.api.updateJwt({ externalId: this.tenant(t).externalId, jwtSecret: this.secrets.tenants[t].jwtSecret });
    if (u?.status !== 200) fail('ADMIN_UPDATE_REFUSED', { httpStatus: u?.status ?? null });
    const after = await this.readSix(id, t);
    const kbadJwt = after.values.jwt_secret;
    if (kbadJwt === this.baseline[t].values.jwt_secret) fail('JWT_NOT_REWRITTEN', {});
    parseGcm(kbadJwt, this.bytes(t, 'jwt_secret'));
    for (const field of DB_FIELDS) {
      if (after.values[field] !== this.baseline[t].values[field]) throw new HarnessError('JWT_UPDATE_TOUCHED_DB', `${field} changed by the JWT update`);
    }
    if (after.otherHash !== this.baseline[t].otherHash) throw new HarnessError('JWT_UPDATE_TOUCHED_DB', 'settings changed by the JWT update');
    await this.record(id, 'jwt-under-kbad', { tenant: t, jwt: sha256(kbadJwt) });
    await this.expectStored(id, 'a');
    await this.stop(id);
    await this.start(id, 'Kbad');
    await this.expectStored(id, t, { jwt_secret: kbadJwt });
    await this.negativeDb(id, t);
    await this.stop(id);
    await this.replaceOne(id, t, 'jwt_secret', kbadJwt, this.baseline[t].values.jwt_secret, {});
    await this.start(id, 'K');
    await this.positive(id, t);
  }

  async tamperCase(c) {
    const t = 'a';
    const original = this.baseline[t].values[c.field];
    const changed = tamper(original, c.region, this.bytes(t, c.field));
    await this.stop(c.id);
    await this.replaceOne(c.id, t, c.field, original, changed, { [c.field]: changed });
    await this.start(c.id, 'K');
    if (c.consumer === 'jwt') await this.negativeJwt(c.id, t);
    else await this.negativeDb(c.id, t);
    await this.stop(c.id);
    await this.replaceOne(c.id, t, c.field, changed, original, {});
    await this.start(c.id, 'K');
    await this.positive(c.id, t);
  }
}

/**
 * Runs the whole schedule once. Returns the verdict; never throws for a case outcome. The
 * Realtime process is stopped on every exit path; the database and evidence are left for the
 * runner's exact teardown after custody.
 */
export async function runQualification({ plan, secrets, adapters }) {
  const checkedPlan = validatePlan(plan);
  validateSecrets(secrets);
  const run = new Run({ plan: checkedPlan, secrets, adapters });
  const cases = [];
  let verdict = 'CONSUMER_CASES_PASSED';
  let stopReason = null;
  let current = null;
  try {
    for (const id of SCHEDULE) {
      current = id;
      const tamperCase = TAMPER_CASES.find((c) => c.id === id);
      await run.record(id, 'case-start');
      try {
        if (tamperCase) await run.tamperCase(tamperCase);
        else await run[id](id);
        cases.push({ id, status: 'PASS' });
        await run.record(id, 'case-pass');
      } catch (e) {
        if (!(e instanceof CaseResult)) throw e;
        cases.push({ id, status: e.status, code: e.code });
        await run.record(id, 'case-stop', { status: e.status, code: e.code, details: e.details });
        verdict = e.status === 'FAIL' ? 'FAIL' : 'INCONCLUSIVE';
        stopReason = e.code;
        break;
      }
    }
    if (verdict === 'CONSUMER_CASES_PASSED') {
      current = 'final';
      await run.stop('final');
      for (const t of TENANTS) await run.expectStored('final', t);
      const late = adapters.sockets.finalCheck?.();
      if (late?.violations?.length) {
        verdict = 'FAIL';
        stopReason = 'LATE_CLIENT_ACTIVITY';
        await run.record('final', 'late-client-activity', { violations: late.violations.map(short) });
      }
    }
  } catch (e) {
    verdict = 'ABORTED';
    stopReason = e instanceof HarnessError ? e.code : 'UNEXPECTED_ERROR';
    cases.push({ id: 'abort', status: 'ABORTED', code: stopReason, in: current });
    try { await run.record('abort', 'abort', { code: stopReason }); } catch { /* evidence already unusable */ }
  } finally {
    if (run.running) {
      try { await run.stop('teardown'); } catch { verdict = verdict === 'CONSUMER_CASES_PASSED' ? 'ABORTED' : verdict; }
    }
    if (run.dirty) {
      // An unproven process (refused start, failed stop proof): stop it without trusting its identity.
      try { await adapters.lifecycle.stop({ caseId: 'teardown' }); } catch { /* the runner's exact teardown follows */ }
      if (verdict === 'CONSUMER_CASES_PASSED') verdict = 'ABORTED';
    }
  }
  return {
    verdict,
    stopReason,
    stoppedIn: verdict === 'CONSUMER_CASES_PASSED' ? null : current,
    cases,
    used: { ...run.budget.used },
    planned: plannedCounts(),
    processIdentities: run.identities.size,
    qualification: 'NOT_QUALIFIED_PENDING_INDEPENDENT_REVIEW',
    limitations: LIMITATIONS,
  };
}
