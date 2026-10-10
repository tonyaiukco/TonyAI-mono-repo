import { Injectable } from '@nestjs/common';
import { InvitationStatus } from '@tonyai/db';
import type { UserRole, UserSummaryDTO } from '@tonyai/shared-types';
import { AuditService } from '../audit/audit.service';
import { AccessAdminService, type InviteMember } from '../auth/access-admin.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuthSyncService } from './auth-sync.service';
import { InvitationDeliveryService } from './invitation-delivery.service';
import { UsersQueryService } from './users-query.service';

/**
 * The users screen's operations (LP4-01). The database change goes through
 * `AccessAdminService` — the one boundary for roles, grants and the enabled
 * state (LP1-03) — and commits first; the steps outside the database follow
 * and record their own outcome (K4): an invitation's delivery, Supabase
 * Auth's ban. Each answers the member as the list shows them, so a step that
 * did not go through is on screen at once.
 */
@Injectable()
export class UserLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessAdminService,
    private readonly delivery: InvitationDeliveryService,
    private readonly authSync: AuthSyncService,
    private readonly query: UsersQueryService,
    private readonly audit: AuditService,
  ) {}

  async invite(actor: RequestUser, input: InviteMember): Promise<UserSummaryDTO> {
    const { profileId } = await this.access.inviteMember(actor, input);
    await this.delivery.deliver(this.prisma, profileId);
    return this.query.summary(actor, profileId);
  }

  async resendInvitation(actor: RequestUser, profileId: string): Promise<UserSummaryDTO> {
    await this.access.reopenInvitation(actor, profileId);
    await this.delivery.deliver(this.prisma, profileId);
    return this.query.summary(actor, profileId);
  }

  async setRole(actor: RequestUser, profileId: string, role: UserRole): Promise<UserSummaryDTO> {
    await this.access.setRole(actor, profileId, role);
    return this.query.summary(actor, profileId);
  }

  async replaceAccess(actor: RequestUser, profileId: string, subsidiaryIds: string[]): Promise<UserSummaryDTO> {
    await this.access.replaceSubsidiaryAccess(actor, profileId, subsidiaryIds);
    return this.query.summary(actor, profileId);
  }

  async disable(actor: RequestUser, profileId: string): Promise<UserSummaryDTO> {
    await this.access.disableMember(actor, profileId);
    // Also when nothing changed: a flag left by an earlier failed call retries.
    await this.authSync.apply(this.prisma, profileId);
    return this.query.summary(actor, profileId);
  }

  async enable(actor: RequestUser, profileId: string): Promise<UserSummaryDTO> {
    await this.access.enableMember(actor, profileId);
    await this.authSync.apply(this.prisma, profileId);
    return this.query.summary(actor, profileId);
  }

  /**
   * The invitee opened a valid invitation (or reset) link: their invitation,
   * whatever state it was left in, is accepted — audited as theirs. The guard
   * has already refused a disabled account. A no-op for an account with no
   * open invitation (seeded ones, or a second call).
   */
  async accept(user: RequestUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invitation.updateMany({
        where: { profileId: user.id, status: { not: InvitationStatus.accepted } },
        data: {
          status: InvitationStatus.accepted,
          acceptedAt: new Date(),
          revokedAt: null,
          lastErrorStep: null,
          lastErrorCode: null,
        },
      });
      if (count === 1) {
        await this.audit.record(user, { action: 'accept', entity: 'invitation', entityId: user.id }, tx);
      }
    });
  }
}
