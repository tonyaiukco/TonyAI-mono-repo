import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { EquipmentLines, NaturalGasInputs, VolumeCorrectionInfo, type ReferenceState } from '@/components/data-entry/record-inputs';
import { checkDecimal, parseLocaleDecimal } from '@/lib/i18n/number';
import { MESSAGES } from '@/messages';

import {
  ACTIVITY_VALUE_MAX,
  STANDARD_REFERENCE_CONDITIONS,
  offeredActivityTypes,
  unitsForRecord,
  type ReleaseParameterDTO,
} from '@/lib/types';
import {
  NO_GAS_INPUTS,
  equipmentIssue,
  equipmentParameters,
  equipmentTotal,
  gasInputsFromRecord,
  gasInputsIssue,
  gasParameters,
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
    expect(recordInputMode('Natural Gas', 'TR', 'kWh')).toBeNull();
    expect(recordInputMode('Refrigerants', 'TR', 'kg')).toBe('refrigerant');
    expect(recordInputMode('Natural Gas', 'UK', 'cubic_metres')).toBeNull();
    expect(recordInputMode('Refrigerants', 'UK', 'kg')).toBeNull();
    expect(recordInputMode('Refrigerants', null, 'kg')).toBeNull();
    expect(recordInputMode('Fugitive Gas', 'TR', 'standard_cubic_metres')).toBeNull();
  });

  it('offers TR natural gas in Sm³ and m³ only, and a TR vehicle mode in litres', () => {
    expect(new Set(unitsForRecord('Natural Gas', 'TR').map((u) => u.value))).toEqual(new Set(['cubic_metres', 'standard_cubic_metres']));
    expect(unitsForRecord('Natural Gas', 'UK').map((u) => u.value)).toContain('kWh');
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
    expect(gasInputsFromRecord({ billedGcvKcalPerSm3: 9300 })).toEqual({ ncv: null, billedGcv: 9300, volumeCorrectionFactor: null });
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
