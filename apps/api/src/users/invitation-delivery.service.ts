import { Injectable, Logger } from '@nestjs/common';
import { InvitationStatus, type PrismaClient } from '@tonyai/db';
import { isLocale, DEFAULT_LOCALE } from '@tonyai/shared-types';
import { MailService } from '../mail/mail.service';
import { AuthAdminError, AuthAdminService } from './auth-admin.service';

/** What a delivery attempt ended in — recorded on the invitation either way. */
export type DeliveryOutcome =
  | { delivered: true }
  | { delivered: false; step: 'auth' | 'email'; code: string }
  | { delivered: false; skipped: 'not_pending' | 'disabled' | 'missing' };

/**
 * The steps of an invitation that run outside the database (K4, K5): the
 * Supabase Auth user (with the profile's own id), a fresh invitation link,
 * and the TR/EN email carrying it. Each attempt is counted on the invitation
 * and its outcome recorded there — `sent`, or the step it stopped at with a
 * short code — so a partial failure is visible on the users screen and a
 * re-send (or `pnpm onboarding provision`, re-run) completes it.
 *
 * `db` is the API's runtime client, or the owner's in the operator CLI.
 */
@Injectable()
export class InvitationDeliveryService {
  private readonly logger = new Logger(InvitationDeliveryService.name);

  constructor(
    private readonly authAdmin: AuthAdminService,
    private readonly mail: MailService,
  ) {}

  async deliver(db: PrismaClient, profileId: string): Promise<DeliveryOutcome> {
    const invitation = await db.invitation.findUnique({
      where: { profileId },
      select: {
        status: true,
        language: true,
        invitedBy: true,
        profile: {
          select: {
            email: true,
            fullName: true,
            disabledAt: true,
            organisation: { select: { legalName: true, tradingName: true } },
          },
        },
      },
    });
    if (!invitation || !invitation.profile.organisation) return { delivered: false, skipped: 'missing' };
    if (invitation.status !== InvitationStatus.pending) return { delivered: false, skipped: 'not_pending' };
    if (invitation.profile.disabledAt) return { delivered: false, skipped: 'disabled' };
    const { email, fullName, organisation } = invitation.profile;

    await db.invitation.updateMany({
      where: { profileId, status: InvitationStatus.pending },
      data: { attempts: { increment: 1 }, lastAttemptAt: new Date() },
    });

    let token: string | null = null;
    try {
      await this.authAdmin.ensureUser(profileId, email);
      // Disabled while the Auth user was being created: its own Auth step may
      // have found no user to ban, so ban the one just made (D19).
      const now = await db.profile.findUnique({ where: { id: profileId }, select: { disabledAt: true } });
      if (now?.disabledAt) {
        await this.authAdmin.setBanned(profileId, true);
        return { delivered: false, skipped: 'disabled' };
      }
      // Minting voids the previous link — only once the email can carry the new one.
      if (this.mail.config) token = await this.authAdmin.inviteToken(profileId, email);
    } catch (error) {
      const code = error instanceof AuthAdminError ? error.code : 'auth_unavailable';
      if (!(error instanceof AuthAdminError)) this.logger.error(`Invitation Auth step failed: ${(error as Error).name}`);
      return this.fail(db, profileId, 'auth', code);
    }

    const link = token ? this.mail.confirmLink(token, 'invite') : null;
    if (!link) return this.fail(db, profileId, 'email', 'mail_not_configured');
    const inviter = invitation.invitedBy
      ? (await db.profile.findUnique({ where: { id: invitation.invitedBy }, select: { fullName: true } }))?.fullName ?? null
      : null;
    const sent = await this.mail.send(email, {
      kind: 'invitation',
      language: isLocale(invitation.language) ? invitation.language : DEFAULT_LOCALE,
      name: fullName,
      organisation: organisation.tradingName || organisation.legalName,
      inviter,
      link,
    });
    if (!sent.ok) return this.fail(db, profileId, 'email', sent.code);

    // Still pending: a disable in the meantime revoked it, and that stands.
    await db.invitation.updateMany({
      where: { profileId, status: InvitationStatus.pending },
      data: { status: InvitationStatus.sent, sentAt: new Date(), lastErrorStep: null, lastErrorCode: null },
    });
    return { delivered: true };
  }

  private async fail(db: PrismaClient, profileId: string, step: 'auth' | 'email', code: string): Promise<DeliveryOutcome> {
    await db.invitation.updateMany({
      where: { profileId, status: InvitationStatus.pending },
      data: { lastErrorStep: step, lastErrorCode: code },
    });
    this.logger.warn(`Invitation delivery stopped at the ${step} step: ${code}`);
    return { delivered: false, step, code };
  }
}
