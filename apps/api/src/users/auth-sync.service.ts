import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@tonyai/db';
import { AuthAdminError, AuthAdminService } from './auth-admin.service';

// "TAUS" — the first key of the two-int advisory lock, apart from the tenant
// admin lock ("TADM") and the period locks ("TPLK").
const AUTH_SYNC_LOCK_NAMESPACE = 0x54415553;

function authSyncLockKey(profileId: string): number {
  return createHash('sha256').update(profileId).digest().readInt32BE(0);
}

/**
 * Brings Supabase Auth's ban in line with `profiles.disabled_at` (K4) — after
 * the database has changed, never before it.
 *
 * Serialised per profile, and each run applies the state it reads under the
 * lock: a disable or enable commits before its own run takes the lock, so the
 * last run to hold it applies the latest state, however the HTTP calls
 * interleave. The flag is cleared only while the state is still the one
 * applied; a change in the meantime keeps it set for that change's run (or
 * `pnpm onboarding reconcile`). A failed Auth call leaves the flag set —
 * visible on the users screen — and the API refuses the account either way.
 */
@Injectable()
export class AuthSyncService {
  private readonly logger = new Logger(AuthSyncService.name);

  constructor(private readonly authAdmin: AuthAdminService) {}

  /** True when Auth now matches the database (or nothing was pending). */
  async apply(db: PrismaClient, rawProfileId: string): Promise<boolean> {
    // One spelling for the lock key and the Auth call (supabase-js refuses an
    // uppercase id): two runs for one account always serialise.
    const profileId = rawProfileId.toLowerCase();
    try {
      return await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUTH_SYNC_LOCK_NAMESPACE}::int4, ${authSyncLockKey(profileId)}::int4)`;
          const profile = await tx.profile.findUnique({
            where: { id: profileId },
            select: { disabledAt: true, authSyncPendingSince: true },
          });
          if (!profile?.authSyncPendingSince) return true;
          const banned = profile.disabledAt !== null;
          await this.authAdmin.setBanned(profileId, banned);
          const { count } = await tx.profile.updateMany({
            where: { id: profileId, disabledAt: banned ? { not: null } : null },
            data: { authSyncPendingSince: null },
          });
          return count === 1;
        },
        { maxWait: 5_000, timeout: 20_000 },
      );
    } catch (error) {
      const reason = error instanceof AuthAdminError ? error.code : (error as Error).name;
      this.logger.warn(`Supabase Auth ban not applied yet (${reason}); left pending for reconcile`);
      return false;
    }
  }
}
