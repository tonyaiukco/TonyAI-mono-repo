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
import { INTENSITY_METRIC_KEYS } from '@tonyai/shared-types';
import type { IntensityMetricKey } from '@tonyai/shared-types';

// Derived, never restated. Hand-copying this list is how `sales_output` came to
// be offered by the UI, written by the seed and refused by the API — a metric
// that looked delivered from every angle except the one that saves it.
const METRICS: IntensityMetricKey[] = [...INTENSITY_METRIC_KEYS];

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
