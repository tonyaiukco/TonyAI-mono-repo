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
import { MAX_AUDIT_LIMIT } from '../audit.service';
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

  /** Capped so a single request cannot pull the whole trail into memory.
   * The service clamps to the same number for non-HTTP callers. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_AUDIT_LIMIT)
  limit?: number;

  /** Bounded too: a deep offset makes the index walk pure waste, and the honest
   * answer at that depth is "narrow your filters", not a slower page. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset?: number;
}

/**
 * `implements` checks only the filters DECLARED here: TypeScript does not
 * require a class to declare an interface's optional members. This makes the
 * doc comment above true — add a filter to `ListAuditParams` and forget it here,
 * and this stops compiling with the missing key named.
 */
const _noMissingAuditFilters: never = null as unknown as Exclude<
  keyof ListAuditParams,
  keyof ListAuditQueryDto
>;
void _noMissingAuditFilters;
