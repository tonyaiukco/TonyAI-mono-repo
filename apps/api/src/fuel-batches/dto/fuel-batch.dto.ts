import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import {
  FUEL_BATCH_STATUSES,
  type BulkSubmitFuelBatchesRequest,
  type FuelBatchFilters,
  type FuelBatchStatus,
  type SubmitFuelBatchRequest,
  type WithdrawFuelBatchRequest,
} from '@tonyai/shared-types';

const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

/** `GET /fuel-batches` and `/metadata` (D10). */
export class FuelBatchFiltersDto implements FuelBatchFilters {
  @IsOptional() @IsIn([...FUEL_BATCH_STATUSES]) status?: FuelBatchStatus;
  @IsOptional() @IsUUID() subsidiaryId?: string;
  @IsOptional() @Transform(bool) @IsBoolean() awaitingMyDecision?: boolean;
  @IsOptional() @Transform(bool) @IsBoolean() mine?: boolean;
}

/** `GET /fuel-batches/:id/rows`: a page of the batch's rows. */
export class FuelBatchRowsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class SubmitFuelBatchDto implements SubmitFuelBatchRequest {
  @IsOptional() @IsString() @MaxLength(2_000) varianceReason?: string;
}

export class WithdrawFuelBatchDto implements WithdrawFuelBatchRequest {
  @IsString() @MaxLength(1_000) reason!: string;
}

export class BulkSubmitFuelBatchesDto implements BulkSubmitFuelBatchesRequest {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) batchIds!: string[];
}
