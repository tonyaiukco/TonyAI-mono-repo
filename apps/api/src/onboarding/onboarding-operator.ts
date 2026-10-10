import { randomUUID } from 'node:crypto';
import { InvitationStatus, type Prisma, type PrismaClient, UserRole } from '@tonyai/db';
import type { Locale } from '@tonyai/shared-types';
import { AuditService } from '../audit/audit.service';
import { lockTenantAdmin, normaliseEmail } from '../auth/access-admin.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthSyncService } from '../users/auth-sync.service';
import type { DeliveryOutcome, InvitationDeliveryService } from '../users/invitation-delivery.service';

/** A refusal the operator must act on (wrong address, wrong organisation…). */
export class OperatorRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorRefusal';
  }
}

export interface NewOrganisation {
  legalName: string;
  tradingName?: string;
  country: string;
  geographyCode: string;
  reportingCurrency: string;
  sector?: string;
}

export interface ProvisionInput {
  /** An existing organisation to add a first administrator to; else `organisation` is created. */
  organisationId?: string;
  organisation?: NewOrganisation;
  adminEmail: string;
  adminName: string;
  language: Locale;
}

export interface ProvisionReport {
  applied: boolean;
  organisation: { id: string | null; created: boolean };
  /** `invitation` as found before this run. */
  admin: { id: string | null; created: boolean; invitation: InvitationStatus | 'none' | 'new' };
  /** A sent, unaccepted invitation re-opened and sent again with a fresh link. */
  resent: boolean;
  delivery: DeliveryOutcome | null;
}

export interface OffboardReport {
  applied: boolean;
  organisationId: string;
  offboardedAt: string | null;
  disabled: number;
  invitationsRevoked: number;
  authPending: string[];
}

export interface ReconcileReport {
  applied: boolean;
  authPending: string[];
  authApplied: string[];
  undeliveredInvitations: { profileId: string; organisationId: string | null; step: string | null; code: string | null; attempts: number }[];
}

/**
 * The operator's side of D18 and K6 (`pnpm onboarding …`): provisioning an
 * organisation and its first administrator, offboarding one, and retrying
 * Supabase Auth steps left pending. Runs on the OWNER's connection
 * (`DIRECT_URL`) — the runtime role may neither create an organisation nor
 * mark one offboarded — and audits each change with a null `userId` and the
 * operator in the diff. Every command is idempotent: a re-run completes what
 * a failed one left half done, and changes nothing that is already right.
 */
export class OnboardingOperator {
  private readonly audit: AuditService;

  constructor(
    private readonly db: PrismaClient,
    private readonly operator: string,
    private readonly delivery: InvitationDeliveryService,
    private readonly authSync: AuthSyncService,
  ) {
    this.audit = new AuditService(db as unknown as PrismaService);
  }

  /**
   * The guards on `organisations` and on records admit the tables' owner by
   * `session_user` (LP4-01 PR A) — a login that SET ROLEs to it would be
   * refused half-way, so the run refuses before it starts ("LP4-01
   * follow-ups" (5)). After a restore under another owner this fails closed.
   */
  async assertOwner(): Promise<void> {
    // Every table in `public` — the operator writes several, and the guards
    // sit on others it reaches (a profile's grants, an organisation's tree).
    const rows = await this.db.$queryRaw<{ relname: string; owner: string; login: string; acting: string }[]>`
      SELECT c.relname::text AS relname, pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
             session_user::text AS login, current_user::text AS acting
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       ORDER BY c.relname`;
    if (!rows.some((r) => r.relname === 'invitations')) {
      throw new OperatorRefusal('The onboarding tables are missing — is every migration applied?');
    }
    for (const row of rows) {
      if (row.login !== row.owner || row.acting !== row.owner) {
        throw new OperatorRefusal(
          `Connect as the tables' owner: public.${row.relname} belongs to ${row.owner}, this login is ${row.login}` +
            (row.acting !== row.login ? ` acting as ${row.acting}` : '') +
            ' (DIRECT_URL, not the runtime role and not a SET ROLE).',
        );
      }
    }
  }

  private operatorDiff(source: string, extra: Record<string, unknown> = {}) {
    return { ...extra, operator: this.operator, source: `onboarding:${source}` };
  }

  async provision(input: ProvisionInput, apply: boolean): Promise<ProvisionReport> {
    await this.assertOwner();
    const email = normaliseEmail(input.adminEmail);
    const existing = await this.db.profile.findUnique({
      where: { email },
      select: {
        id: true,
        role: true,
        organisationId: true,
        organisation: { select: { id: true, legalName: true, offboardedAt: true } },
        invitation: { select: { status: true } },
      },
    });

    if (existing) {
      // A re-run, or an address already in use: never re-point it (D17).
      const org = existing.organisation;
      if (!org) throw new OperatorRefusal('That address has a profile with no organisation; it cannot be provisioned.');
      if (input.organisationId && input.organisationId !== org.id) {
        throw new OperatorRefusal('That address already belongs to another organisation (D17: one organisation per account).');
      }
      if (!input.organisationId && input.organisation && input.organisation.legalName !== org.legalName) {
        throw new OperatorRefusal('That address already belongs to another organisation (D17: one organisation per account).');
      }
      if (org.offboardedAt) throw new OperatorRefusal('That organisation is offboarded.');
      if (existing.role !== UserRole.super_admin) {
        throw new OperatorRefusal(`That address is already a ${existing.role} of the organisation; its administrators change roles in the app.`);
      }
      const invitation = existing.invitation?.status ?? 'none';
      // A sent invitation not yet accepted is sent again — its link may have
      // expired, and the first administrator has nobody else to ask (the
      // email tells them to ask TonyAI). Pending: the last delivery did not
      // finish. Accepted, revoked or none: nothing to send.
      const resend = invitation === InvitationStatus.sent;
      if (!apply || (invitation !== InvitationStatus.pending && !resend)) {
        return { applied: apply, organisation: { id: org.id, created: false }, admin: { id: existing.id, created: false, invitation }, resent: false, delivery: null };
      }
      if (resend) {
        await this.db.$transaction(async (tx) => {
          const { count } = await tx.invitation.updateMany({
            where: { profileId: existing.id, status: InvitationStatus.sent },
            data: { status: InvitationStatus.pending },
          });
          if (count === 0) return; // accepted or revoked in the meantime
          await this.audit.recordSystem(
            {
              organisationId: org.id,
              action: 'invite',
              entity: 'invitation',
              entityId: existing.id,
              diff: this.operatorDiff('provision', { resend: true, before: { status: InvitationStatus.sent } }),
            },
            tx,
          );
        });
      }
      const delivery = await this.delivery.deliver(this.db, existing.id);
      return { applied: true, organisation: { id: org.id, created: false }, admin: { id: existing.id, created: false, invitation }, resent: resend, delivery };
    }

    let organisationId = input.organisationId ?? null;
    if (organisationId) {
      const org = await this.db.organisation.findUnique({ where: { id: organisationId }, select: { offboardedAt: true } });
      if (!org) throw new OperatorRefusal('No organisation has that id.');
      if (org.offboardedAt) throw new OperatorRefusal('That organisation is offboarded.');
    } else if (!input.organisation) {
      throw new OperatorRefusal('Name the organisation to create, or --organisation-id of an existing one.');
    }
    if (!apply) {
      return {
        applied: false,
        organisation: { id: organisationId, created: !organisationId },
        admin: { id: null, created: true, invitation: 'new' },
        resent: false,
        delivery: null,
      };
    }

    const profileId = randomUUID();
    const createOrganisation = !organisationId;
    organisationId = await this.db.$transaction(async (tx) => {
      let orgId = organisationId;
      if (!orgId) {
        const o = input.organisation!;
        const created = await tx.organisation.create({
          data: {
            legalName: o.legalName,
            tradingName: o.tradingName ?? null,
            country: o.country,
            geographyCode: o.geographyCode,
            reportingCurrency: o.reportingCurrency,
            sector: o.sector ?? null,
          },
          select: { id: true },
        });
        orgId = created.id;
        await this.audit.recordSystem(
          {
            organisationId: orgId,
            action: 'create',
            entity: 'organisation',
            entityId: orgId,
            diff: this.operatorDiff('provision', { country: o.country, geographyCode: o.geographyCode, reportingCurrency: o.reportingCurrency }),
          },
          tx,
        );
      }
      await tx.profile.create({
        data: { id: profileId, email, fullName: input.adminName.trim(), role: UserRole.super_admin, language: input.language, organisationId: orgId },
      });
      await tx.invitation.create({ data: { profileId, language: input.language, invitedBy: null } });
      await this.audit.recordSystem(
        {
          organisationId: orgId,
          action: 'invite',
          entity: 'invitation',
          entityId: profileId,
          diff: this.operatorDiff('provision', { role: UserRole.super_admin, language: input.language, subsidiaryIds: [] }),
        },
        tx,
      );
      return orgId;
    });
    const delivery = await this.delivery.deliver(this.db, profileId);
    return {
      applied: true,
      organisation: { id: organisationId, created: createOrganisation },
      admin: { id: profileId, created: true, invitation: 'new' },
      resent: false,
      delivery,
    };
  }

  async offboard(organisationId: string, apply: boolean): Promise<OffboardReport> {
    await this.assertOwner();
    const org = await this.db.organisation.findUnique({ where: { id: organisationId }, select: { offboardedAt: true } });
    if (!org) throw new OperatorRefusal('No organisation has that id.');
    const members = await this.db.profile.findMany({
      where: { organisationId },
      select: { id: true, disabledAt: true },
      orderBy: { id: 'asc' },
    });
    const toDisable = members.filter((m) => !m.disabledAt).map((m) => m.id);
    if (!apply) {
      const pending = await this.pendingIn(organisationId);
      return {
        applied: false,
        organisationId,
        offboardedAt: org.offboardedAt?.toISOString() ?? null,
        disabled: toDisable.length,
        invitationsRevoked: 0,
        authPending: pending,
      };
    }
    const { offboardedAt, revoked, disabled } = await this.db.$transaction(async (tx) => {
      // The tenant administrators' lock: an invitation or an enable that is in
      // flight finishes first, and none starts until this commits — so no
      // member is left enabled (and unbanned) in an offboarded organisation.
      await lockTenantAdmin(tx, organisationId);
      const enabled = (
        await tx.profile.findMany({ where: { organisationId, disabledAt: null }, select: { id: true }, orderBy: { id: 'asc' } })
      ).map((m) => m.id);
      const now = new Date();
      let at = (await tx.organisation.findUniqueOrThrow({ where: { id: organisationId }, select: { offboardedAt: true } })).offboardedAt;
      if (!at) {
        // Conditional: two operators at once record one offboarding.
        const { count } = await tx.organisation.updateMany({ where: { id: organisationId, offboardedAt: null }, data: { offboardedAt: now } });
        if (count === 1) {
          at = now;
          await this.audit.recordSystem(
            { organisationId, action: 'offboard', entity: 'organisation', entityId: organisationId, diff: this.operatorDiff('offboard') },
            tx,
          );
        }
      }
      let invitationsRevoked = 0;
      for (const id of enabled) {
        const { count } = await tx.profile.updateMany({
          where: { id, organisationId, disabledAt: null },
          data: { disabledAt: now, authSyncPendingSince: now },
        });
        if (count === 0) continue;
        const r = await tx.invitation.updateMany({
          where: { profileId: id, status: { in: [InvitationStatus.pending, InvitationStatus.sent] } },
          data: { status: InvitationStatus.revoked, revokedAt: now },
        });
        invitationsRevoked += r.count;
        await this.audit.recordSystem(
          {
            organisationId,
            action: 'disable',
            entity: 'profile',
            entityId: id,
            diff: this.operatorDiff('offboard', { invitationRevoked: r.count > 0 }),
          },
          tx,
        );
      }
      return { offboardedAt: at, revoked: invitationsRevoked, disabled: enabled.length };
    });
    for (const id of await this.pendingIn(organisationId)) await this.authSync.apply(this.db, id);
    return {
      applied: true,
      organisationId,
      offboardedAt: offboardedAt?.toISOString() ?? null,
      disabled,
      invitationsRevoked: revoked,
      authPending: await this.pendingIn(organisationId),
    };
  }

  async reconcile(organisationId: string | undefined, apply: boolean): Promise<ReconcileReport> {
    await this.assertOwner();
    const before = await this.pendingIn(organisationId);
    const authApplied: string[] = [];
    if (apply) {
      for (const id of before) if (await this.authSync.apply(this.db, id)) authApplied.push(id);
    }
    const where: Prisma.InvitationWhereInput = {
      status: InvitationStatus.pending,
      ...(organisationId ? { profile: { organisationId } } : {}),
    };
    const undelivered = await this.db.invitation.findMany({
      where,
      select: {
        profileId: true,
        lastErrorStep: true,
        lastErrorCode: true,
        attempts: true,
        profile: { select: { organisationId: true } },
      },
      orderBy: { profileId: 'asc' },
    });
    return {
      applied: apply,
      authPending: apply ? await this.pendingIn(organisationId) : before,
      authApplied,
      // Re-sending is an administrator's act (the users screen) — listed here,
      // not sent: an operator run must not mail a tenant's people unasked.
      undeliveredInvitations: undelivered.map((i) => ({
        profileId: i.profileId,
        organisationId: i.profile.organisationId,
        step: i.lastErrorStep,
        code: i.lastErrorCode,
        attempts: i.attempts,
      })),
    };
  }

  private async pendingIn(organisationId: string | undefined): Promise<string[]> {
    const rows = await this.db.profile.findMany({
      where: { authSyncPendingSince: { not: null }, ...(organisationId ? { organisationId } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }
}
