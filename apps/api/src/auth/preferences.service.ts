import { Injectable } from '@nestjs/common';
import type { Locale, PasswordSetFlow } from '@tonyai/shared-types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from './auth.types';

/**
 * The caller's own preferences (LP3-01): today the UI language, which the web
 * mirrors into a cookie and the API will read for a report's default language
 * and an email's (D16).
 *
 * Self-service and tenant-free — the row is the caller's own profile, by the
 * token's subject, never an id from the request. The runtime role may write
 * `language` (and `updated_at`) on `profiles` and no other new column.
 */
@Injectable()
export class PreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Sets the caller's language; a change is audited, a no-op writes nothing. */
  async setLanguage(user: RequestUser, language: Locale): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Locked, so two tabs changing it at once audit the before each saw.
      const [row] = await tx.$queryRaw<{ language: string }[]>`
        SELECT language FROM profiles WHERE id = ${user.id}::uuid FOR UPDATE`;
      // The guard loaded this profile moments ago; gone now, it was deleted.
      if (!row || row.language === language) return;
      await tx.profile.update({ where: { id: user.id }, data: { language } });
      await this.audit.record(
        user,
        {
          action: 'update',
          entity: 'profile',
          entityId: user.id,
          diff: { before: { language: row.language }, after: { language } },
        },
        tx,
      );
    });
  }

  /**
   * Records that Auth accepted a new password for the caller from an email
   * link (`account-access`; `pre-g5-security-hardening`). One `password_set`
   * row as the caller, about their own profile, with the flow and nothing
   * about the password. Auth changes the password; the API cannot see it, so
   * this is the web's report of it — and a caller can only ever write it
   * about themselves.
   */
  async recordPasswordSet(user: RequestUser, flow: PasswordSetFlow, changeId: string): Promise<void> {
    // A repeat of a change already recorded — its first answer lost on the
    // way back — writes nothing: one row per password change (Codex review).
    // The web's repeats are sequential, so a read before the write suffices.
    const recorded = await this.prisma.auditLog.findFirst({
      where: { action: 'password_set', entity: 'profile', entityId: user.id, diff: { path: ['changeId'], equals: changeId } },
      select: { id: true },
    });
    if (recorded) return;
    await this.audit.record(user, { action: 'password_set', entity: 'profile', entityId: user.id, diff: { flow, changeId } });
  }
}
