import {
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  ACTIVITY_UNIT_MAX_LENGTH,
  CATEGORIES,
  EXPLANATION_MAX_LENGTH,
  PERIOD_VALUE_MAX_LENGTH,
  REPORTING_PERIODS,
} from '@tonyai/shared-types';
import type {
  Category,
  ReportingPeriod,
} from '@tonyai/shared-types';
import { IsActivityUnit } from '../../calculations/is-activity-unit.decorator';
import { blankToNull } from '../../common/blank-to-null';
import { storableUnit } from '../../calculations/storable-unit';


/**
 * Body of POST /api/v1/activity-records.
 * Mirrors CreateActivityRecordInput in @tonyai/shared-types. `scope` and the
 * calculation snapshot are derived server-side, never accepted from the client.
 */
export class CreateActivityRecordDto {
  // NB: a plain string, not @IsUUID — the tenant-access check + the FK
  // constraint enforce a valid, accessible subsidiary. (Seed ids are not
  // RFC-4122-conformant, so strict UUID validation would reject them.)
  @IsString()
  @MinLength(1)
  subsidiaryId!: string;

  // Optional operational location within the subsidiary; drives factor geography
  // when set. The service verifies it belongs to `subsidiaryId`.
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string | null;

  @IsInt()
  @Min(2000)
  @Max(2100)
  reportingYear!: number;

  @IsString()
  @IsIn(REPORTING_PERIODS as readonly string[])
  reportingPeriod!: ReportingPeriod;

  // Bounded as well as non-empty. The cap is NOT what keeps a record and a
  // period lock matchable — `canonicalPeriodValue` is, on both write paths —
  // it is the refusal that happens before the DTO pipeline and the vocabulary
  // lookup, whose 400 echoes the value back. See PERIOD_VALUE_MAX_LENGTH.
  @IsString()
  @MinLength(1)
  @MaxLength(PERIOD_VALUE_MAX_LENGTH)
  periodValue!: string;

  @IsString()
  @IsIn(CATEGORIES as readonly string[])
  category!: Category;

  @IsNumber()
  @Min(0)
  activityValue!: number;

  // Whitespace-normalised before it is bounded, so what is stored is the
  // spelling the vocabulary approved. `canonicalUnit` trims AND collapses
  // `\s+` to `_` before it looks a unit up, so neither a surrounding U+FEFF
  // nor an INTERIOR carriage return is visible to it — `us`, a CR and
  // `gallons` is a valid ten-character `us_gallons` — and the raw spelling is
  // what reached the column, the immutable snapshot, the audit row and every
  // export. See `storableUnit`.
  @IsActivityUnit()
  @IsString()
  @Transform(storableUnit)
  @MinLength(1)
  @MaxLength(ACTIVITY_UNIT_MAX_LENGTH)
  activityUnit!: string;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown> | null;

  // Unbounded `text` in Postgres, rendered verbatim to a reviewer, and one of
  // the three explanations-about-a-figure that share EXPLANATION_MAX_LENGTH.
  // `blankToNull` for the same reason the contact fields carry it: an empty
  // CSV cell is the archetypal bulk-import value, and without it the column
  // ends up with three spellings of "no explanation".
  @IsOptional()
  @IsString()
  @Transform(blankToNull)
  @MaxLength(EXPLANATION_MAX_LENGTH)
  varianceReason?: string | null;
}
