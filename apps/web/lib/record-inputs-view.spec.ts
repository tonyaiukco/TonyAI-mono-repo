import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { CalorificBasisChoice, EquipmentLines, NaturalGasInputs, VolumeCorrectionInfo, type ReferenceState } from '@/components/data-entry/record-inputs';
import { checkDecimal, parseLocaleDecimal } from '@/lib/i18n/number';
import { MESSAGES } from '@/messages';

import {
  ACTIVITY_VALUE_MAX,
  STANDARD_REFERENCE_CONDITIONS,
  offeredActivityTypes,
  unitsForCategory,
  unitsForRecord,
  type ReleaseParameterDTO,
} from '@/lib/types';
import {
  NO_GAS_INPUTS,
  derivedNetQuantity,
  equipmentIssue,
  equipmentParameters,
  equipmentTotal,
  gasEnergyIssue,
  gasInputsFromRecord,
  gasInputsIssue,
  gasParameters,
  clearsNetEnergyQuantity,
  copyKeepsOwnUnit,
  unitChangeClearsBasis,
  basisAfterUnitChange,
  unitCategoryAfterReset,
  previewedNetSource,
  calculationRevised,
  unitChangeClearsQuantity,
  leakRateOf,
  leakRatePercent,
  linesFromRecord,
  newEquipmentLine,
  offersAlternative,
  recordInputMode,
  referenceValue,
  type EquipmentLineDraft,
} from './record-inputs-view';

const enEntry = MESSAGES.en.dataEntry;
const trEntry = MESSAGES.tr.dataEntry;

// Display fixture only: these numbers stand in for a release's parameters and
// are not a source. The form must show whatever the release holds.
const param = (key: string, equipmentType: string | null, value: number, isDefault = true): ReleaseParameterDTO => ({
  key, equipmentType, value, unit: key === 'leak_rate' ? 'fraction' : 'kcal/Sm3', isDefault, source: 'SPEC FIXTURE',
});
const ROWS = [
  param('reference_ncv', null, 8250), param('reference_gcv', null, 9155),
  param('leak_rate', 'split_air_conditioner', 0.01), param('leak_rate', 'split_air_conditioner', 0.1, false),
  param('leak_rate', 'chiller', 0.02), param('leak_rate', 'chiller', 0.08, false),
  param('leak_rate', 'refrigerator', 0.001),
];
const READY: ReferenceState = {
  status: 'ready',
  data: {
    release: {
      id: 'r', publisher: 'Display fixture', title: 'Display only', edition: 'test-edition', ordinal: 1,
      status: 'fixture', sourceUrl: null, licence: null, publishedAt: null, gwpSet: null,
    },
    parameters: ROWS,
  },
};
const line = (over: Partial<EquipmentLineDraft> = {}): EquipmentLineDraft => ({ ...newEquipmentLine('l1'), equipmentType: 'chiller', capacityKg: 20, ...over });

describe('which inputs a record takes (D11)', () => {
  it('asks for them only under the TR rules, for natural gas in a volume and for refrigerants', () => {
    expect(recordInputMode('Natural Gas', 'TR', 'standard_cubic_metres')).toBe('natural_gas');
    expect(recordInputMode('Natural Gas', 'TR', 'cubic_metres')).toBe('natural_gas');
    // A bill's energy carries its stored basis (ng-kwh-engine).
    expect(recordInputMode('Natural Gas', 'TR', 'kWh')).toBe('natural_gas_energy');
    expect(recordInputMode('Natural Gas', 'TR', 'MWh')).toBe('natural_gas_energy');
    expect(recordInputMode('Natural Gas', 'TR', 'therms')).toBeNull();
    expect(recordInputMode('Natural Gas', 'UK', 'kWh')).toBeNull();
    expect(recordInputMode('Refrigerants', 'TR', 'kg')).toBe('refrigerant');
    expect(recordInputMode('Natural Gas', 'UK', 'cubic_metres')).toBeNull();
    expect(recordInputMode('Refrigerants', 'UK', 'kg')).toBeNull();
    expect(recordInputMode('Refrigerants', null, 'kg')).toBeNull();
    expect(recordInputMode('Fugitive Gas', 'TR', 'standard_cubic_metres')).toBeNull();
  });

  it('offers TR natural gas as a volume first, then as a bill, and a TR vehicle mode in litres', () => {
    // m³ first: the unit a new TR gas record starts on (ng-kwh-form, Decision 1).
    expect(unitsForRecord('Natural Gas', 'TR').map((u) => u.value)).toEqual(['cubic_metres', 'standard_cubic_metres', 'kWh', 'MWh']);
    // Outside the TR rules the category's whole list, unchanged.
    expect(unitsForRecord('Natural Gas', 'UK')).toEqual(unitsForCategory('Natural Gas'));
    expect(unitsForRecord('Mobile Combustion', 'TR').map((u) => u.value)).toEqual(['litres']);
    expect(unitsForRecord('Fuel', 'TR').map((u) => u.value)).toContain('kg');
    expect(unitsForRecord('Fugitive Gas', 'TR').map((u) => u.value)).toEqual(['standard_cubic_metres']);
  });

  it('offers TR marine gas oil by mass, and keeps a TR vehicle mode in litres (UAT2 BUG-R2-11)', () => {
    // kg first: the unit a new MGO record starts on.
    expect(unitsForRecord('Mobile Combustion', 'TR', 'marine_gas_oil').map((u) => u.value)).toEqual(['kg', 'tonnes']);
    expect(unitsForRecord('Mobile Combustion', 'TR', 'on_road_diesel').map((u) => u.value)).toEqual(['litres']);
    expect(unitsForRecord('Mobile Combustion', 'TR', null).map((u) => u.value)).toEqual(['litres']);
    // Outside the TR rules the category's whole list, whatever the type.
    expect(new Set(unitsForRecord('Mobile Combustion', 'UK', 'marine_gas_oil').map((u) => u.value))).toEqual(
      new Set(['litres', 'uk_gallons', 'us_gallons', 'kg', 'tonnes']),
    );
  });

  it('names marine gas oil as marine fuel, never as the stationary gas oil (UAT2 BUG-R2-11)', () => {
    for (const catalogue of [enEntry, trEntry]) {
      expect(catalogue.activityTypes.marine_gas_oil).toMatch(/MGO/);
      expect(catalogue.activityTypes.marine_gas_oil).not.toBe(catalogue.activityTypes.gas_oil);
    }
    expect(enEntry.activityTypes.marine_gas_oil).toMatch(/^Marine gas oil/);
    // "Deniz motorini" is marine diesel; "gaz yağı" would read as kerosene.
    expect(trEntry.activityTypes.marine_gas_oil).toMatch(/^Deniz motorini/);
    expect(trEntry.activityTypes.marine_gas_oil.toLowerCase()).not.toMatch(/gaz ?yağı/);
  });

  it('asks a TR mobile record for one of the five vehicle modes or marine gas oil', () => {
    expect(offeredActivityTypes('Mobile Combustion', 'TR').map((t) => t.value)).toEqual([
      'on_road_petrol', 'on_road_diesel', 'on_road_lpg', 'off_road_petrol', 'off_road_diesel', 'marine_gas_oil',
    ]);
    expect(offeredActivityTypes('Mobile Combustion', 'UK').map((t) => t.value)).toContain('diesel');
    expect(offeredActivityTypes('Fuel', 'TR').map((t) => t.value)).toEqual(expect.arrayContaining(['petrol', 'coal', 'lng']));
  });
});

describe('a bill\'s stored calorific basis (ng-kwh-engine)', () => {
  it('round-trips a stored basis from the record to what the form sends', () => {
    const opened = gasInputsFromRecord({ cvBasis: 'gross' });
    expect(opened.cvBasis).toBe('gross');
    expect(gasParameters(opened, 'kWh', 8250)).toEqual({ cvBasis: 'gross' });
    expect(gasParameters(gasInputsFromRecord({ cvBasis: 'net' }), 'MWh', 8250)).toEqual({ cvBasis: 'net' });
  });

  it('sends nothing for a bill without a basis, so the API names the missing choice', () => {
    expect(gasParameters(NO_GAS_INPUTS, 'kWh', 8250)).toBeNull();
    expect(gasInputsFromRecord({ cvBasis: 'lower' }).cvBasis).toBeNull();
  });

  it('never sends a basis on a volume reading, nor a volume input on a bill', () => {
    const both = { ...NO_GAS_INPUTS, cvBasis: 'gross' as const, ncv: 8100, volumeCorrectionFactor: 0.97 };
    expect(gasParameters(both, 'standard_cubic_metres', 8250)).toEqual({ ncvKcalPerSm3: 8100 });
    expect(gasParameters(both, 'cubic_metres', 8250)).toEqual({ ncvKcalPerSm3: 8100, volumeCorrectionFactor: 0.97 });
    expect(gasParameters(both, 'kWh', 8250)).toEqual({ cvBasis: 'gross' });
  });

  it.each([
    ['a net bill outside the TR rules (moved, a site re-classified, or copied there)', 'Natural Gas', null, 'kWh', 'net', true],
    ['a net MWh bill outside the TR rules', 'Natural Gas', null, 'MWh', 'net', true],
    ['a gross bill outside the TR rules', 'Natural Gas', null, 'kWh', 'gross', false],
    ['a bill with no basis', 'Natural Gas', null, 'kWh', null, false],
    ['a net bill under the TR rules', 'Natural Gas', 'natural_gas_energy', 'kWh', 'net', false],
    ['a volume reading holding a stale basis', 'Natural Gas', 'natural_gas', 'standard_cubic_metres', 'net', false],
    ['another category', 'Electricity', null, 'kWh', 'net', false],
  ] as const)('clears the quantity for %s: %s', (_case, category, mode, unit, basis, clears) => {
    expect(clearsNetEnergyQuantity(category, mode, unit, basis)).toBe(clears);
  });

  it.each([
    ['kWh', 'standard_cubic_metres', true, true],
    ['MWh', 'cubic_metres', true, true],
    ['standard_cubic_metres', 'kWh', true, true],
    ['kWh', 'MWh', true, false],
    ['standard_cubic_metres', 'cubic_metres', true, false],
    ['litres', 'gallons_us', true, false],
    ['kWh', 'kWh', false, false],
  ] as const)('a unit change from %s to %s clears the quantity: %s, and a bill\'s basis: %s (second review)', (previous, next, quantity, basis) => {
    expect(unitChangeClearsQuantity(previous, next)).toBe(quantity);
    expect(unitChangeClearsBasis(previous, next)).toBe(basis);
  });
});

describe('the basis a unit change leaves (ng-kwh-engine, third review)', () => {
  const own = { unit: 'kWh', cvBasis: 'gross' as const };
  it('restores the record\'s own basis when its own energy unit is picked again', () => {
    expect(basisAfterUnitChange('standard_cubic_metres', 'kWh', null, own)).toBe('gross');
  });
  it('clears it between energy and volume, keeps it within energy, and restores nothing a record never had', () => {
    expect(basisAfterUnitChange('kWh', 'standard_cubic_metres', 'gross', own)).toBeNull();
    expect(basisAfterUnitChange('kWh', 'MWh', 'gross', own)).toBe('gross');
    expect(basisAfterUnitChange('standard_cubic_metres', 'MWh', null, own)).toBeNull();
    expect(basisAfterUnitChange('standard_cubic_metres', 'kWh', null, { unit: 'kWh', cvBasis: null })).toBeNull();
    expect(basisAfterUnitChange('standard_cubic_metres', 'kWh', null, { unit: null, cvBasis: null })).toBeNull();
  });
  it('keeps the basis the user chose across kWh and MWh, even back onto the record\'s own unit (ng-kwh-form review)', () => {
    // A stored NET draft in kWh: the user picks gross, goes to MWh and back to kWh.
    const net = { unit: 'kWh', cvBasis: 'net' as const };
    const inMwh = basisAfterUnitChange('kWh', 'MWh', 'gross', net);
    expect(inMwh).toBe('gross');
    expect(basisAfterUnitChange('MWh', 'kWh', inMwh, net)).toBe('gross');
    // The reverse: an own MWh record, left for kWh and returned to.
    expect(basisAfterUnitChange('kWh', 'MWh', 'gross', { unit: 'MWh', cvBasis: 'net' })).toBe('gross');
  });
  it('still restores the stored basis after a detour through a volume unit', () => {
    const net = { unit: 'kWh', cvBasis: 'net' as const };
    expect(basisAfterUnitChange('cubic_metres', 'kWh', null, net)).toBe('net');
  });
});

describe('the unit the next record starts on after a reset (ng-kwh-form review)', () => {
  // The rule asks the form's input mode and the reason: a submit lets a TR gas bill's unit go, nothing else does.
  it.each([
    ['a submitted TR gas bill in kWh', 'Natural Gas', 'TR', 'kWh', 'submitted', ''],
    ['a submitted TR gas bill in MWh', 'Natural Gas', 'TR', 'MWh', 'submitted', ''],
    ['a submitted TR gas reading in m3', 'Natural Gas', 'TR', 'cubic_metres', 'submitted', 'Natural Gas'],
    ['submitted TR electricity in MWh', 'Electricity', 'TR', 'MWh', 'submitted', 'Electricity'],
    ['submitted TR electricity in kWh', 'Electricity', 'TR', 'kWh', 'submitted', 'Electricity'],
    ['submitted gas in kWh outside the TR rules', 'Natural Gas', 'GB', 'kWh', 'submitted', 'Natural Gas'],
    ['submitted gas in MWh outside the TR rules', 'Natural Gas', 'GB', 'MWh', 'submitted', 'Natural Gas'],
    ['submitted TR refrigerants', 'Refrigerants', 'TR', 'kg', 'submitted', 'Refrigerants'],
    // A subsidiary change (and a copy, a failed cancel) is not a submit: the unit the target offers stays.
    ['a TR gas bill in MWh whose subsidiary changes', 'Natural Gas', 'TR', 'MWh', 'other', 'Natural Gas'],
    ['a TR gas bill in kWh whose subsidiary changes', 'Natural Gas', 'TR', 'kWh', 'other', 'Natural Gas'],
  ] as const)('%s: the unit counts as chosen for %j afterwards', (_case, category, geography, unit, reason, expected) => {
    expect(unitCategoryAfterReset(recordInputMode(category, geography, unit), category, reason)).toBe(expected);
  });

  it('leaves MWh on the list of a UK gas record, so a TR bill moved there keeps it (design: a geography change alone keeps the unit)', () => {
    expect(unitsForRecord('Natural Gas', 'GB').map((u) => u.value)).toContain('MWh');
  });
});

describe('a save priced on other releases than the preview (ng-kwh-form review)', () => {
  const snapshot = (factorReleaseId: string, conversionReleaseId: string | null = null) => ({
    snapshotSchema: 3, factorId: 'f1', tCo2e: 1,
    factorRelease: { id: factorReleaseId },
    conversion: conversionReleaseId === null ? null : { release: { id: conversionReleaseId } },
    parameterRows: [],
  }) as never;
  it.each([
    ['the same releases', snapshot('a'), snapshot('a'), false],
    ['the same releases with a conversion', snapshot('a', 'c'), snapshot('a', 'c'), false],
    ['another factor release', snapshot('a'), snapshot('b'), true],
    ['another conversion release', snapshot('a', 'c'), snapshot('a', 'd'), true],
    ['a conversion that appeared', snapshot('a'), snapshot('a', 'c'), true],
    ['no preview to correct', null, snapshot('b'), false],
    ['a saved record that was not calculated', snapshot('a'), { snapshotSchema: 3 }, false],
    ['a record saved with no calculation', snapshot('a'), null, false],
  ])('%s: revised is %s', (_case, shown, saved, revised) => {
    expect(calculationRevised(shown as never, saved as never)).toBe(revised);
  });
});

describe('a copy keeps its own unit only where it was priced (ng-kwh-engine, qa-auditor S2)', () => {
  const tr = { category: 'Natural Gas', activityType: null, geography: 'TR' };
  it('keeps it on the source\'s category, type and geography', () => {
    expect(copyKeepsOwnUnit(tr, 'Natural Gas', '', 'TR')).toBe(true);
    expect(copyKeepsOwnUnit({ category: 'Mobile Combustion', activityType: 'diesel', geography: 'UK' }, 'Mobile Combustion', 'diesel', 'UK')).toBe(true);
  });
  it('narrows it like a new record once it crosses the TR rules, changes category or type, or has no known geography', () => {
    expect(copyKeepsOwnUnit({ ...tr, geography: 'UK' }, 'Natural Gas', '', 'TR')).toBe(false);
    expect(copyKeepsOwnUnit({ category: 'Mobile Combustion', activityType: 'diesel', geography: 'UK' }, 'Mobile Combustion', 'diesel', 'TR')).toBe(false);
    expect(copyKeepsOwnUnit(tr, 'Fuel', '', 'TR')).toBe(false);
    expect(copyKeepsOwnUnit({ ...tr, geography: null }, 'Natural Gas', '', null)).toBe(false);
    expect(copyKeepsOwnUnit(null, 'Natural Gas', '', 'TR')).toBe(false);
  });
});

describe('natural gas inputs (D5)', () => {
  it('sends nothing for an unedited NCV, so its origin stays the default', () => {
    expect(gasParameters({ ...NO_GAS_INPUTS, ncv: 8250 }, 'standard_cubic_metres', 8250)).toBeNull();
    expect(gasParameters(NO_GAS_INPUTS, 'standard_cubic_metres', 8250)).toBeNull();
  });

  it('sends an edited NCV, a billed GCV, and a correction factor only for m³', () => {
    expect(gasParameters({ ...NO_GAS_INPUTS, ncv: 8100 }, 'standard_cubic_metres', 8250)).toEqual({ ncvKcalPerSm3: 8100 });
    expect(gasParameters({ ...NO_GAS_INPUTS, billedGcv: 9349.174 }, 'standard_cubic_metres', 8250)).toEqual({ billedGcvKcalPerSm3: 9349.174 });
    expect(gasParameters({ ...NO_GAS_INPUTS, volumeCorrectionFactor: 0.97 }, 'cubic_metres', 8250)).toEqual({ volumeCorrectionFactor: 0.97 });
    expect(gasParameters({ ...NO_GAS_INPUTS, volumeCorrectionFactor: 0.97 }, 'standard_cubic_metres', 8250)).toBeNull();
  });

  it('holds a record back for a missing correction factor, or an NCV beside a GCV', () => {
    expect(gasInputsIssue(NO_GAS_INPUTS, 'cubic_metres', 8250)).toBe('volume_correction_required');
    expect(gasInputsIssue({ ...NO_GAS_INPUTS, volumeCorrectionFactor: 0.97 }, 'cubic_metres', 8250)).toBeNull();
    expect(gasInputsIssue({ ...NO_GAS_INPUTS, ncv: 8100, billedGcv: 9300 }, 'standard_cubic_metres', 8250)).toBe('ncv_and_gcv');
    expect(gasInputsIssue({ ...NO_GAS_INPUTS, ncv: 8250, billedGcv: 9300 }, 'standard_cubic_metres', 8250)).toBeNull();
  });

  it('reads the default from the release, and opens a stored record as it was saved', () => {
    expect(referenceValue(ROWS, 'reference_ncv')).toBe(8250);
    expect(referenceValue([], 'reference_ncv')).toBeNull();
    expect(gasInputsFromRecord({ billedGcvKcalPerSm3: 9300 })).toEqual({ ncv: null, billedGcv: 9300, volumeCorrectionFactor: null, cvBasis: null });
    expect(gasInputsFromRecord(null)).toEqual(NO_GAS_INPUTS);
  });

  it('reads a Turkish 8078,67 as 8,078.67, and refuses an ambiguous separator', () => {
    const read = (text: string) => checkDecimal(parseLocaleDecimal(text, 'tr'), 'positive', 1e300);
    expect(read('8078,67')).toMatchObject({ ok: true, value: 8078.67 });
    expect(read('8.078,67')).toMatchObject({ ok: true, value: 8078.67 });
    expect(read('0')).toMatchObject({ ok: false, reason: 'not_positive' });
    expect(read('8,078.67').ok).toBe(false);
  });
});

describe('refrigerant equipment lines (D7)', () => {
  it('totals the capacities as the record\'s quantity, and accepts a refill alone', () => {
    const lines = [line(), line({ id: 'l2', equipmentType: 'split_air_conditioner', capacityKg: 10.5, refillKg: 1 })];
    expect(equipmentTotal(lines)).toBe(30.5);
    expect(equipmentIssue(lines)).toBeNull();
    expect(equipmentParameters(lines)).toEqual({ equipment: [
      { equipmentType: 'chiller', capacityKg: 20, refillKg: 0, leakRateChoice: 'default' },
      { equipmentType: 'split_air_conditioner', capacityKg: 10.5, refillKg: 1, leakRateChoice: 'default' },
    ] });
    expect(equipmentIssue([line({ capacityKg: 0, refillKg: 2 })])).toBeNull();
    expect(equipmentTotal([line({ capacityKg: 0, refillKg: 2 })])).toBe(0);
  });

  it.each([
    ['no line', [], 'no_lines'],
    ['a line with no type', [line({ equipmentType: '' })], 'type_missing'],
    ['one type twice', [line(), line({ id: 'l2' })], 'type_repeated'],
    ['an empty or refused mass', [line({ refillKg: null })], 'value_missing'],
    ['neither a capacity nor a refill', [line({ capacityKg: 0 })], 'empty_line'],
    ['a total above the bound', [line({ capacityKg: ACTIVITY_VALUE_MAX }), line({ id: 'l2', equipmentType: 'refrigerator', capacityKg: ACTIVITY_VALUE_MAX })], 'too_large'],
  ] as const)('holds back %s', (_case, lines, issue) => {
    expect(equipmentIssue(lines as unknown as EquipmentLineDraft[])).toBe(issue);
  });

  it('offers the alternative only where the type has one and the release states it', () => {
    expect(offersAlternative(ROWS, 'split_air_conditioner')).toBe(true);
    expect(offersAlternative(ROWS, 'chiller')).toBe(true);
    expect(offersAlternative(ROWS, 'refrigerator')).toBe(false);
    expect(offersAlternative([], 'chiller')).toBe(false);
    expect(leakRateOf(ROWS, 'chiller', 'alternative')).toBe(0.08);
    expect(leakRatePercent(0.0001, 'en')).toBe('0.01%');
    expect(leakRatePercent(0.1, 'tr')).toBe('10%');
  });

  it('opens a stored record\'s lines, and a blank line when it has none', () => {
    let n = 0;
    const id = () => `id-${(n += 1)}`;
    expect(linesFromRecord({ equipment: [{ equipmentType: 'chiller', capacityKg: 5, refillKg: 0, leakRateChoice: 'alternative' }] }, id))
      .toEqual([{ id: 'id-1', equipmentType: 'chiller', capacityKg: 5, refillKg: 0, leakRateChoice: 'alternative' }]);
    expect(linesFromRecord(null, id)).toEqual([newEquipmentLine('id-2')]);
  });
});

describe('a bill\'s calorific basis, chosen on the form (ng-kwh-form)', () => {
  it('holds a bill without a basis back from preview and save, and nothing else', () => {
    expect(gasEnergyIssue(NO_GAS_INPUTS, 'natural_gas_energy')).toBe('basis_missing');
    expect(gasEnergyIssue({ ...NO_GAS_INPUTS, cvBasis: 'net' }, 'natural_gas_energy')).toBeNull();
    expect(gasEnergyIssue({ ...NO_GAS_INPUTS, cvBasis: 'gross' }, 'natural_gas_energy')).toBeNull();
    expect(gasEnergyIssue(NO_GAS_INPUTS, 'natural_gas')).toBeNull();
    expect(gasEnergyIssue(NO_GAS_INPUTS, null)).toBeNull();
  });

  it('derives a gross bill\'s net quantity from the release\'s own 8,250 / 9,155, never 0.9', () => {
    const derived = derivedNetQuantity(1000, ROWS);
    expect(derived?.ratio).toBeCloseTo(8250 / 9155, 12);
    expect(derived?.net).toBeCloseTo(901.147, 3);
    expect(derived?.ratio).not.toBe(0.9);
    expect(derivedNetQuantity(2, ROWS)?.net).toBeCloseTo(1.802294, 6);
  });

  it.each([
    ['no reference GCV', [param('reference_ncv', null, 8250)]],
    ['no reference NCV', [param('reference_gcv', null, 9155)]],
    ['no rows at all', []],
    ['a zero GCV', [param('reference_ncv', null, 8250), param('reference_gcv', null, 0)]],
    ['a negative GCV', [param('reference_ncv', null, 8250), param('reference_gcv', null, -9155)]],
    ['a negative NCV', [param('reference_ncv', null, -8250), param('reference_gcv', null, 9155)]],
    ['an NCV not below the GCV', [param('reference_ncv', null, 9155), param('reference_gcv', null, 8250)]],
    ['an equal NCV and GCV', [param('reference_ncv', null, 9155), param('reference_gcv', null, 9155)]],
  ])('derives nothing, and invents no ratio, with %s', (_case, rows) => {
    expect(derivedNetQuantity(1000, rows)).toBeNull();
  });

  const render = (locale: 'en' | 'tr', props: object) =>
    renderToStaticMarkup(createElement(IntlProvider, {
      locale, timeZone: 'UTC', messages: MESSAGES[locale],
      children: createElement(CalorificBasisChoice, {
        basis: null, quantity: null, unit: 'kWh', reference: READY, issue: null, onChange: () => {}, ...props,
      } as never),
    }));
  const checked = (html: string) => [...html.matchAll(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*value="([a-z]+)"/g)].map((m) => m[1]);

  it.each(['en', 'tr'] as const)('%s offers net and gross with neither chosen, and says what is missing', (locale) => {
    const html = render(locale, { issue: 'basis_missing' });
    const copy = MESSAGES[locale].dataEntry.inputs.cvBasis;
    expect(html).toContain(copy.net);
    expect(html).toContain(copy.gross);
    expect(html).toContain(copy.help);
    expect(html).toContain(copy.missing.replace(/'/g, '&#x27;'));
    expect(html).toContain('aria-required="true"');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-checked="true"');
  });

  it('selects a stored basis', () => {
    expect(render('en', { basis: 'gross' })).toMatch(/aria-checked="true"[^>]*value="gross"|value="gross"[^>]*aria-checked="true"/);
    expect(checked(render('en', { basis: 'net' }))).not.toContain('gross');
  });

  it.each([
    ['en', 'kWh', 1000, '901.15 kWh', '0.901147', '8,250', '9,155'],
    ['tr', 'kWh', 1000, '901,15 kWh', '0,901147', '8.250', '9.155'],
    ['en', 'MWh', 2, '1.8023 MWh', '0.901147', '8,250', '9,155'],
  ] as const)('%s shows a gross %s bill\'s net figure and its ratio, with the release named', (locale, unit, quantity, net, ratio, ncv, gcv) => {
    const html = render(locale, { basis: 'gross', quantity, unit });
    expect(html).toContain('data-testid="gas-energy-derived-net"');
    for (const part of [net, ratio, ncv, gcv, 'Display fixture', 'test-edition']) expect(html).toContain(part);
    expect(html).toContain(MESSAGES[locale].dataEntry.inputs.notAuthoritative.trim());
  });

  // A preview priced on another edition than the form's own reference read (a release sealed between the two requests).
  const PREVIEWED = {
    snapshotSchema: 3, factorId: 'f1', tCo2e: 1,
    factorRelease: { ...READY.data.release, id: 'r-preview', edition: 'preview-edition' },
    parameterRows: [
      { ...param('reference_ncv', null, 8000), releaseId: 'r-preview', edition: 'preview-edition', id: 'p1' },
      { ...param('reference_gcv', null, 10000), releaseId: 'r-preview', edition: 'preview-edition', id: 'p2' },
    ],
  } as never;

  it('shows the net figure and ratio of the edition the preview priced, not the reference read (ng-kwh-form review)', () => {
    const html = render('en', { basis: 'gross', quantity: 1000, previewed: previewedNetSource(PREVIEWED) });
    // 8,000 / 10,000 = 0.8 from the preview's rows; the reference's 8,250 / 9,155 is not shown.
    for (const part of ['800 kWh', '0.8', '8,000', '10,000', 'preview-edition']) expect(html).toContain(part);
    for (const part of ['901.15', '9,155', 'test-edition']) expect(html).not.toContain(part);
  });

  it('shows no derived figure once the preview was refused, though the reference read still holds a ratio (ng-kwh-form review)', () => {
    expect(render('en', { basis: 'gross', quantity: 1000 })).toContain('gas-energy-derived-net');
    expect(render('en', { basis: 'gross', quantity: 1000, priceRefused: true })).not.toContain('gas-energy-derived-net');
    expect(render('en', { basis: 'gross', quantity: 1000, priceRefused: true, previewed: previewedNetSource(PREVIEWED) })).not.toContain('gas-energy-derived-net');
  });

  it('falls back to the reference read until a preview holds the rows', () => {
    const html = render('en', { basis: 'gross', quantity: 1000, previewed: previewedNetSource(null) });
    expect(html).toContain('901.15 kWh');
    expect(html).toContain('test-edition');
  });

  it.each([
    ['a net bill', { basis: 'net', quantity: 1000 }],
    ['no basis yet', { quantity: 1000 }],
    ['no quantity yet', { basis: 'gross' }],
    ['a release still loading', { basis: 'gross', quantity: 1000, reference: { status: 'loading' } }],
    ['a failed release read', { basis: 'gross', quantity: 1000, reference: { status: 'failed' } }],
    ['a release without its GCV', { basis: 'gross', quantity: 1000, reference: { ...READY, data: { ...READY.data, parameters: [param('reference_ncv', null, 8250)] } } }],
  ])('shows no derived figure for %s', (_case, props) => {
    expect(render('en', props)).not.toContain('gas-energy-derived-net');
  });
});

describe('the net source a preview offers (ng-kwh-form review)', () => {
  const snapshot = (over: object = {}) => ({
    snapshotSchema: 3, factorId: 'f1', tCo2e: 1, factorRelease: READY.status === 'ready' ? READY.data.release : null,
    parameterRows: [param('reference_ncv', null, 8250), param('reference_gcv', null, 9155)], ...over,
  }) as never;
  it('is the preview\'s own release and NCV/GCV rows', () => {
    const source = previewedNetSource(snapshot());
    expect(source?.release.id).toBe('r');
    expect(source && derivedNetQuantity(1000, source.parameters)?.ratio).toBeCloseTo(8250 / 9155, 9);
  });
  it.each([
    ['no preview', null],
    ['an uncalculated preview', { snapshotSchema: 3 }],
    ['a net bill\'s preview, which reads no ratio', snapshot({ parameterRows: [] })],
    ['a preview without its GCV', snapshot({ parameterRows: [param('reference_ncv', null, 8250)] })],
    ['a snapshot of an older schema', snapshot({ snapshotSchema: 2 })],
  ])('is nothing for %s', (_case, preview) => {
    expect(previewedNetSource(preview as never)).toBeNull();
  });
});

describe('the input fields as rendered', () => {
  const render = (locale: 'en' | 'tr', element: typeof NaturalGasInputs | typeof EquipmentLines, props: object) =>
    renderToStaticMarkup(createElement(IntlProvider, {
      locale, timeZone: 'UTC', messages: MESSAGES[locale], children: createElement(element as never, props as never),
    }));
  const gas = (over: object = {}) => ({
    unit: 'standard_cubic_metres', inputs: NO_GAS_INPUTS, reference: READY, issue: null, epoch: 0, onChange: () => {}, ...over,
  });
  const valueOf = (html: string, id: string) => html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`))?.[1]
    ?? html.match(new RegExp(`value="([^"]*)"[^>]*id="${id}"`))?.[1];

  it.each(['en', 'tr'] as const)('%s opens the NCV on the release\'s default, and says where it came from', (locale) => {
    const html = render(locale, NaturalGasInputs, gas());
    expect(valueOf(html, 'input-ncv')).toBe('8250');
    expect(html).toContain('Display fixture');
    expect(html).toContain(MESSAGES[locale].dataEntry.inputs.notAuthoritative.trim());
    expect(html).not.toContain('id="input-volume-correction"');
  });

  it('asks for the correction factor in m³', () => {
    expect(render('en', NaturalGasInputs, gas({ unit: 'cubic_metres' }))).toContain('id="input-volume-correction"');
  });

  // UAT round 2, BUG-R2-06: the factor's explanation behind an ⓘ.
  it.each(['en', 'tr'] as const)('%s offers the ⓘ beside the correction factor in m³, and neither in Sm³', (locale) => {
    const aria = MESSAGES[locale].dataEntry.inputs.volumeCorrectionInfo.aria;
    expect(render(locale, NaturalGasInputs, gas({ unit: 'cubic_metres' }))).toContain(`aria-label="${aria}"`);
    const sm3 = render(locale, NaturalGasInputs, gas());
    expect(sm3).not.toContain('id="input-volume-correction"');
    expect(sm3).not.toContain(`aria-label="${aria}"`);
  });

  it.each([
    ['en', '0.75–30', '15 °C and 1013.25 mbar'],
    ['tr', '0,75–30', '15 °C ve 1013,25 mbar'],
  ] as const)('%s explains the factor in four points, the range from the contract\'s bounds', (locale, range, conditions) => {
    const html = renderToStaticMarkup(createElement(IntlProvider, {
      locale, timeZone: 'UTC', messages: MESSAGES[locale], children: createElement(VolumeCorrectionInfo),
    }));
    expect(html.match(/<li>/g)).toHaveLength(4);
    expect(html).toContain(range);
    expect(html).toContain(conditions);
    // The calorific value is release data: the explanation names it, never quotes it.
    expect(html).not.toMatch(/8[.,]?250/);
  });

  it('pins the contract\'s standard reference conditions the explanation words per language', () => {
    // If this changes, reword dataEntry.inputs.volumeCorrectionInfo.standard
    // in both catalogues to match, then update this pin.
    expect(STANDARD_REFERENCE_CONDITIONS).toBe('15 °C, 101.325 kPa (ISO 13443)');
  });

  it('disables the NCV beside a billed GCV, and the GCV beside an edited NCV', () => {
    const billed = render('en', NaturalGasInputs, gas({ inputs: { ...NO_GAS_INPUTS, billedGcv: 9300 } }));
    expect(billed).toMatch(/id="input-ncv"[^>]*disabled=""|disabled=""[^>]*id="input-ncv"/);
    expect(billed).toContain(MESSAGES.en.dataEntry.inputs.ncvDerived);
    const edited = render('en', NaturalGasInputs, gas({ inputs: { ...NO_GAS_INPUTS, ncv: 8100 } }));
    expect(edited).toMatch(/id="input-gcv"[^>]*disabled=""|disabled=""[^>]*id="input-gcv"/);
    expect(edited).toContain(MESSAGES.en.dataEntry.inputs.gcvBlocked);
  });

  it('shows no default when no release covers the record', () => {
    const html = render('en', NaturalGasInputs, gas({ reference: { status: 'ready', data: { release: null, parameters: [] } } }));
    expect(valueOf(html, 'input-ncv')).toBe('');
    expect(html).toContain(MESSAGES.en.dataEntry.inputs.referenceMissing);
  });

  const equipment = (lines: EquipmentLineDraft[]) => ({
    lines, reference: READY, issue: null, epoch: 0, onChange: () => {}, onAdd: () => {}, onRemove: () => {},
  });

  it.each(['en', 'tr'] as const)('%s shows a refrigerator\'s default rate and offers no alternative', (locale) => {
    const html = render(locale, EquipmentLines, equipment([line({ equipmentType: 'refrigerator' })]));
    expect(html).toContain('data-testid="equipment-rate"');
    expect(html).toContain(locale === 'en' ? '0.1%' : '0,1%');
    expect(html).not.toContain(`${MESSAGES[locale].dataEntry.inputs.leakRate} 1"`);
  });

  it('offers a chiller\'s alternative as a choice', () => {
    const html = render('en', EquipmentLines, equipment([line()]));
    expect(html).not.toContain('data-testid="equipment-rate"');
    expect(html).toContain(`aria-label="${MESSAGES.en.dataEntry.inputs.leakRate} 1"`);
  });
});
