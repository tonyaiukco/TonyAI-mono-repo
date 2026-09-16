import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { quoteCallerText } from '../common/caller-text';
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
        // Quoted, never whole: this sentence reaches a 400 and a bulk import's
        // report, where a 100,000-character cell came back as a
        // 100,053-character message (measured).
        //
        // And `$` goes, which is what makes the quote a bound. class-validator
        // replaces `$value` in the FINISHED sentence with the raw value
        // (`ValidationUtils.replaceMessageSpecialTokens`), using it as a
        // `String.replace` replacement string — so `$'` and `$&` expand too. A
        // unit of seven `$value` tokens followed by `$'` padding put the whole
        // of itself back, seven times over: a 99,994-byte body returned an
        // 18,563,231-byte 400 in 19 ms, and a 27 KB import built a
        // 5,656,876-character message per row and spent 5.7 s doing it
        // (measured). `@MaxLength` does not help — every constraint on a
        // property is evaluated, so the sentence is built anyway.
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} "${quoteCallerText(String(args.value)).replaceAll('$', '')}" is not a unit this system understands`,
      },
    });
  };
}
