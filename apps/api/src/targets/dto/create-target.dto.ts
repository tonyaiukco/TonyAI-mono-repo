import { IsIn, IsInt, IsNumber, IsString, Max, Min, MinLength } from 'class-validator';
import type { EmissionsScope, TargetBasis } from '@tonyai/shared-types';

const BASES: TargetBasis[] = ['science_based', 'internal_annual', 'baseline_reduction'];
const SCOPES: EmissionsScope[] = ['all', 'scope1', 'scope2', 'scope3'];

/**
 * Body of POST /api/v1/targets — an emission-reduction target for one
 * subsidiary. Cross-field coherence (targetYear > baselineYear, target ≤
 * baseline) is enforced in the service.
 */
export class CreateTargetDto {
  @IsString()
  @MinLength(1)
  subsidiaryId!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @IsIn(BASES)
  basis!: TargetBasis;

  @IsString()
  @IsIn(SCOPES)
  scope!: EmissionsScope;

  @IsInt()
  @Min(2000)
  @Max(2100)
  baselineYear!: number;

  @IsNumber()
  @Min(0)
  baselineTCo2e!: number;

  @IsInt()
  @Min(2000)
  @Max(2100)
  targetYear!: number;

  @IsNumber()
  @Min(0)
  targetTCo2e!: number;
}
