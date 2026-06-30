import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class UpdateSubsidiaryDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  legalName?: string;

  @IsOptional()
  @IsString()
  tradingName?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  @IsIn(['UK', 'TR', 'EU'])
  geographyCode?: string;

  @IsOptional()
  @IsString()
  businessArea?: string;

  @IsOptional()
  @IsString()
  sector?: string;

  @IsOptional()
  @IsString()
  designatedPerson?: string;

  @IsOptional()
  @IsIn(['active', 'inactive', 'pending'])
  reportingStatus?: 'active' | 'inactive' | 'pending';

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  includedScopes?: number[];
}
