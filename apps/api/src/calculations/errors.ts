import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  type CalculationRefusalBody,
  type CalculationRefusalCode,
  type CoverageKey,
} from '@tonyai/shared-types';

/**
 * The refusal codes of each HTTP class. `CALCULATION_REFUSAL_STATUS` types its
 * values as the union, so the split is written out — and `errors.spec.ts`
 * checks every code lands in the class its status names.
 */
export type InputRefusalCode = Extract<
  CalculationRefusalCode,
  | 'unit_unknown'
  | 'unit_blocked'
  | 'unit_not_for_category'
  | 'activity_type_not_for_category'
  | 'activity_type_required'
>;
export type CoverageRefusalCode = Extract<
  CalculationRefusalCode,
  'no_factor' | 'placeholder_refused' | 'no_conversion' | 'calorific_basis_mismatch'
>;
export type LibraryRefusalCode = Extract<CalculationRefusalCode, 'ambiguous_factor' | 'factor_scope_mismatch'>;

export const INPUT_REFUSAL_CODES: readonly InputRefusalCode[] = [
  'unit_unknown',
  'unit_blocked',
  'unit_not_for_category',
  'activity_type_not_for_category',
  'activity_type_required',
];
export const COVERAGE_REFUSAL_CODES: readonly CoverageRefusalCode[] = [
  'no_factor',
  'placeholder_refused',
  'no_conversion',
  'calorific_basis_mismatch',
];
export const LIBRARY_REFUSAL_CODES: readonly LibraryRefusalCode[] = ['ambiguous_factor', 'factor_scope_mismatch'];

/**
 * The calculation refused what the caller sent (400): a unit the engine does
 * not know or cannot calculate, a unit or activity type the category does not
 * have, or a typed category's new record naming no activity type. The body
 * carries the machine-readable `code` (`CalculationRefusalBody`); `message`
 * stays the sentence every existing reader shows.
 */
export class CalculationInputError extends BadRequestException {
  readonly code: InputRefusalCode;

  constructor(code: InputRefusalCode, message: string) {
    super({ statusCode: 400, error: 'Bad Request', message, code } satisfies CalculationRefusalBody);
    this.code = code;
  }
}

/**
 * No factor path covers this lookup (404): none at all (`no_factor`), only
 * non-authoritative ones where placeholders are refused
 * (`placeholder_refused`), a factor whose sourced conversion nobody loaded
 * (`no_conversion`), or only the other calorific basis
 * (`calorific_basis_mismatch`).
 *
 * A 404 like "Subsidiary not found", and the bulk importer has to tell the two
 * apart: one is a row the factor library cannot price yet (`no_factor`), the
 * other a reporting entity the caller may not name (`not_found`). The class is
 * that contract — every coverage refusal is this class, whatever its code, or
 * the importer would report it as "not yours".
 *
 * `coverage` is the exact lookup, built by the engine from validated canonical
 * values only — and only after the record path's tenant checks have passed, so
 * a foreign subsidiary still gets the plain 404 with nothing about the library.
 */
export class NoEmissionFactorError extends NotFoundException {
  readonly code: CoverageRefusalCode;
  readonly coverage: CoverageKey | undefined;

  constructor(message: string, options: { code?: CoverageRefusalCode; coverage?: CoverageKey } = {}) {
    const code = options.code ?? 'no_factor';
    super({
      statusCode: 404,
      error: 'Not Found',
      message,
      code,
      ...(options.coverage ? { coverage: options.coverage } : {}),
    } satisfies CalculationRefusalBody);
    this.code = code;
    this.coverage = options.coverage;
  }
}

/**
 * The factor library contradicts itself (409): two releases claim one key at
 * the same rank (`ambiguous_factor`), or the resolved factor's scope is not its
 * category's (`factor_scope_mismatch`). A defect a person settles in the
 * library, never a silent pick.
 */
export class FactorLibraryConflictError extends ConflictException {
  readonly code: LibraryRefusalCode;

  constructor(code: LibraryRefusalCode, message: string) {
    super({ statusCode: 409, error: 'Conflict', message, code } satisfies CalculationRefusalBody);
    this.code = code;
  }
}
