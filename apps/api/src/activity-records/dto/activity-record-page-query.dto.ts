import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Validate,
} from 'class-validator';
import {
  ACTIVITY_RECORD_SEARCH_MAX_LENGTH,
  ACTIVITY_RECORD_SORTS,
  ACTIVITY_RECORD_STATUSES,
  CATEGORIES,
  REPORTING_PERIODS,
  type ActivityRecordPageFilters,
  type ActivityRecordPageParams,
  type ActivityRecordSort,
  type ActivityRecordStatus,
  type Category,
  type ReportingPeriod,
} from '@tonyai/shared-types';
import { decimalInt, PageCursor, PageLimit } from '../../common/cursor-page-query.dto';
import { IdFilter, NoControlCharacters, PeriodValueOfPeriod, YearFilter } from '../../common/page-filters';
import { ID_SHAPE_MESSAGE, lowercaseUuid, UUID_SHAPE } from '../../common/parse-uuid-param.pipe';

/** `locationId=none` is the wire spelling of `null` (company-level records); an id is lowercased. */
function locationIdOrNone({ value }: { value: unknown }): unknown {
  return value === 'none' ? null : lowercaseUuid({ value });
}

/**
 * The filters of GET /activity-records and GET /activity-records/metadata
 * (LP4-05's `ActivityRecordPageFilters`), AND-combined. Every one is
 * validated against its known set: an unrecognised value used to return a
 * silently EMPTY list to a caller who believed they had narrowed it.
 */
export class ActivityRecordFiltersQueryDto implements ActivityRecordPageFilters {
  @IdFilter()
  subsidiaryId?: string;

  @YearFilter()
  year?: number;

  @IsOptional()
  @IsIn([...REPORTING_PERIODS])
  period?: ReportingPeriod;

  @IsOptional()
  @IsIn([...CATEGORIES])
  category?: Category;

  /**
   * One status or a comma-separated set (`submitted,under_review`), OR-combined.
   * An empty string is refused rather than read as "no filter": silently
   * dropping a filter hands back the UNFILTERED list to a caller who believes
   * they narrowed it. (A client omits an empty set; it never sends `status=`.)
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((v) => v.trim()) : value))
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(ACTIVITY_RECORD_STATUSES.length)
  @IsIn([...ACTIVITY_RECORD_STATUSES], { each: true })
  status?: ActivityRecordStatus[];

  /** Omitted = every site; `none` = company-level records; an id = that site, within the caller's access. */
  @IsOptional()
  @Transform(locationIdOrNone)
  @IsString()
  @Matches(UUID_SHAPE, { message: ID_SHAPE_MESSAGE })
  locationId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Validate(PeriodValueOfPeriod)
  periodValue?: string;

  @IsOptional()
  @Transform(decimalInt)
  @IsIn([1, 2, 3])
  scope?: 1 | 2 | 3;

  /** A literal, case-insensitive substring; empty means no search. */
  @IsOptional()
  @IsString()
  @MaxLength(ACTIVITY_RECORD_SEARCH_MAX_LENGTH)
  @Validate(NoControlCharacters)
  search?: string;
}

/** GET /activity-records: the filters, a sort, and the page. */
export class ActivityRecordPageQueryDto extends ActivityRecordFiltersQueryDto implements ActivityRecordPageParams {
  @IsOptional()
  @IsIn([...ACTIVITY_RECORD_SORTS])
  sort?: ActivityRecordSort;

  @PageLimit()
  limit?: number;

  @PageCursor()
  cursor?: string;
}

/**
 * `implements` only checks the members a class DECLARES — TypeScript does not
 * require a class to declare an interface's optional members, so a filter added
 * to the contract and forgotten here would keep compiling while the API, with
 * `forbidNonWhitelisted`, refused the client's request for it. These fail the
 * moment a key is missing, and the error names it.
 */
const _noMissingFilters: never = null as unknown as Exclude<
  keyof ActivityRecordPageFilters,
  keyof ActivityRecordFiltersQueryDto
>;
const _noMissingPageParams: never = null as unknown as Exclude<
  keyof ActivityRecordPageParams,
  keyof ActivityRecordPageQueryDto
>;
void _noMissingFilters;
void _noMissingPageParams;
