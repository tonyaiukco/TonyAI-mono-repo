import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MAX_CURSOR_LENGTH, MAX_PAGE_LIMIT, type CursorPageParams } from '@tonyai/shared-types';

const DECIMAL = /^[0-9]{1,9}$/;

/**
 * `@Transform` for an integer query value: plain decimal digits become a
 * number; anything else (`1.5`, `1e2`, `0x10`, ` 5`, an empty or repeated key)
 * stays as it came, for `@IsInt` to refuse. `@Type(() => Number)` would read
 * `0x10` as 16 and `' 5'` as 5 — a silent correction the contract forbids.
 */
export function decimalInt({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && DECIMAL.test(value) ? Number(value) : value;
}

/** `limit`: an integer in [1, MAX_PAGE_LIMIT]; omitted means the default. Never clamped. */
export const PageLimit = () =>
  applyDecorators(IsOptional(), Transform(decimalInt), IsInt(), Min(1), Max(MAX_PAGE_LIMIT));

/** `cursor`: omitted on the first page; empty or over the bound is refused. */
export const PageCursor = () =>
  applyDecorators(IsOptional(), IsString(), MinLength(1), MaxLength(MAX_CURSOR_LENGTH));

/** A `CursorPage` route's own two parameters (LP4-05's contract). */
export class CursorPageQueryDto implements CursorPageParams {
  @PageLimit()
  limit?: number;

  @PageCursor()
  cursor?: string;
}
