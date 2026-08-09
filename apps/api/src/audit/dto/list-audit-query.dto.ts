import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '@tonyai/shared-types';

/**
 * `ValidationPipe` runs with `whitelist + forbidNonWhitelisted`, so an unknown
 * query key is a 400 rather than a silently ignored filter — which matters here,
 * because a mistyped filter on an audit search would otherwise quietly return
 * the unfiltered trail.
 */
export class ListAuditQueryDto {
  @IsOptional()
  @IsIn(AUDIT_ENTITIES as unknown as string[])
  entity?: string;

  @IsOptional()
  @IsIn(AUDIT_ACTIONS as unknown as string[])
  action?: string;

  /** Not a UUID: `entityId` is an unconstrained string so audit rows survive
   * the deletion of their subject. */
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  /** Capped so a single request cannot pull the whole trail into memory. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
