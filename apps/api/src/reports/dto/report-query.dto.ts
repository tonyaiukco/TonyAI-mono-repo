import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ReportingContextQueryDto } from '../../common/reporting-context-query.dto';
import { UUID_SHAPE } from '../../common/parse-uuid-param.pipe';
import type { ReportTemplate } from '@tonyai/shared-types';

const SUBSIDIARY_ID_MAX_LENGTH = 36;
/** (19) A legacy selector is blank (whitespace included — its meaning is open
 * question (2)) or an id's shape; anything else — a NUL, which jsonb refuses
 * only after the whole artifact is built, markup, bidi controls — never
 * reaches the generation audit row or a label. */
const LEGACY_SUBSIDIARY_SELECTOR = new RegExp(`^(?:\\s*|${UUID_SHAPE.source.slice(1, -1)})$`, 'i');
const TEMPLATES: ReportTemplate[] = ['executive_summary', 'ghg_protocol_detail'];

/** Query of GET /reports/{pdf|excel|csv} — filter-aware (FR §5.3), year-scoped v1. */
export class ReportQueryDto {
  @IsString()
  @IsIn(TEMPLATES)
  template!: ReportTemplate;

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  /** (19): a blank selector keeps its legacy meaning (open question (2));
   * anything else must have an id's shape. 36 is a hyphenated id's length. */
  @IsOptional()
  @IsString()
  @MaxLength(SUBSIDIARY_ID_MAX_LENGTH)
  @Matches(LEGACY_SUBSIDIARY_SELECTOR)
  subsidiaryId?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeMethodologyNotes?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeEvidenceSummary?: boolean;
}

/** Query of GET /reports/meta — status/completeness for the preview badge. */
export class ReportMetaQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  /** (19): a blank selector keeps its legacy meaning (open question (2));
   * anything else must have an id's shape. 36 is a hyphenated id's length. */
  @IsOptional()
  @IsString()
  @MaxLength(SUBSIDIARY_ID_MAX_LENGTH)
  @Matches(LEGACY_SUBSIDIARY_SELECTOR)
  subsidiaryId?: string;
}

/** Additive context exports: strict booleans, with the canonical required context. */
export class ReportingExportQueryDto extends ReportingContextQueryDto {
  @IsString()
  @IsIn(TEMPLATES)
  template!: ReportTemplate;

  @IsOptional()
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean()
  includeMethodologyNotes?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean()
  includeEvidenceSummary?: boolean;
}
