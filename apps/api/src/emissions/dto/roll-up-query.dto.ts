import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/** GET /api/v1/emissions/roll-up (inc26-group-tree, D9): one reporting year. */
export class RollUpQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  reportingYear!: number;
}
