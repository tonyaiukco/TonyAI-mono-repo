import {
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ACTIVITY_UNIT_MAX_LENGTH,
  CATEGORIES,
  GEOGRAPHY_CODES,
} from '@tonyai/shared-types';
import type { Category, GeographyCode } from '@tonyai/shared-types';
import { IsActivityUnit } from '../is-activity-unit.decorator';

/**
 * Body of POST /api/v1/calculations/preview.
 * Mirrors CalculationInput in @tonyai/shared-types.
 *
 * Preview refuses what save refuses. Every field here is looked up against the
 * factor table, and `category` and `geographyCode` were `@IsString()` alone:
 * any text reached the lookup, and the miss was answered by a 404 that echoed
 * that text back verbatim. `CreateActivityRecordDto` checks `CATEGORIES` and
 * four subsidiary/location DTOs check `GEOGRAPHY_CODES`, so the one endpoint
 * that took those vocabularies on trust was this one — the same value could be
 * previewed and then rejected on save, which is the mismatch a preview exists
 * to prevent.
 */
export class CalculationInputDto {
  @IsString()
  @IsIn(CATEGORIES as readonly string[])
  category!: Category;

  // GEOGRAPHY_CODES, never SELECTABLE_GEOGRAPHY_CODES: the selectable list
  // hides EU from pickers while keeping it valid at the API, in the factor
  // table and on every existing record. Validating against it would 400 every
  // preview for an EU-geography entity, the seeded Munich subsidiary among
  // them.
  @IsString()
  @IsIn(GEOGRAPHY_CODES as readonly string[])
  geographyCode!: GeographyCode;

  @IsInt()
  @Min(2000)
  @Max(2100)
  reportingYear!: number;

  @IsNumber()
  @Min(0)
  value!: number;

  // Bounded to match the write DTOs, because the vocabulary check bounds
  // nothing: `canonicalUnit` trims and collapses whitespace before it looks
  // anything up, so a spelling of any length canonicalises to a known unit and
  // `@IsActivityUnit()` passes it. This is the one path that could still send
  // an unbounded unit into the refusals that quote it back. See
  // ACTIVITY_UNIT_MAX_LENGTH.
  @IsActivityUnit()
  @IsString()
  @MinLength(1)
  @MaxLength(ACTIVITY_UNIT_MAX_LENGTH)
  unit!: string;
}
