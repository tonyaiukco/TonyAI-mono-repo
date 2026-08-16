import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { blankToNull } from '../../common/blank-to-null';
import { GEOGRAPHY_CODES } from '@tonyai/shared-types';

/**
 * Everything that describes WHAT a location is — the base, mirroring
 * `CreateSubsidiaryLocationInput` in the shared contract.
 *
 * `POST /subsidiaries` accepts an array of these directly (round-1 UAT SUB-3).
 * It has no `subsidiaryId` on purpose: the parent does not exist yet, and
 * accepting one would let a caller attach a location to somebody else's
 * subsidiary through the create endpoint.
 *
 * The base rather than an `Omit<CreateLocationDto, 'subsidiaryId'>`, and for
 * the same reason as in the shared types: a field describing a location should
 * reach BOTH forms, while a field describing how it attaches to a parent
 * belongs only to the extension. Derived the other way those two edits are
 * indistinguishable, and the second one silently breaks the nested create with
 * a 400 (`whitelist` + `forbidNonWhitelisted` reject an undeclared key).
 *
 * `blankToNull` on every optional: without it the column ends up with three
 * spellings of "not recorded" — `null`, `''` and `'   '` — and which one you
 * get depends on the endpoint, which is how the two create paths diverged
 * before.
 */
export class CreateSubsidiaryLocationDto {
  @Transform(blankToNull)
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @IsIn(GEOGRAPHY_CODES)
  geographyCode!: string;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  address?: string | null;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  authorizedPerson?: string | null;
}

/**
 * Body of POST /api/v1/locations — the same shape, plus the parent it attaches
 * to.
 *
 * NB: `subsidiaryId` is a plain string, not `@IsUUID` — the tenant-access check
 * and the FK constraint enforce a valid, accessible subsidiary, and the seed's
 * fixed ids are not RFC-4122-conformant (see `ParseUuidParamPipe`, which has
 * the same problem and solves it the same way).
 */
export class CreateLocationDto extends CreateSubsidiaryLocationDto {
  @IsString()
  @MinLength(1)
  subsidiaryId!: string;
}
