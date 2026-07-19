import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { ReportTemplate } from '@tonyai/shared-types';

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

  @IsOptional()
  @IsString()
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

  @IsOptional()
  @IsString()
  subsidiaryId?: string;
}
