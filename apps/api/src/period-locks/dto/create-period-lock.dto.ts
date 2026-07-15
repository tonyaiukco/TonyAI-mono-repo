import { IsIn, IsInt, IsString, Max, Min, MinLength } from 'class-validator';
import type { ReportingPeriod } from '@tonyai/shared-types';

const REPORTING_PERIODS: ReportingPeriod[] = ['monthly', 'quarterly', 'annual'];

/**
 * Body of POST /api/v1/period-locks — closes one subsidiary's reporting period
 * (FR §4.2). `periodValue` is validated against the granularity in the service
 * (same canonical vocabulary as activity records).
 */
export class CreatePeriodLockDto {
  @IsString()
  @MinLength(1)
  subsidiaryId!: string;

  @IsInt()
  @Min(2000)
  @Max(2100)
  reportingYear!: number;

  @IsString()
  @IsIn(REPORTING_PERIODS)
  reportingPeriod!: ReportingPeriod;

  @IsString()
  @MinLength(1)
  periodValue!: string;
}
