import {
  EXPORTED_TO_GRID_KWH_INPUT,
  FACILITY_CONSUMPTION_KWH_INPUT,
  SELF_GENERATED_KWH_INPUT,
  SELF_GENERATION_KEYS,
  isGenerationTopology,
  isSelfGenerationSource,
  selfGenerationIssue,
  type ElectricityRecordParameters,
  type SnapshotInput,
} from '@tonyai/shared-types';
import { CalculationInputError } from './errors';

/**
 * Electricity's self-generation block in the engine (self-gen-model; Decisions
 * 2026-11-20 D5, D6, D8). The block is checked and echoed, never priced:
 * Scope 2 stays the record's value (the grid import) × the year's grid
 * factor, location-based, in any geography.
 */

/** The shape CHECK's bounds (`20261123120000_self_gen_model`), the DTO's too. */
const KWH_FLOOR = 1e-300;
const KWH_CEILING = 1e300;

const MESSAGES = {
  generationTopology: 'A self-generation block states its topology.',
  selfGenerationSource: 'A self-generation block states its source: solar, wind, natural gas CHP or a diesel generator.',
  selfGeneratedKwh: 'A self-generation block states the kWh generated on site.',
} as const;

/**
 * Refuses a block the engine does not accept (`selfGenerationIssue`), as an
 * input refusal (HTTP 400): a missing topology, source or generated kWh
 * (`parameters_required`, naming it), a topology other than `A`
 * (`parameters_not_applicable`), exports above the generation, or a key or
 * value the block does not define (`record_parameters_invalid`). The DTO
 * refuses the last already; the engine holds the same named values and the
 * same bounds as the DTO and the shape CHECK, so a caller that skipped the DTO
 * gets a 400 here, never the CHECK's 23514 as a 500.
 */
export function assertSelfGeneration(parameters: object): ElectricityRecordParameters {
  if (typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new CalculationInputError('record_parameters_invalid', 'Record parameters are an object or null.');
  }
  const unknown = Object.keys(parameters).filter((key) => !(SELF_GENERATION_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new CalculationInputError('record_parameters_invalid', 'An Electricity record takes only a self-generation block.');
  }
  const block = parameters as ElectricityRecordParameters;
  const { generationTopology, selfGenerationSource } = block as Record<string, unknown>;
  if (generationTopology != null && !isGenerationTopology(generationTopology)) {
    throw new CalculationInputError('record_parameters_invalid', 'A self-generation topology is A, B or C.');
  }
  if (selfGenerationSource != null && !isSelfGenerationSource(selfGenerationSource)) {
    throw new CalculationInputError(
      'record_parameters_invalid',
      'A self-generation source is solar, wind, natural_gas_chp or diesel_generator.',
    );
  }
  for (const [key, min] of [
    [SELF_GENERATED_KWH_INPUT, 0],
    [EXPORTED_TO_GRID_KWH_INPUT, 0],
    // Above zero, from the CHECK's floor, as the DTO says.
    [FACILITY_CONSUMPTION_KWH_INPUT, KWH_FLOOR],
  ] as const) {
    const value: unknown = block[key];
    if (value !== null && value !== undefined && (typeof value !== 'number' || !(value >= min && value <= KWH_CEILING))) {
      throw new CalculationInputError('record_parameters_invalid', `${key} is a number of kWh within the accepted range.`);
    }
  }
  const issue = selfGenerationIssue(block);
  if (issue === null) return block;
  switch (issue.code) {
    case 'parameters_required':
      throw new CalculationInputError('parameters_required', MESSAGES[issue.input], { input: issue.input });
    case 'parameters_not_applicable':
      throw new CalculationInputError(
        'parameters_not_applicable',
        `Self-generation topology ${String(block.generationTopology)} is not accepted yet: only A, behind the meter.`,
      );
    case 'record_parameters_invalid':
      throw new CalculationInputError('record_parameters_invalid', 'The kWh exported to the grid cannot exceed the kWh generated.');
  }
}

/**
 * The record inputs a block's calculation echoes, origin `user`: the generated
 * kWh, then the exported and the consumed kWh when given. The topology and the
 * source stay in the record's parameters.
 */
export function selfGenerationInputs(block: ElectricityRecordParameters): SnapshotInput[] {
  const inputs: SnapshotInput[] = [];
  for (const name of [SELF_GENERATED_KWH_INPUT, EXPORTED_TO_GRID_KWH_INPUT, FACILITY_CONSUMPTION_KWH_INPUT] as const) {
    const value = block[name];
    if (value !== null && value !== undefined) inputs.push({ name, value, origin: 'user' });
  }
  return inputs;
}
