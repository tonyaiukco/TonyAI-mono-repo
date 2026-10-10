import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import { tokenVerifier, TokenVerificationError } from './token-verifier';
import { AccountDisabledError, SessionRevokedError } from './access-errors';
import type { RequestUser } from './auth.types';

/**
 * When the token's session began, in epoch milliseconds: the earliest of its
 * `amr` timestamps (Supabase Auth keeps the sign-in's across refreshes —
 * measured on GoTrue v2.184.0 — while `iat` is the refresh's) and `iat`.
 * Whole seconds, so a session begun in the revocation's own second counts as
 * before it. A token with neither is treated as older than any revocation.
 */
export function sessionStartedAt(payload: { iat?: unknown; amr?: unknown }): number {
  const stamps = [payload.iat];
  if (Array.isArray(payload.amr)) {
    for (const entry of payload.amr) stamps.push((entry as { timestamp?: unknown } | null)?.timestamp);
  }
  const seconds = stamps.filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
  return seconds.length ? Math.min(...seconds) * 1000 : -Infinity;
}

/**
 * Primary tenant-isolation enforcement point.
 *
 * Verifies the Supabase-issued JWT (HS256 shared secret or asymmetric via JWKS
 * — see token-verifier.ts), loads the matching profile, and computes
 * `accessibleSubsidiaryIds` which all downstream services use to scope queries.
 * Supabase RLS is the secondary (defense-in-depth) layer at the database level.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);
  /**
   * Config errors are throttled per message. An unauthenticated caller can
   * trigger some of them at will (the `alg` header alone picks the path, before
   * any signature check), so logging per request would be a free ERROR-level
   * flood — but logging strictly once per process is worse in the other
   * direction: a transient blip at 02:00 would permanently silence the real
   * outage next week. Re-log after the window instead.
   */
  private static readonly CONFIG_LOG_WINDOW_MS = 5 * 60_000;
  private lastLoggedConfigError = new Map<string, number>();

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'] as string | undefined;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = authHeader.slice('Bearer '.length);

    let payload: Awaited<ReturnType<typeof tokenVerifier.verify>>;
    try {
      payload = await tokenVerifier.verify(token);
    } catch (error) {
      // A misconfigured API 401s every request identically to a bad token, which
      // is exactly how "the page loads but there is no data" happens. Surface
      // the cause in the server log; the client still learns nothing.
      if (error instanceof TokenVerificationError && error.configError) {
        const now = Date.now();
        const last = this.lastLoggedConfigError.get(error.message) ?? 0;
        if (now - last >= SupabaseAuthGuard.CONFIG_LOG_WINDOW_MS) {
          this.lastLoggedConfigError.set(error.message, now);
          this.logger.error(error.message);
        }
      }
      throw new UnauthorizedException('Invalid or expired token');
    }

    const userId = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (!userId) throw new UnauthorizedException('Invalid token subject');

    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      include: { subsidiaryAccess: true, organisation: { select: { offboardedAt: true } } },
    });
    if (!profile) {
      throw new UnauthorizedException('No profile found for this user');
    }
    // D19: a disabled account is refused on its next request — not when its
    // token expires, which is what a Supabase Auth ban alone would give (the
    // token verifier checks a signature and an expiry, never the session). An
    // offboarded organisation's members are refused the same way (K6), even
    // one an incomplete offboarding missed.
    if (profile.disabledAt || profile.organisation?.offboardedAt) {
      throw new AccountDisabledError();
    }
    // A session that began before the account's sessions were revoked (a
    // disable) stays refused after a re-enable: its token's signature and
    // expiry are still good, and Supabase Auth may not have revoked it yet,
    // so the API is where that has to hold (Codex review, finding 1).
    if (profile.sessionsRevokedAt && sessionStartedAt(payload) <= profile.sessionsRevokedAt.getTime()) {
      throw new SessionRevokedError();
    }

    let accessibleSubsidiaryIds: string[];
    if (profile.role === 'data_entry') {
      // Access rows are intersected with the profile's OWN organisation. Without
      // this, a stray `user_subsidiary_access` row pointing at another tenant's
      // subsidiary would grant real access — and every audit row it produced
      // would be stamped with this actor's organisation (WP7 denormalises the
      // tenant from the actor), filing another tenant's activity under this one:
      // visible to the wrong super_admin, invisible to the right one.
      // A data_entry profile with no organisation is default-denied for the same
      // reason the privileged roles below are.
      if (!profile.organisationId) {
        accessibleSubsidiaryIds = [];
      } else {
        const granted = profile.subsidiaryAccess.map((a) => a.subsidiaryId);
        const sameOrg = granted.length
          ? await this.prisma.subsidiary.findMany({
              where: { id: { in: granted }, organisationId: profile.organisationId },
              select: { id: true },
            })
          : [];
        accessibleSubsidiaryIds = sameOrg.map((s) => s.id);
      }
    } else if (!profile.organisationId) {
      // super_admin / consultant / executive_viewer WITHOUT an organisation →
      // default-deny. Otherwise a null `organisationId` would make the query below
      // an unfiltered `findMany` and expose EVERY subsidiary across all tenants.
      accessibleSubsidiaryIds = [];
    } else {
      // super_admin / consultant / executive_viewer get organisation-wide visibility.
      const subs = await this.prisma.subsidiary.findMany({
        where: { organisationId: profile.organisationId },
        select: { id: true },
      });
      accessibleSubsidiaryIds = subs.map((s) => s.id);
    }

    const user: RequestUser = {
      id: profile.id,
      email: profile.email,
      fullName: profile.fullName,
      role: profile.role,
      organisationId: profile.organisationId,
      accessibleSubsidiaryIds,
    };
    request.user = user;
    return true;
  }
}
