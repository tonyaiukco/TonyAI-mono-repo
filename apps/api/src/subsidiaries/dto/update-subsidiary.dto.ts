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
  IsNumber,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  GEOGRAPHY_CODES,
  SUBSIDIARY_STATUSES,
  SUBSIDIARY_TEXT_MAX_LENGTH,
  TRACKING_GRANULARITIES,
  type SubsidiaryStatus,
  type TrackingGranularity,
  CONTROL_KINDS,
  NACE_CODE_MAX_LENGTH,
  NACE_CODE_PATTERN,
  NODE_TYPES,
  type ControlKind,
  type NodeType,
} from '@tonyai/shared-types';
import { blankToNull } from '../../common/blank-to-null';
import { ID_SHAPE_MESSAGE, lowercaseUuid, UUID_SHAPE } from '../../common/parse-uuid-param.pipe';

export class UpdateSubsidiaryDto {
  // All six free-text descriptors are bounded, not just the names: one class
  // of field, every one unbounded `text` in Postgres, every one reaching a
  // PDF, an Excel sheet and a CSV cell verbatim. #81 decided what such a cell
  // may start with; this decides how long it may be.
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(SUBSIDIARY_TEXT_MAX_LENGTH)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SUBSIDIARY_TEXT_MAX_LENGTH)
  tradingName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SUBSIDIARY_TEXT_MAX_LENGTH)
  location?: string;

  @IsOptional()
  @IsString()
  @IsIn(GEOGRAPHY_CODES as readonly string[])
  geographyCode?: string;

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
  @IsIn(SUBSIDIARY_STATUSES as readonly string[])
  reportingStatus?: SubsidiaryStatus;

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

  // ---- The group tree (inc26-group-tree) ----------------------------------

  /**
   * The parent node. Omitted: the parent is unchanged; a value is a move (masterkey only; refused under the node's own subtree or while its subtree holds records); `null` is refused for every node but the holding. A parent the caller cannot read
   * answers `subsidiary_not_found`, exactly as an unknown company.
   */
  // The shape, not RFC 4122's version bits: the seed's fixed ids are not
  // version-conformant (`ParseUuidParamPipe` says why).
  @IsOptional()
  @Transform(lowercaseUuid)
  @IsString()
  @Matches(UUID_SHAPE, { message: ID_SHAPE_MESSAGE })
  parentId?: string | null;

  /** Accepted only unchanged: a node's type is fixed at creation (`node_type_fixed`). */
  @IsOptional()
  @IsIn(NODE_TYPES as readonly string[])
  nodeType?: NodeType;

  /** `associate` only on a `company` or `child_company`, by a masterkey.
   *  Absent leaves it; `null` is refused here (a NOT NULL column — it reached
   *  the database as a 500; QA review, WP7). */
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(CONTROL_KINDS as readonly string[])
  control?: ControlKind;

  /** 0–100, two decimals at most; inert (no rule or figure reads it). */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  sharePercent?: number | null;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(NACE_CODE_MAX_LENGTH)
  @Matches(NACE_CODE_PATTERN)
  naceCode?: string | null;
}
