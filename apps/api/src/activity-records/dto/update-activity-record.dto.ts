import {
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { CATEGORIES } from '@tonyai/shared-types';
import type { Category, ReportingPeriod } from '@tonyai/shared-types';

const REPORTING_PERIODS: ReportingPeriod[] = ['monthly', 'quarterly', 'annual'];

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
  @IsIn(REPORTING_PERIODS)
  reportingPeriod?: ReportingPeriod;

  @IsOptional()
  @IsString()
  @MinLength(1)
  periodValue?: string;

  @IsOptional()
  @IsString()
  @IsIn(CATEGORIES as readonly string[])
  category?: Category;

  @IsOptional()
  @IsNumber()
  @Min(0)
  activityValue?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  activityUnit?: string;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  varianceReason?: string | null;
}
