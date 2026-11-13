import { describe, expect, it } from 'vitest';
import { CEILING_UNIT_MULTIPLIERS } from '@tonyai/shared-types';
import { baseUnitOf, normalize } from './normalization';

/**
 * The first-period typo ceilings (BUG-R2-07 tier 3) reach their base unit
 * through a copy of the definitional multipliers in the contract package, so
 * that the web and the operator scripts can judge a record without the API's
 * normaliser. A copy can drift; this pins it to the normaliser, unit by unit.
 */
describe('first-period ceiling unit multipliers', () => {
  it.each(Object.entries(CEILING_UNIT_MULTIPLIERS))(
    '%s matches the calculation normaliser',
    (unit, { base, multiplier }) => {
      const result = normalize(1, unit, 'any', null);
      expect(result.normalizedValue).toBe(multiplier);
      // Metered m³ is its own base: the ceiling holds it to the Sm³ NUMBER,
      // never through a conversion, and the normaliser agrees it is no Sm³.
      expect(baseUnitOf(unit)).toBe(base);
    },
  );
});
