import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@tonyai/db';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from './auth.types';

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
 *  - Every change writes its audit row in the same transaction.
 *
 * Organisations and first administrators are provisioned by the operator, not
 * through this service (D18, LP4-01); disabling a user is LP4-01's (D19).
 */
@Injectable()
export class AccessAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Grants `subsidiaryId` to the data_entry user `profileId`. Idempotent. */
  async grantSubsidiaryAccess(actor: RequestUser, profileId: string, subsidiaryId: string): Promise<void> {
    const organisationId = assertTenantAdmin(actor);
    await this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId);
      const target = await findMember(tx, organisationId, profileId);
      if (target.role !== UserRole.data_entry) {
        // The guard ignores grants for organisation-wide roles; storing one would
        // silently widen that user's access if their role later changed.
        throw new BadRequestException(
          'Only data_entry users are granted subsidiaries; other roles read their whole organisation.',
        );
      }
      const subsidiary = await tx.subsidiary.findFirst({
        where: { id: subsidiaryId, organisationId },
        select: { id: true },
      });
      if (!subsidiary) throw new NotFoundException('Subsidiary not found');

      const existing = await tx.userSubsidiaryAccess.findUnique({
        where: { userId_subsidiaryId: { userId: profileId, subsidiaryId } },
        select: { userId: true },
      });
      if (existing) return;

      await tx.userSubsidiaryAccess.create({ data: { userId: profileId, subsidiaryId, organisationId } });
      await this.audit.record(
        admin,
        { action: 'create', entity: 'subsidiary_access', entityId: profileId, diff: { subsidiaryId } },
        tx,
      );
    });
  }

  /** Withdraws `subsidiaryId` from `profileId`. 404 when no such grant exists in the actor's organisation. */
  async revokeSubsidiaryAccess(actor: RequestUser, profileId: string, subsidiaryId: string): Promise<void> {
    const organisationId = assertTenantAdmin(actor);
    await this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId);
      const { count } = await tx.userSubsidiaryAccess.deleteMany({
        where: { userId: profileId, subsidiaryId, organisationId },
      });
      if (count === 0) throw new NotFoundException('Grant not found');
      await this.audit.record(
        admin,
        { action: 'delete', entity: 'subsidiary_access', entityId: profileId, diff: { subsidiaryId } },
        tx,
      );
    });
  }

  /** Changes the role of `profileId`, a member of the actor's organisation other than the actor. */
  async setRole(actor: RequestUser, profileId: string, role: UserRole): Promise<void> {
    const organisationId = assertTenantAdmin(actor);
    if (!Object.values(UserRole).includes(role)) throw new BadRequestException('Unknown role');
    if (profileId === actor.id) {
      throw new ForbiddenException('You cannot change your own role; ask another super_admin.');
    }
    await this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId);
      const target = await findMember(tx, organisationId, profileId);
      if (target.role === role) return;
      await tx.profile.update({ where: { id: profileId }, data: { role } });
      await this.audit.record(
        admin,
        { action: 'update', entity: 'profile', entityId: profileId, diff: { role: { from: target.role, to: role } } },
        tx,
      );
    });
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
  if (actor.role !== UserRole.super_admin || !actor.organisationId) {
    throw new ForbiddenException('Only a super_admin manages roles and access.');
  }
  return actor.organisationId;
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
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TENANT_ADMIN_LOCK_NAMESPACE}::int4, ${tenantAdminLockKey(organisationId)}::int4)`;
  const current = await tx.profile.findUnique({
    where: { id: actor.id },
    select: { role: true, organisationId: true },
  });
  if (!current || current.role !== UserRole.super_admin || current.organisationId !== organisationId) {
    throw new ForbiddenException('Only a super_admin manages roles and access.');
  }
  return { ...actor, role: current.role };
}

/** A profile of `organisationId`; any other id — another tenant's included — is 404. */
async function findMember(tx: Prisma.TransactionClient, organisationId: string, profileId: string) {
  const member = await tx.profile.findFirst({
    where: { id: profileId, organisationId },
    select: { id: true, role: true },
  });
  if (!member) throw new NotFoundException('User not found');
  return member;
}
