/** Exact synthetic-tenant custody around the shipped r004 services and operator CLI. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateTarget } from './hosted-lifecycle-bootstrap.mjs';
import { validateOwnerUrl } from './hosted-smoke-fixture.mjs';
const fail = () => new Error('Lifecycle operator stopped; private custody receipt requires review.');
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export function validateInput(input) {
  const target = validateTarget(input.target);
  if (input.operation !== 'lifecycle' || !['inject-disable', 'reconcile-dry', 'reconcile-apply', 'offboard-dry', 'offboard-apply'].includes(input.step)
      || !Array.isArray(input.invitees) || input.invitees.length > 2
      || (!input.step.startsWith('offboard') && input.invitees.length !== 2) || !input.invitees.every(x => uuid.test(x.id) && typeof x.email === 'string' && x.email.length <= 254)
      || new Set([target.userId, ...input.invitees.map(x => x.id)]).size !== input.invitees.length + 1
      || new Set([target.email, ...input.invitees.map(x => x.email.toLowerCase())]).size !== input.invitees.length + 1
      || !input.invitees.every(x => ['tr', 'en'].includes(x.language))
      || new Set(input.invitees.map(x => x.language)).size !== input.invitees.length
      || typeof input.operator !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.operator)) throw fail();
  validateOwnerUrl(input.url, target.projectRef);
  return target;
}
export async function execute(input, deps) {
  const target = validateInput(input);
  const db = new deps.Client({ datasourceUrl: input.url, log: [] });
  try {
    const org = await db.organisation.findUnique({ where: { id: target.organisationId } });
    const rows = await db.profile.findMany({ where: { organisationId: target.organisationId }, orderBy: { id: 'asc' } });
    const expected = [{ id: target.userId, email: target.email, role: 'super_admin' },
      ...input.invitees.map(x => ({ ...x, role: x.language === 'tr' ? 'super_admin' : 'executive_viewer' }))];
    if (!org || org.legalName !== target.name || org.offboardedAt !== null || rows.length !== expected.length
        || !expected.every(x => rows.some(r => r.id === x.id && r.email === x.email && (input.step.startsWith('offboard') || r.role === x.role)))) throw fail();
    const enId = input.invitees.find(x => x.language === 'en')?.id;
    const pending = rows.filter(r => r.authSyncPendingSince !== null).map(r => r.id);
    const disabled = rows.filter(r => r.disabledAt !== null).map(r => r.id);
    if (input.step === 'inject-disable') {
      if (pending.length || disabled.length) throw fail();
      const actorRow = rows.find(r => r.id === target.userId);
      const actor = { id: actorRow.id, email: actorRow.email, fullName: actorRow.fullName,
        role: actorRow.role, organisationId: target.organisationId, accessibleSubsidiaryIds: [] };
      const audit = new deps.Audit(db);
      let calls = 0;
      const auth = { async setBanned(id, banned) {
        calls++;
        if (id !== enId || banned !== true || calls !== 1) throw fail();
        throw new deps.AuthAdminError('auth_unavailable');
      } };
      // Real service commits the disable audit; only the provider boundary is injected.
      const lifecycle = new deps.Lifecycle(db, new deps.Access(db, audit), undefined,
        new deps.Sync(auth), new deps.Query(db), audit);
      await lifecycle.disable(actor, enId);
      const after = await db.profile.findUnique({ where: { id: enId } });
      if (calls !== 1 || !after?.disabledAt || !after.authSyncPendingSince || !after.sessionsRevokedAt) throw fail();
      return { status: 'LIFECYCLE_OBSERVED', step: input.step, provider_calls: 0, injected_failures: 1, pending: 1 };
    }
    if (input.step.startsWith('reconcile')) {
      if (pending.length !== 1 || pending[0] !== enId || disabled.length !== 1 || disabled[0] !== enId) throw fail();
    }
    // The shipped CLI's own remote/owner guards remain in force. Neither allowed command sends mail.
    process.env.DIRECT_URL = input.url;
    process.env.SUPABASE_URL = 'https://' + target.projectRef + '.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = input.backendKey;
    const apply = input.step.endsWith('-apply');
    const command = input.step.startsWith('reconcile') ? 'reconcile' : 'offboard';
    const result = await deps.runCli({ command, operator: input.operator,
      organisationId: target.organisationId, apply, allowRemote: true });
    const r = result.report;
    if (!r || r.applied !== apply || !Array.isArray(r.authPending)) throw fail();
    if (command === 'reconcile') {
      if (r.undeliveredInvitations.length || (apply ? r.authPending.length || r.authApplied.length !== 1 || r.authApplied[0] !== enId
        : r.authPending.length !== 1 || r.authPending[0] !== enId || r.authApplied.length)) throw fail();
    } else if (r.organisationId !== target.organisationId || r.disabled !== rows.length - disabled.length
        || (apply ? r.authPending.length || !r.offboardedAt : r.offboardedAt !== null || r.authPending.length !== pending.length)
        || !Number.isInteger(r.invitationsRevoked) || r.invitationsRevoked < 0 || r.invitationsRevoked > input.invitees.length) throw fail();
    if (apply) {
      const after = await db.profile.findMany({ where: { organisationId: target.organisationId } });
      if (after.length !== expected.length || after.some(r => r.authSyncPendingSince !== null)
          || (command === 'offboard' && after.some(r => !r.disabledAt))) throw fail();
    }
    return { status: 'LIFECYCLE_OBSERVED', step: input.step, pending: r.authPending.length,
      retired: command === 'offboard' && apply };
  } finally { await db.$disconnect(); }
}
async function main() {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  try {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 32768) throw fail(); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const require = createRequire('/app/apps/api/dist/onboarding/onboarding.cli.js');
    const { PrismaClient, Prisma } = require('@tonyai/db');
    if (process.versions.node.split('.')[0] !== '22' || Prisma.prismaVersion.client !== '6.19.3'
        || createHash('sha256').update(readFileSync('/app/infra/certs/prod-ca-2021.crt')).digest('hex') !== input.caSha256) throw fail();
    // Shipped service loggers may include provider diagnostics. Nothing raw leaves this child.
    process.stdout.write = () => true; process.stderr.write = () => true;
    const deps = { Client: PrismaClient,
      Audit: require('/app/apps/api/dist/audit/audit.service.js').AuditService,
      Access: require('/app/apps/api/dist/auth/access-admin.service.js').AccessAdminService,
      Sync: require('/app/apps/api/dist/users/auth-sync.service.js').AuthSyncService,
      Query: require('/app/apps/api/dist/users/users-query.service.js').UsersQueryService,
      Lifecycle: require('/app/apps/api/dist/users/user-lifecycle.service.js').UserLifecycleService,
      AuthAdminError: require('/app/apps/api/dist/users/auth-admin.service.js').AuthAdminError,
      runCli: require('/app/apps/api/dist/onboarding/onboarding.cli.js').run };
    const result = await execute(input, deps);
    out(JSON.stringify(result));
  } catch { out(JSON.stringify({ status: 'STOPPED', retry: false })); process.exitCode = 1; }
  finally { process.stdout.write = out; process.stderr.write = err; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
