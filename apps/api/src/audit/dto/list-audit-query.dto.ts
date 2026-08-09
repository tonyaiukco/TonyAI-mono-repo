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
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  type AuditAction,
  type AuditEntity,
  type ListAuditParams,
} from '@tonyai/shared-types';

/**
 * `ValidationPipe` runs with `whitelist + forbidNonWhitelisted`, so an unknown
 * query key is a 400 rather than a silently ignored filter — which matters here,
 * because a mistyped filter on an audit search would otherwise quietly return
 * the unfiltered trail.
 */
export class ListAuditQueryDto implements ListAuditParams {
  // `[...ARRAY]` rather than a cast: the decorator only needs a mutable array,
  // and keeping the property typed as the union means this DTO cannot drift
  // from `ListAuditParams` without failing to compile.
  @IsOptional()
  @IsIn([...AUDIT_ENTITIES])
  entity?: AuditEntity;

  @IsOptional()
  @IsIn([...AUDIT_ACTIONS])
  action?: AuditAction;

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
