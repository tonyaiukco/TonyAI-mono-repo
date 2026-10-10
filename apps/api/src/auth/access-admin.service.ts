import { createHash, randomUUID } from 'node:crypto';
import { ResourceNotFoundError } from '../common/api-error';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InvitationStatus, Prisma, UserRole as DbUserRole } from '@tonyai/db';
import { isLocale, type Locale, type UserRole } from '@tonyai/shared-types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AccessRoleMismatchError,
  AccountDisabledError,
  EmailUnavailableError,
  InvitationClosedError,
  OwnAccountError,
  UserDisabledError,
} from './access-errors';
import type { RequestUser } from './auth.types';

/** What an administrator invites (LP4-01) — validated by the DTO, re-checked here. */
export interface InviteMember {
  email: string;
  fullName: string;
  role: UserRole;
  language: Locale;
  subsidiaryIds: string[];
}

/** The outcome of a disable or enable: whether anything changed. */
export interface EnabledChange {
  changed: boolean;
}

/**
 * The one boundary through which a tenant's roles and subsidiary grants change
 * (LP1-03, F06/F07). LP4-01's onboarding screens and invitation flow call it;
 * nothing else writes `profiles.role` or `user_subsidiary_access`.
 *
 * The rules, each enforced here and — where the database can — again below:
 *  - Only a `super_admin` of an organisation administers it. There is no
 *    cross-tenant administrator: every lookup is bounded by the actor's own
 *    organisation, and an id from another tenant answers 404, exactly as an id
 *    that does not exist (no existence oracle).
 *  - A grant joins a profile and a subsidiary of the SAME organisation — the
 *    composite foreign keys on `user_subsidiary_access` refuse anything else,
 *    whoever writes it.
 *  - A profile never changes organisation (D17): the runtime database role may
 *    UPDATE only `profiles.role`, so not even a bug here could move one.
 *  - Nobody changes their own role, so an organisation is never left without a
 *    `super_admin` by its last one, and nobody promotes themselves.
 *  - The actor is re-read under a per-organisation lock, so an administrator
 *    demoted a moment ago cannot act on the stale role their request was
 *    authenticated with, and two administrators cannot demote each other at
 *    once.
 *  - Only data_entry users hold grants: a user moved to another role loses them,
 *    each withdrawal audited, so a later move back to data_entry starts with
 *    nothing rather than silently regaining old access.
 *  - Every change writes its audit row in the same transaction.
 *  - LP4-01: an invitation creates its profile, grants and invitation row here
 *    in one transaction (the database first; Auth and the email follow, in
 *    `users/`). Nobody disables their own account, and a disabled actor is
 *    refused under the lock — so an organisation always keeps an active
 *    `super_admin`: the actor, who is one and is never the target.
 *
 * Organisations and first administrators are provisioned by the operator, not
 * through this service (D18; `pnpm onboarding provision`).
 */
@Injectable()
export class AccessAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Grants `subsidiaryId` to the data_entry user `profileId`. Idempotent. */
  async grantSubsidiaryAccess(actor: RequestUser, rawProfileId: string, rawSubsidiaryId: string): Promise<void> {
    const organisationId = assertTenantAdmin(actor);
    const profileId = canonicalId(rawProfileId);
    const subsidiaryId = canonicalId(rawSubsidiaryId);
    await this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId);
      const target = await findMember(tx, organisationId, profileId);
      if (target.role !== DbUserRole.data_entry) {
        // The guard ignores grants for organisation-wide roles; storing one would
        // silently widen that user's access if their role later changed.
        throw new AccessRoleMismatchError();
      }
      const subsidiary = await tx.subsidiary.findFirst({
        where: { id: subsidiaryId, organisationId },
        select: { id: true },
      });
      if (!subsidiary) throw new ResourceNotFoundError('subsidiary_not_found');

      const existing = await tx.userSubsidiaryAccess.findUnique({
        where: { userId_subsidiaryId: { userId: profileId, subsidiaryId } },
        select: { userId: true },
      });
      if (existing) return;

      try {
        await tx.userSubsidiaryAccess.create({ data: { userId: profileId, subsidiaryId, organisationId } });
      } catch (err) {
        // The subsidiary (or profile) was deleted after the lookup above — a
        // subsidiary delete does not take this lock. The same answer as a miss.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
          throw new ResourceNotFoundError('subsidiary_not_found');
        }
        throw err;
      }
      await this.audit.record(
        admin,
        { action: 'create', entity: 'subsidiary_access', entityId: profileId, diff: { subsidiaryId } },
        tx,
      );
    });
  }

  /** Withdraws `subsidiaryId` from `profileId`. 404 when no such grant exists in the actor's organisation. */
  async revokeSubsidiaryAccess(actor: RequestUser, rawProfileId: string, rawSubsidiaryId: string): Promise<void> {
    const organisationId = assertTenantAdmin(actor);
    const profileId = canonicalId(rawProfileId);
    const subsidiaryId = canonicalId(rawSubsidiaryId);
    await this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId);
      const { count } = await tx.userSubsidiaryAccess.deleteMany({
        where: { userId: profileId, subsidiaryId, organisationId },
      });
      if (count === 0) throw new ResourceNotFoundError('access_grant_not_found');
      await this.audit.record(
        admin,
        { action: 'delete', entity: 'subsidiary_access', entityId: profileId, diff: { subsidiaryId } },
        tx,
      );
    });
  }

  /** Changes the role of `profileId`, a member of the actor's organisation other than the actor. */
  async setRole(actor: RequestUser, rawProfileId: string, role: UserRole): Promise<void> {
    const organisationId = assertTenantAdmin(actor);
    const profileId = canonicalId(rawProfileId);
    if (!(Object.values(DbUserRole) as string[]).includes(role)) throw new BadRequestException('Unknown role');
    if (profileId === actor.id) throw new OwnAccountError('role');
    await this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId);
      const target = await findMember(tx, organisationId, profileId);
      if (target.role === role) return;
      await tx.profile.update({ where: { id: profileId }, data: { role } });
      await this.audit.record(
        admin,
        { action: 'update', entity: 'profile', entityId: profileId, diff: { before: { role: target.role }, after: { role } } },
        tx,
      );
      if (target.role === DbUserRole.data_entry) {
        // One statement, so the audit names exactly the grants it removed — a
        // subsidiary deleted (or a grant added by the seed) between a read and
        // a delete would otherwise be audited without being removed, or the
        // reverse (`security-rls` round 2).
        const grants = await tx.$queryRaw<{ subsidiaryId: string }[]>`
          DELETE FROM user_subsidiary_access
          WHERE user_id = ${profileId}::uuid AND organisation_id = ${organisationId}::uuid
          RETURNING subsidiary_id::text AS "subsidiaryId"`;
        grants.sort((x, y) => x.subsidiaryId.localeCompare(y.subsidiaryId));
        for (const { subsidiaryId } of grants) {
          await this.audit.record(
            admin,
            {
              action: 'delete',
              entity: 'subsidiary_access',
              entityId: profileId,
              diff: { subsidiaryId, reason: `role changed from data_entry to ${role}` },
            },
            tx,
          );
        }
      }
    });
  }

  /**
   * Replaces the data_entry user's grants with exactly `subsidiaryIds` (an
   * access screen's whole set, rather than grant/revoke pairs). Each grant
   * added or withdrawn is audited on its own, as with the single calls.
   */
  async replaceSubsidiaryAccess(actor: RequestUser, rawProfileId: string, subsidiaryIds: string[]): Promise<void> {
    const organisationId = assertTenantAdmin(actor);
    const profileId = canonicalId(rawProfileId);
    const wanted = [...new Set(subsidiaryIds.map(canonicalId))].sort();
    await this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId);
      const target = await findMember(tx, organisationId, profileId);
      if (target.role !== DbUserRole.data_entry) {
        if (wanted.length === 0) return; // nothing to hold, nothing held
        throw new AccessRoleMismatchError();
      }
      await assertSubsidiaries(tx, organisationId, wanted);
      const held = (
        await tx.userSubsidiaryAccess.findMany({
          where: { userId: profileId, organisationId },
          select: { subsidiaryId: true },
        })
      ).map((g) => g.subsidiaryId);
      const removed = held.filter((id) => !wanted.includes(id)).sort();
      const added = wanted.filter((id) => !held.includes(id));
      if (removed.length) {
        await tx.userSubsidiaryAccess.deleteMany({
          where: { userId: profileId, organisationId, subsidiaryId: { in: removed } },
        });
      }
      for (const subsidiaryId of removed) {
        await this.audit.record(
          admin,
          { action: 'delete', entity: 'subsidiary_access', entityId: profileId, diff: { subsidiaryId } },
          tx,
        );
      }
      await createGrants(tx, profileId, organisationId, added);
      for (const subsidiaryId of added) {
        await this.audit.record(
          admin,
          { action: 'create', entity: 'subsidiary_access', entityId: profileId, diff: { subsidiaryId } },
          tx,
        );
      }
    });
  }

  /**
   * LP4-01: creates an invited account — its profile (the Auth user's id
   * chosen here, so the database is written before Auth, K4), its grants and
   * its invitation — in one audited transaction. Delivery (the Auth user, the
   * link, the email) follows outside it and is retried from the invitation's
   * state. The audit names the role, language and grants, never the address
   * or the name: the trail has no correction path (D20).
   */
  async inviteMember(actor: RequestUser, input: InviteMember): Promise<{ profileId: string }> {
    const organisationId = assertTenantAdmin(actor);
    if (!(Object.values(DbUserRole) as string[]).includes(input.role)) throw new BadRequestException('Unknown role');
    if (!isLocale(input.language)) throw new BadRequestException('Unsupported language');
    const email = normaliseEmail(input.email);
    const subsidiaryIds = [...new Set(input.subsidiaryIds.map(canonicalId))].sort();
    if (input.role !== DbUserRole.data_entry && subsidiaryIds.length) throw new AccessRoleMismatchError();
    const profileId = randomUUID();
    try {
      await this.prisma.$transaction(async (tx) => {
        const admin = await lockAndReadActor(tx, actor, organisationId);
        // D17: one organisation per account — an address with a profile anywhere
        // is unavailable. The unique index catches the race between tenants.
        const taken = await tx.profile.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
          select: { id: true },
        });
        if (taken) throw new EmailUnavailableError();
        await assertSubsidiaries(tx, organisationId, subsidiaryIds);
        await tx.profile.create({
          data: {
            id: profileId,
            email,
            fullName: input.fullName.trim(),
            role: input.role,
            language: input.language,
            organisationId,
          },
        });
        await createGrants(tx, profileId, organisationId, subsidiaryIds);
        await tx.invitation.create({ data: { profileId, language: input.language, invitedBy: admin.id } });
        await this.audit.record(
          admin,
          {
            action: 'invite',
            entity: 'invitation',
            entityId: profileId,
            diff: { role: input.role, language: input.language, subsidiaryIds },
          },
          tx,
        );
        for (const subsidiaryId of subsidiaryIds) {
          await this.audit.record(
            admin,
            { action: 'create', entity: 'subsidiary_access', entityId: profileId, diff: { subsidiaryId } },
            tx,
          );
        }
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new EmailUnavailableError();
      throw err;
    }
    return { profileId };
  }

  /**
   * Re-opens an invitation for a re-send: a revoked one (its account since
   * enabled) becomes pending again. Refused once accepted, or while the
   * account is disabled.
   */
  async reopenInvitation(actor: RequestUser, rawProfileId: string): Promise<void> {
    const organisationId = assertTenantAdmin(actor);
    const profileId = canonicalId(rawProfileId);
    await this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId);
      const target = await findMember(tx, organisationId, profileId);
      const invitation = await tx.invitation.findUnique({ where: { profileId }, select: { status: true } });
      if (!invitation) throw new ResourceNotFoundError('invitation_not_found');
      if (invitation.status === InvitationStatus.accepted) throw new InvitationClosedError();
      if (target.disabledAt) throw new UserDisabledError();
      await tx.invitation.update({
        where: { profileId },
        data: { status: InvitationStatus.pending, revokedAt: null },
      });
      await this.audit.record(
        admin,
        { action: 'invite', entity: 'invitation', entityId: profileId, diff: { resend: true, before: { status: invitation.status } } },
        tx,
      );
    });
  }

  /**
   * D19: disables a member of the actor's organisation — the guard refuses
   * them from their next request — and withdraws an invitation not yet
   * accepted. Flags Supabase Auth's ban as pending in the same transaction
   * (K4); the caller then applies it. Idempotent.
   */
  async disableMember(actor: RequestUser, rawProfileId: string): Promise<EnabledChange> {
    const organisationId = assertTenantAdmin(actor);
    const profileId = canonicalId(rawProfileId);
    if (profileId === actor.id) throw new OwnAccountError('disable');
    return this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId);
      const target = await findMember(tx, organisationId, profileId);
      if (target.disabledAt) return { changed: false };
      const now = new Date();
      await tx.profile.update({ where: { id: profileId }, data: { disabledAt: now, authSyncPendingSince: now } });
      const { count: revoked } = await tx.invitation.updateMany({
        where: { profileId, status: { in: [InvitationStatus.pending, InvitationStatus.sent] } },
        data: { status: InvitationStatus.revoked, revokedAt: now },
      });
      await this.audit.record(
        admin,
        { action: 'disable', entity: 'profile', entityId: profileId, diff: { invitationRevoked: revoked > 0 } },
        tx,
      );
      return { changed: true };
    });
  }

  /** Re-enables a disabled member; Auth's unban is flagged pending (K4). Idempotent. */
  async enableMember(actor: RequestUser, rawProfileId: string): Promise<EnabledChange> {
    const organisationId = assertTenantAdmin(actor);
    const profileId = canonicalId(rawProfileId);
    return this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId);
      const target = await findMember(tx, organisationId, profileId);
      if (!target.disabledAt) return { changed: false };
      await tx.profile.update({ where: { id: profileId }, data: { disabledAt: null, authSyncPendingSince: new Date() } });
      await this.audit.record(admin, { action: 'enable', entity: 'profile', entityId: profileId }, tx);
      return { changed: true };
    });
  }
}

/**
 * An id as the database spells it (lowercase). Postgres matches either case,
 * but this service compares ids as strings ("the actor's own account?") and
 * writes them into audit rows, so one spelling is used throughout — an
 * uppercase spelling of one's own id must not pass for another account's.
 */
function canonicalId(id: string): string {
  return id.toLowerCase();
}

/** Addresses compare without case or surrounding space; stored lower-case. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Every id a subsidiary of `organisationId`; any other — another tenant's included — is 404. */
async function assertSubsidiaries(tx: Prisma.TransactionClient, organisationId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const found = await tx.subsidiary.count({ where: { id: { in: ids }, organisationId } });
  if (found !== ids.length) throw new ResourceNotFoundError('subsidiary_not_found');
}

async function createGrants(
  tx: Prisma.TransactionClient,
  profileId: string,
  organisationId: string,
  subsidiaryIds: string[],
): Promise<void> {
  if (!subsidiaryIds.length) return;
  try {
    await tx.userSubsidiaryAccess.createMany({
      data: subsidiaryIds.map((subsidiaryId) => ({ userId: profileId, subsidiaryId, organisationId })),
    });
  } catch (err) {
    // A subsidiary deleted after the check above (its delete takes no lock here).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      throw new ResourceNotFoundError('subsidiary_not_found');
    }
    throw err;
  }
}

// The first key of the two-int advisory-lock form, so these locks share no key
// with the lifecycle protocol's period locks ("TPLK") — "TADM".
const TENANT_ADMIN_LOCK_NAMESPACE = 0x5441444d;

/** An organisation's advisory-lock key: 32 bits of a SHA-256 of its id. */
export function tenantAdminLockKey(organisationId: string): number {
  return createHash('sha256').update(organisationId).digest().readInt32BE(0);
}

/** The actor's organisation, when the actor may administer it at all. */
function assertTenantAdmin(actor: RequestUser): string {
  if (actor.role !== DbUserRole.super_admin || !actor.organisationId) {
    throw new ForbiddenException('Only a super_admin manages roles and access.');
  }
  return actor.organisationId;
}

/**
 * The organisation's administrative lock, held until the transaction ends.
 * Every change through this service takes it, and so does the operator's
 * offboarding (LP4-01), so an invitation or an enable cannot slip past an
 * offboarding that is disabling everyone.
 */
export async function lockTenantAdmin(tx: Prisma.TransactionClient, organisationId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TENANT_ADMIN_LOCK_NAMESPACE}::int4, ${tenantAdminLockKey(organisationId)}::int4)`;
}

/**
 * Serialises every administrative change within one organisation, then
 * re-reads the actor: the role the request was authenticated with may have
 * been withdrawn since.
 */
async function lockAndReadActor(
  tx: Prisma.TransactionClient,
  actor: RequestUser,
  organisationId: string,
): Promise<RequestUser> {
  await lockTenantAdmin(tx, organisationId);
  const current = await tx.profile.findUnique({
    where: { id: actor.id },
    select: { role: true, organisationId: true, disabledAt: true, organisation: { select: { offboardedAt: true } } },
  });
  // Disabled — or the organisation offboarded — since the guard admitted the
  // request (D19, K6): the same answer the guard gives, so the session ends
  // rather than acting once more.
  if (current?.disabledAt || current?.organisation?.offboardedAt) throw new AccountDisabledError();
  if (!current || current.role !== DbUserRole.super_admin || current.organisationId !== organisationId) {
    throw new ForbiddenException('Only a super_admin manages roles and access.');
  }
  return { ...actor, role: current.role };
}

/** A profile of `organisationId`; any other id — another tenant's included — is 404. */
async function findMember(tx: Prisma.TransactionClient, organisationId: string, profileId: string) {
  const member = await tx.profile.findFirst({
    where: { id: profileId, organisationId },
    select: { id: true, role: true, disabledAt: true },
  });
  if (!member) throw new ResourceNotFoundError('user_not_found');
  return member;
}
