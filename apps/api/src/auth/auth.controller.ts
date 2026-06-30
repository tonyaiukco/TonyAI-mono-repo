import { Controller, Get } from '@nestjs/common';
import type { AuthUser } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from './current-user.decorator';
import type { RequestUser } from './auth.types';

@Controller()
export class AuthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  async me(@CurrentUser() user: RequestUser): Promise<AuthUser> {
    const profile = await this.prisma.profile.findUnique({ where: { id: user.id } });
    return {
      id: user.id,
      email: user.email,
      fullName: profile?.fullName ?? '',
      role: user.role,
      organisationId: user.organisationId,
      accessibleSubsidiaryIds: user.accessibleSubsidiaryIds,
      language: profile?.language ?? 'en',
      theme: profile?.theme ?? 'light',
    };
  }
}
