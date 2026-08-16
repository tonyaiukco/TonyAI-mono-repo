import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

/** Optional filters for GET /api/v1/emissions/tracking-matrix. */
export class TrackingMatrixQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  /**
   * Narrow the matrix to one subsidiary.
   *
   * Added for the Data Entry status surface, which needs completeness for the
   * subsidiary in the form and nothing else. It reads the SAME endpoint on
   * purpose: DE-2 and DASH-3 are one rule shown twice, and a second
   * implementation for the second surface is exactly how the two would drift.
   *
   * A plain string, not `@IsUUID` — the seed's fixed ids are not
   * RFC-4122-conformant (see `ParseUuidParamPipe`). An id outside the caller's
   * accessible set returns the empty matrix, never a 403.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  subsidiaryId?: string;
}
