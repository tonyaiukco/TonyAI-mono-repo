import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { GEOGRAPHY_CODES } from '@tonyai/shared-types';

/** Body of PATCH /api/v1/locations/:id — all optional; `subsidiaryId` is
 * immutable (a location cannot move between subsidiaries). */
export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn(GEOGRAPHY_CODES as readonly string[])
  geographyCode?: string;

  @IsOptional()
  @IsString()
  address?: string | null;

  @IsOptional()
  @IsString()
  authorizedPerson?: string | null;
}
