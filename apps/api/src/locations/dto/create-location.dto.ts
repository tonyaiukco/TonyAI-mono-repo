import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { GEOGRAPHY_CODES } from '@tonyai/shared-types';

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

  @IsString()
  @IsIn(GEOGRAPHY_CODES as readonly string[])
  geographyCode!: string;

  @IsOptional()
  @IsString()
  address?: string | null;

  @IsOptional()
  @IsString()
  authorizedPerson?: string | null;
}
