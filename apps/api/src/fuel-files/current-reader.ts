import { ForbiddenException } from '@nestjs/common';
import type { RequestUser } from '../auth/auth.types';
import { readAccess } from '../auth/auth.guard';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The caller re-read after a long step (a file read, an apply, a formation):
 * the same role and organisation and an enabled account (403 otherwise, as
 * `lockActor`), and its scope as the guard builds it now — so an answer never
 * counts a company or category withdrawn meanwhile (fourth to sixth reviews of
 * WP9 PR B).
 */
export async function currentReader(prisma: Pick<PrismaService, 'profile' | 'subsidiary'>, user: RequestUser): Promise<RequestUser> {
  const profile = await prisma.profile.findUnique({ where: { id: user.id }, include: { subsidiaryAccess: true } });
  if (!profile || profile.disabledAt || profile.role !== user.role || profile.organisationId !== user.organisationId) {
    throw new ForbiddenException();
  }
  return { ...user, ...(await readAccess(prisma, profile)) };
}
