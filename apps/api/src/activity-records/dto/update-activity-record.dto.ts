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
import type { Category, ReportingPeriod } from '@tonyai/shared-types';
import { IsActivityUnit } from '../../calculations/is-activity-unit.decorator';
import { blankToNull } from '../../common/blank-to-null';
import { storableUnit } from '../../calculations/storable-unit';


/**
 * Body of PATCH /api/v1/activity-records/:id. All fields optional.
 * `subsidiaryId` is intentionally omitted — a record cannot be moved between
 * subsidiaries (that would break tenant scoping and the calc snapshot's
 * geography). `scope`/`calculation` are re-derived server-side on any change.
 */
export class UpdateActivityRecordDto {
  // Re-target the reporting entity while the record is editable. `null` detaches
  // it back to subsidiary-level; omitted leaves it unchanged. (The service
  // checks the location belongs to the record's subsidiary.)
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  reportingYear?: number;

  @IsOptional()
  @IsString()
  @IsIn(REPORTING_PERIODS as readonly string[])
  reportingPeriod?: ReportingPeriod;

  // Bounded as well as non-empty. The cap is NOT what keeps a record and a
  // period lock matchable — `canonicalPeriodValue` is, on both write paths —
  // it is the refusal that happens before the DTO pipeline and the vocabulary
  // lookup, whose 400 echoes the value back. See PERIOD_VALUE_MAX_LENGTH.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(PERIOD_VALUE_MAX_LENGTH)
  periodValue?: string;

  @IsOptional()
  @IsString()
  @IsIn(CATEGORIES as readonly string[])
  category?: Category;

  @IsOptional()
  @IsNumber()
  @Min(0)
  activityValue?: number;

  // Whitespace-normalised before it is validated or bounded (`storableUnit`):
  // `canonicalUnit` collapses `\s+` to `_` before it looks a unit up, so an
  // interior carriage return in `us gallons` was invisible to it and reached
  // the snapshot, the audit row and every export. Case and alias are left as
  // typed here — the service stores the vocabulary's canonical spelling
  // (`storedUnit`) and the snapshot keeps this one as `inputUnit`.
  @IsOptional()
  @IsActivityUnit()
  @IsString()
  @Transform(storableUnit)
  @MinLength(1)
  @MaxLength(ACTIVITY_UNIT_MAX_LENGTH)
  activityUnit?: string;

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
