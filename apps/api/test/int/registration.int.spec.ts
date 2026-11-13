import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { InvitationStatus, UserRole } from '@tonyai/db';
import { REGISTRATION_CONSENT_VERSION } from '@tonyai/shared-types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { AccessAdminService } from '../../src/auth/access-admin.service';
import { MailService, type MailConfig, type MailTransport } from '../../src/mail/mail.service';
import { OnboardingOperator } from '../../src/onboarding/onboarding-operator';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { AuthAdminService } from '../../src/users/auth-admin.service';
import { AuthSyncService } from '../../src/users/auth-sync.service';
import { InvitationDeliveryService } from '../../src/users/invitation-delivery.service';
import { PasswordResetService } from '../../src/users/password-reset.service';
import { readRegistrationConfig } from '../../src/users/registration-config';
import {
  REGISTRATION_COOLDOWN_SECONDS,
  REGISTRATION_MAX_DELIVERIES,
  RegistrationService,
  type RegistrationJob,
} from '../../src/users/registration.service';
import { UserLifecycleService } from '../../src/users/user-lifecycle.service';
import { UsersQueryService } from '../../src/users/users-query.service';
import { connect, connectOwner, createTenant, TENANT_ORG_PREFIX, type Tenant } from './db';

/**
 * Self-service registration against the real database on the RUNTIME role —
 * the column-level INSERT on `organisations`, `profiles.job_title` and
 * `consents` either suffice here or the feature fails in production — and the
 * local stack's real Supabase Auth. Email goes to an in-memory transport.
 */

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  throw new Error(
    'The registration tests need the local Supabase Auth: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (`set -a; source apps/api/.env; set +a`). CI exports both.',
  );
}
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('refusing a non-local SUPABASE_URL');
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }).auth.admin;
const browser = () =>
  createClient(url, process.env.SUPABASE_ANON_KEY ?? serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const MAIL: MailConfig = { host: '127.0.0.1', port: 2525, secure: false, from: 'TonyAI <int@tonyai.test>', appUrl: 'http://localhost:3000' };
const CONFIG = readRegistrationConfig({ REGISTRATION_CODE: 'aB3x9', REGISTRATION_ALLOW_PLACEHOLDER_CONSENT: 'true' } as NodeJS.ProcessEnv);
type Sent = { to: string; subject: string; text: string; html: string };
function inbox() {
  const sent: Sent[] = [];
  const transport: MailTransport = { sendMail: vi.fn(async (m: Sent) => { sent.push(m); return {} as never; }) as never };
  return { sent, transport };
}
const failingTransport: MailTransport = { sendMail: vi.fn(async () => { throw Object.assign(new Error('boom'), { responseCode: 554 }); }) as never };
const tokenIn = (mail: Sent): string => /token_hash=([A-Za-z0-9_-]+)&type=invite/.exec(mail.text)![1];

let runtime: PrismaService;
let owner: PrismaService;
let A: Tenant;
let tag: string;
let counter = 0;
const address = () => `int-reg${++counter}-${tag}@tonyai.test`;
const company = (label = '') => `${TENANT_ORG_PREFIX}registration ${tag} ${label}${counter}`;

function wire(transport: MailTransport | null, db: PrismaService = runtime) {
  const audit = new AuditService(db);
  const access = new AccessAdminService(db, audit);
  const authAdmin = new AuthAdminService();
  const authSync = new AuthSyncService(authAdmin);
  const delivery = new InvitationDeliveryService(authAdmin, new MailService(transport ?? undefined, transport ? MAIL : null), authSync);
  const registrations = new RegistrationService(db, access, delivery, {} as never, CONFIG);
  const lifecycle = new UserLifecycleService(db, access, delivery, authSync, new UsersQueryService(db), audit);
  return { registrations, access, delivery, lifecycle, audit };
}

function job(over: Partial<RegistrationJob> = {}): RegistrationJob {
  const email = over.email ?? address();
  return {
    firstName: 'Ada',
    lastName: 'Yilmaz',
    companyName: company(),
    jobTitle: 'Sustainability Manager',
    email,
    consentVersion: REGISTRATION_CONSENT_VERSION,
    language: 'tr',
    ...over,
  };
}

const profileOf = (email: string) =>
  owner.profile.findUnique({
    where: { email: email.toLowerCase() },
    include: { organisation: true, invitation: true, consents: true, subsidiaryAccess: true },
  });

/** Moves an invitation's clocks back past the cooldown, as the owner. */
async function pastCooldown(profileId: string): Promise<void> {
  await owner.$executeRaw`
    UPDATE invitations
    SET sent_at = sent_at - make_interval(secs => ${REGISTRATION_COOLDOWN_SECONDS + 5}),
        last_attempt_at = last_attempt_at - make_interval(secs => ${REGISTRATION_COOLDOWN_SECONDS + 5}),
        created_at = created_at - make_interval(secs => ${REGISTRATION_COOLDOWN_SECONDS + 5})
    WHERE profile_id = ${profileId}::uuid`;
}

const organisationsNamed = (legalName: string) => owner.organisation.count({ where: { legalName } });
const subsidiariesOf = (organisationId: string) =>
  owner.subsidiary.findMany({ where: { organisationId }, include: { locations: true, access: true, inventoryBoundaries: true } });

beforeAll(async () => {
  tag = randomUUID().slice(0, 8);
  runtime = connect(4);
  owner = connectOwner(2);
  A = await createTenant();
  const [{ user }] = await runtime.$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`;
  expect(user).toBe('tonyai_runtime');
}, 60_000);

afterAll(async () => {
  try {
    // Everything this file made carries its own markers: the address pattern and the company prefix.
    const profiles = await owner.profile.findMany({ where: { email: { startsWith: 'int-reg', endsWith: `-${tag}@tonyai.test` } }, select: { id: true } });
    const ids = profiles.map((p) => p.id);
    const orgs = await owner.organisation.findMany({ where: { legalName: { startsWith: `${TENANT_ORG_PREFIX}registration ${tag}` } }, select: { id: true } });
    const orgIds = orgs.map((o) => o.id);
    for (const id of ids) await admin.deleteUser(id).catch(() => undefined);
    await owner.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { userId: { in: ids } }, { organisationId: { in: orgIds } }] } });
    await owner.profile.deleteMany({ where: { id: { in: ids } } });
    await owner.organisation.deleteMany({ where: { id: { in: orgIds } } });
  } finally {
    await A?.cleanup();
    await runtime?.$disconnect();
    await owner?.$disconnect();
  }
}, 60_000);

describe('a new address — the organisation, its default subsidiary, its first administrator, the invitation and the consent', () => {
  it('writes all five on the runtime role, born as the pilot defaults say, and emails the self-registered wording', async () => {
    const { sent, transport } = inbox();
    const request = job({ firstName: ' Ada ', email: address().toUpperCase() });
    const before = new Date(Date.now() - 5_000);
    expect(await wire(transport).registrations.run(request)).toBe('sent');

    const profile = (await profileOf(request.email))!;
    expect(profile).toMatchObject({
      email: request.email.toLowerCase(),
      fullName: 'Ada Yilmaz',
      jobTitle: 'Sustainability Manager',
      role: UserRole.super_admin,
      language: 'tr',
      disabledAt: null,
    });
    expect(profile.organisation).toMatchObject({
      legalName: request.companyName,
      tradingName: null,
      country: 'TR',
      geographyCode: 'TR',
      reportingCurrency: 'TRY',
      offboardedAt: null,
    });
    expect(profile.subsidiaryAccess).toEqual([]);
    // K1: the company itself as its one subsidiary, so a facility can be added at once.
    const subsidiaries = await subsidiariesOf(profile.organisationId!);
    expect(subsidiaries).toHaveLength(1);
    expect(subsidiaries[0]).toMatchObject({
      legalName: request.companyName,
      tradingName: null,
      sector: null,
      geographyCode: 'TR',
      reportingStatus: 'pending',
      includedScopes: [1, 2],
      trackingGranularity: 'subsidiary',
      locations: [],
      access: [],
      inventoryBoundaries: [],
    });
    expect(profile.invitation).toMatchObject({ status: InvitationStatus.sent, invitedBy: null, language: 'tr', attempts: 1 });
    expect(profile.consents).toHaveLength(1);
    expect(profile.consents[0]).toMatchObject({ kind: 'kvkk_registration', textVersion: REGISTRATION_CONSENT_VERSION, language: 'tr' });
    // Stamped by the database, now — not a value the API chose.
    expect(profile.consents[0].acceptedAt.getTime()).toBeGreaterThan(before.getTime());

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(request.email.toLowerCase());
    expect(sent[0].subject).toBe("TonyAI'da şirket hesabınızın kurulumunu tamamlayın");
    // Nothing the registrant typed rides in the email.
    for (const typed of [request.companyName, 'Ada', 'Yilmaz']) expect(`${sent[0].subject}\n${sent[0].text}\n${sent[0].html}`).not.toContain(typed);
    expect(sent[0].text).toContain('kayıt formunu aynı e-posta adresiyle yeniden gönderin');
    expect(sent[0].text).not.toContain("TonyAI'dan yeni bir davet");
  });

  it('audits the four rows with no actor, and holds no name, address, job title or company', async () => {
    const request = job({ firstName: 'Zeynep', lastName: 'Karaca', jobTitle: 'Chief Carbon Officer' });
    await wire(inbox().transport).registrations.run(request);
    const profile = (await profileOf(request.email))!;
    const rows = await owner.auditLog.findMany({ where: { organisationId: profile.organisationId! }, orderBy: { createdAt: 'asc' } });
    const [{ id: subsidiaryId }] = await subsidiariesOf(profile.organisationId!);
    expect(rows.map((r) => [r.action, r.entity, r.entityId, r.userId, r.role])).toEqual(
      expect.arrayContaining([
        ['create', 'organisation', profile.organisationId, null, null],
        ['create', 'subsidiary', subsidiaryId, null, null],
        ['invite', 'invitation', profile.id, null, null],
        ['create', 'consent', profile.id, null, null],
      ]),
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) expect((row.diff as { source: string }).source).toBe('auth:registration');
    expect(rows.find((r) => r.entity === 'subsidiary')!.diff).toMatchObject({ default: true, geographyCode: 'TR', trackingGranularity: 'subsidiary' });
    const trail = JSON.stringify(rows.map((r) => r.diff)).toLowerCase();
    for (const personal of ['zeynep', 'karaca', 'carbon officer', request.email.toLowerCase(), request.companyName.toLowerCase()]) {
      expect(trail, personal).not.toContain(personal);
    }
  });

  it('the link signs the new administrator in, and the invitation is accepted as theirs', async () => {
    const { sent, transport } = inbox();
    const request = job({ language: 'en' });
    const { registrations, lifecycle } = wire(transport);
    await registrations.run(request);
    expect(sent[0].subject).toBe('Finish setting up your company on TonyAI');
    const session = await browser().auth.verifyOtp({ type: 'invite', token_hash: tokenIn(sent[0]) });
    expect(session.error).toBeNull();
    const profile = (await profileOf(request.email))!;
    expect(session.data.user?.id).toBe(profile.id);
    await lifecycle.accept({
      id: profile.id, email: profile.email, fullName: profile.fullName, role: profile.role,
      organisationId: profile.organisationId, accessibleSubsidiaryIds: [],
    });
    expect((await profileOf(request.email))!.invitation!.status).toBe(InvitationStatus.accepted);
  });

  it('a reset requested before the invitation is accepted carries nothing the registrant typed; after it, the name', async () => {
    const invited = inbox();
    const request = job({ firstName: 'Visit https://evil.example', lastName: 'now', language: 'en' });
    const { registrations, lifecycle } = wire(invited.transport);
    expect(await registrations.run(request)).toBe('sent');
    const profile = (await profileOf(request.email))!;
    expect(profile.fullName).toBe('Visit https://evil.example now');

    const resetWith = (transport: MailTransport) =>
      new PasswordResetService(runtime, new AuthAdminService(), new MailService(transport, MAIL), new AuditService(runtime), {} as never);
    const before = inbox();
    expect(await resetWith(before.transport).run(request.email)).toBe('sent');
    expect(before.sent).toHaveLength(1);
    expect(before.sent[0].text.split('\n')[0]).toBe('Hello,');
    for (const part of [before.sent[0].subject, before.sent[0].text, before.sent[0].html]) {
      expect(part).not.toContain('evil.example');
      expect(part).not.toContain(request.companyName);
    }

    // The address's owner follows that link and accepts: the account is theirs, and so is its name.
    const token = /token_hash=([A-Za-z0-9_-]+)&type=recovery/.exec(before.sent[0].text)![1];
    expect((await browser().auth.verifyOtp({ type: 'recovery', token_hash: token })).error).toBeNull();
    await lifecycle.accept({ id: profile.id, email: profile.email, fullName: profile.fullName, role: profile.role, organisationId: profile.organisationId, accessibleSubsidiaryIds: [] });
    await owner.profile.update({ where: { id: profile.id }, data: { recoverySentAt: null } }); // past the reset's own cooldown
    const after = inbox();
    expect(await resetWith(after.transport).run(request.email)).toBe('sent');
    expect(after.sent[0].text.split('\n')[0]).toBe('Hello Visit https://evil.example now,');
  });

  it('two companies with the same name are two organisations', async () => {
    const name = company('same-name ');
    const { registrations } = wire(inbox().transport);
    expect(await registrations.run(job({ companyName: name }))).toBe('sent');
    expect(await registrations.run(job({ companyName: name }))).toBe('sent');
    expect(await organisationsNamed(name)).toBe(2);
    // Each with its own subsidiary — never one shared across the two tenants.
    const subsidiaries = await owner.subsidiary.findMany({ where: { legalName: name }, select: { organisationId: true } });
    expect(new Set(subsidiaries.map((s) => s.organisationId)).size).toBe(2);
    expect(subsidiaries).toHaveLength(2);
  });

  it('two submissions of one new address at once create one organisation and send one email', async () => {
    const { sent, transport } = inbox();
    const request = job();
    const { registrations } = wire(transport);
    const outcomes = await Promise.all([registrations.run(request), registrations.run({ ...request })]);
    expect(outcomes.sort()).toEqual(['sent', 'skipped']);
    expect(await organisationsNamed(request.companyName)).toBe(1);
    expect(await owner.subsidiary.count({ where: { legalName: request.companyName } })).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('a failed email leaves the rows and records the step; nothing half-written', async () => {
    const request = job();
    expect(await wire(failingTransport).registrations.run(request)).toBe('failed');
    const profile = (await profileOf(request.email))!;
    expect(profile.invitation).toMatchObject({ status: InvitationStatus.pending, lastErrorStep: 'email', lastErrorCode: 'smtp_failed' });
    expect(profile.consents).toHaveLength(1);
    expect(profile.organisation).not.toBeNull();
  });

  it('a failure inside the transaction stores nothing — not the organisation either', async () => {
    const request = job();
    const audit = new AuditService(runtime);
    // The last write of the transaction fails: the consent's audit row.
    vi.spyOn(audit, 'recordSystem').mockImplementation(async (entry, tx) => {
      if (entry.entity === 'consent') throw new Error('injected');
      await AuditService.prototype.recordSystem.call(audit, entry, tx);
    });
    const access = new AccessAdminService(runtime, audit);
    await expect(
      access.registerOrganisation({
        email: request.email, fullName: 'Ada Yilmaz', jobTitle: request.jobTitle, companyName: request.companyName,
        language: 'tr', consentVersion: REGISTRATION_CONSENT_VERSION,
      }),
    ).rejects.toThrow('injected');
    expect(await profileOf(request.email)).toBeNull();
    expect(await organisationsNamed(request.companyName)).toBe(0);
    expect(await owner.subsidiary.count({ where: { legalName: request.companyName } })).toBe(0);
  });
});

describe('an address that is already known — the same job, no second organisation', () => {
  it('inside the cooldown nothing is sent; past it the same invitation goes out again with a fresh link, audited', async () => {
    const { sent, transport } = inbox();
    const request = job();
    const { registrations } = wire(transport);
    expect(await registrations.run(request)).toBe('sent');
    const profile = (await profileOf(request.email))!;
    const first = tokenIn(sent[0]);

    // Submitted again at once, with another company typed: ignored.
    expect(await registrations.run({ ...request, companyName: company('other ') , jobTitle: 'Someone Else' })).toBe('skipped');
    expect(sent).toHaveLength(1);

    await pastCooldown(profile.id);
    expect(await registrations.run({ ...request, companyName: company('other ') })).toBe('sent');
    expect(sent).toHaveLength(2);
    expect(tokenIn(sent[1])).not.toBe(first);
    const after = (await profileOf(request.email))!;
    expect(after.organisationId).toBe(profile.organisationId);
    expect(after.organisation!.legalName).toBe(request.companyName);
    expect(after.jobTitle).toBe('Sustainability Manager');
    expect(after.invitation).toMatchObject({ status: InvitationStatus.sent, attempts: 2 });
    expect(after.consents).toHaveLength(1);
    expect(await owner.organisation.count({ where: { legalName: { startsWith: `${TENANT_ORG_PREFIX}registration ${tag} other` } } })).toBe(0);
    // A re-submission creates no second subsidiary either.
    expect(await subsidiariesOf(profile.organisationId!)).toHaveLength(1);
    expect(await owner.subsidiary.count({ where: { legalName: { startsWith: `${TENANT_ORG_PREFIX}registration ${tag} other` } } })).toBe(0);
    const resends = await owner.auditLog.findMany({ where: { entityId: profile.id, entity: 'invitation', action: 'invite' }, orderBy: { createdAt: 'asc' } });
    expect(resends).toHaveLength(2);
    expect(resends[1]).toMatchObject({ userId: null, organisationId: profile.organisationId });
    expect(resends[1].diff).toMatchObject({ source: 'auth:registration', resend: true, before: { status: 'sent' } });
    // The new link works.
    expect((await browser().auth.verifyOtp({ type: 'invite', token_hash: tokenIn(sent[1]) })).error).toBeNull();
  });

  it('sends five emails to one address at most, however often the form comes back', async () => {
    const { sent, transport } = inbox();
    const request = job();
    const { registrations } = wire(transport);
    expect(await registrations.run(request)).toBe('sent');
    const { id } = (await profileOf(request.email))!;
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      await pastCooldown(id);
      outcomes.push(await registrations.run(request));
    }
    expect(outcomes).toEqual(['sent', 'sent', 'sent', 'sent', 'skipped', 'skipped']);
    expect(sent).toHaveLength(REGISTRATION_MAX_DELIVERIES);
    expect((await profileOf(request.email))!.invitation).toMatchObject({ status: InvitationStatus.sent, attempts: REGISTRATION_MAX_DELIVERIES });
    // The last link sent still works.
    expect((await browser().auth.verifyOtp({ type: 'invite', token_hash: tokenIn(sent[4]) })).error).toBeNull();
  });

  it('two re-submissions at once past the cooldown send one email', async () => {
    const { sent, transport } = inbox();
    const request = job();
    const { registrations } = wire(transport);
    await registrations.run(request);
    await pastCooldown((await profileOf(request.email))!.id);
    const outcomes = await Promise.all([registrations.run(request), registrations.run({ ...request })]);
    expect(outcomes.sort()).toEqual(['sent', 'skipped']);
    expect(sent).toHaveLength(2);
  });

  it('an accepted account gets nothing, however long ago', async () => {
    const { sent, transport } = inbox();
    const request = job();
    const { registrations, lifecycle } = wire(transport);
    await registrations.run(request);
    const profile = (await profileOf(request.email))!;
    expect((await browser().auth.verifyOtp({ type: 'invite', token_hash: tokenIn(sent[0]) })).error).toBeNull();
    await lifecycle.accept({ id: profile.id, email: profile.email, fullName: profile.fullName, role: profile.role, organisationId: profile.organisationId, accessibleSubsidiaryIds: [] });
    await pastCooldown(profile.id);
    const audits = await owner.auditLog.count({ where: { organisationId: profile.organisationId! } });
    expect(await registrations.run(request)).toBe('skipped');
    expect(sent).toHaveLength(1);
    expect(await owner.auditLog.count({ where: { organisationId: profile.organisationId! } })).toBe(audits);
  });

  it('a disabled registrant, and one of an offboarded organisation, get nothing', async () => {
    const { sent, transport } = inbox();
    const { registrations } = wire(transport);
    const disabled = job();
    await registrations.run(disabled);
    const d = (await profileOf(disabled.email))!;
    await pastCooldown(d.id);
    await owner.profile.update({ where: { id: d.id }, data: { disabledAt: new Date() } });
    const trail = (organisationId: string) => owner.auditLog.count({ where: { organisationId } });
    const disabledTrail = await trail(d.organisationId!);
    expect(await registrations.run(disabled)).toBe('skipped');
    // Not re-opened and not audited: the refusal is the claim's own, not only delivery's.
    expect((await profileOf(disabled.email))!.invitation).toMatchObject({ status: InvitationStatus.sent, attempts: 1 });
    expect(await trail(d.organisationId!)).toBe(disabledTrail);

    const offboarded = job();
    await registrations.run(offboarded);
    const o = (await profileOf(offboarded.email))!;
    await pastCooldown(o.id);
    await owner.organisation.update({ where: { id: o.organisationId! }, data: { offboardedAt: new Date() } });
    const offboardedTrail = await trail(o.organisationId!);
    expect(await registrations.run(offboarded)).toBe('skipped');
    expect((await profileOf(offboarded.email))!.invitation).toMatchObject({ status: InvitationStatus.sent, attempts: 1 });
    expect(await trail(o.organisationId!)).toBe(offboardedTrail);
    expect(sent).toHaveLength(2); // the two first emails only
  });

  it('never re-sends an invitation registration did not create: an administrator’s invitee, or the operator’s first administrator', async () => {
    const { sent, transport } = inbox();
    const { registrations, lifecycle } = wire(transport);

    const invitee = address();
    const invited = await lifecycle.invite(A.users.superAdmin, { email: invitee, fullName: 'Invited Person', role: UserRole.consultant, language: 'en', subsidiaryIds: [] });
    await pastCooldown(invited.id);

    const provisioned = address();
    const operator = new OnboardingOperator(owner, 'int-operator@tonyai.test', wire(transport, owner).delivery, new AuthSyncService(new AuthAdminService()));
    const report = await operator.provision(
      { organisation: { legalName: company('operator '), country: 'TR', geographyCode: 'TR', reportingCurrency: 'TRY' }, adminEmail: provisioned, adminName: 'Provisioned Admin', language: 'en' },
      true,
    );
    await pastCooldown(report.admin.id!);
    expect(sent).toHaveLength(2);
    // The operator's first administrator still reads the provisioned wording.
    expect(sent[1].text).toContain('ask TonyAI');

    for (const email of [invitee, provisioned]) {
      expect(await registrations.run(job({ email }))).toBe('skipped');
    }
    expect(sent).toHaveLength(2);
    expect((await profileOf(invitee))!.organisationId).toBe(A.organisationId);
  });
});

describe('through the HTTP API — the public routes, the switch and the answers', () => {
  let base: string;
  let close: () => Promise<void>;

  async function start(env: Record<string, string | undefined>): Promise<void> {
    process.env.DATABASE_URL = process.env.INT_RUNTIME_DATABASE_URL;
    process.env.STORAGE_SWEEP_INTERVAL_SECONDS = '0';
    // No mail: a delivery stops at `mail_not_configured`, which is all these need.
    for (const k of ['SMTP_HOST', 'MAIL_FROM', 'APP_URL']) delete process.env[k];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../../src/app.module');
    const { configureApp } = await import('../../src/app-setup');
    const { JsonLogger } = await import('../../src/observability/json-logger');
    const { RuntimeLimits } = await import('../../src/common/runtime-limits');
    const app = await NestFactory.create(AppModule, { logger: ['error'] });
    configureApp(app, Object.assign(new JsonLogger(), { event: () => undefined }), { requestLogging: false });
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/v1`.replace('[::1]', '127.0.0.1');
    close = async () => {
      // Let a registration the 202 left running finish before the pool closes.
      await app.get(RuntimeLimits, { strict: false }).settle();
      await app.close();
    };
  }
  const call = async (method: string, body?: unknown) => {
    const res = await fetch(`${base}/auth/registration`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : undefined };
  };
  const form = (over: Record<string, unknown> = {}) => ({ ...job(), registrationCode: 'aB3x9', consent: true, ...over });

  describe('with no registration code configured', () => {
    // Empty, not deleted: the app's ConfigModule reads apps/api/.env, where a
    // developer's local code would otherwise come back. Empty is "no code".
    beforeAll(() => start({ REGISTRATION_CODE: '' }), 60_000);
    afterAll(() => close());

    it('answers 404 to the status, to a valid submission and to a malformed one alike — and creates nothing', async () => {
      const valid = form();
      for (const answer of [await call('GET'), await call('POST', valid), await call('POST', { nonsense: true })]) {
        expect(answer).toMatchObject({ status: 404, body: { code: 'registration_unavailable' } });
      }
      expect(await profileOf(valid.email)).toBeNull();
      expect(await organisationsNamed(valid.companyName)).toBe(0);
    });
  });

  describe('with a registration code', () => {
    beforeAll(
      () => start({ REGISTRATION_CODE: 'aB3x9', REGISTRATION_ALLOW_PLACEHOLDER_CONSENT: 'true', AUTH_EMAIL_PER_IP_PER_MINUTE: '6' }),
      60_000,
    );
    afterAll(() => close());

    it('serves the notice version without a token', async () => {
      expect(await call('GET')).toMatchObject({ status: 200, body: { consentVersion: REGISTRATION_CONSENT_VERSION, consentIsPlaceholder: true } });
    });

    it('refuses a submission without the consent, or naming another notice, as a validation error — nothing created', async () => {
      const refused = form({ consent: false });
      expect(await call('POST', refused)).toMatchObject({ status: 400, body: { code: 'validation_failed' } });
      expect(await call('POST', form({ consentVersion: 'v0' }))).toMatchObject({ status: 400, body: { code: 'validation_failed' } });
      expect(await call('POST', form({ email: 'nope' }))).toMatchObject({ status: 400 });
      // Valid by the RFC, refused by Supabase Auth: stopped here, before an organisation exists.
      const quoted = form({ email: `"int-reg-quoted-${tag}"@tonyai.test` });
      expect(await call('POST', quoted)).toMatchObject({ status: 400, body: { code: 'validation_failed' } });
      expect(await organisationsNamed(quoted.companyName)).toBe(0);
      expect(await profileOf(refused.email)).toBeNull();
      // K1: the default subsidiary carries the name, and a subsidiary's needs two characters.
      const tooShort = form({ companyName: ' X ' });
      expect(await call('POST', tooShort)).toMatchObject({ status: 400, body: { code: 'validation_failed' } });
      expect(await profileOf(tooShort.email)).toBeNull();
      expect(await organisationsNamed('X')).toBe(0);
    });

    it('answers a new address and a known one the same 202 with no body, and the work follows the answer', async () => {
      const first = form();
      const fresh = await call('POST', first);
      expect(fresh).toEqual({ status: 202, text: '', body: undefined });
      // The same address again — now known — and one that has long had an account.
      const again = await call('POST', first);
      const active = await call('POST', form({ email: A.users.consultant.email }));
      expect(again).toEqual(fresh);
      expect(active).toEqual(fresh);

      const deadline = Date.now() + 10_000;
      while (!(await profileOf(first.email))?.invitation?.lastErrorCode && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const profile = (await profileOf(first.email))!;
      expect(profile.role).toBe(UserRole.super_admin);
      expect(profile.invitation).toMatchObject({ status: InvitationStatus.pending, lastErrorStep: 'email', lastErrorCode: 'mail_not_configured' });
      expect(await organisationsNamed(first.companyName)).toBe(1);
      // The active account is untouched.
      expect((await profileOf(A.users.consultant.email))!.organisationId).toBe(A.organisationId);
    });

    it('refuses a wrong code in words — a different letter case included — then 429 once the client address has spent its quota', async () => {
      const wrongCase = form({ registrationCode: 'AB3X9' });
      // However much of the six a minute the tests above spent, these fit when
      // this test runs alone and when it runs after them.
      for (const body of [wrongCase, form({ registrationCode: 'zzzzz' }), form({ registrationCode: '' })]) {
        expect(await call('POST', body)).toMatchObject({ status: 403, body: { code: 'registration_code_invalid' } });
      }
      expect(await profileOf(wrongCase.email)).toBeNull();
      // Wrong codes spend the rest: each is refused in words until the quota answers.
      let spent = 0;
      for (; spent < 6; spent += 1) {
        const answer = await call('POST', form({ registrationCode: 'zzzzz' }));
        if (answer.status === 429) break;
        expect(answer).toMatchObject({ status: 403, body: { code: 'registration_code_invalid' } });
      }
      expect(spent).toBeLessThan(6);
      // Past the quota even the right code waits.
      const late = form();
      expect((await call('POST', late)).status).toBe(429);
      expect(await profileOf(late.email)).toBeNull();
    });
  });
});
