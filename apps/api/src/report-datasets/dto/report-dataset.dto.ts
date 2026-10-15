import { Transform } from 'class-transformer';
import {
  IsIn, IsInt, Matches, Max, Min, Validate, ValidateIf,
  ValidatorConstraint, type ValidationArguments, type ValidatorConstraintInterface,
} from 'class-validator';
import {
  CATEGORIES, CATEGORY_SCOPE_MAP, REPORTING_YEAR_MAX, REPORTING_YEAR_MIN,
  type CaptureReportDatasetRequest, type Category,
} from '@tonyai/shared-types';
import { lowercaseUuid, UUID_SHAPE } from '../../common/parse-uuid-param.pipe';
import { integerQuery } from '../../common/reporting-context-query.dto';

/** A category filter inside a scope filter must be one of that scope's. */
@ValidatorConstraint({ name: 'datasetSelection', async: false })
class DatasetSelectionConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const { scope, category } = args.object as CaptureReportDatasetRequest;
    return scope === undefined || category === undefined || CATEGORY_SCOPE_MAP[category] === scope;
  }

  defaultMessage(): string {
    return 'category must be one of the selected scope';
  }
}

/**
 * POST /report-datasets (LP3-04 PR C; V1–V3): the version and an extract's
 * filters. The year is the version's and the selection derived; the capturer
 * is the verified token's (E6). Not `@IsOptional`: that would let `null`
 * through as "no filter".
 */
export class CaptureReportDatasetDto implements CaptureReportDatasetRequest {
  @Transform(lowercaseUuid)
  @Matches(UUID_SHAPE, { message: 'boundaryId must be an id' })
  boundaryId!: string;

  @ValidateIf((o: CaptureReportDatasetDto) => o.subsidiaryId !== undefined)
  @Transform(lowercaseUuid)
  @Matches(UUID_SHAPE, { message: 'subsidiaryId must be an id' })
  subsidiaryId?: string;

  @ValidateIf((o: CaptureReportDatasetDto) => o.scope !== undefined)
  @IsIn([1, 2, 3])
  scope?: 1 | 2 | 3;

  @ValidateIf((o: CaptureReportDatasetDto) => o.category !== undefined)
  @IsIn(CATEGORIES)
  @Validate(DatasetSelectionConstraint)
  category?: Category;
}

/** GET /report-datasets?year= — one reporting year's datasets. */
export class ListReportDatasetsQueryDto {
  @Transform(integerQuery)
  @IsInt()
  @Min(REPORTING_YEAR_MIN)
  @Max(REPORTING_YEAR_MAX)
  year!: number;
}
