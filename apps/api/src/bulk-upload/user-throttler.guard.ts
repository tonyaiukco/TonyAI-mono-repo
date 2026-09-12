import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { RequestUser } from '../auth/auth.types';

/**
 * A throttle keyed on the authenticated USER, not the socket address.
 *
 * `ThrottlerGuard`'s default tracker is `req.ip`, and this API never enables
 * Express `trust proxy`. Behind Azure Container Apps' ingress every request
 * therefore presents the same peer address, so "5 per minute" would have been
 * five per minute **for the entire product** — one tenant's import locking out
 * everyone else's. It looks correct locally only because the browser connects
 * straight to the process.
 *
 * Enabling `trust proxy` instead would key on `X-Forwarded-For`, which the
 * client sets freely — a limit anyone can step around. The user id comes from
 * a verified JWT, and the global `SupabaseAuthGuard` runs before any
 * controller-scoped guard, so it is always present by the time this runs. The
 * address is kept as the fallback for the case that cannot happen, rather than
 * throwing inside a rate limiter.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as RequestUser | undefined;
    return user?.id ?? `ip:${String(req.ip ?? 'unknown')}`;
  }
}
