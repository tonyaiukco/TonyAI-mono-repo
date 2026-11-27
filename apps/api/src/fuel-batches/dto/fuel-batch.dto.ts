import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, Matches } from 'class-validator';
import { ID_SHAPE_MESSAGE, UUID_SHAPE, lowercaseUuid } from '../../common/parse-uuid-param.pipe';
import {
  FILE_FUELS,
  FUEL_BATCH_CURSOR_SHAPE,
  FUEL_BULK_SUBMIT_MAX,
  FUEL_BATCH_STATUSES,
  FUEL_USAGES,
  REPORTING_YEAR_MAX,
  REPORTING_YEAR_MIN,
  type FileFuel,
  type FuelUsage,
  type UpdateFuelBatchDeclarationsRequest,
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
  @IsOptional() @Transform(lowercaseUuid) @Matches(UUID_SHAPE, { message: ID_SHAPE_MESSAGE }) subsidiaryId?: string;
  @IsOptional() @Transform(bool) @IsBoolean() awaitingMyDecision?: boolean;
  @IsOptional() @Transform(bool) @IsBoolean() mine?: boolean;
  @IsOptional() @Transform(bool) @IsBoolean() inReview?: boolean;
  @IsOptional() @IsString() @MaxLength(120) @Matches(FUEL_BATCH_CURSOR_SHAPE) after?: string;
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
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(FUEL_BULK_SUBMIT_MAX) @Transform(({ value }) => (Array.isArray(value) ? value.map((v) => lowercaseUuid({ value: v })) : value)) @Matches(UUID_SHAPE, { each: true, message: ID_SHAPE_MESSAGE }) batchIds!: string[];
}

/** `PATCH /fuel-batches/:id/declarations` (D13). */
export class UpdateFuelBatchDeclarationsDto implements UpdateFuelBatchDeclarationsRequest {
  @IsIn([...FUEL_USAGES]) usage!: FuelUsage;
  @IsOptional() @IsIn([...FILE_FUELS]) fuel?: FileFuel;
  @IsOptional() @IsInt() @Min(REPORTING_YEAR_MIN) @Max(REPORTING_YEAR_MAX) year?: number;
  @IsOptional() @IsInt() @Min(1) @Max(12) month?: number;
}
