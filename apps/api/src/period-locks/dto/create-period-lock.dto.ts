import {
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  PERIOD_VALUE_MAX_LENGTH,
  REPORTING_PERIODS,
} from '@tonyai/shared-types';
import type { ReportingPeriod } from '@tonyai/shared-types';


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
  @IsIn(REPORTING_PERIODS as readonly string[])
  reportingPeriod!: ReportingPeriod;

  // The SAME cap as the record's `periodValue`, from the same constant —
  // kept symmetric because these two strings are compared raw to decide
  // whether a period is closed. It is symmetry, not the mechanism: this
  // service canonicalises before it writes, exactly as the record path does,
  // and that is what makes the raw comparison sound.
  @IsString()
  @MinLength(1)
  @MaxLength(PERIOD_VALUE_MAX_LENGTH)
  periodValue!: string;
}
