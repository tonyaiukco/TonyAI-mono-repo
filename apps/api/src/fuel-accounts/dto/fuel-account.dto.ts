import { Transform } from 'class-transformer';
import { IsIn, IsString, MaxLength, ValidateIf, Matches } from 'class-validator';
import { ID_SHAPE_MESSAGE, UUID_SHAPE, lowercaseUuid } from '../../common/parse-uuid-param.pipe';
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
  @Transform(lowercaseUuid) @Matches(UUID_SHAPE, { message: ID_SHAPE_MESSAGE }) subsidiaryId!: string;
}

/** `POST /fuel-accounts/:id/confirm` (C5). */
export class ConfirmFuelAccountDto implements ConfirmFuelAccountRequest {
  @Transform(lowercaseUuid) @Matches(UUID_SHAPE, { message: ID_SHAPE_MESSAGE }) subsidiaryId!: string;
}

/** `PATCH /fuel-accounts/:id` (masterkey): a company, or null to withdraw the mapping. */
export class UpdateFuelAccountDto implements UpdateFuelAccountRequest {
  @ValidateIf((dto: UpdateFuelAccountDto) => dto.subsidiaryId !== null)
  @Transform(lowercaseUuid) @Matches(UUID_SHAPE, { message: ID_SHAPE_MESSAGE })
  subsidiaryId!: string | null;
}
