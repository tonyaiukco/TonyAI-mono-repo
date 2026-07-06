import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Body of POST /api/v1/locations.
 * NB: `subsidiaryId` is a plain string, not @IsUUID — the tenant-access check
 * + the FK constraint enforce a valid, accessible subsidiary (seed ids are not
 * RFC-4122-conformant).
 */
export class CreateLocationDto {
  @IsString()
  @MinLength(1)
  subsidiaryId!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  address?: string | null;

  @IsOptional()
  @IsString()
  authorizedPerson?: string | null;
}
