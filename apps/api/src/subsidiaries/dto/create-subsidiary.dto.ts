import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  ValidateNested,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { GEOGRAPHY_CODES } from '@tonyai/shared-types';

/**
 * One location supplied while creating its parent subsidiary.
 *
 * `CreateLocationDto` minus `subsidiaryId`: the parent does not exist yet, and
 * accepting an id here would let a caller attach a location to somebody else's
 * subsidiary through the create endpoint.
 */
export class CreateSubsidiaryLocationDto {
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
 * Trim, and turn a blank into `null`.
 *
 * Without it the phone column ends up with THREE representations of "no phone"
 * — `null`, `''` and `'   '` — because `@IsOptional` only skips null/undefined
 * and `@IsString` happily accepts whitespace. A panel then renders an empty
 * string where it should render its empty state, and "clear this field" behaves
 * differently depending on whether the user pressed space. Email escapes the
 * same fate only because `@IsEmail` rejects whitespace; it is trimmed here too,
 * so a pasted address with a trailing space is saved rather than refused.
 */
export function blankToNull({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export class CreateSubsidiaryDto {
  @IsString()
  @MinLength(2)
  legalName!: string;

  @IsOptional()
  @IsString()
  tradingName?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsString()
  @IsIn(GEOGRAPHY_CODES as readonly string[])
  geographyCode!: string;

  @IsOptional()
  @IsString()
  businessArea?: string;

  @IsOptional()
  @IsString()
  sector?: string;

  @IsOptional()
  @IsString()
  designatedPerson?: string;

  /**
   * Bounded and format-checked, unlike the free-text fields above. These are
   * the only columns on this entity a human is expected to act on — someone
   * reads the address off the panel and sends an email — so a value that only
   * looks like an address is worse than an empty one. `MaxLength` because both
   * are unbounded `text` in Postgres and both are rendered verbatim.
   *
   * Phone stays a string, deliberately: there is no international format this
   * product can assume, and normalising would mangle extensions.
   *
   * `| null` is not decoration — `@IsOptional()` skips validation for null, and
   * the service's `!== undefined` check turns an explicit null into a cleared
   * column. Without it in the type, the DTO would claim the endpoint refuses
   * the only way a contact can ever be REMOVED once set. (The older optional
   * fields on this DTO still carry that mismatch against
   * `CreateSubsidiaryInput`, which does say `| null`; not widened here because
   * it is unrelated to this change.)
   */
  @IsOptional()
  @Transform(blankToNull)
  @IsEmail()
  @MaxLength(320)
  contactEmail?: string | null;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  contactPhone?: string | null;

  @IsOptional()
  @IsIn(['active', 'inactive', 'pending'])
  reportingStatus?: 'active' | 'inactive' | 'pending';

  /** Only the three GHG Protocol scopes exist. Unbounded integers were accepted
   *  and stored (`[99]` returned 200), which the Edit dialog now makes a
   *  first-class UI path rather than an API-only curiosity. */
  /**
   * Locations to create alongside the subsidiary, in one transaction (round-1
   * UAT SUB-3).
   *
   * Optional at this layer on purpose. The create FORM requires at least one —
   * a subsidiary's locations are its operational borders, and WP17's
   * completeness denominator is that count — but making it mandatory here would
   * be a breaking contract change for every existing caller, and a holding
   * entity with no distinct site is a real thing.
   *
   * `@ValidateNested` + `@Type` are load-bearing: without them the global
   * `whitelist` pipe strips these into bare objects and the per-location rules
   * never run.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSubsidiaryLocationDto)
  locations?: CreateSubsidiaryLocationDto[];

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @IsIn([1, 2, 3], { each: true })
  includedScopes?: number[];
}
