import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { FuelFileFields } from '../fuel-files.service';

/**
 * The multipart fields beside a fuel file (inc28-fuel-bulk D3). Each is text
 * here, and the service refuses a missing or unknown source, usage or digest
 * with the fuel upload's own codes, so the screen words each refusal.
 */
export class FuelFileFieldsDto implements FuelFileFields {
  @IsOptional() @IsString() @MaxLength(32) source?: string;
  @IsOptional() @IsString() @MaxLength(32) usage?: string;
  @IsOptional() @IsString() @MaxLength(128) fileSha256?: string;
  @IsOptional() @IsString() @MaxLength(262_144) declarations?: string;
}
