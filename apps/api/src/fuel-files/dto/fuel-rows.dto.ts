import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, Matches } from 'class-validator';
import { ID_SHAPE_MESSAGE, UUID_SHAPE, lowercaseUuid } from '../../common/parse-uuid-param.pipe';
import { FUEL_UPLOAD_CURSOR_SHAPE, type FormFuelBatchesRequest, type TakeOverFuelRowsRequest, type WithdrawFuelRowsRequest } from '@tonyai/shared-types';

/** `POST /fuel-files/:id/withdraw-rows` (C14): one account or one raw fuel name, with a reason. */
export class WithdrawFuelRowsDto implements WithdrawFuelRowsRequest {
  @IsOptional() @Transform(lowercaseUuid) @Matches(UUID_SHAPE, { message: ID_SHAPE_MESSAGE }) accountId?: string;
  @IsOptional() @IsString() @MaxLength(200) rawFuelName?: string;
  @IsString() @MaxLength(1_000) reason!: string;
}

/** `POST /fuel-files/:id/take-over` (masterkey, C8). */
export class TakeOverFuelRowsDto implements TakeOverFuelRowsRequest {
  @IsOptional() @Transform(lowercaseUuid) @Matches(UUID_SHAPE, { message: ID_SHAPE_MESSAGE }) accountId?: string;
}

/** `POST /fuel-files/:id/form-batches` (D8): the holder's held rows made ready first, on request. */
export class FormFuelBatchesDto implements FormFuelBatchesRequest {
  @IsOptional() @IsBoolean() retryHeld?: boolean;
}

/** `GET /fuel-files`: the next page after an upload's cursor (`fuelUploadCursor`). */
export class FuelUploadsQueryDto {
  @IsOptional() @IsString() @MaxLength(80) @Matches(FUEL_UPLOAD_CURSOR_SHAPE) after?: string;
}
