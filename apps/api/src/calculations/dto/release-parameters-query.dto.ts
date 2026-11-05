import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { CATEGORIES, GEOGRAPHY_CODES } from '@tonyai/shared-types';
import type { Category, GeographyCode } from '@tonyai/shared-types';
import { ACTIVITY_TYPE_SHAPE, ACTIVITY_TYPE_SHAPE_MESSAGE } from '../activity-type';

/**
 * Query of GET /api/v1/factors/parameters (LP4-02 PR4): one lookup's key, as
 * the preview takes it. The vocabularies are checked here, so no text a caller
 * types reaches the lookup or comes back in a refusal.
 */
export class ReleaseParametersQueryDto {
  @IsString()
  @IsIn(CATEGORIES as readonly string[])
  category!: Category;

  @IsOptional()
  @IsString()
  @Matches(ACTIVITY_TYPE_SHAPE, { message: ACTIVITY_TYPE_SHAPE_MESSAGE })
  activityType?: string;

  @IsString()
  @IsIn(GEOGRAPHY_CODES as readonly string[])
  geographyCode!: GeographyCode;

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;
}
