import { IsInt, IsNumber, IsString, Max, Min } from 'class-validator';
import { IsActivityUnit } from '../is-activity-unit.decorator';

/**
 * Body of POST /api/v1/calculations/preview.
 * Mirrors CalculationInput in @tonyai/shared-types.
 */
export class CalculationInputDto {
  @IsString()
  category!: string;

  @IsString()
  geographyCode!: string;

  @IsInt()
  @Min(2000)
  @Max(2100)
  reportingYear!: number;

  @IsNumber()
  @Min(0)
  value!: number;

  @IsActivityUnit()
  @IsString()
  unit!: string;
}
