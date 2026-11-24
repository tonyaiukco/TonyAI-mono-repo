import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
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
    // One row per password change, decided by the database: the row's id is
    // derived from the caller and the change, so a repeat — sequential, or
    // overlapping its first try — meets the primary key and writes nothing
    // (Codex reviews). Never an update: the trail stays append-only.
    try {
      await this.audit.record(
        user,
        { action: 'password_set', entity: 'profile', entityId: user.id, diff: { flow, changeId } },
        undefined,
        passwordSetRowId(user.id, changeId),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }
  }
}

/**
 * The `password_set` row's id for one change of one user: a UUID-shaped digest
 * of both (version 8, the custom layout). Deterministic, so the primary key is
 * what keeps a repeat from writing a second row; derived from the caller's own
 * id, so no caller can aim it at another account's row.
 */
export function passwordSetRowId(userId: string, changeId: string): string {
  const hex = createHash('sha256').update(`password_set:${userId}:${changeId}`).digest('hex');
  const variant = (8 + (parseInt(hex[16], 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
