import { IsIn, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import {
  FUEL_SOURCES,
  type ConfirmFuelAccountRequest,
  type CreateFuelAccountRequest,
  type FuelSource,
  type UpdateFuelAccountRequest,
} from '@tonyai/shared-types';

/** `POST /fuel-accounts` (masterkey, B7). */
export class CreateFuelAccountDto implements CreateFuelAccountRequest {
  @IsIn(FUEL_SOURCES) source!: FuelSource;
  @IsString() @MaxLength(64) code!: string;
  @IsString() @MaxLength(200) name!: string;
  @IsUUID() subsidiaryId!: string;
}

/** `POST /fuel-accounts/:id/confirm` (C5). */
export class ConfirmFuelAccountDto implements ConfirmFuelAccountRequest {
  @IsUUID() subsidiaryId!: string;
}

/** `PATCH /fuel-accounts/:id` (masterkey): a company, or null to withdraw the mapping. */
export class UpdateFuelAccountDto implements UpdateFuelAccountRequest {
  @ValidateIf((dto: UpdateFuelAccountDto) => dto.subsidiaryId !== null)
  @IsUUID()
  subsidiaryId!: string | null;
}
