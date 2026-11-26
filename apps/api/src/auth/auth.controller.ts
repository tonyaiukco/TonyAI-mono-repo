import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { DEFAULT_LOCALE, can, isLocale, type AuthUser } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from './current-user.decorator';
import type { RequestUser } from './auth.types';
import { RecordPasswordSetDto } from './dto/record-password-set.dto';
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
    const profile = await this.prisma.profile.findUnique({
      where: { id: user.id },
      include: { organisation: { select: { onboardingCompletedAt: true } } },
    });
    return {
      id: user.id,
      email: user.email,
      fullName: profile?.fullName ?? '',
      role: user.role,
      organisationId: user.organisationId,
      accessibleSubsidiaryIds: user.accessibleSubsidiaryIds,
      // The caller's own grants (Data Entry filters its category picker by
      // them): a standard user's with their ticked categories, a super_admin's
      // with none; the organisation-wide roles hold none.
      access: can(user.role, 'scope.granted')
        ? user.accessibleSubsidiaryIds.map((subsidiaryId) => ({
            subsidiaryId,
            categories: can(user.role, 'scope.categories') ? [...(user.categoryGrants?.[subsidiaryId] ?? [])] : [],
            // The main company or a central reporter grant's company (D3).
            kind: user.grantKinds?.[subsidiaryId] ?? 'assigned',
          }))
        : [],
      // The column's CHECK admits only supported locales; a row from before it
      // (or a missing profile) reads as the default rather than as a string
      // the web cannot load a catalogue for.
      language: isLocale(profile?.language) ? profile.language : DEFAULT_LOCALE,
      theme: profile?.theme ?? 'light',
      // A masterkey of an organisation whose setup is not finished (D8): the
      // web holds them on the wizard. Read from the role the guard read now.
      onboardingPending: can(user.role, 'onboarding.run') && !!profile?.organisation && profile.organisation.onboardingCompletedAt === null,
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

  /** The web's record of a password set from an email link: 204, one `password_set` audit row. */
  @Post('me/password-set')
  @HttpCode(204)
  async recordPasswordSet(@CurrentUser() user: RequestUser, @Body() dto: RecordPasswordSetDto): Promise<void> {
    await this.preferences.recordPasswordSet(user, dto.flow, dto.changeId);
  }
}
