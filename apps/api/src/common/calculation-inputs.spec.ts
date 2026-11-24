import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import type { CalculationResultV3, Locale } from '@tonyai/shared-types';
import { calculationInputs, type CalculationInputsKey } from './calculation-inputs';
import { REPORT_CATALOGUES } from '../reports/report-vocabulary';
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

  it.each(['en', 'tr'] as const)('%s prints refill as the released mass in both catalogues', (locale) => {
    const inputs = v3({ refrigerantTerms: [
      { equipmentType: 'split_air_conditioner', leakRateChoice: 'alternative', capacityKg: 10,
        leakRate: 0.1, leakedKg: 1, refillKg: 0.5, pricedBy: 'refill' },
    ] });
    const expected = locale === 'en'
      ? '0.5 kg released from the refill. The capacity estimate (10 kg at 10%) was excluded.'
      : '0,5 kg dolum, salınan miktardır. Kapasiteye dayalı tahmin (10 kg, oran %10) hesaba katılmadı.';
    for (const catalogue of [REPORT_CATALOGUES[locale], ISSUANCE_CATALOGUES[locale]]) {
      expect(calculationInputs(inputs, words(locale, catalogue)))
        .toBe(`${catalogue.inputsEquipment_split_air_conditioner}: ${expected}`);
    }
  });

  // Codex's review of #282: three fixed decimals printed a real refill of
  // 0.00049 kg (SF6, 25,200) as 0 beside the mass it produced.
  it.each([
    ['en', 'transformer or circuit breaker: 0 kg × 0.01% + 0.00049 kg refilled = 0.00049 kg released; '
      + 'chiller: 0.0004 kg × 2% + 0 kg refilled = 0.000008 kg released; volume correction ×0.0000004'],
    ['tr', 'transformatör kesici: 0 kg × %0,01 + 0,00049 kg dolum = 0,00049 kg salım; '
      + 'chiller (soğutma grubu): 0,0004 kg × %2 + 0 kg dolum = 0,000008 kg salım; hacim düzeltme ×0,0000004'],
  ] as const)('%s keeps a small input as entered, so the line adds up', (locale, expected) => {
    const text = calculationInputs(v3({
      parameters: [{ name: 'volumeCorrectionFactor', value: 0.0000004, origin: 'user' }],
      refrigerantTerms: [
        { equipmentType: 'transformer_breaker', leakRateChoice: 'default', capacityKg: 0, leakRate: 0.0001, leakedKg: 0, refillKg: 0.00049 },
        { equipmentType: 'chiller', leakRateChoice: 'default', capacityKg: 0.0004, leakRate: 0.02, leakedKg: 0.000008, refillKg: 0 },
      ],
    }), words(locale));
    expect(text.split('; ').sort()).toEqual(expected.split('; ').sort());
  });

  it('shows an input as entered, dropping only float noise, and a derived NCV to six digits', () => {
    const text = calculationInputs(v3({
      parameters: [
        { name: 'billedGcvKcalPerSm3', value: 9349.17412345, origin: 'user' },
        { name: 'ncvKcalPerSm3', value: 8078.670167, origin: 'derived' },
      ],
      refrigerantTerms: [{ equipmentType: 'chiller', leakRateChoice: 'alternative', capacityKg: 12.345678, leakRate: 0.07, leakedKg: 12.345678 * 0.07, refillKg: 0 }],
    }), words('en'));
    expect(text).toContain('billed GCV 9,349.17412345 kcal/Sm³');
    expect(text).toContain('NCV 8,078.67 kcal/Sm³');
    expect(text).toContain('12.345678 kg × 7% + 0 kg refilled = 0.864197 kg released');
  });

  it('reads the same in the issued reports\' catalogue', () => {
    expect(calculationInputs(billed, words('tr', ISSUANCE_CATALOGUES.tr))).toBe(calculationInputs(billed, words('tr')));
  });

  it.each([
    ['en', REPORT_CATALOGUES.en, 'gross to net ×0.901147'],
    ['tr', REPORT_CATALOGUES.tr, 'brütten nete ×0,901147'],
    ['en', ISSUANCE_CATALOGUES.en, 'gross to net ×0.901147'],
    ['tr', ISSUANCE_CATALOGUES.tr, 'brütten nete ×0,901147'],
  ] as const)('%s names a gross energy bill\'s gross-to-net ratio, to six digits (ng-kwh-engine)', (locale, catalogue, expected) => {
    const gross = v3({ parameters: [{ name: 'grossToNetRatio', value: 8250 / 9155, origin: 'derived' }] });
    expect(calculationInputs(gross, words(locale, catalogue))).toContain(expected);
  });

  // UAT round 4, BUG-12: a fire suppression line reads as a refrigerant line does.
  it.each([
    ['en', 'fire extinguisher: 6 kg × 4% + 0 kg refilled = 0.24 kg released; '
      + 'fire suppression system: 35 kg released from the refill. The capacity estimate (50 kg at 2%) was excluded.'],
    ['tr', 'yangın söndürme tüpü: 6 kg × %4 + 0 kg dolum = 0,24 kg salım; '
      + 'yangın söndürme sistemi: 35 kg dolum, salınan miktardır. Kapasiteye dayalı tahmin (50 kg, oran %2) hesaba katılmadı.'],
  ] as const)('%s prints fire suppression lines, a refill-priced one included, in both catalogues', (locale, expected) => {
    const inputs = v3({ refrigerantTerms: [
      { equipmentType: 'fire_extinguisher', leakRateChoice: 'default', capacityKg: 6, leakRate: 0.04, leakedKg: 0.24, refillKg: 0 },
      { equipmentType: 'fire_suppression_system', leakRateChoice: 'default', capacityKg: 50, leakRate: 0.02, leakedKg: 1, refillKg: 35, pricedBy: 'refill' },
    ] });
    for (const catalogue of [REPORT_CATALOGUES[locale], ISSUANCE_CATALOGUES[locale]]) {
      expect(calculationInputs(inputs, words(locale, catalogue))).toBe(expected);
    }
  });

  it('is empty for a snapshot that carries no inputs', () => {
    expect(calculationInputs(v3({}), words('en'))).toBe('');
    expect(calculationInputs({ snapshotSchema: 2, tCo2e: 1 }, words('en'))).toBe('');
    expect(calculationInputs(null, words('en'))).toBe('');
  });
});

describe('an Electricity self-generation block in a report (self-gen-model, design 5)', () => {
  // The block's echo: names the report does not word, so it prints nothing.
  const echo = [
    { name: 'selfGeneratedKwh', value: 400000, origin: 'user' as const },
    { name: 'exportedToGridKwh', value: 50000, origin: 'user' as const },
    { name: 'facilityConsumptionKwh', value: 1000000, origin: 'user' as const },
  ];

  it.each(['en', 'tr'] as const)('%s prints the same input text with the block as without it, in the report and the issuance', (locale) => {
    for (const catalogue of [REPORT_CATALOGUES[locale], ISSUANCE_CATALOGUES[locale]]) {
      const plain = calculationInputs(v3({ category: 'Electricity', parameters: [] }), words(locale, catalogue));
      const withBlock = calculationInputs(v3({ category: 'Electricity', parameters: echo }), words(locale, catalogue));
      expect(withBlock).toBe(plain);
      expect(withBlock).toBe('');
    }
  });
});
