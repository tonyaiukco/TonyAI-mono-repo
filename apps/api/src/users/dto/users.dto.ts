import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  SUPPORTED_LOCALES,
  type InviteUserRequest,
  type ListUsersParams,
  type Locale,
  type PasswordResetRequest,
  type ReplaceUserAccessRequest,
  type UpdateUserRoleRequest,
  type UserRole,
  USER_ROLES,
} from '@tonyai/shared-types';
import { CursorPageQueryDto } from '../../common/cursor-page-query.dto';
import { canonicalUuid, UUID_SHAPE } from '../../common/parse-uuid-param.pipe';

/** Each id lowercased — the database's spelling, so grants and audit rows carry one. */
const lowercaseIds = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? value.map((v) => canonicalUuid(v) ?? v) : value;

/** The canonical `user_role` (CLAUDE.md) — Prisma's enum holds the same four;
 *  one list, in shared-types (LP4-04 slice 2 PR C). */
export { USER_ROLES };

/** RFC 5321's longest deliverable address. */
const MAX_EMAIL_LENGTH = 254;
/** A subsidiary set no organisation reaches in the pilot; bounds the request. */
const MAX_GRANTS = 500;

/** POST /api/v1/users/invitations */
export class InviteUserDto implements InviteUserRequest {
  @IsEmail()
  @MaxLength(MAX_EMAIL_LENGTH)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(/\S/, { message: 'fullName must not be blank' })
  fullName!: string;

  @IsIn(USER_ROLES)
  role!: UserRole;

  @IsIn(SUPPORTED_LOCALES)
  language!: Locale;

  @IsOptional()
  @Transform(lowercaseIds)
  @IsArray()
  @ArrayMaxSize(MAX_GRANTS)
  // The 8-4-4-4-12 shape, not `@IsUUID`: the seed's fixed ids are not RFC 4122
  // conformant (see `ParseUuidParamPipe`).
  @Matches(UUID_SHAPE, { each: true, message: 'each subsidiaryIds entry must be an id' })
  subsidiaryIds?: string[];
}

/** PATCH /api/v1/users/:id/role */
export class UpdateUserRoleDto implements UpdateUserRoleRequest {
  @IsIn(USER_ROLES)
  role!: UserRole;
}

/** PUT /api/v1/users/:id/access — the complete set. */
export class ReplaceUserAccessDto implements ReplaceUserAccessRequest {
  @Transform(lowercaseIds)
  @IsArray()
  @ArrayMaxSize(MAX_GRANTS)
  @Matches(UUID_SHAPE, { each: true, message: 'each subsidiaryIds entry must be an id' })
  subsidiaryIds!: string[];
}

/** GET /api/v1/users — `CursorPage` bounds (LP4-05's contract). */
export class ListUsersQueryDto extends CursorPageQueryDto implements ListUsersParams {}

/** POST /api/v1/auth/password-reset — public. */
export class PasswordResetDto implements PasswordResetRequest {
  @IsEmail()
  @MaxLength(MAX_EMAIL_LENGTH)
  email!: string;
}
