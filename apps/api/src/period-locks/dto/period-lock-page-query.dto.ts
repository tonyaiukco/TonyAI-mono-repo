import { IsIn, IsOptional, IsString, MaxLength, Validate } from 'class-validator';
import { REPORTING_PERIODS, type PeriodLockPageParams, type ReportingPeriod } from '@tonyai/shared-types';
import { CursorPageQueryDto } from '../../common/cursor-page-query.dto';
import { IdFilter, PeriodValueOfPeriod, YearFilter } from '../../common/page-filters';

/**
 * GET /period-locks (LP4-05's `PeriodLockPageParams`). The exact
 * subsidiary/year/period/periodValue query addresses at most one lock — the
 * only lock query from which a client may conclude "unlocked".
 */
export class PeriodLockPageQueryDto extends CursorPageQueryDto implements PeriodLockPageParams {
  @IdFilter()
  subsidiaryId?: string;

  @YearFilter()
  year?: number;

  @IsOptional()
  @IsIn([...REPORTING_PERIODS])
  period?: ReportingPeriod;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Validate(PeriodValueOfPeriod)
  periodValue?: string;
}

/** A contract key this class forgot would otherwise be refused by `forbidNonWhitelisted`; this names it at compile time. */
const _noMissingParams: never = null as unknown as Exclude<keyof PeriodLockPageParams, keyof PeriodLockPageQueryDto>;
void _noMissingParams;
