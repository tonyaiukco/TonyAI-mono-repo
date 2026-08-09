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
import {
  ACTIVITY_RECORD_STATUSES,
  CATEGORIES,
  REPORTING_PERIODS,
  type ActivityRecordStatus,
  type Category,
  type ListActivityRecordsParams,
  type ReportingPeriod,
} from '@tonyai/shared-types';

/** Optional filters for GET /api/v1/activity-records (all AND-combined). */
export class ListActivityRecordsQueryDto implements ListActivityRecordsParams {
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
  @IsIn([...REPORTING_PERIODS])
  period?: ReportingPeriod;

  /** Validated against the known set: an unrecognised category used to return a
   * silently EMPTY list to a caller who believed they had narrowed it — the same
   * failure `forbidNonWhitelisted` exists to prevent, one level down. */
  @IsOptional()
  @IsIn([...CATEGORIES])
  category?: Category;

  /**
   * One status or a comma-separated set (`submitted,under_review`), because the
   * reviewer queue is a set of states rather than one. Normalised to an array so
   * the service has a single shape to reason about; a lone value still works, so
   * existing callers are unaffected.
   *
   * An empty string is rejected rather than treated as "no filter" — silently
   * dropping a filter would hand back the UNFILTERED list to a caller who
   * believes they narrowed it.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map((v) => v.trim()) : value,
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(ACTIVITY_RECORD_STATUSES.length)
  @IsIn([...ACTIVITY_RECORD_STATUSES], { each: true })
  status?: ActivityRecordStatus[];
}

/**
 * `implements` above only checks the filters this class DECLARES — TypeScript
 * does not require a class to declare an interface's *optional* members, so a
 * filter added to the contract and forgotten here would keep compiling while the
 * API silently ignored it. This assignment fails the moment that set is
 * non-empty, and the error names the missing filter.
 */
const _noMissingFilters: never = null as unknown as Exclude<
  keyof ListActivityRecordsParams,
  keyof ListActivityRecordsQueryDto
>;
void _noMissingFilters;
