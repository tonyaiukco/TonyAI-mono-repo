import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { TakeOverFuelRowsRequest, WithdrawFuelRowsRequest } from '@tonyai/shared-types';

/** `POST /fuel-files/:id/withdraw-rows` (C14): one account or one raw fuel name, with a reason. */
export class WithdrawFuelRowsDto implements WithdrawFuelRowsRequest {
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @IsString() @MaxLength(200) rawFuelName?: string;
  @IsString() @MaxLength(1_000) reason!: string;
}

/** `POST /fuel-files/:id/take-over` (masterkey, C8). */
export class TakeOverFuelRowsDto implements TakeOverFuelRowsRequest {
  @IsOptional() @IsUUID() accountId?: string;
}
