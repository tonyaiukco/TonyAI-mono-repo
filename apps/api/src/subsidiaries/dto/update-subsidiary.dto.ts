import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  GEOGRAPHY_CODES,
  TRACKING_GRANULARITIES,
  type TrackingGranularity,
} from '@tonyai/shared-types';
import { blankToNull } from '../../common/blank-to-null';

export class UpdateSubsidiaryDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  legalName?: string;

  @IsOptional()
  @IsString()
  tradingName?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  @IsIn(GEOGRAPHY_CODES as readonly string[])
  geographyCode?: string;

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
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @IsIn([1, 2, 3], { each: true })
  includedScopes?: number[];

  /**
   * How this subsidiary's completeness is measured (WP17).
   *
   * Update-only — `CreateSubsidiaryDto` deliberately does not accept it. See
   * `UpdateSubsidiaryInput` in the shared contract for why: switching to
   * `location` requires locations to exist, and at create time they are being
   * written in the same transaction.
   */
  @IsOptional()
  @IsIn(TRACKING_GRANULARITIES as readonly string[])
  trackingGranularity?: TrackingGranularity;
}
