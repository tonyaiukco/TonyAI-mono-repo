import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { InvitationStatus, UserRole } from '@tonyai/db';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { AccessAdminService, lockTenantAdmin } from '../../src/auth/access-admin.service';
import type { RequestUser } from '../../src/auth/auth.types';
import { MailService, type MailConfig, type MailTransport } from '../../src/mail/mail.service';
import { OnboardingOperator, OperatorRefusal } from '../../src/onboarding/onboarding-operator';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { AuthAdminError, AuthAdminService } from '../../src/users/auth-admin.service';
import { AuthSyncService } from '../../src/users/auth-sync.service';
import { InvitationDeliveryService } from '../../src/users/invitation-delivery.service';
import { PasswordResetService } from '../../src/users/password-reset.service';
import { UserLifecycleService } from '../../src/users/user-lifecycle.service';
import { UsersQueryService } from '../../src/users/users-query.service';
import { connect, connectOwner, createTenant, deferred, holdBefore, TENANT_ORG_PREFIX, type Tenant } from './db';
import { failingAuditClient, INJECTED_AUDIT_FAILURE } from './services';

/**
 * LP4-01 PR B — onboarding and the user lifecycle, against the real database
 * on the RUNTIME role (what the API uses: a missing grant fails here as it
 * would in production — PR A's lesson) and the local stack's real Supabase
 * Auth (GoTrue). Email goes to an in-memory transport: CI runs no mailpit,
 * and the live run (mailpit, browser) is the PR's separate evidence.
 */

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  throw new Error(
    'The onboarding tests need the local Supabase Auth: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (`set -a; source apps/api/.env; set +a`). CI exports both.',
  );
}
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('refusing a non-local SUPABASE_URL');
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }).auth.admin;
/** A browser's client: anon key when exported, else the service key (verifyOtp is a public endpoint). */
const browser = () =>
  createClient(url, process.env.SUPABASE_ANON_KEY ?? serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const MAIL: MailConfig = { host: '127.0.0.1', port: 2525, secure: false, from: 'TonyAI <int@tonyai.test>', appUrl: 'http://localhost:3000' };
type Sent = { to: string; subject: string; text: string; html: string };
function inbox() {
  const sent: Sent[] = [];
  const transport: MailTransport = { sendMail: vi.fn(async (m: Sent) => { sent.push(m); return {} as never; }) as never };
  return { sent, transport };
}
const failingTransport: MailTransport = { sendMail: vi.fn(async () => { throw Object.assign(new Error('boom'), { responseCode: 554 }); }) as never };
const tokenIn = (mail: Sent, type: 'invite' | 'recovery'): string => {
  const link = /http:\/\/localhost:3000\/auth\/confirm\?token_hash=([A-Za-z0-9_-]+)&type=(\w+)/.exec(mail.text);
  expect(link?.[2]).toBe(type);
  return link![1];
};

let runtime: PrismaService;
let owner: PrismaService;
let A: Tenant;
let B: Tenant;
let tag: string;
let counter = 0;
const invitedIds: string[] = [];
const createdOrgs: string[] = [];
const address = () => `int-inv${++counter}-${tag}@tonyai.test`;

function services(transport: MailTransport | null, overrides: { authAdmin?: AuthAdminService; db?: PrismaService } = {}) {
  const db = overrides.db ?? runtime;
  const audit = new AuditService(db);
  const access = new AccessAdminService(db, audit);
  const authAdmin = overrides.authAdmin ?? new AuthAdminService();
  const mail = new MailService(transport ?? undefined, transport ? MAIL : null);
  const authSync = new AuthSyncService(authAdmin);
  const delivery = new InvitationDeliveryService(authAdmin, mail, authSync);
  const query = new UsersQueryService(db);
  const lifecycle = new UserLifecycleService(db, access, delivery, authSync, query, audit);
  return { audit, access, delivery, authSync, query, lifecycle, mail, authAdmin };
}

/** The member as the guard would build them — for calls an invitee makes. */
async function asRequestUser(profileId: string): Promise<RequestUser> {
  const p = await owner.profile.findUniqueOrThrow({ where: { id: profileId } });
  return { id: p.id, email: p.email, fullName: p.fullName, role: p.role, organisationId: p.organisationId, accessibleSubsidiaryIds: [] };
}

async function invite(transport: MailTransport | null, over: Partial<Parameters<AccessAdminService['inviteMember']>[1]> = {}, actor = A.users.superAdmin) {
  const created = await services(transport).lifecycle.invite(actor, {
    email: address(),
    fullName: 'Int Invitee',
    role: UserRole.data_entry,
    language: 'en',
    subsidiaryIds: [],
    ...over,
  });
  invitedIds.push(created.id);
  return created;
}

async function bannedInAuth(id: string): Promise<boolean> {
  const { data } = await admin.getUserById(id);
  const until = (data.user as { banned_until?: string | null } | null)?.banned_until;
  return Boolean(until && new Date(until) > new Date());
}

/** Waits until some session is queued on an advisory lock — the operation under test is blocked behind the holder. */
async function queuedOnAdvisoryLock(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ n }] = await owner.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('nothing queued on an advisory lock within the timeout');
}

beforeAll(async () => {
  tag = randomUUID().slice(0, 8);
  runtime = connect(4);
  owner = connectOwner(2);
  A = await createTenant();
  B = await createTenant();
  const [{ user }] = await runtime.$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`;
  expect(user).toBe('tonyai_runtime');
}, 60_000);

afterAll(async () => {
  try {
    for (const id of invitedIds) await admin.deleteUser(id).catch(() => undefined);
    await owner.auditLog.deleteMany({ where: { OR: [{ entityId: { in: invitedIds } }, { userId: { in: invitedIds } }, { organisationId: { in: createdOrgs } }] } });
    await owner.profile.deleteMany({ where: { id: { in: invitedIds } } });
    await owner.organisation.deleteMany({ where: { id: { in: createdOrgs } } });
  } finally {
    await A?.cleanup();
    await B?.cleanup();
    await runtime?.$disconnect();
    await owner?.$disconnect();
  }
}, 60_000);

describe('an invitation — the database first, then Auth, then the email (K4, K5)', () => {
  it('creates profile, grant, invitation and audit on the runtime role, then the Auth user and a TR email', async () => {
    const { sent, transport } = inbox();
    const email = address();
    const created = await services(transport).lifecycle.invite(A.users.superAdmin, {
      email: `  ${email.toUpperCase()} `,
      fullName: 'Ayşe <Yılmaz>',
      role: UserRole.data_entry,
      language: 'tr',
      subsidiaryIds: [A.subsidiaryId],
    });
    invitedIds.push(created.id);

    expect(created).toMatchObject({
      email, role: 'data_entry', language: 'tr', status: 'invited', subsidiaryIds: [A.subsidiaryId],
      invitation: { status: 'sent', attempts: 1, lastErrorStep: null, language: 'tr' },
    });
    const profile = await owner.profile.findUniqueOrThrow({ where: { id: created.id } });
    expect(profile).toMatchObject({ organisationId: A.organisationId, disabledAt: null, theme: 'light' });
    const invitation = await owner.invitation.findUniqueOrThrow({ where: { profileId: created.id } });
    expect(invitation).toMatchObject({ status: InvitationStatus.sent, invitedBy: A.users.superAdmin.id, language: 'tr' });

    // The Auth user carries the profile's own id (created after it, K4).
    const { data } = await admin.getUserById(created.id);
    expect(data.user?.email).toBe(email);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(email);
    expect(sent[0].subject).toContain('davetiniz var');
    expect(sent[0].html).toContain('Ayşe &lt;Yılmaz&gt;');
    expect(sent[0].text).toContain('Ayşe <Yılmaz>');

    const rows = await owner.auditLog.findMany({ where: { entityId: created.id }, orderBy: { action: 'asc' } });
    expect(rows.map((r) => [r.action, r.entity, r.userId, r.organisationId])).toEqual([
      ['create', 'subsidiary_access', A.users.superAdmin.id, A.organisationId],
      ['invite', 'invitation', A.users.superAdmin.id, A.organisationId],
    ]);
    // The trail has no correction path (D20): never the address or the name.
    expect(JSON.stringify(rows.map((r) => r.diff))).not.toMatch(/inv\d|Ayşe|tonyai\.test/);
  });

  it('the emailed link signs the invitee in, and the acceptance is theirs', async () => {
    const { sent, transport } = inbox();
    const created = await invite(transport, { language: 'en' });
    const session = await browser().auth.verifyOtp({ type: 'invite', token_hash: tokenIn(sent[0], 'invite') });
    expect(session.error).toBeNull();
    expect(session.data.user?.id).toBe(created.id);

    const invitee = await asRequestUser(created.id);
    await services(null).lifecycle.accept(invitee);
    await services(null).lifecycle.accept(invitee); // a second call changes nothing
    const invitation = await owner.invitation.findUniqueOrThrow({ where: { profileId: created.id } });
    expect(invitation.status).toBe(InvitationStatus.accepted);
    const accepts = await owner.auditLog.findMany({ where: { entityId: created.id, action: 'accept' } });
    expect(accepts.map((r) => [r.userId, r.role])).toEqual([[created.id, 'data_entry']]);
    // Accepted: a re-send is refused, and the list says active.
    await expect(services(inbox().transport).lifecycle.resendInvitation(A.users.superAdmin, created.id)).rejects.toMatchObject({
      response: { code: 'invitation_closed' },
    });
    expect((await services(null).query.summary(A.users.superAdmin, created.id)).status).toBe('active');
  });

  it.each([
    ['a consultant', () => A.users.consultant],
    ['a data_entry user', () => A.users.dataEntry],
    ["another tenant's super_admin, for this tenant's subsidiary", () => B.users.superAdmin],
  ])('refuses %s, writing nothing', async (_label, actor) => {
    const email = address();
    const attempt = services(inbox().transport).lifecycle.invite(actor(), {
      email, fullName: 'X', role: UserRole.data_entry, language: 'en', subsidiaryIds: [A.subsidiaryId],
    });
    await expect(attempt).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await owner.profile.count({ where: { email } })).toBe(0);
  });

  it('refuses an address that has an account here or in another organisation (D17), in any case', async () => {
    for (const taken of [A.users.consultant.email, B.users.consultant.email.toUpperCase()]) {
      await expect(invite(inbox().transport, { email: taken })).rejects.toMatchObject({ response: { code: 'email_unavailable' } });
    }
  });

  it('an address is matched exactly — `_` and `%` are characters, never wildcards over other tenants (review P1)', async () => {
    const target = B.users.consultant.email; // int-consultant-<tag>@tonyai.test
    const underscore = target.replace('consultant', 'consultan_');
    const percent = target.replace('consultant', 'c%');
    // With a subsidiary that is not the actor's, every address — an existing one
    // included — answers the same 404: the subsidiaries are checked first.
    for (const email of [percent, underscore, `int-nobody-${tag}@tonyai.test`, target]) {
      await expect(invite(inbox().transport, { email, subsidiaryIds: [randomUUID()] })).rejects.toMatchObject({
        response: { code: 'subsidiary_not_found' },
      });
    }
    // Without one, an address that only LOOKS like another tenant's is not "taken".
    const created = await invite(inbox().transport, { email: underscore, role: UserRole.consultant });
    expect(created.email).toBe(underscore);
  });

  it("refuses another tenant's subsidiary (the same 404 as none) and grants for an organisation-wide role", async () => {
    const email = address();
    await expect(invite(inbox().transport, { email, subsidiaryIds: [B.subsidiaryId] })).rejects.toMatchObject({
      response: { code: 'subsidiary_not_found' },
    });
    await expect(invite(inbox().transport, { email, role: UserRole.consultant, subsidiaryIds: [A.subsidiaryId] })).rejects.toMatchObject({
      response: { code: 'access_role_mismatch' },
    });
    expect(await owner.profile.count({ where: { email } })).toBe(0);
  });

  it('an audit failure leaves nothing — no profile, no invitation, and no Auth user (the database goes first)', async () => {
    const email = address();
    const audit = new AuditService(failingAuditClient(runtime));
    const access = new AccessAdminService(failingAuditClient(runtime), audit);
    await expect(
      access.inviteMember(A.users.superAdmin, { email, fullName: 'X', role: UserRole.consultant, language: 'en', subsidiaryIds: [] }),
    ).rejects.toThrow(INJECTED_AUDIT_FAILURE);
    expect(await owner.profile.count({ where: { email } })).toBe(0);
    const [{ n }] = await owner.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM auth.users WHERE email = ${email}`;
    expect(n).toBe(0);
  });

  it('an email that does not go out is recorded on the invitation; a re-send completes it with a new link', async () => {
    const created = await invite(failingTransport);
    expect(created.invitation).toMatchObject({ status: 'pending', attempts: 1, lastErrorStep: 'email', lastErrorCode: 'smtp_failed' });
    expect(created.status).toBe('invited');

    const { sent, transport } = inbox();
    const resent = await services(transport).lifecycle.resendInvitation(A.users.superAdmin, created.id);
    expect(resent.invitation).toMatchObject({ status: 'sent', attempts: 2, lastErrorStep: null, lastErrorCode: null });
    expect(sent).toHaveLength(1);
    const resends = await owner.auditLog.findMany({ where: { entityId: created.id, action: 'invite' } });
    expect(resends.map((r) => (r.diff as { resend?: boolean } | null)?.resend ?? false)).toEqual(expect.arrayContaining([false, true]));
  });

  it('a re-send voids the link already in the inbox; only the new one signs in', async () => {
    const first = inbox();
    const created = await invite(first.transport);
    const second = inbox();
    await services(second.transport).lifecycle.resendInvitation(A.users.superAdmin, created.id);
    const stale = await browser().auth.verifyOtp({ type: 'invite', token_hash: tokenIn(first.sent[0], 'invite') });
    expect(stale.error).not.toBeNull();
    const fresh = await browser().auth.verifyOtp({ type: 'invite', token_hash: tokenIn(second.sent[0], 'invite') });
    expect(fresh.error).toBeNull();
  });

  it('without mail settings the email step records mail_not_configured and mints no link', async () => {
    const created = await invite(null);
    expect(created.invitation).toMatchObject({ status: 'pending', lastErrorStep: 'email', lastErrorCode: 'mail_not_configured' });
    // The Auth user exists (that step succeeded) but holds no invitation token yet.
    const [{ token }] = await owner.$queryRaw<{ token: string | null }[]>`
      SELECT confirmation_token AS token FROM auth.users WHERE id = ${created.id}::uuid`;
    expect(token ?? '').toBe('');
  });

  it('an address an Auth user already holds (no profile) is recorded unavailable and nothing is mailed — the real GoTrue', async () => {
    const email = address();
    const orphan = await admin.createUser({ email, email_confirm: true });
    try {
      const { sent, transport } = inbox();
      const created = await services(transport).lifecycle.invite(A.users.superAdmin, {
        email, fullName: 'X', role: UserRole.consultant, language: 'en', subsidiaryIds: [],
      });
      invitedIds.push(created.id);
      expect(created.invitation).toMatchObject({ status: 'pending', lastErrorStep: 'auth', lastErrorCode: 'email_unavailable' });
      expect(sent).toHaveLength(0);
    } finally {
      if (orphan.data.user) await admin.deleteUser(orphan.data.user.id);
    }
  });

  it('an Auth step that fails is recorded at the auth step', async () => {
    const authAdmin = new AuthAdminService();
    vi.spyOn(authAdmin, 'ensureUser').mockRejectedValueOnce(new AuthAdminError('auth_unavailable'));
    const email = address();
    const created = await services(inbox().transport, { authAdmin }).lifecycle.invite(A.users.superAdmin, {
      email, fullName: 'X', role: UserRole.executive_viewer, language: 'en', subsidiaryIds: [],
    });
    invitedIds.push(created.id);
    expect(created.invitation).toMatchObject({ status: 'pending', lastErrorStep: 'auth', lastErrorCode: 'auth_unavailable' });
    const { sent, transport } = inbox();
    const resent = await services(transport).lifecycle.resendInvitation(A.users.superAdmin, created.id);
    expect(resent.invitation?.status).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('a re-send to an invitee Auth already confirmed leaves their password and session alone (security re-review of be2b8d9, P2)', async () => {
    const { sent, transport } = inbox();
    const created = await invite(transport, { language: 'en' });
    const session = await browser().auth.verifyOtp({ type: 'invite', token_hash: tokenIn(sent[0], 'invite') });
    expect(session.error).toBeNull();
    const holder = browser();
    await holder.auth.setSession(session.data.session!);
    expect((await holder.auth.updateUser({ password: 'their-own-pass-123' })).error).toBeNull();
    // …and their acceptance never reached the API: the invitation is still `sent`.
    const again = inbox();
    await services(again.transport).lifecycle.resendInvitation(A.users.superAdmin, created.id);
    expect(again.sent).toHaveLength(0);
    expect(await bannedInAuth(created.id)).toBe(false);
    expect((await browser().auth.signInWithPassword({ email: created.email, password: 'their-own-pass-123' })).error).toBeNull();
    expect((await holder.auth.refreshSession()).error).toBeNull();
  });

  it('an enabled invitee whose unban fails gets no link — the auth step is recorded, and a re-send completes it (Codex re-review, finding 2)', async () => {
    const authAdmin = new AuthAdminService();
    vi.spyOn(authAdmin, 'setBanned').mockRejectedValueOnce(new AuthAdminError('auth_unavailable'));
    const first = inbox();
    const created = await services(first.transport, { authAdmin }).lifecycle.invite(A.users.superAdmin, {
      email: address(), fullName: 'X', role: UserRole.executive_viewer, language: 'en', subsidiaryIds: [],
    });
    invitedIds.push(created.id);
    expect(created.invitation).toMatchObject({ status: 'pending', lastErrorStep: 'auth', lastErrorCode: 'auth_unavailable' });
    expect(first.sent).toHaveLength(0);
    expect(await bannedInAuth(created.id)).toBe(true); // born banned, still
    const { sent, transport } = inbox();
    const resent = await services(transport).lifecycle.resendInvitation(A.users.superAdmin, created.id);
    expect(resent.invitation?.status).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(await bannedInAuth(created.id)).toBe(false);
    const session = await browser().auth.verifyOtp({ type: 'invite', token_hash: tokenIn(sent[0], 'invite') });
    expect(session.error).toBeNull();
  });
});

describe('disabling (D19, K4) — the database first, then the Auth ban', () => {
  it('disables, revokes the open invitation and bans in Auth; enabling lifts the ban', async () => {
    const created = await invite(inbox().transport);
    const s = services(null);
    const disabled = await s.lifecycle.disable(A.users.superAdmin, created.id);
    expect(disabled).toMatchObject({ status: 'disabled', authSyncPending: false, invitation: { status: 'revoked' } });
    expect(await bannedInAuth(created.id)).toBe(true);
    await s.lifecycle.disable(A.users.superAdmin, created.id); // idempotent
    expect(await owner.auditLog.count({ where: { entityId: created.id, action: 'disable' } })).toBe(1);

    // A revoked invitation is not re-sent while the account is disabled.
    await expect(s.lifecycle.resendInvitation(A.users.superAdmin, created.id)).rejects.toMatchObject({ response: { code: 'user_disabled' } });

    const enabled = await s.lifecycle.enable(A.users.superAdmin, created.id);
    expect(enabled).toMatchObject({ authSyncPending: false, disabledAt: null, invitation: { status: 'revoked' } });
    expect(await bannedInAuth(created.id)).toBe(false);
    // …and now it can be re-opened and sent again.
    const resent = await services(inbox().transport).lifecycle.resendInvitation(A.users.superAdmin, created.id);
    expect(resent).toMatchObject({ status: 'invited', invitation: { status: 'sent' } });
  });

  it('a disable while the Auth user is being created stands: the new Auth user is banned, nothing is sent', async () => {
    const authAdmin = new AuthAdminService();
    const real = new AuthAdminService();
    const s = services(null);
    vi.spyOn(authAdmin, 'ensureUser').mockImplementation(async (id, email) => {
      const made = await real.ensureUser(id, email);
      await s.access.disableMember(A.users.superAdmin, id); // an administrator, at that moment
      return made;
    });
    const { sent, transport } = inbox();
    const created = await services(transport, { authAdmin }).lifecycle.invite(A.users.superAdmin, {
      email: address(), fullName: 'X', role: UserRole.consultant, language: 'en', subsidiaryIds: [],
    });
    invitedIds.push(created.id);
    expect(created).toMatchObject({ status: 'disabled', invitation: { status: 'revoked' } });
    expect(sent).toHaveLength(0);
    expect(await bannedInAuth(created.id)).toBe(true);
  });

  it('a disable while the email is in flight stands: the invitation stays revoked, never marked sent', async () => {
    const s = services(null);
    let target = '';
    const transport: MailTransport = {
      sendMail: vi.fn(async () => {
        await s.access.disableMember(A.users.superAdmin, target);
        return {} as never;
      }) as never,
    };
    const authAdmin = new AuthAdminService();
    const created = await services(transport, { authAdmin }).access.inviteMember(A.users.superAdmin, {
      email: address(), fullName: 'X', role: UserRole.consultant, language: 'en', subsidiaryIds: [],
    });
    invitedIds.push(created.profileId);
    target = created.profileId;
    await new InvitationDeliveryService(authAdmin, new MailService(transport, MAIL), new AuthSyncService(authAdmin)).deliver(runtime, created.profileId);
    const invitation = await owner.invitation.findUniqueOrThrow({ where: { profileId: created.profileId } });
    expect(invitation).toMatchObject({ status: InvitationStatus.revoked, sentAt: null });
  });

  it('an enable that commits while the ban is applied keeps the flag for its own run', async () => {
    const created = await invite(inbox().transport);
    const s = services(null);
    await s.access.disableMember(A.users.superAdmin, created.id);
    const real = new AuthAdminService();
    const flipping = new AuthAdminService();
    vi.spyOn(flipping, 'setBanned').mockImplementationOnce(async (id, banned) => {
      await real.setBanned(id, banned);
      // The enable commits while the ban is in flight (it takes the tenant lock, not the sync's).
      await s.access.enableMember(A.users.superAdmin, id);
    });
    expect(await new AuthSyncService(flipping).apply(runtime, created.id)).toBe(false);
    expect((await owner.profile.findUniqueOrThrow({ where: { id: created.id } })).authSyncPendingSince).not.toBeNull();
    // The enable's own run then applies the state it reads: unbanned, cleared.
    expect(await new AuthSyncService(real).apply(runtime, created.id)).toBe(true);
    expect(await bannedInAuth(created.id)).toBe(false);
  });

  it('a disable that commits while the unban is applied keeps the flag for its own run', async () => {
    const created = await invite(inbox().transport);
    const s = services(null);
    await s.lifecycle.disable(A.users.superAdmin, created.id);
    await s.access.enableMember(A.users.superAdmin, created.id); // an enable whose sync is about to run
    const real = new AuthAdminService();
    const flipping = new AuthAdminService();
    vi.spyOn(flipping, 'setBanned').mockImplementationOnce(async (id, banned) => {
      await real.setBanned(id, banned);
      await s.access.disableMember(A.users.superAdmin, id);
    });
    expect(await new AuthSyncService(flipping).apply(runtime, created.id)).toBe(false);
    expect(await bannedInAuth(created.id)).toBe(false); // the unban landed; the disable is still owed
    expect((await owner.profile.findUniqueOrThrow({ where: { id: created.id } })).authSyncPendingSince).not.toBeNull();
    expect(await new AuthSyncService(real).apply(runtime, created.id)).toBe(true);
    expect(await bannedInAuth(created.id)).toBe(true);
  });

  it('a session that existed when the account was disabled does not come back with the enable (security P2-2)', async () => {
    const created = await invite(inbox().transport);
    await admin.updateUserById(created.id, { password: 'a-long-enough-pass-1', email_confirm: true });
    const session = await browser().auth.signInWithPassword({ email: created.email, password: 'a-long-enough-pass-1' });
    expect(session.error).toBeNull();
    const s = services(null);
    await s.lifecycle.disable(A.users.superAdmin, created.id);
    await s.lifecycle.enable(A.users.superAdmin, created.id);
    const revived = await browser().auth.refreshSession({ refresh_token: session.data.session!.refresh_token });
    expect(revived.error?.code).toBe('refresh_token_not_found');
    // …and the old password is gone too: the re-enabled user resets it.
    const old = await browser().auth.signInWithPassword({ email: created.email, password: 'a-long-enough-pass-1' });
    expect(old.error?.code).toBe('invalid_credentials');
  });

  it('an enable that reaches Auth before the disable’s own call did still revokes the old session (security re-review P3-1)', async () => {
    const created = await invite(inbox().transport);
    await admin.updateUserById(created.id, { password: 'a-long-enough-pass-1', email_confirm: true });
    const session = await browser().auth.signInWithPassword({ email: created.email, password: 'a-long-enough-pass-1' });
    expect(session.error).toBeNull();
    const failing = new AuthAdminService();
    vi.spyOn(failing, 'setBanned').mockRejectedValueOnce(new AuthAdminError('auth_unavailable'));
    const disabled = await services(null, { authAdmin: failing }).lifecycle.disable(A.users.superAdmin, created.id);
    expect(disabled.authSyncPending).toBe(true); // the disable never reached Auth
    await services(null).lifecycle.enable(A.users.superAdmin, created.id); // …and the enable's run does
    expect((await browser().auth.refreshSession({ refresh_token: session.data.session!.refresh_token })).error?.code).toBe('refresh_token_not_found');
    expect((await browser().auth.signInWithPassword({ email: created.email, password: 'a-long-enough-pass-1' })).error?.code).toBe('invalid_credentials');
  });

  it('a corrective ban that loses to an enable leaves the account enabled and unbanned (Codex finding 2, schedule A)', async () => {
    const s = services(null);
    const { profileId } = await s.access.inviteMember(A.users.superAdmin, {
      email: address(), fullName: 'X', role: UserRole.consultant, language: 'en', subsidiaryIds: [],
    });
    invitedIds.push(profileId);
    const real = new AuthAdminService();
    const authAdmin = new AuthAdminService();
    // Disabled while the Auth user is being made (its own sync bans the new user).
    vi.spyOn(authAdmin, 'ensureUser').mockImplementation(async (id, email) => {
      const made = await real.ensureUser(id, email);
      await s.lifecycle.disable(A.users.superAdmin, id);
      return made;
    });
    const hold = holdBefore(runtime, 'Profile', 'updateMany'); // delivery's re-arm, after it saw "disabled"
    const delivering = new InvitationDeliveryService(authAdmin, new MailService(inbox().transport, MAIL), new AuthSyncService(authAdmin))
      .deliver(hold.client, profileId);
    await hold.reached();
    await s.lifecycle.enable(A.users.superAdmin, profileId); // the enable commits and its sync completes first
    hold.release();
    expect(await delivering).toEqual({ delivered: false, skipped: 'disabled' });
    expect(await bannedInAuth(profileId)).toBe(false);
    expect(await owner.profile.findUniqueOrThrow({ where: { id: profileId } })).toMatchObject({ disabledAt: null, authSyncPendingSince: null });
  });

  it('a disable whose own sync ran before the Auth user existed is banned by delivery at once (Codex finding 2)', async () => {
    const s = services(null);
    const { profileId } = await s.access.inviteMember(A.users.superAdmin, {
      email: address(), fullName: 'X', role: UserRole.consultant, language: 'en', subsidiaryIds: [],
    });
    invitedIds.push(profileId);
    const real = new AuthAdminService();
    const authAdmin = new AuthAdminService();
    vi.spyOn(authAdmin, 'ensureUser').mockImplementation(async (id, email) => {
      await s.lifecycle.disable(A.users.superAdmin, id); // finds no Auth user: nothing banned, flag cleared
      return real.ensureUser(id, email);
    });
    const outcome = await new InvitationDeliveryService(authAdmin, new MailService(inbox().transport, MAIL), new AuthSyncService(authAdmin))
      .deliver(runtime, profileId);
    expect(outcome).toEqual({ delivered: false, skipped: 'disabled' });
    expect(await bannedInAuth(profileId)).toBe(true);
    expect((await owner.profile.findUniqueOrThrow({ where: { id: profileId } })).authSyncPendingSince).toBeNull();
  });

  it('an Auth user whose creation response is lost stays banned for a disabled account (Codex re-review, finding 2)', async () => {
    const s = services(null);
    const { profileId } = await s.access.inviteMember(A.users.superAdmin, {
      email: address(), fullName: 'X', role: UserRole.consultant, language: 'en', subsidiaryIds: [],
    });
    invitedIds.push(profileId);
    const real = new AuthAdminService();
    const authAdmin = new AuthAdminService();
    vi.spyOn(authAdmin, 'ensureUser').mockImplementation(async (id, email) => {
      await s.lifecycle.disable(A.users.superAdmin, id); // its sync finds no Auth user: nothing banned, flag cleared
      await real.ensureUser(id, email); // Auth creates the user…
      throw new AuthAdminError('auth_unavailable'); // …and the response is lost
    });
    const outcome = await new InvitationDeliveryService(authAdmin, new MailService(inbox().transport, MAIL), new AuthSyncService(authAdmin))
      .deliver(runtime, profileId);
    expect(outcome).toMatchObject({ delivered: false });
    expect(await bannedInAuth(profileId)).toBe(true);
  });

  it('an Auth user is born banned: a delivery interrupted after creating it leaves nothing to sign in with (Codex re-review, finding 2)', async () => {
    const { profileId, email } = await services(null).access.inviteMember(A.users.superAdmin, {
      email: address(), fullName: 'X', role: UserRole.consultant, language: 'en', subsidiaryIds: [],
    }).then(async (r) => ({ ...r, email: (await owner.profile.findUniqueOrThrow({ where: { id: r.profileId } })).email }));
    invitedIds.push(profileId);
    await new AuthAdminService().ensureUser(profileId, email); // …and the process stops here
    expect(await bannedInAuth(profileId)).toBe(true);
  });

  it('a disable whose own sync is still in flight cannot clear delivery’s re-armed flag (Codex finding 2, the re-arm moves the generation)', async () => {
    const real = new AuthAdminService();
    const gated = new AuthAdminService(); // the disable's own sync
    const s = services(null, { authAdmin: gated });
    const { profileId } = await s.access.inviteMember(A.users.superAdmin, {
      email: address(), fullName: 'X', role: UserRole.consultant, language: 'en', subsidiaryIds: [],
    });
    invitedIds.push(profileId);
    let reachedBan!: () => void;
    const banReached = new Promise<void>((r) => (reachedBan = r));
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    // Its ban finds no Auth user yet (nothing to ban) and is held before it clears the flag.
    vi.spyOn(gated, 'setBanned').mockImplementationOnce(async (id, banned) => {
      await real.setBanned(id, banned);
      reachedBan();
      await gate;
    });
    let disabling!: Promise<unknown>;
    const deliveryAuth = new AuthAdminService();
    vi.spyOn(deliveryAuth, 'ensureUser').mockImplementation(async (id, email) => {
      disabling = s.lifecycle.disable(A.users.superAdmin, id);
      await banReached;
      return real.ensureUser(id, email); // the Auth user appears after that ban
    });
    const delivering = new InvitationDeliveryService(deliveryAuth, new MailService(inbox().transport, MAIL), new AuthSyncService(deliveryAuth))
      .deliver(runtime, profileId);
    await queuedOnAdvisoryLock(); // delivery re-armed the flag and waits for the disable's sync
    openGate();
    expect(await delivering).toEqual({ delivered: false, skipped: 'disabled' });
    await disabling;
    expect(await bannedInAuth(profileId)).toBe(true);
    expect((await owner.profile.findUniqueOrThrow({ where: { id: profileId } })).authSyncPendingSince).toBeNull();
  });

  it('a corrective ban that fails stays flagged, and reconcile applies it (Codex finding 2, schedule B)', async () => {
    const s = services(null);
    const { profileId } = await s.access.inviteMember(A.users.superAdmin, {
      email: address(), fullName: 'X', role: UserRole.consultant, language: 'en', subsidiaryIds: [],
    });
    invitedIds.push(profileId);
    const real = new AuthAdminService();
    const authAdmin = new AuthAdminService();
    // The disable's own sync runs before the Auth user exists — nothing to ban, flag cleared — then the user is made.
    vi.spyOn(authAdmin, 'ensureUser').mockImplementation(async (id, email) => {
      await s.lifecycle.disable(A.users.superAdmin, id);
      return real.ensureUser(id, email);
    });
    vi.spyOn(authAdmin, 'setBanned').mockRejectedValueOnce(new AuthAdminError('auth_unavailable')); // the corrective ban fails
    const outcome = await new InvitationDeliveryService(authAdmin, new MailService(inbox().transport, MAIL), new AuthSyncService(authAdmin))
      .deliver(runtime, profileId);
    expect(outcome).toEqual({ delivered: false, skipped: 'disabled' });
    expect(await bannedInAuth(profileId)).toBe(true); // born banned: the failed sync leaves nothing to sign in with
    expect((await owner.profile.findUniqueOrThrow({ where: { id: profileId } })).authSyncPendingSince).not.toBeNull();
    const operator = new OnboardingOperator(owner, 'ops@tonyai.test', new InvitationDeliveryService(real, new MailService(undefined, null), new AuthSyncService(real)), new AuthSyncService(real));
    const report = await operator.reconcile(A.organisationId, true);
    expect(report.authApplied).toContain(profileId);
    expect(await bannedInAuth(profileId)).toBe(true);
  });

  it('a sync that outlives a newer disable and enable leaves their work to them: a session from in between is revoked (Codex finding 3)', async () => {
    const created = await invite(inbox().transport);
    await admin.updateUserById(created.id, { email_confirm: true });
    const s = services(null);
    await s.lifecycle.disable(A.users.superAdmin, created.id);
    await s.access.enableMember(A.users.superAdmin, created.id); // an enable whose sync is about to run
    const real = new AuthAdminService();
    const slow = new AuthAdminService();
    let refreshToken: string | undefined;
    vi.spyOn(slow, 'setBanned').mockImplementationOnce(async (id, banned) => {
      await real.setBanned(id, banned); // the unban and its rotation reach Auth…
      // …a fresh recovery session starts before the response comes back…
      const { data } = await admin.generateLink({ type: 'recovery', email: created.email });
      const session = await browser().auth.verifyOtp({ type: 'recovery', token_hash: data.properties!.hashed_token });
      refreshToken = session.data.session!.refresh_token;
      // …and a disable and an enable commit meanwhile (the tenant lock, not the sync's).
      await s.access.disableMember(A.users.superAdmin, id);
      await s.access.enableMember(A.users.superAdmin, id);
    });
    expect(await new AuthSyncService(slow).apply(runtime, created.id)).toBe(false); // the newer change keeps its flag
    expect(await new AuthSyncService(real).apply(runtime, created.id)).toBe(true); // …and its run rotates again
    expect(refreshToken).toBeDefined();
    expect((await browser().auth.refreshSession({ refresh_token: refreshToken! })).error?.code).toBe('refresh_token_not_found');
  });

  it('nobody disables their own account', async () => {
    await expect(services(null).lifecycle.disable(A.users.superAdmin, A.users.superAdmin.id)).rejects.toMatchObject({
      response: { code: 'own_account_forbidden' },
    });
  });

  it('two administrators cannot disable each other at once — one stays, so the organisation keeps an active super_admin', async () => {
    const second = await invite(inbox().transport, { role: UserRole.super_admin });
    const other = await asRequestUser(second.id);
    const s = services(null);
    try {
      const results = await Promise.allSettled([
        s.access.disableMember(A.users.superAdmin, second.id),
        s.access.disableMember(other, A.users.superAdmin.id),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ response: { code: 'account_disabled' } });
      const active = await owner.profile.count({
        where: { organisationId: A.organisationId, role: UserRole.super_admin, disabledAt: null, id: { in: [A.users.superAdmin.id, second.id] } },
      });
      expect(active).toBe(1);
    } finally {
      // Put A's administrator back for the tests below (as the fixture owner), pass or fail.
      await owner.profile.update({ where: { id: A.users.superAdmin.id }, data: { disabledAt: null, authSyncPendingSince: null } });
      await owner.profile.update({ where: { id: second.id }, data: { disabledAt: new Date() } });
    }
  });

  it('an Auth ban that fails stays flagged — the API still refuses the account — and reconcile applies it', async () => {
    const created = await invite(inbox().transport);
    const authAdmin = new AuthAdminService();
    vi.spyOn(authAdmin, 'setBanned').mockRejectedValueOnce(new AuthAdminError('auth_unavailable'));
    const disabled = await services(null, { authAdmin }).lifecycle.disable(A.users.superAdmin, created.id);
    expect(disabled).toMatchObject({ status: 'disabled', authSyncPending: true });
    expect(await bannedInAuth(created.id)).toBe(false);

    const real = new AuthAdminService();
    const operator = new OnboardingOperator(owner, 'ops@tonyai.test', new InvitationDeliveryService(real, new MailService(undefined, null), new AuthSyncService(real)), new AuthSyncService(real));
    const dry = await operator.reconcile(A.organisationId, false);
    expect(dry.authPending).toContain(created.id);
    const report = await operator.reconcile(A.organisationId, true);
    expect(report.authApplied).toContain(created.id);
    expect(report.authPending).not.toContain(created.id);
    expect(await bannedInAuth(created.id)).toBe(true);
  });
});

describe('roles and subsidiary access', () => {
  it("replaces a data_entry user's grants with exactly the set, each change audited", async () => {
    const extra = await owner.subsidiary.create({ data: { organisationId: A.organisationId, legalName: `Int-test subsidiary 2 ${tag}`, geographyCode: 'UK' } });
    const target = A.users.dataEntry.id;
    const s = services(null);
    const before = await owner.auditLog.count({ where: { entityId: target, entity: 'subsidiary_access' } });
    const updated = await s.lifecycle.replaceAccess(A.users.superAdmin, target, [extra.id, extra.id]);
    expect(updated.subsidiaryIds).toEqual([extra.id]);
    const changes = await owner.auditLog.findMany({ where: { entityId: target, entity: 'subsidiary_access' }, orderBy: { createdAt: 'asc' } });
    expect(changes.slice(before).map((r) => [r.action, (r.diff as { subsidiaryId: string }).subsidiaryId])).toEqual([
      ['delete', A.subsidiaryId],
      ['create', extra.id],
    ]);
    await s.lifecycle.replaceAccess(A.users.superAdmin, target, [extra.id]); // nothing to change
    expect(await owner.auditLog.count({ where: { entityId: target, entity: 'subsidiary_access' } })).toBe(before + 2);
    // Restore the fixture's grant.
    await s.lifecycle.replaceAccess(A.users.superAdmin, target, [A.subsidiaryId]);
  });

  it("refuses another tenant's subsidiary, grants for another role, and another tenant's user (404, as none)", async () => {
    const s = services(null);
    await expect(s.lifecycle.replaceAccess(A.users.superAdmin, A.users.dataEntry.id, [B.subsidiaryId])).rejects.toMatchObject({
      response: { code: 'subsidiary_not_found' },
    });
    await expect(s.lifecycle.replaceAccess(A.users.superAdmin, A.users.consultant.id, [A.subsidiaryId])).rejects.toMatchObject({
      response: { code: 'access_role_mismatch' },
    });
    await s.lifecycle.replaceAccess(A.users.superAdmin, A.users.consultant.id, []); // nothing held, nothing to do
    for (const id of [B.users.dataEntry.id, randomUUID()]) {
      await expect(s.lifecycle.replaceAccess(A.users.superAdmin, id, [])).rejects.toMatchObject({ response: { code: 'user_not_found' } });
      await expect(s.lifecycle.disable(A.users.superAdmin, id)).rejects.toMatchObject({ response: { code: 'user_not_found' } });
      await expect(s.lifecycle.resendInvitation(A.users.superAdmin, id)).rejects.toMatchObject({ response: { code: 'user_not_found' } });
    }
    expect(await owner.profile.findUniqueOrThrow({ where: { id: B.users.dataEntry.id } })).toMatchObject({ disabledAt: null });
    await expect(s.lifecycle.setRole(A.users.superAdmin, A.users.superAdmin.id, UserRole.consultant)).rejects.toMatchObject({
      response: { code: 'own_account_forbidden' },
    });
  });
});

describe('the users list (CursorPage)', () => {
  it("pages the organisation's members newest first — every one once, none of another tenant", async () => {
    const q = services(null).query;
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await q.list(A.users.superAdmin, { limit: 2, cursor });
      expect(page.limit).toBe(2);
      seen.push(...page.items.map((u) => u.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const expected = await owner.profile.findMany({ where: { organisationId: A.organisationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    expect(seen).toEqual(expected.map((p) => p.id));
    expect(seen).not.toEqual(expect.arrayContaining([B.users.superAdmin.id]));
    expect(JSON.stringify(await q.list(A.users.superAdmin, {}))).not.toContain(B.organisationId);
  });

  it('a page that ends exactly at the last member says so — no cursor to an empty page', async () => {
    const q = services(null).query;
    const total = await owner.profile.count({ where: { organisationId: A.organisationId } });
    const page = await q.list(A.users.superAdmin, { limit: total });
    expect(page.items).toHaveLength(total);
    expect(page.nextCursor).toBeNull();
    const short = await q.list(A.users.superAdmin, { limit: total - 1 });
    expect(short.nextCursor).not.toBeNull();
  });

  it('refuses every other role and a malformed or foreign cursor', async () => {
    const q = services(null).query;
    for (const actor of [A.users.consultant, A.users.dataEntry, A.users.executiveViewer]) {
      await expect(q.list(actor, {})).rejects.toMatchObject({ status: 403 });
    }
    for (const cursor of ['nope', Buffer.from(JSON.stringify({ v: 1, k: 'records', t: new Date().toISOString(), i: randomUUID() })).toString('base64url')]) {
      await expect(q.list(A.users.superAdmin, { cursor })).rejects.toMatchObject({ response: { code: 'validation_failed' } });
    }
    await expect(q.summary(A.users.superAdmin, B.users.superAdmin.id)).rejects.toMatchObject({ response: { code: 'user_not_found' } });
  });
});

describe('password reset (K5) — one link per cooldown, in the account’s language', () => {
  it('sends an enabled account a working recovery link, audited with no person as actor; the cooldown holds', async () => {
    const created = await invite(inbox().transport, { language: 'tr' });
    const { sent, transport } = inbox();
    const resets = new PasswordResetService(runtime, new AuthAdminService(), new MailService(transport, MAIL), new AuditService(runtime), {} as never);
    expect(await resets.run(created.email.toUpperCase())).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('TonyAI şifrenizi sıfırlayın');
    const session = await browser().auth.verifyOtp({ type: 'recovery', token_hash: tokenIn(sent[0], 'recovery') });
    expect(session.error).toBeNull();
    expect(await resets.run(created.email)).toBe('skipped'); // inside the cooldown
    expect(sent).toHaveLength(1);
    const rows = await owner.auditLog.findMany({ where: { entityId: created.id, action: 'password_reset' } });
    expect(rows.map((r) => [r.userId, r.role, r.organisationId])).toEqual([[null, null, A.organisationId]]);
  });

  it('a member of an offboarded organisation gets nothing', async () => {
    const created = await invite(inbox().transport);
    const { sent, transport } = inbox();
    const resets = new PasswordResetService(runtime, new AuthAdminService(), new MailService(transport, MAIL), new AuditService(runtime), {} as never);
    await owner.organisation.update({ where: { id: A.organisationId }, data: { offboardedAt: new Date() } });
    try {
      expect(await resets.run(created.email)).toBe('skipped');
    } finally {
      await owner.organisation.update({ where: { id: A.organisationId }, data: { offboardedAt: null } });
    }
    expect(sent).toHaveLength(0);
  });

  it('an unknown or disabled address gets nothing, and nothing is written', async () => {
    const created = await invite(inbox().transport);
    await services(null).lifecycle.disable(A.users.superAdmin, created.id);
    const { sent, transport } = inbox();
    const resets = new PasswordResetService(runtime, new AuthAdminService(), new MailService(transport, MAIL), new AuditService(runtime), {} as never);
    expect(await resets.run(`int-nobody-${tag}@tonyai.test`)).toBe('skipped');
    expect(await resets.run(created.email)).toBe('skipped');
    // A pattern reaches nobody: `%` and `_` are characters (review P1).
    expect(await resets.run(A.users.superAdmin.email.replace(/^int-/, 'int%'))).toBe('skipped');
    expect(await resets.run(A.users.superAdmin.email.replace('admin', 'adm_n'))).toBe('skipped');
    expect(sent).toHaveLength(0);
    expect(await owner.auditLog.count({ where: { entityId: created.id, action: 'password_reset' } })).toBe(0);
  });
});

describe('the operator CLI (D18, K3, K6) — on the owner login', () => {
  const orgName = () => `${TENANT_ORG_PREFIX}operator ${tag}`;

  it('refuses any login but the tables’ owner — the runtime login, or the owner acting as another role', async () => {
    const real = new AuthAdminService();
    const make = (db: unknown) =>
      new OnboardingOperator(db as never, 'ops@tonyai.test', new InvitationDeliveryService(real, new MailService(undefined, null), new AuthSyncService(real)), new AuthSyncService(real));
    await expect(make(runtime).assertOwner()).rejects.toBeInstanceOf(OperatorRefusal);
    const refused = await owner
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
        return make(tx).assertOwner().then(() => 'admitted', (e: unknown) => (e instanceof OperatorRefusal ? e.message : String(e)));
      })
      .catch((e: unknown) => String(e));
    expect(refused).toMatch(/acting as authenticated/);
    await expect(make(owner).assertOwner()).resolves.toBeUndefined();
  });

  it('provisioning into an organisation an offboarding is closing waits for it, and refuses (security re-review P3-3)', async () => {
    const C = await createTenant();
    const email = address();
    const holder = connectOwner(1);
    try {
      const real = new AuthAdminService();
      const operator = new OnboardingOperator(owner, 'ops@tonyai.test', new InvitationDeliveryService(real, new MailService(inbox().transport, MAIL), new AuthSyncService(real)), new AuthSyncService(real));
      const locked = deferred();
      const release = deferred();
      // An offboarding mid-flight: the tenant lock held, the mark written, not yet committed.
      const offboarding = holder.$transaction(async (tx) => {
        await lockTenantAdmin(tx, C.organisationId);
        await tx.organisation.update({ where: { id: C.organisationId }, data: { offboardedAt: new Date() } });
        locked.resolve();
        await release.promise;
      }, { timeout: 20_000 });
      await locked.promise;
      const provisioning = operator.provision({ organisationId: C.organisationId, adminEmail: email, adminName: 'Late', language: 'en' }, true);
      const outcome = provisioning.then(() => 'provisioned', (e: unknown) => (e instanceof OperatorRefusal ? e.message : String(e)));
      await queuedOnAdvisoryLock(); // provision has passed its first check and waits on the lock
      release.resolve();
      await offboarding;
      expect(await outcome).toMatch(/offboarded/);
      expect(await owner.profile.count({ where: { email } })).toBe(0);
    } finally {
      await holder.$disconnect();
      await owner.profile.deleteMany({ where: { email } });
      await owner.auditLog.deleteMany({ where: { organisationId: C.organisationId } });
      await C.cleanup();
    }
  });

  it('an existing address is provisioned again only as its own organisation’s super_admin, never in an offboarded one', async () => {
    const real = new AuthAdminService();
    const operator = new OnboardingOperator(owner, 'ops@tonyai.test', new InvitationDeliveryService(real, new MailService(inbox().transport, MAIL), new AuthSyncService(real)), new AuthSyncService(real));
    await expect(
      operator.provision({ organisationId: A.organisationId, adminEmail: A.users.consultant.email, adminName: 'X', language: 'en' }, true),
    ).rejects.toThrow(/already a consultant/);
    await owner.organisation.update({ where: { id: A.organisationId }, data: { offboardedAt: new Date() } });
    try {
      await expect(
        operator.provision({ organisationId: A.organisationId, adminEmail: A.users.superAdmin.email, adminName: 'X', language: 'en' }, true),
      ).rejects.toThrow(/offboarded/);
    } finally {
      await owner.organisation.update({ where: { id: A.organisationId }, data: { offboardedAt: null } });
    }
  });

  it('provisions an organisation and its first administrator, idempotently; then offboards it', async () => {
    const { sent, transport } = inbox();
    const real = new AuthAdminService();
    const operator = new OnboardingOperator(owner, 'ops@tonyai.test', new InvitationDeliveryService(real, new MailService(transport, MAIL), new AuthSyncService(real)), new AuthSyncService(real));
    const input = {
      organisation: { legalName: orgName(), country: 'TR', geographyCode: 'TR', reportingCurrency: 'TRY' },
      adminEmail: address(),
      adminName: 'Int Operator Admin',
      language: 'tr' as const,
    };
    const dry = await operator.provision(input, false);
    expect(dry).toMatchObject({ applied: false, organisation: { created: true }, admin: { created: true } });
    expect(await owner.organisation.count({ where: { legalName: orgName() } })).toBe(0);

    const first = await operator.provision(input, true);
    const orgId = first.organisation.id!;
    createdOrgs.push(orgId);
    invitedIds.push(first.admin.id!);
    expect(first).toMatchObject({ applied: true, organisation: { created: true }, admin: { created: true }, delivery: { delivered: true } });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("TonyAI'dan yeni bir davet");
    const rows = await owner.auditLog.findMany({ where: { organisationId: orgId }, orderBy: { action: 'asc' } });
    expect(rows.map((r) => [r.action, r.entity, r.userId, (r.diff as { operator?: string }).operator])).toEqual([
      ['create', 'organisation', null, 'ops@tonyai.test'],
      ['invite', 'invitation', null, 'ops@tonyai.test'],
    ]);

    // Re-run: the invitation went out but was not accepted — sent again with a
    // fresh link (the first administrator has nobody else to ask; QA P2-1).
    const again = await operator.provision(input, true);
    expect(again).toMatchObject({
      organisation: { id: orgId, created: false },
      admin: { id: first.admin.id, created: false, invitation: 'sent' },
      resent: true,
      delivery: { delivered: true },
    });
    expect(sent).toHaveLength(2);
    const resend = await owner.auditLog.findMany({ where: { organisationId: orgId, action: 'invite' }, orderBy: { createdAt: 'asc' } });
    expect(resend.map((r) => [r.userId, (r.diff as { resend?: boolean; operator?: string }).resend ?? false, (r.diff as { operator?: string }).operator])).toEqual([
      [null, false, 'ops@tonyai.test'],
      [null, true, 'ops@tonyai.test'],
    ]);
    // A pattern of the admin's address is a new address, not a re-run (review P1).
    const dryPattern = await operator.provision({ ...input, adminEmail: input.adminEmail.replace(/^int-/, 'int%') }, false);
    expect(dryPattern.admin).toMatchObject({ id: null, created: true });
    await expect(operator.provision({ ...input, organisation: { ...input.organisation, legalName: 'Another org' } }, true)).rejects.toBeInstanceOf(OperatorRefusal);
    await expect(operator.provision({ organisationId: orgId, adminEmail: A.users.consultant.email, adminName: 'X', language: 'en' }, true)).rejects.toBeInstanceOf(OperatorRefusal);

    const before = await owner.profile.findUniqueOrThrow({ where: { id: first.admin.id! } });
    const off = await operator.offboard(orgId, true);
    expect(off).toMatchObject({ applied: true, disabled: 1, invitationsRevoked: 1, authPending: [] });
    // Its sessions end, and an older sync still in flight cannot clear its intent (Codex findings 1, 3).
    const after = await owner.profile.findUniqueOrThrow({ where: { id: first.admin.id! } });
    expect(after.sessionsRevokedAt).not.toBeNull();
    expect(after.authSyncGeneration).toBe(before.authSyncGeneration + 1);
    expect((await owner.organisation.findUniqueOrThrow({ where: { id: orgId } })).offboardedAt).not.toBeNull();
    expect(await bannedInAuth(first.admin.id!)).toBe(true);
    const offRows = await owner.auditLog.findMany({ where: { organisationId: orgId, action: { in: ['offboard', 'disable'] } } });
    expect(offRows.map((r) => [r.action, r.userId]).sort()).toEqual([['disable', null], ['offboard', null]]);
    const reOff = await operator.offboard(orgId, true);
    expect(reOff.disabled).toBe(0);
    expect(await owner.auditLog.count({ where: { organisationId: orgId, action: { in: ['offboard', 'disable'] } } })).toBe(2);
    // Offboarded: a re-run sends nothing (the invitation is revoked).
    await expect(operator.provision(input, true)).rejects.toBeInstanceOf(OperatorRefusal);
    await expect(operator.provision({ organisationId: orgId, adminEmail: address(), adminName: 'X', language: 'en' }, true)).rejects.toBeInstanceOf(OperatorRefusal);
  });
});

describe('offboarding and the tenant administrators (architect P2-1)', () => {
  it('an offboarding waits for an administrative change in flight and disables what it added', async () => {
    const C = await createTenant();
    const added = randomUUID();
    const holder = connectOwner(1);
    try {
      const real = new AuthAdminService();
      const operator = new OnboardingOperator(owner, 'ops@tonyai.test', new InvitationDeliveryService(real, new MailService(undefined, null), new AuthSyncService(real)), new AuthSyncService(real));
      const locked = deferred();
      const release = deferred();
      // An invitation's transaction, mid-flight: the lock held, a new member written, not yet committed.
      const change = holder.$transaction(async (tx) => {
        await lockTenantAdmin(tx, C.organisationId);
        await tx.profile.create({
          data: { id: added, email: `int-added-${tag}@tonyai.test`, fullName: 'Added', role: UserRole.consultant, organisationId: C.organisationId },
        });
        locked.resolve();
        await release.promise;
      }, { timeout: 20_000 });
      await locked.promise;
      const offboarding = operator.offboard(C.organisationId, true);
      await queuedOnAdvisoryLock(); // the offboarding now waits on the tenant lock
      release.resolve();
      await change;
      const report = await offboarding;
      expect(report.disabled).toBe(C.profileIds.length + 1);
      expect((await owner.profile.findUniqueOrThrow({ where: { id: added } })).disabledAt).not.toBeNull();
    } finally {
      await holder.$disconnect();
      await owner.auditLog.deleteMany({ where: { organisationId: C.organisationId } });
      await owner.profile.deleteMany({ where: { id: added } });
      await C.cleanup();
    }
  });

  it('an administrator of an offboarded organisation is refused under the lock, and no invitation goes out to it', async () => {
    const { sent, transport } = inbox();
    const pending = await invite(null); // pending, mail not configured
    await owner.organisation.update({ where: { id: A.organisationId }, data: { offboardedAt: new Date() } });
    try {
      await expect(services(null).access.disableMember(A.users.superAdmin, A.users.consultant.id)).rejects.toMatchObject({
        response: { code: 'account_disabled' },
      });
      const authAdmin = new AuthAdminService();
      const ensureUser = vi.spyOn(authAdmin, 'ensureUser');
      const outcome = await new InvitationDeliveryService(authAdmin, new MailService(transport, MAIL), new AuthSyncService(authAdmin)).deliver(runtime, pending.id);
      expect(outcome).toEqual({ delivered: false, skipped: 'disabled' });
      expect(ensureUser).not.toHaveBeenCalled(); // refused before any Auth step
      expect(sent).toHaveLength(0);
    } finally {
      await owner.organisation.update({ where: { id: A.organisationId }, data: { offboardedAt: null } });
    }
  });
});

describe('through the HTTP API (guard, routes, public reset)', () => {
  const JWT_SECRET = randomBytes(32).toString('hex');
  let app: INestApplication;
  let base: string;
  const token = (sub: string) =>
    new SignJWT({ sub, role: 'authenticated', aud: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JWT_SECRET));
  const call = async (method: string, path: string, sub?: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(sub ? { Authorization: `Bearer ${await token(sub)}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : undefined };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.INT_RUNTIME_DATABASE_URL;
    process.env.SUPABASE_JWT_SCHEME = 'hs256';
    process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
    process.env.STORAGE_SWEEP_INTERVAL_SECONDS = '0';
    for (const k of ['SMTP_HOST', 'MAIL_FROM', 'APP_URL']) delete process.env[k];
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../../src/app.module');
    const { configureApp } = await import('../../src/app-setup');
    const { JsonLogger } = await import('../../src/observability/json-logger');
    app = await NestFactory.create(AppModule, { logger: ['error'] });
    configureApp(app, Object.assign(new JsonLogger(), { event: () => undefined }), { requestLogging: false });
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/v1`.replace('[::1]', '127.0.0.1');
  }, 60_000);
  afterAll(async () => {
    // Let a reset job the 202 left running finish before the pool closes —
    // what `installRuntimeShutdown` does for the deployed app.
    const { RuntimeLimits } = await import('../../src/common/runtime-limits');
    await app?.get(RuntimeLimits, { strict: false }).settle();
    await app?.close();
  });

  it('a disabled account is refused on its next request — 401 account_disabled — and an offboarded organisation’s too', async () => {
    const created = await invite(inbox().transport, { role: UserRole.consultant });
    expect((await call('GET', '/me', created.id)).status).toBe(200);
    await services(null).lifecycle.disable(A.users.superAdmin, created.id);
    const refused = await call('GET', '/me', created.id);
    expect(refused).toMatchObject({ status: 401, body: { code: 'account_disabled' } });

    await owner.profile.update({ where: { id: created.id }, data: { disabledAt: null } });
    await owner.organisation.update({ where: { id: A.organisationId }, data: { offboardedAt: new Date() } });
    try {
      expect(await call('GET', '/me', created.id)).toMatchObject({ status: 401, body: { code: 'account_disabled' } });
    } finally {
      await owner.organisation.update({ where: { id: A.organisationId }, data: { offboardedAt: null } });
    }
  });

  it('a token issued before a disable stays refused after the enable — synced or not — and a fresh sign-in is accepted (Codex finding 1)', async () => {
    const withToken = async (bearer: string) =>
      (await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${bearer}` } })).json().then((b) => b as { code?: string; id?: string });
    for (const authFails of [false, true]) {
      const created = await invite(inbox().transport, { role: UserRole.consultant });
      const before = await token(created.id);
      expect(await withToken(before)).toMatchObject({ id: created.id });
      const authAdmin = new AuthAdminService();
      if (authFails) vi.spyOn(authAdmin, 'setBanned').mockRejectedValue(new AuthAdminError('auth_unavailable'));
      const lifecycle = services(null, { authAdmin }).lifecycle;
      await lifecycle.disable(A.users.superAdmin, created.id);
      expect(await withToken(before)).toMatchObject({ code: 'account_disabled' });
      await lifecycle.enable(A.users.superAdmin, created.id);
      expect(await withToken(before)).toMatchObject({ code: 'session_revoked' });
      await new Promise((r) => setTimeout(r, 1_100)); // iat is whole seconds
      expect(await withToken(await token(created.id))).toMatchObject({ id: created.id });
      vi.restoreAllMocks();
    }
  });

  it('a session from before the disable stays refused after the enable though it refreshed in between — the disable’s Auth step failed (Codex finding 1)', async () => {
    // GoTrue's own claims — its `iat`, `amr` and session — re-signed with this app's test secret.
    const withToken = async (gotrue: string) => {
      const claims = JSON.parse(Buffer.from(gotrue.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
      const bearer = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(JWT_SECRET));
      return (await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${bearer}` } })).json().then((b) => b as { code?: string; id?: string });
    };
    const created = await invite(inbox().transport, { role: UserRole.consultant });
    await admin.updateUserById(created.id, { password: 'a-long-enough-pass-1', email_confirm: true });
    const signedIn = await browser().auth.signInWithPassword({ email: created.email, password: 'a-long-enough-pass-1' });
    expect(signedIn.error).toBeNull();
    const failing = new AuthAdminService();
    vi.spyOn(failing, 'setBanned').mockRejectedValue(new AuthAdminError('auth_unavailable'));
    const lifecycle = services(null, { authAdmin: failing }).lifecycle;
    await lifecycle.disable(A.users.superAdmin, created.id); // neither the ban nor the rotation reaches Auth
    await new Promise((r) => setTimeout(r, 1_100)); // a refresh stamped a later second than the revocation
    const refreshed = await browser().auth.refreshSession({ refresh_token: signedIn.data.session!.refresh_token });
    expect(refreshed.error).toBeNull();
    await lifecycle.enable(A.users.superAdmin, created.id);
    expect(await withToken(refreshed.data.session!.access_token)).toMatchObject({ code: 'session_revoked' });
    // The session's refresh token is still alive in Auth (both syncs failed): what it mints now is refused too.
    const again = await browser().auth.refreshSession({ refresh_token: refreshed.data.session!.refresh_token });
    expect(again.error).toBeNull();
    expect(await withToken(again.data.session!.access_token)).toMatchObject({ code: 'session_revoked' });
    // A new session — a recovery link after the enable, in a later second than it — is accepted.
    await new Promise((r) => setTimeout(r, 1_100));
    const { data } = await admin.generateLink({ type: 'recovery', email: created.email });
    const fresh = await browser().auth.verifyOtp({ type: 'recovery', token_hash: data.properties!.hashed_token });
    expect(await withToken(fresh.data.session!.access_token)).toMatchObject({ id: created.id });
  });

  it('a session begun between the enable’s commit and its successful Auth sync loses its API access with its refresh token (Codex re-review, finding 1)', async () => {
    const withToken = async (gotrue: string) => {
      const claims = JSON.parse(Buffer.from(gotrue.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
      const bearer = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(JWT_SECRET));
      return (await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${bearer}` } })).json().then((b) => b as { code?: string; id?: string });
    };
    const created = await invite(inbox().transport, { role: UserRole.consultant });
    await admin.updateUserById(created.id, { password: 'a-long-enough-pass-1', email_confirm: true });
    const failing = new AuthAdminService();
    vi.spyOn(failing, 'setBanned').mockRejectedValueOnce(new AuthAdminError('auth_unavailable'));
    await services(null, { authAdmin: failing }).lifecycle.disable(A.users.superAdmin, created.id); // Auth keeps the password
    await new Promise((r) => setTimeout(r, 1_100));
    await services(null).access.enableMember(A.users.superAdmin, created.id); // committed; its sync has not run
    await new Promise((r) => setTimeout(r, 1_100));
    const between = await browser().auth.signInWithPassword({ email: created.email, password: 'a-long-enough-pass-1' });
    expect(between.error).toBeNull();
    expect(await withToken(between.data.session!.access_token)).toMatchObject({ id: created.id });
    expect(await new AuthSyncService(new AuthAdminService()).apply(runtime, created.id)).toBe(true); // unban + rotation
    expect((await browser().auth.refreshSession({ refresh_token: between.data.session!.refresh_token })).error?.code).toBe('refresh_token_not_found');
    expect(await withToken(between.data.session!.access_token)).toMatchObject({ code: 'session_revoked' });
    await new Promise((r) => setTimeout(r, 1_100));
    const { data } = await admin.generateLink({ type: 'recovery', email: created.email });
    const fresh = await browser().auth.verifyOtp({ type: 'recovery', token_hash: data.properties!.hashed_token });
    expect(await withToken(fresh.data.session!.access_token)).toMatchObject({ id: created.id });
  });

  it('a session begun while the account was disabled — through a session Auth still honoured — is refused after the enable (security re-review P2)', async () => {
    const withToken = async (gotrue: string) => {
      const claims = JSON.parse(Buffer.from(gotrue.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
      const bearer = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(JWT_SECRET));
      return (await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${bearer}` } })).json().then((b) => b as { code?: string; id?: string });
    };
    const created = await invite(inbox().transport, { role: UserRole.consultant });
    await admin.updateUserById(created.id, { password: 'a-long-enough-pass-1', email_confirm: true });
    const stolen = await browser().auth.signInWithPassword({ email: created.email, password: 'a-long-enough-pass-1' });
    expect(stolen.error).toBeNull();
    const failing = new AuthAdminService();
    vi.spyOn(failing, 'setBanned').mockRejectedValueOnce(new AuthAdminError('auth_unavailable'));
    const s = services(null, { authAdmin: failing });
    await s.lifecycle.disable(A.users.superAdmin, created.id); // neither the ban nor the rotation reaches Auth
    await new Promise((r) => setTimeout(r, 1_100));
    // While disabled: the surviving session sets a password of its own and signs in anew.
    const holder = browser();
    await holder.auth.setSession(stolen.data.session!);
    expect((await holder.auth.updateUser({ password: 'attacker-chosen-pass-1' })).error).toBeNull();
    const begunWhileDisabled = await browser().auth.signInWithPassword({ email: created.email, password: 'attacker-chosen-pass-1' });
    expect(begunWhileDisabled.error).toBeNull();
    expect(await withToken(begunWhileDisabled.data.session!.access_token)).toMatchObject({ code: 'account_disabled' });
    await new Promise((r) => setTimeout(r, 1_100));
    await s.lifecycle.enable(A.users.superAdmin, created.id); // its sync rotates the password; the token lives on
    expect(await withToken(begunWhileDisabled.data.session!.access_token)).toMatchObject({ code: 'session_revoked' });
    await new Promise((r) => setTimeout(r, 1_100));
    const { data } = await admin.generateLink({ type: 'recovery', email: created.email });
    const fresh = await browser().auth.verifyOtp({ type: 'recovery', token_hash: data.properties!.hashed_token });
    expect(await withToken(fresh.data.session!.access_token)).toMatchObject({ id: created.id });
  });

  it('an uppercase spelling of one’s own id is still one’s own; another member’s is stored and banned in the one spelling', async () => {
    const own = A.users.superAdmin.id.toUpperCase();
    expect(await call('POST', `/users/${own}/disable`, A.users.superAdmin.id)).toMatchObject({ status: 403, body: { code: 'own_account_forbidden' } });
    expect(await call('PATCH', `/users/${own}/role`, A.users.superAdmin.id, { role: 'executive_viewer' })).toMatchObject({
      status: 403,
      body: { code: 'own_account_forbidden' },
    });
    expect(await owner.profile.findUniqueOrThrow({ where: { id: A.users.superAdmin.id } })).toMatchObject({ role: 'super_admin', disabledAt: null });

    const created = await invite(inbox().transport, { role: UserRole.consultant });
    const disabled = await call('POST', `/users/${created.id.toUpperCase()}/disable`, A.users.superAdmin.id);
    expect(disabled).toMatchObject({ status: 200, body: { id: created.id, status: 'disabled', authSyncPending: false } });
    expect(await bannedInAuth(created.id)).toBe(true);
    const rows = await owner.auditLog.findMany({ where: { action: 'disable', entityId: { in: [created.id, created.id.toUpperCase()] } } });
    expect(rows.map((r) => r.entityId)).toEqual([created.id]);
  });

  it('an uppercase subsidiary id is the same grant: re-sending the same set changes and audits nothing', async () => {
    const target = A.users.dataEntry.id;
    const before = await owner.auditLog.count({ where: { entityId: target, entity: 'subsidiary_access' } });
    const res = await call('PUT', `/users/${target}/access`, A.users.superAdmin.id, { subsidiaryIds: [A.subsidiaryId.toUpperCase()] });
    expect(res).toMatchObject({ status: 200, body: { subsidiaryIds: [A.subsidiaryId] } });
    expect(await owner.auditLog.count({ where: { entityId: target, entity: 'subsidiary_access' } })).toBe(before);
  });

  it('the users routes: super_admin only, ids validated, another tenant’s id answers like none', async () => {
    expect((await call('GET', '/users', A.users.superAdmin.id)).status).toBe(200);
    for (const who of [A.users.consultant.id, A.users.dataEntry.id, A.users.executiveViewer.id]) {
      expect((await call('GET', '/users', who)).status).toBe(403);
      expect((await call('POST', '/users/invitations', who, { email: address(), fullName: 'X', role: 'consultant', language: 'en' })).status).toBe(403);
    }
    expect((await call('POST', '/users/not-an-id/disable', A.users.superAdmin.id)).body).toMatchObject({ code: 'invalid_id' });
    expect((await call('POST', '/users/invitations', A.users.superAdmin.id, { email: 'nope', fullName: 'X', role: 'consultant', language: 'en' })).body).toMatchObject({ code: 'validation_failed' });
    expect((await call('POST', '/users/invitations', A.users.superAdmin.id, { email: address(), fullName: 'X', role: 'consultant', language: 'de' })).body).toMatchObject({ code: 'validation_failed' });
    const foreign = await call('POST', `/users/${B.users.consultant.id}/disable`, A.users.superAdmin.id);
    const missing = await call('POST', `/users/${randomUUID()}/disable`, A.users.superAdmin.id);
    expect(foreign).toMatchObject({ status: 404, body: { code: 'user_not_found' } });
    expect(foreign.text).toBe(missing.text);
  });

  it('the public reset endpoint answers 202 with no body for every address, known or not', async () => {
    const known = await call('POST', '/auth/password-reset', undefined, { email: A.users.consultant.email });
    const unknown = await call('POST', '/auth/password-reset', undefined, { email: `int-nobody-${tag}@tonyai.test` });
    expect(known).toEqual({ status: 202, text: '', body: undefined });
    expect(unknown).toEqual(known);
    expect((await call('POST', '/auth/password-reset', undefined, { email: 'nope' })).status).toBe(400);
  });
});
