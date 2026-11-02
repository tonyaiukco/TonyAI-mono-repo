import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execute, validateInput } from '../scripts/hosted-lifecycle-operator.mjs';
function fixture() {
  const userId = randomUUID(), organisationId = randomUUID();
  const projectRef = 'a'.repeat(20);
  const input = { operation: 'lifecycle', step: 'inject-disable', operator: 'operator@example.test',
    target: { mode: 'hosted-l10-lifecycle', userId, organisationId, projectRef, sourceSha: 'b'.repeat(40),
      email: `lp2-l10-${userId}@tonyai.test`, name: `L10 synthetic acceptance ${organisationId}` },
    invitees: ['tr', 'en'].map(language => ({ id: randomUUID(), language, email: `${language}@example.test` })),
    url: `postgresql://postgres.${projectRef}:SYNTHETIC@aws-0-eu-north-1.pooler.supabase.com:5432/postgres?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt`, backendKey: 'SYNTHETIC' };
  const rows = [{ id: userId, email: input.target.email, fullName: 'L10 bootstrap', role: 'super_admin' },
    ...input.invitees.map(x => ({ ...x, role: x.language === 'tr' ? 'super_admin' : 'executive_viewer' }))]
    .map(x => ({ ...x, disabledAt: null, authSyncPendingSince: null, sessionsRevokedAt: null }));
  const org = { legalName: input.target.name, offboardedAt: null };
  let called = 0, disconnected = false;
  const db = { organisation: { findUnique: async () => org }, profile: { findMany: async () => rows,
    findUnique: async ({ where }) => rows.find(x => x.id === where.id) }, $disconnect: async () => { disconnected = true; } };
  const deps = { Client: class { constructor() { return db; } }, Audit: class {}, Access: class {}, Query: class {},
    AuthAdminError: class extends Error {}, Sync: class { constructor(auth) { this.auth = auth; } },
    Lifecycle: class {
      constructor(_db, _access, _delivery, sync) { this.sync = sync; }
      async disable(actor, id) {
        assert.equal(actor.id, userId); assert.equal(id, input.invitees[1].id);
        const row = rows.find(x => x.id === id); row.disabledAt = new Date(); row.sessionsRevokedAt = new Date(); row.authSyncPendingSince = new Date();
        await assert.rejects(this.sync.auth.setBanned(id, true), deps.AuthAdminError);
      }
    }, runCli: async options => {
      called++; assert.equal(options.organisationId, organisationId); assert.equal(options.operator, input.operator);
      assert.equal(options.allowRemote, true); assert.ok(['reconcile', 'offboard'].includes(options.command));
      const en = rows.find(x => x.language === 'en');
      if (options.command === 'reconcile') {
        if (options.apply) en.authSyncPendingSince = null;
        return { report: { applied: options.apply, authPending: options.apply ? [] : [en.id],
          authApplied: options.apply ? [en.id] : [], undeliveredInvitations: [] } };
      }
      const n = rows.filter(x => !x.disabledAt).length;
      if (options.apply) { org.offboardedAt = new Date(); rows.forEach(x => { x.disabledAt = new Date(); x.authSyncPendingSince = null; }); }
      return { report: { applied: options.apply, organisationId, disabled: n, invitationsRevoked: 0,
        offboardedAt: options.apply ? new Date().toISOString() : null, authPending: rows.filter(x => x.authSyncPendingSince).map(x => x.id) } };
    } };
  return { input, rows, org, deps, calls: () => called, disconnected: () => disconnected };
}

test('scoped injected failure, shipped reconcile dry/apply and retained retirement are separate steps', async () => {
  const f = fixture();
  const original = { DIRECT_URL: process.env.DIRECT_URL, SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  try {
    const injected = await execute(f.input, f.deps);
    assert.equal(injected.provider_calls, 0); assert.equal(injected.injected_failures, 1); assert.equal(f.calls(), 0);
    for (const step of ['reconcile-dry', 'reconcile-apply', 'offboard-dry', 'offboard-apply']) {
      f.input.step = step; const result = await execute(f.input, f.deps);
      assert.equal(result.step, step); assert.equal(result.retired, step === 'offboard-apply');
    }
    assert.equal(f.calls(), 4); assert.equal(f.disconnected(), true);
  } finally { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

for (const defect of ['foreign-member', 'foreign-org', 'wrong-role', 'already-disabled', 'already-pending']) {
  test(`no service/provider call on ${defect}`, async () => {
    const f = fixture();
    if (defect === 'foreign-member') f.rows.push({ ...f.rows[0], id: randomUUID() });
    if (defect === 'foreign-org') f.org.legalName = 'Customer company';
    if (defect === 'wrong-role') f.rows[0].role = 'consultant';
    if (defect === 'already-disabled') f.rows[1].disabledAt = new Date();
    if (defect === 'already-pending') f.rows[1].authSyncPendingSince = new Date();
    await assert.rejects(execute(f.input, f.deps)); assert.equal(f.calls(), 0); assert.equal(f.disconnected(), true);
  });
}

test('retirement accepts an exact bootstrap-only early failure, without role or recipient expansion', async () => {
  const f = fixture(); f.input.invitees = []; f.rows.splice(1); f.input.step = 'offboard-dry';
  const report = await execute(f.input, f.deps); assert.equal(report.retired, false); assert.equal(f.calls(), 1);
  f.input.step = 'inject-disable'; assert.throws(() => validateInput(f.input));
});

test('reconciliation refuses pending foreign member or a provider pending outcome', async () => {
  const f = fixture(); f.input.step = 'reconcile-apply';
  f.rows[1].disabledAt = new Date(); f.rows[1].authSyncPendingSince = new Date();
  await assert.rejects(execute(f.input, f.deps)); assert.equal(f.calls(), 0);
  f.rows[1].disabledAt = null; f.rows[1].authSyncPendingSince = null;
  f.rows[2].disabledAt = new Date(); f.rows[2].authSyncPendingSince = new Date();
  f.deps.runCli = async () => ({ report: { applied: true, authPending: [f.rows[2].id], authApplied: [], undeliveredInvitations: [] } });
  await assert.rejects(execute(f.input, f.deps));
});
