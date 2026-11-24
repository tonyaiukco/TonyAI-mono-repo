import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { recordReferenceIssues, storableRecordReferences } from '@tonyai/shared-types';

/**
 * A record's invoice number and supplier, as `input` stores them (UAT round 4,
 * BUG-16; `uat4-quick-fixes`): trimmed, and dropped when blank, so "none" has
 * one spelling. A `@Transform`, so it runs before the bound below is checked.
 * Every other key of `input` passes through as sent.
 */
export function storableInput({ value }: { value: unknown }): unknown {
  return storableRecordReferences(value);
}

@ValidatorConstraint({ name: 'ValidRecordReferences', async: false })
class ValidRecordReferencesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return recordReferenceIssues(value).length === 0;
  }

  defaultMessage(args: ValidationArguments): string {
    return recordReferenceIssues(args.value).join('; ');
  }
}

/**
 * `input`'s invoice number and supplier hold to their rule
 * (`recordReferenceIssues`): text, within the shared limits. It bounds these
 * two keys only. `input` stays the free object it has always been for the
 * rest, so every record written before this rule still saves.
 */
export function IsValidRecordReferences(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: ValidRecordReferencesConstraint,
    });
  };
}
