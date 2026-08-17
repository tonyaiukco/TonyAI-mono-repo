import { Type } from 'class-transformer';
import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';

/**
 * Filters for GET /api/v1/emissions/completeness — the drill-down behind one
 * subsidiary in the tracking matrix.
 *
 * Both params are REQUIRED, unlike the matrix's. The invoice rule is
 * `locations × 12` for one reporting year, so a year-less answer would compare
 * several years' records against one year's denominator; and the response is a
 * per-location grid, which only means something for a single subsidiary. The
 * matrix can afford optional filters because it falls back to the yes/no rule;
 * this endpoint has no such fallback to offer.
 */
export class CompletenessQueryDto {
  /**
   * A plain string, not `@IsUUID` — the seed's fixed ids are not
   * RFC-4122-conformant (see `ParseUuidParamPipe`). An id outside the caller's
   * accessible set is answered as not found rather than forbidden, so the
   * response cannot confirm the row exists.
   */
  @IsString()
  @MinLength(1)
  subsidiaryId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;
}
