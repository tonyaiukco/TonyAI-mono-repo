import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { canonicalPeriodValue } from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { decimalInt } from './cursor-page-query.dto';
import { ID_SHAPE_MESSAGE, lowercaseUuid, UUID_SHAPE } from './parse-uuid-param.pipe';

/** An optional id filter: the accepted spelling lowercased; empty or not an id is refused. */
export const IdFilter = () =>
  applyDecorators(IsOptional(), Transform(lowercaseUuid), IsString(), Matches(UUID_SHAPE, { message: ID_SHAPE_MESSAGE }));

/** An optional reporting-year filter, in the range every write accepts. */
export const YearFilter = () => applyDecorators(IsOptional(), Transform(decimalInt), IsInt(), Min(2000), Max(2100));

/** A period value is only meaningful within its period, and must be one of its values (any case). */
@ValidatorConstraint({ name: 'periodValueOfPeriod' })
export class PeriodValueOfPeriod implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const { period } = args.object as { period?: unknown };
    return typeof value === 'string' && typeof period === 'string' && canonicalPeriodValue(period, value) !== null;
  }

  defaultMessage(): string {
    return 'periodValue requires period and must be one of its values';
  }
}

/**
 * Free text with no control characters. PostgreSQL refuses a NUL in a text
 * parameter (22021), which would surface as a 500; the rest have no place in a
 * search box. Checked by code point, so the source carries no control escape.
 */
@ValidatorConstraint({ name: 'noControlCharacters' })
export class NoControlCharacters implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return false;
    }
    return true;
  }

  defaultMessage(): string {
    return '$property must not contain control characters';
  }
}

/**
 * The subsidiaries a list reads: the caller's CURRENT access, narrowed to the
 * requested one. A subsidiary the caller cannot see is an empty set — answered
 * exactly like one that holds nothing, so no list is an existence oracle.
 */
export function scopedSubsidiaryIds(user: RequestUser, requested: string | undefined): string[] {
  return requested === undefined
    ? [...user.accessibleSubsidiaryIds]
    : user.accessibleSubsidiaryIds.filter((id) => id === requested);
}
