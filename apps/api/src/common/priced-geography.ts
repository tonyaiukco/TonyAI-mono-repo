import type { CalculationsService } from '../calculations/calculations.service';
import { geographyWithoutFactors } from '../subsidiaries/tree-errors';

/**
 * A company's or facility's geography must be one the environment's factor
 * library can price (inc26-group-tree, INC-2.6 §2.1, design D10): at least one
 * coverage entry for it under the pricing policy — the same read the web's
 * pickers and Data Entry's legend use. Anything else is refused with 422
 * `geography_without_factors` before it is stored; a stored geography stays
 * valid until it is changed, so callers check only a value they are about to
 * write anew.
 */
export async function assertPricedGeography(
  calculations: Pick<CalculationsService, 'coverage'>,
  geographyCode: string,
): Promise<void> {
  const { entries } = await calculations.coverage();
  if (!entries.some((entry) => entry.geographyCode === geographyCode)) {
    throw geographyWithoutFactors(geographyCode);
  }
}
