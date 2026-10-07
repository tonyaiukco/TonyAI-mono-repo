import { Injectable } from '@nestjs/common';
import type { Locale } from '@tonyai/shared-types';
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
}
