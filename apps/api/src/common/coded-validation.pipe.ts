import { BadRequestException, ValidationPipe, type ValidationError } from '@nestjs/common';
import { isApiErrorCode, type ApiErrorCode, type DomainErrorCode } from '@tonyai/shared-types';
import { errorBody } from './api-error';

/**
 * The global pipe's options — one copy, shared by `main.ts` and the
 * integration suite (`configureApp`), so the app under test validates exactly
 * as the deployed one does.
 */
export const GLOBAL_VALIDATION_OPTIONS = {
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
} as const;

/**
 * A constraint that refuses with its own code (LP4-04): pass it as a
 * decorator's options, `@Max(ACTIVITY_VALUE_MAX, codedConstraint('…'))`.
 * class-validator hands the context back on the failure, so the pipe and the
 * bulk importer read one marker instead of matching property names.
 */
export function codedConstraint(code: DomainErrorCode): { context: { code: DomainErrorCode } } {
  return { context: { code } };
}

/**
 * The code a field's failure carries: when EVERY constraint it failed was
 * declared with `codedConstraint` and the same code, that code; otherwise
 * null. A value that is both negative and over a bound, or a field with
 * nested failures, keeps the generic refusal.
 */
export function failureCode(error: ValidationError): ApiErrorCode | null {
  if (error.children && error.children.length > 0) return null;
  const failed = Object.keys(error.constraints ?? {});
  if (failed.length === 0) return null;
  const codes = new Set(failed.map((key) => (error.contexts?.[key] as { code?: unknown } | undefined)?.code));
  if (codes.size !== 1) return null;
  const [code] = codes;
  return isApiErrorCode(code) ? code : null;
}

/**
 * Nest's ValidationPipe, answering a refused DTO with `validation_failed`
 * (LP3-01). The body is otherwise Nest's own — `message` is still the list of
 * class-validator sentences, one per field — so every existing reader of it
 * keeps working. Without this the filter could only call it `bad_request`,
 * the same as a refused state transition.
 *
 * A body whose ONLY failure is one coded constraint answers that code
 * instead (`activity_value_too_large`), its `message` the field's sentence. With
 * more than one field refused it stays `validation_failed`: a screen worded
 * by one code would hide the other field's refusal.
 */
export class CodedValidationPipe extends ValidationPipe {
  override createExceptionFactory() {
    return (validationErrors: ValidationError[] = []) => {
      const sentences = this.flattenValidationErrors(validationErrors);
      const own = validationErrors.length === 1 ? failureCode(validationErrors[0]) : null;
      // A domain code's message is one sentence, as every other thrower's is.
      return new BadRequestException(
        own ? errorBody(own, sentences.join(' ')) : errorBody('validation_failed', sentences),
      );
    };
  }
}
