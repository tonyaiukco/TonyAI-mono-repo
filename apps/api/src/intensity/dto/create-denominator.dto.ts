import {
  IsIn,
  IsInt,
  IsNumber,
  IsPositive,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import type { IntensityMetricKey } from '@tonyai/shared-types';

const METRICS: IntensityMetricKey[] = [
  'area',
  'revenue',
  'headcount',
  'production_output',
];

/**
 * Body of POST /api/v1/denominators — a configured intensity denominator for one
 * subsidiary + year + metric. `value` must be positive (it is a divisor). The
 * (subsidiary, year, metric) uniqueness is enforced by the DB (409 on clash).
 */
export class CreateDenominatorDto {
  @IsString()
  @MinLength(1)
  subsidiaryId!: string;

  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @IsString()
  @IsIn(METRICS)
  metric!: IntensityMetricKey;

  @IsNumber()
  @IsPositive()
  value!: number;

  @IsString()
  @MinLength(1)
  unit!: string;
}
