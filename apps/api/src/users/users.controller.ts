import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import type { CursorPage, UserSummaryDTO } from '@tonyai/shared-types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import { InviteUserDto, ListUsersQueryDto, ReplaceUserAccessDto, UpdateUserRoleDto } from './dto/users.dto';
import { UserLifecycleService } from './user-lifecycle.service';
import { UsersQueryService } from './users-query.service';

/**
 * User and access management (LP4-01) — the caller's own organisation, a
 * `super_admin`'s alone; every other role is refused (403) and an id of
 * another tenant answers 404, exactly as one that does not exist.
 */
@Controller('users')
export class UsersController {
  constructor(
    private readonly lifecycle: UserLifecycleService,
    private readonly query: UsersQueryService,
  ) {}

  /** Members, newest first (`CursorPage`). */
  @Get()
  list(@CurrentUser() user: RequestUser, @Query() params: ListUsersQueryDto): Promise<CursorPage<UserSummaryDTO>> {
    return this.query.list(user, params);
  }

  /** Invites an account — 201 with the member, whose invitation shows whether the email went out. */
  @Post('invitations')
  invite(@CurrentUser() user: RequestUser, @Body() dto: InviteUserDto): Promise<UserSummaryDTO> {
    return this.lifecycle.invite(user, {
      email: dto.email,
      fullName: dto.fullName,
      role: dto.role,
      language: dto.language,
      subsidiaryIds: dto.subsidiaryIds ?? [],
    });
  }

  /** Re-sends an invitation not yet accepted, with a fresh link (the last one stops working). */
  @Post(':id/invitation/resend')
  @HttpCode(200)
  resend(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string): Promise<UserSummaryDTO> {
    return this.lifecycle.resendInvitation(user, id);
  }

  @Patch(':id/role')
  setRole(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Body() dto: UpdateUserRoleDto,
  ): Promise<UserSummaryDTO> {
    return this.lifecycle.setRole(user, id, dto.role);
  }

  /** The complete set of a data_entry user's subsidiaries. */
  @Put(':id/access')
  replaceAccess(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Body() dto: ReplaceUserAccessDto,
  ): Promise<UserSummaryDTO> {
    return this.lifecycle.replaceAccess(user, id, dto.subsidiaryIds);
  }

  @Post(':id/disable')
  @HttpCode(200)
  disable(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string): Promise<UserSummaryDTO> {
    return this.lifecycle.disable(user, id);
  }

  @Post(':id/enable')
  @HttpCode(200)
  enable(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string): Promise<UserSummaryDTO> {
    return this.lifecycle.enable(user, id);
  }
}
