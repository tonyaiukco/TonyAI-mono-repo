import { CalculationInputError } from '../calculations/errors';

/**
 * The engine reads a record's parameters from LP4-02 PR3. Until then one saved
 * would sit beside a figure that never used it, and freeze there once the record
 * is committed, so a write refuses any but null. PR3 deletes this gate.
 */
export function assertParametersArePriced(parameters: unknown): void {
  if (parameters !== null && parameters !== undefined) {
    throw new CalculationInputError(
      'record_parameters_invalid',
      'Calculations do not use record parameters yet, so they cannot be saved. Send none.',
    );
  }
}
