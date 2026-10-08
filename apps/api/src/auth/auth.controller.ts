import { Body, Controller, Get, Patch } from '@nestjs/common';
import { DEFAULT_LOCALE, isLocale, type AuthUser } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from './current-user.decorator';
import type { RequestUser } from './auth.types';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { PreferencesService } from './preferences.service';

@Controller()
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly preferences: PreferencesService,
  ) {}

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
      // The column's CHECK admits only supported locales; a row from before it
      // (or a missing profile) reads as the default rather than as a string
      // the web cannot load a catalogue for.
      language: isLocale(profile?.language) ? profile.language : DEFAULT_LOCALE,
      theme: profile?.theme ?? 'light',
    };
  }

  /** The caller's own preferences; answers the updated user, as GET /me does. */
  @Patch('me/preferences')
  async updatePreferences(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdatePreferencesDto,
  ): Promise<AuthUser> {
    await this.preferences.setLanguage(user, dto.language);
    return this.me(user);
  }
}
