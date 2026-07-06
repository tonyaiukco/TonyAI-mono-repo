import { IsOptional, IsString, MinLength } from 'class-validator';

/** Body of PATCH /api/v1/locations/:id — all optional; `subsidiaryId` is
 * immutable (a location cannot move between subsidiaries). */
export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  address?: string | null;

  @IsOptional()
  @IsString()
  authorizedPerson?: string | null;
}
