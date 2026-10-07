import { BadRequestException, ValidationPipe, type ValidationError } from '@nestjs/common';
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
 * Nest's ValidationPipe, answering a refused DTO with `validation_failed`
 * (LP3-01). The body is otherwise Nest's own — `message` is still the list of
 * class-validator sentences, one per field — so every existing reader of it
 * keeps working. Without this the filter could only call it `bad_request`,
 * the same as a refused state transition.
 */
export class CodedValidationPipe extends ValidationPipe {
  override createExceptionFactory() {
    return (validationErrors: ValidationError[] = []) =>
      new BadRequestException(errorBody('validation_failed', this.flattenValidationErrors(validationErrors)));
  }
}
