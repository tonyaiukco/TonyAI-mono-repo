import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
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
import { Transform } from 'class-transformer';
import { IsActivityUnit } from '../is-activity-unit.decorator';
import { storableUnit } from '../storable-unit';
import { ACTIVITY_TYPE_SHAPE, ACTIVITY_TYPE_SHAPE_MESSAGE } from '../activity-type';

/**
 * Body of POST /api/v1/calculations/preview.
 *
 * Mirrors `CalculationInput` in @tonyai/shared-types and narrows it: that
 * interface still declares `category` and `geographyCode` as `string`, because
 * `compute`'s other caller passes values read from database rows. The
 * vocabularies are enforced here, at the one door a request body comes through.
 *
 * Preview refuses what save refuses. Every field here is looked up against the
 * factor table, and `category` and `geographyCode` were `@IsString()` alone:
 * any text reached the lookup, and the miss was answered by a 404 that echoed
 * that text back verbatim. `CreateActivityRecordDto` checks `CATEGORIES` and
 * four subsidiary/location DTOs check `GEOGRAPHY_CODES`, so the one endpoint
 * that took those vocabularies on trust was this one — the same value could be
 * previewed and then rejected on save, which is the mismatch a preview exists
 * to prevent.
 *
 * ONE CASE RUNS THE OTHER WAY, worth knowing before someone "fixes" it: a save
 * does not bind this DTO at all — `ActivityRecordsService` derives the
 * geography from the subsidiary or location row — so a STORED code outside the
 * vocabulary would now be refused by preview while the save still succeeded.
 * No such row exists: every write to those columns is behind the same `@IsIn`,
 * and neither vocabulary has ever been narrowed. The old behaviour there was a
 * 404 in any case, since no factor is seeded for a code outside the list.
 */
export class CalculationInputDto {
  @IsString()
  @IsIn(CATEGORIES as readonly string[])
  category!: Category;

  // LP3-03: the fuel or gas of a typed category (Fuel, Mobile Combustion,
  // Refrigerants); none for the others. Shape only here — see ACTIVITY_TYPE_SHAPE.
  @IsOptional()
  @IsString()
  @Matches(ACTIVITY_TYPE_SHAPE, { message: ACTIVITY_TYPE_SHAPE_MESSAGE })
  activityType?: string | null;

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
  // Normalised as well as bounded, for the same reason #118 bounded it: the
  // preview exists to agree with the save. The write DTOs collapse a
  // whitespace run to one space before the service prices it, so without this
  // the two disagree about what `us`+CR+`gallons` IS. (The record then STORES
  // the vocabulary's canonical spelling — `storedUnit` — which the preview has
  // no column for.)
  @IsActivityUnit()
  @IsString()
  @Transform(storableUnit)
  @MinLength(1)
  @MaxLength(ACTIVITY_UNIT_MAX_LENGTH)
  unit!: string;
}
