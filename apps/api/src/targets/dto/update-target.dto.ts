import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import type { EmissionsScope, TargetBasis } from '@tonyai/shared-types';

const BASES: TargetBasis[] = ['science_based', 'internal_annual', 'baseline_reduction'];
const SCOPES: EmissionsScope[] = ['all', 'scope1', 'scope2', 'scope3'];

/**
 * Body of PATCH /api/v1/targets/:id. All fields optional; `subsidiaryId` is
 * immutable (a target never moves across tenants). Coherence re-checked in the
 * service against the merged values.
 */
export class UpdateTargetDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn(BASES)
  basis?: TargetBasis;

  @IsOptional()
  @IsString()
  @IsIn(SCOPES)
  scope?: EmissionsScope;

  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  baselineYear?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  baselineTCo2e?: number;

  @IsOptional()
  @IsInt()
  @Min(2000)
  @Max(2100)
  targetYear?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  targetTCo2e?: number;
}
