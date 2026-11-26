import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { blankToNull } from '../../common/blank-to-null';
import { GEOGRAPHY_CODES, LOCATION_TYPES, type LocationType } from '@tonyai/shared-types';

/** Body of PATCH /api/v1/locations/:id — all optional; `subsidiaryId` is
 * immutable (a location cannot move between subsidiaries). */
export class UpdateLocationDto {
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn(GEOGRAPHY_CODES as readonly string[])
  geographyCode?: string;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  address?: string | null;

  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  authorizedPerson?: string | null;

  /** Optional facility type (inc26-group-tree, RD12); `null` clears it. */
  @IsOptional()
  @IsIn(LOCATION_TYPES as readonly string[])
  locationType?: LocationType | null;
}
