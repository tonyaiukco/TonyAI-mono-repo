import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import type { CalculationResultV3, Locale } from '@tonyai/shared-types';
import { calculationInputs, type CalculationInputsKey } from './calculation-inputs';
import { REPORT_CATALOGUES } from './report-vocabulary';
import { ISSUANCE_CATALOGUES } from '../report-issuances/issuance-html';

// Display fixture: the numbers are a snapshot's, not a source's.
const v3 = (over: Partial<CalculationResultV3>): CalculationResultV3 => ({
  snapshotSchema: 3, factorId: 'display-factor', tCo2e: 1, parameters: [], parameterRows: [], refrigerantTerms: null, ...over,
} as unknown as CalculationResultV3);

const words = (locale: Locale, catalogue: Readonly<Record<string, string>> = REPORT_CATALOGUES[locale]) => ({
  text: (key: CalculationInputsKey, values?: Record<string, string>) => String(new IntlMessageFormat(catalogue[key], locale).format(values)),
  locale,
});

describe('a record\'s calculation inputs in a report (LP4-02 PR5, task 5.3)', () => {
  const billed = v3({ parameters: [
    { name: 'billedGcvKcalPerSm3', value: 9349.174, origin: 'user' },
    { name: 'ncvKcalPerSm3', value: 8078.6702, origin: 'derived' },
  ] });

  it.each(['en', 'tr'] as const)('%s names a gas record\'s own NCV and where it came from', (locale) => {
    const text = calculationInputs(billed, words(locale));
    expect(text).toContain(locale === 'en' ? '9,349.174' : '9.349,174');
    expect(text).toContain(locale === 'en' ? '8,078.67' : '8.078,67');
    expect(text).toContain(REPORT_CATALOGUES[locale].inputsOriginDerived);
  });

  it('names the default NCV as the release\'s, and a metered reading\'s correction factor', () => {
    const text = calculationInputs(v3({ parameters: [
      { name: 'ncvKcalPerSm3', value: 8250, origin: 'default' },
      { name: 'volumeCorrectionFactor', value: 0.97, origin: 'user' },
    ] }), words('en'));
    expect(text).toBe("NCV 8,250 kcal/Sm³ (the release's default); volume correction ×0.97");
  });

  it('prints each equipment line\'s capacity, rate and refill, a refill alone included', () => {
    const text = calculationInputs(v3({ refrigerantTerms: [
      { equipmentType: 'split_air_conditioner', leakRateChoice: 'alternative', capacityKg: 10, leakRate: 0.1, leakedKg: 1, refillKg: 0.5 },
      { equipmentType: 'chiller', leakRateChoice: 'default', capacityKg: 0, leakRate: 0.02, leakedKg: 0, refillKg: 2 },
    ] }), words('en'));
    expect(text).toBe(
      'split air conditioner: 10 kg × 10% + 0.5 kg refilled = 1.5 kg released; '
      + 'chiller: 0 kg × 2% + 2 kg refilled = 2 kg released',
    );
  });

  it('reads the same in the issued reports\' catalogue', () => {
    expect(calculationInputs(billed, words('tr', ISSUANCE_CATALOGUES.tr))).toBe(calculationInputs(billed, words('tr')));
  });

  it('is empty for a snapshot that carries no inputs', () => {
    expect(calculationInputs(v3({}), words('en'))).toBe('');
    expect(calculationInputs({ snapshotSchema: 2, tCo2e: 1 }, words('en'))).toBe('');
    expect(calculationInputs(null, words('en'))).toBe('');
  });
});
