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
import type { RequestUser } from './auth.types';

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
   * Config errors are logged ONCE per process. On a single-scheme deployment an
   * unauthenticated caller can trigger the other scheme's "not configured"
   * message at will (the header alone picks the path, before any signature
   * check), so logging per request would be a free ERROR-level flood.
   */
  private loggedConfigErrors = new Set<string>();

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
      if (
        error instanceof TokenVerificationError &&
        error.configError &&
        !this.loggedConfigErrors.has(error.message)
      ) {
        this.loggedConfigErrors.add(error.message);
        this.logger.error(error.message);
      }
      throw new UnauthorizedException('Invalid or expired token');
    }

    const userId = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (!userId) throw new UnauthorizedException('Invalid token subject');

    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      include: { subsidiaryAccess: true },
    });
    if (!profile) {
      throw new UnauthorizedException('No profile found for this user');
    }

    let accessibleSubsidiaryIds: string[];
    if (profile.role === 'data_entry') {
      accessibleSubsidiaryIds = profile.subsidiaryAccess.map((a) => a.subsidiaryId);
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
      role: profile.role,
      organisationId: profile.organisationId,
      accessibleSubsidiaryIds,
    };
    request.user = user;
    return true;
  }
}
