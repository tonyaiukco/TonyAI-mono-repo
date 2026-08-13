import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { GEOGRAPHY_CODES } from '@tonyai/shared-types';

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
  @IsIn(GEOGRAPHY_CODES as readonly string[])
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

  /** Only the three GHG Protocol scopes exist. Unbounded integers were accepted
   *  and stored (`[99]` returned 200), which the Edit dialog now makes a
   *  first-class UI path rather than an API-only curiosity. */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @IsIn([1, 2, 3], { each: true })
  includedScopes?: number[];
}
