import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
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

  @IsOptional()
  @IsString()
  @IsIn(STATUSES)
  status?: ActivityRecordStatus;
}
