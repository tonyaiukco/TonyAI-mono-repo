import { IsNumber, IsOptional, IsPositive, IsString, MinLength } from 'class-validator';

/**
 * Body of PATCH /api/v1/denominators/:id. Only the value/unit are mutable — the
 * (subsidiary, year, metric) identity is fixed (delete + recreate to change it).
 */
export class UpdateDenominatorDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  value?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  unit?: string;
}
