import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { isKnownUnit } from './normalization';

/**
 * Rejects a unit the calculation engine cannot resolve, at validation time.
 *
 * `activityUnit` was a bare `@IsString()`, so any string reached the engine and
 * failed later — or, for a unit the dropdown offered but the engine did not
 * know, failed only once someone tried to calculate.
 *
 * It delegates to `isKnownUnit` rather than listing values, because the engine
 * accepts ALIASES (`m3`, `m³`, `cubic_metre`) and a hand-written whitelist would
 * quietly reject spellings that work today. Being *known* is the DTO's question;
 * whether a known unit can currently be CALCULATED (Sm³ cannot) is the service's,
 * so that refusal keeps its own explanatory message.
 */
export function IsActivityUnit(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isActivityUnit',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isKnownUnit(value),
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} "${String(args.value)}" is not a unit this system understands`,
      },
    });
  };
}
