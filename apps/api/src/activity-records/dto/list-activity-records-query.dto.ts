import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type { ActivityRecordStatus, ReportingPeriod } from '@tonyai/shared-types';

const REPORTING_PERIODS: ReportingPeriod[] = ['monthly', 'quarterly', 'annual'];
const STATUSES: ActivityRecordStatus[] = [
  'draft',
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'locked',
];

/** Optional filters for GET /api/v1/activity-records (all AND-combined). */
export class ListActivityRecordsQueryDto {
  @IsOptional()
  @IsString()
  subsidiaryId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @IsOptional()
  @IsString()
  @IsIn(REPORTING_PERIODS)
  period?: ReportingPeriod;

  @IsOptional()
  @IsString()
  category?: string;

  /**
   * One status or a comma-separated set (`submitted,under_review`), because the
   * reviewer queue is a set of states rather than one. Normalised to an array
   * so the service has a single shape to reason about; a lone value still works,
   * so existing callers are unaffected.
   *
   * An empty string is rejected rather than treated as "no filter" — silently
   * dropping a filter would hand back the UNFILTERED list to a caller who
   * believes they narrowed it, the same class of bug `forbidNonWhitelisted`
   * exists to prevent.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map((v) => v.trim()) : value,
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(STATUSES.length)
  @IsIn(STATUSES, { each: true })
  status?: ActivityRecordStatus[];
}
