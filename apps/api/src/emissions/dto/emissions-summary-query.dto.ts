import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Optional filters for GET /api/v1/emissions/summary (all AND-combined).
 * Tenant scope is always enforced server-side on top of these.
 */
export class EmissionsSummaryQueryDto {
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
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2, 3])
  scope?: number;

  @IsOptional()
  @IsString()
  category?: string;
}
