import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { RequestUser } from './auth.types';

/**
 * Primary tenant-isolation enforcement point.
 *
 * Verifies the Supabase-issued JWT (HS256, signed with SUPABASE_JWT_SECRET),
 * loads the matching profile, and computes `accessibleSubsidiaryIds` which all
 * downstream services use to scope queries. Supabase RLS is the secondary
 * (defense-in-depth) layer at the database level.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
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

    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      throw new UnauthorizedException('Auth is not configured (SUPABASE_JWT_SECRET missing)');
    }

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, secret) as jwt.JwtPayload;
    } catch {
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
    } else {
      // super_admin / consultant / executive_viewer get organisation-wide visibility
      const subs = await this.prisma.subsidiary.findMany({
        where: profile.organisationId ? { organisationId: profile.organisationId } : undefined,
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
