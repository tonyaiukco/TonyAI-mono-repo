import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
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
  REGISTRATION_CONSENT_VERSION,
  REGISTRATION_FIELD_MAX,
  SUPPORTED_LOCALES,
  type InviteUserRequest,
  type ListUsersParams,
  type Locale,
  type PasswordResetRequest,
  type RegistrationRequest,
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

/** A typed value with the space around it removed; anything else is left for the validators. */
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** POST /api/v1/auth/registration — public, behind the registration code. */
export class RegistrationDto implements RegistrationRequest {
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(REGISTRATION_FIELD_MAX.firstName)
  firstName!: string;

  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(REGISTRATION_FIELD_MAX.lastName)
  lastName!: string;

  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(REGISTRATION_FIELD_MAX.companyName)
  companyName!: string;

  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(REGISTRATION_FIELD_MAX.jobTitle)
  jobTitle!: string;

  // ASCII only: Supabase Auth refuses any other address, and by then the
  // organisation would exist with an administrator no email can ever reach
  // (QA review, F1 — `ayşe@…` typed on a Turkish keyboard).
  @IsEmail({ allow_utf8_local_part: false })
  @Matches(/^[\x21-\x7e]+$/, { message: 'email must use ASCII characters only' })
  @MaxLength(REGISTRATION_FIELD_MAX.email)
  email!: string;

  // Only bounded here: a code of any wrong shape is a wrong code (403), told
  // apart from a right one in constant time by the service.
  @IsString()
  @MaxLength(64)
  registrationCode!: string;

  @Equals(true, { message: 'consent must be accepted' })
  consent!: true;

  // The one notice this API serves: a consent to any other text is refused.
  @Equals(REGISTRATION_CONSENT_VERSION, { message: 'consentVersion is not the current notice' })
  consentVersion!: string;

  @IsIn(SUPPORTED_LOCALES)
  language!: Locale;
}
