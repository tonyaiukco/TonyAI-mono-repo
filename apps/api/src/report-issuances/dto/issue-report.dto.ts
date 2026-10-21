import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, Matches, ValidateIf } from 'class-validator';
import {
  REPORT_TEMPLATES, SUPPORTED_LOCALES,
  type IssueReportRequest, type Locale, type ReportTemplate,
} from '@tonyai/shared-types';
import { lowercaseUuid, UUID_SHAPE } from '../../common/parse-uuid-param.pipe';
import { ListReportDatasetsQueryDto } from '../../report-datasets/dto/report-dataset.dto';

/**
 * POST /report-issuances (LP3-04 PR D): the retained dataset, the template,
 * the language (D16: else the issuer's) and the options. Status and gaps are
 * the gate's, never sent; the issuer is the verified token's (E6). Not
 * `@IsOptional`: that would let `null` through as "not sent".
 */
export class IssueReportDto implements IssueReportRequest {
  @Transform(lowercaseUuid)
  @Matches(UUID_SHAPE, { message: 'datasetId must be an id' })
  datasetId!: string;

  @IsIn(REPORT_TEMPLATES.map((t) => t.id))
  template!: ReportTemplate;

  @ValidateIf((o: IssueReportDto) => o.language !== undefined)
  @IsIn(SUPPORTED_LOCALES)
  language?: Locale;

  @ValidateIf((o: IssueReportDto) => o.includeMethodologyNotes !== undefined)
  @IsBoolean()
  includeMethodologyNotes?: boolean;

  @ValidateIf((o: IssueReportDto) => o.includeEvidenceSummary !== undefined)
  @IsBoolean()
  includeEvidenceSummary?: boolean;
}

/** GET /report-issuances?year= — one reporting year's issuances (as the datasets' list). */
export class ListReportIssuancesQueryDto extends ListReportDatasetsQueryDto {}
