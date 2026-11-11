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

/**
 * The address shape Supabase Auth (GoTrue) accepts — the HTML5 one: an
 * unquoted ASCII local part and dot-separated ASCII labels. Measured against
 * the local stack's Auth on 2026-11-12 with eighteen edge forms (quoted,
 * commented, address-literal, spaced, doubled and leading dots, every allowed
 * symbol): Auth's answer matched this expression on each.
 */
export const AUTH_EMAIL_SHAPE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

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

  // Only an address Supabase Auth accepts: it refuses any other after the
  // organisation would already exist, leaving an administrator no email can
  // ever reach (`ayşe@…` typed on a Turkish keyboard; a quoted local part).
  // `AUTH_EMAIL_SHAPE` is what Auth was measured to accept; `@IsEmail` adds
  // the length and top-level-domain rules, so the two together never admit
  // an address Auth refuses.
  @IsEmail({ allow_utf8_local_part: false })
  @Matches(AUTH_EMAIL_SHAPE, { message: 'email must be a plain address: letters, digits and . ! # $ % & \' * + / = ? ^ _ ` { | } ~ - before the @' })
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
