import { Transform } from 'class-transformer';
import {
  IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, Validate,
  ValidatorConstraint, type ValidationArguments, type ValidatorConstraintInterface,
} from 'class-validator';
import {
  CATEGORIES, isReportingContext, REPORTING_YEAR_MIN, REPORTING_YEAR_MAX,
  type Category, type ReportingContext,
} from '@tonyai/shared-types';
import { UUID_SHAPE } from './parse-uuid-param.pipe';

// Preserve arrays and malformed strings for validation instead of coercing them.
export const integerQuery = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

/** Omit absent fields, including when class-transformer creates undefined keys. */
export function reportingContext(query: ReportingContext): ReportingContext {
  return {
    year: query.year,
    ...(query.subsidiaryId !== undefined ? { subsidiaryId: query.subsidiaryId } : {}),
    ...(query.scope !== undefined ? { scope: query.scope } : {}),
    ...(query.category !== undefined ? { category: query.category } : {}),
  };
}

@ValidatorConstraint({ name: 'reportingContext', async: false })
class ReportingContextConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return isReportingContext(reportingContext(args.object as ReportingContext));
  }

  defaultMessage(): string {
    return 'Reporting scope and category must form a valid reporting context';
  }
}

/** Context routes require one year and reject unknown, repeated or invalid filters. */
export class ReportingContextQueryDto implements ReportingContext {
  @Transform(integerQuery)
  @IsInt()
  @Min(REPORTING_YEAR_MIN)
  @Max(REPORTING_YEAR_MAX)
  @Validate(ReportingContextConstraint)
  year!: number;

  /** (19): an id's shape, which bounds what an export writes into its audit
   * row and labels. Not lowercased: the context is echoed verbatim, and an
   * uppercase spelling matches no stored id, so it answers empty. */
  @IsOptional()
  @IsString()
  @Matches(UUID_SHAPE)
  subsidiaryId?: string;

  @IsOptional()
  @Transform(integerQuery)
  @IsInt()
  @IsIn([1, 2, 3])
  scope?: 1 | 2 | 3;

  @IsOptional()
  @IsIn(CATEGORIES)
  category?: Category;
}
