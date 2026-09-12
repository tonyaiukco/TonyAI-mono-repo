import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
import {
  GEOGRAPHY_CODES,
  MAX_LOCATIONS_PER_CREATE,
  SUBSIDIARY_TEXT_MAX_LENGTH,
  TRACKING_GRANULARITIES,
  type TrackingGranularity,
} from '@tonyai/shared-types';
import { blankToNull } from '../../common/blank-to-null';
// Owned by the locations module — it is a location shape, and the module edge
// already runs subsidiaries → locations.
import { CreateSubsidiaryLocationDto } from '../../locations/dto/create-location.dto';


export class CreateSubsidiaryDto {
  // All six free-text descriptors are bounded, not just the names: one class
  // of field, every one unbounded `text` in Postgres, every one reaching a
  // PDF, an Excel sheet and a CSV cell verbatim. #81 decided what such a cell
  // may start with; this decides how long it may be.
  @IsString()
  @MinLength(2)
  @MaxLength(SUBSIDIARY_TEXT_MAX_LENGTH)
  legalName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(SUBSIDIARY_TEXT_MAX_LENGTH)
  tradingName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SUBSIDIARY_TEXT_MAX_LENGTH)
  location?: string;

  @IsString()
  @IsIn(GEOGRAPHY_CODES as readonly string[])
  geographyCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(SUBSIDIARY_TEXT_MAX_LENGTH)
  businessArea?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SUBSIDIARY_TEXT_MAX_LENGTH)
  sector?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SUBSIDIARY_TEXT_MAX_LENGTH)
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
  @ArrayMaxSize(MAX_LOCATIONS_PER_CREATE)
  @ValidateNested({ each: true })
  @Type(() => CreateSubsidiaryLocationDto)
  locations?: CreateSubsidiaryLocationDto[];

  /**
   * How completeness is measured (WP17). `location` requires at least one
   * location in `locations[]` above — validated in the service, where both
   * write paths can state the same invariant.
   */
  @IsOptional()
  @IsIn(TRACKING_GRANULARITIES as readonly string[])
  trackingGranularity?: TrackingGranularity;
}
