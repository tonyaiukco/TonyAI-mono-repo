import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { CalorificBasisChoice, EquipmentLines, NaturalGasInputs, SelfGenerationInputs, VolumeCorrectionInfo, type ReferenceState } from '@/components/data-entry/record-inputs';
import { checkDecimal, parseLocaleDecimal } from '@/lib/i18n/number';
import { MESSAGES } from '@/messages';
import { copyPrefill } from '@/lib/record-edit-view';

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
  effectiveGasBasis,
  gasEnergyIssue,
  gasInputsFromRecord,
  gasInputsInEffect,
  selfGenerationFromRecord,
  EMPTY_SELF_GENERATION_FORM,
  selfGenerationBlock,
  selfGenerationFormFromRecord,
  selfGenerationFormIssue,
  selfGenerationReminder,
  selfGenerationRemovalNotice,
  type SelfGenerationForm,
  gasInputsIssue,
  gasParameters,
  clearsNetEnergyQuantity,
  copyKeepsOwnUnit,
  unitChangeClearsBasis,
  basisAfterUnitChange,
  unitCategoryAfterReset,
  previewedNetSource,
  calculationRevised,
  savedCalculationEffect,
  unitChangeClearsQuantity,
  leakRateOf,
  leakRatePercent,
  linesFromRecord,
  linesForNewRecord,
  newEquipmentLine,
  newLineUnit,
  massInKg,
  withLineUnit,
  deviceOptions,
  maxEquipmentLines,
  takesLineUnit,
  offersOtherGas,
  OTHER_GAS,
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
const line = (over: Partial<EquipmentLineDraft> = {}): EquipmentLineDraft => ({ ...newEquipmentLine('l1'), equipmentType: 'chiller', capacity: 20, ...over });

const SELF_GENERATION_BLOCK = Object.freeze({
  generationTopology: 'A',
  selfGenerationSource: 'solar',
  selfGeneratedKwh: 400_000,
  facilityConsumptionKwh: 1_000_000,
} as const);

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
    // Electricity's block is no input mode, in any unit or geography: the page reads its shape (self-gen-form, design 2).
    for (const unit of ['kWh', 'MWh']) {
      expect(recordInputMode('Electricity', 'TR', unit)).toBeNull();
      expect(recordInputMode('Electricity', 'UK', unit)).toBeNull();
    }
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
    const opened = gasInputsFromRecord('Natural Gas', { cvBasis: 'gross' });
    expect(opened.cvBasis).toBe('gross');
    expect(gasParameters(opened, 'kWh', 8250)).toEqual({ cvBasis: 'gross' });
    expect(gasParameters(gasInputsFromRecord('Natural Gas', { cvBasis: 'net' }), 'MWh', 8250)).toEqual({ cvBasis: 'net' });
  });

  it('sends nothing for a bill without a basis, so the API names the missing choice', () => {
    expect(gasParameters(NO_GAS_INPUTS, 'kWh', 8250)).toBeNull();
    expect(gasInputsFromRecord('Natural Gas', { cvBasis: 'lower' }).cvBasis).toBeNull();
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

  // PR #360 review: a copy is a new record, so it never carries a gas the form no longer offers one.
  it('narrows a copied Refrigerants record of HFC-227ea or SF6, and keeps an offered gas', () => {
    for (const gas of ['HFC-227ea', 'SF6']) {
      expect(copyKeepsOwnUnit({ category: 'Refrigerants', activityType: gas, geography: 'TR' }, 'Refrigerants', gas, 'TR')).toBe(false);
    }
    expect(copyKeepsOwnUnit({ category: 'Refrigerants', activityType: 'R-410A', geography: 'TR' }, 'Refrigerants', 'R-410A', 'TR')).toBe(true);
    expect(copyKeepsOwnUnit({ category: 'Fire Suppression', activityType: 'HFC-227ea', geography: 'TR' }, 'Fire Suppression', 'HFC-227ea', 'TR')).toBe(true);
  });

  it('gives a copied record\'s lines no stored device, and clears one the category no longer offers', () => {
    const lines = linesFromRecord({ equipment: [
      { equipmentType: 'fire_suppression_system', capacityKg: 40, refillKg: 0, leakRateChoice: 'default' },
      { equipmentType: 'chiller', capacityKg: 20, refillKg: 1, leakRateChoice: 'alternative' },
    ] }, () => 'c');
    const copied = linesForNewRecord(lines, 'Refrigerants');
    expect(copied.map((l) => [l.equipmentType, l.capacity, l.refill, l.storedType])).toEqual([
      ['', 40, 0, undefined],
      ['chiller', 20, 1, undefined],
    ]);
    expect(equipmentIssue(copied)).toBe('type_missing');
    expect(deviceOptions('Refrigerants', copied[0], new Set(['chiller']))).not.toContain('fire_suppression_system');
    // Fire Suppression keeps its own devices.
    const fire = linesFromRecord({ equipment: [{ equipmentType: 'fire_extinguisher', capacityKg: 6, refillKg: 0, leakRateChoice: 'default' }] }, () => 'f');
    expect(linesForNewRecord(fire, 'Fire Suppression')[0].equipmentType).toBe('fire_extinguisher');
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
    expect(gasInputsFromRecord('Natural Gas', { billedGcvKcalPerSm3: 9300 })).toEqual({ ncv: null, billedGcv: 9300, volumeCorrectionFactor: null, cvBasis: null });
    expect(gasInputsFromRecord('Natural Gas', null)).toEqual(NO_GAS_INPUTS);
  });

  it('reads no gas inputs from an Electricity record, whatever its parameters hold (self-gen-model)', () => {
    expect(gasInputsFromRecord('Electricity', SELF_GENERATION_BLOCK)).toEqual(NO_GAS_INPUTS);
    // Even keys that look like gas inputs are not read off another category.
    expect(gasInputsFromRecord('Electricity', { cvBasis: 'net' })).toEqual(NO_GAS_INPUTS);
    expect(gasInputsFromRecord('Refrigerants', { equipment: [] })).toEqual(NO_GAS_INPUTS);
  });


  it('reads a Turkish 8078,67 as 8,078.67, and refuses an ambiguous separator', () => {
    const read = (text: string) => checkDecimal(parseLocaleDecimal(text, 'tr'), 'positive', 1e300);
    expect(read('8078,67')).toMatchObject({ ok: true, value: 8078.67 });
    expect(read('8.078,67')).toMatchObject({ ok: true, value: 8078.67 });
    expect(read('0')).toMatchObject({ ok: false, reason: 'not_positive' });
    expect(read('8,078.67').ok).toBe(false);
  });
});

// UAT round 4, BUG-12: a Fire Suppression line takes grams or kilograms, and
// the form always sends kilograms.
describe('fire suppression equipment lines (UAT round 4, BUG-12)', () => {
  const fire = (over: Partial<EquipmentLineDraft> = {}): EquipmentLineDraft =>
    ({ ...newEquipmentLine('f1', 'g'), equipmentType: 'fire_extinguisher', ...over });

  it('starts a new Fire Suppression line on grams, and a refrigerant line on kilograms', () => {
    expect(newLineUnit('Fire Suppression')).toBe('g');
    expect(newLineUnit('Refrigerants')).toBe('kg');
    expect(takesLineUnit('Fire Suppression')).toBe(true);
    expect(takesLineUnit('Refrigerants')).toBe(false);
    expect(newEquipmentLine('x', newLineUnit('Fire Suppression'))).toMatchObject({ unit: 'g', capacity: 0, refill: 0 });
  });

  it('converts 6000 g to 6 kg and 35 g to 0.035 kg, with no float noise', () => {
    expect(massInKg(6000, 'g')).toBe(6);
    expect(massInKg(35, 'g')).toBe(0.035);
    expect(massInKg(1, 'g')).toBe(0.001);
    expect(massInKg(0.1, 'g')).toBe(0.0001);
    // A decimal gram figure: 4.1 / 1000 is 0.0040999999999999995 in binary, and
    // toFixed would give 4.000599999999999 for 4000.6 g (QA review).
    expect(massInKg(4.1, 'g')).toBe(0.0041);
    expect(massInKg(4000.6, 'g')).toBe(4.0006);
    expect(massInKg(6, 'kg')).toBe(6);
    const sent = equipmentParameters([fire({ capacity: 6000, refill: 35 })]);
    expect(sent).toEqual({ equipment: [{ equipmentType: 'fire_extinguisher', capacityKg: 6, refillKg: 0.035, leakRateChoice: 'default' }] });
  });

  it('totals lines in different units in kilograms: 6000 g and 50 kg are 56 kg', () => {
    const lines = [fire({ capacity: 6000 }), fire({ id: 'f2', equipmentType: 'fire_suppression_system', capacity: 50, unit: 'kg' })];
    expect(equipmentTotal(lines)).toBe(56);
    expect(equipmentIssue(lines)).toBeNull();
    expect(equipmentParameters(lines).equipment.map((l) => l.capacityKg)).toEqual([6, 50]);
  });

  it('clears only the changed line\'s figures on a unit change, and nothing on the same unit', () => {
    const typed = fire({ capacity: 6000, refill: 10 });
    const other = fire({ id: 'f2', equipmentType: 'fire_suppression_system', capacity: 50, unit: 'kg' });
    const switched = withLineUnit(typed, 'kg');
    expect(switched).toMatchObject({ unit: 'kg', capacity: null, refill: null, equipmentType: 'fire_extinguisher' });
    expect(withLineUnit(typed, 'g')).toBe(typed);
    expect(equipmentIssue([switched, other])).toBe('value_missing');
    expect(other).toMatchObject({ capacity: 50, unit: 'kg' });
  });

  it('opens a stored record in kilograms with the selector on kilograms, and a blank line on grams', () => {
    let n = 0;
    const id = () => `id-${(n += 1)}`;
    const stored = { equipment: [{ equipmentType: 'fire_extinguisher', capacityKg: 6, refillKg: 0, leakRateChoice: 'default' }] };
    expect(linesFromRecord(stored, id, 'g')).toEqual([
      { id: 'id-1', equipmentType: 'fire_extinguisher', capacity: 6, refill: 0, unit: 'kg', leakRateChoice: 'default', storedType: 'fire_extinguisher' },
    ]);
    expect(linesFromRecord(null, id, 'g')).toEqual([newEquipmentLine('id-2', 'g')]);
  });

  it('offers a Fire Suppression line its three devices, each once', () => {
    const blank = { equipmentType: '' as const };
    expect(deviceOptions('Fire Suppression', blank, new Set())).toEqual(['fire_extinguisher', 'fire_suppression_system', 'transformer_breaker']);
    expect(deviceOptions('Fire Suppression', blank, new Set(['fire_extinguisher']))).toEqual(['fire_suppression_system', 'transformer_breaker']);
    expect(maxEquipmentLines('Fire Suppression', [])).toBe(3);
  });

  it('ends the Fire Suppression gas list with "Other gas", never an activity type', () => {
    expect(offersOtherGas('Fire Suppression')).toBe(true);
    expect(offersOtherGas('Refrigerants')).toBe(false);
    expect(['CO2', 'HFC-227ea', 'SF6', 'dry_powder_or_foam']).not.toContain(OTHER_GAS);
  });
});

// UAT round 4, BUG-12 (design decision 7): a new refrigerant line is offered
// cooling devices only; an opened record keeps its own fire device.
describe('the refrigerant form\'s narrowed device list', () => {
  it('offers a new refrigerant line the six cooling devices only', () => {
    expect(deviceOptions('Refrigerants', { equipmentType: '' }, new Set())).toEqual([
      'split_air_conditioner', 'water_dispenser', 'refrigerator', 'chiller', 'mobile_air_conditioner', 'portable_air_conditioner',
    ]);
    expect(maxEquipmentLines('Refrigerants', [])).toBe(6);
  });

  it('keeps an opened HFC-227ea draft\'s fire suppression system line selectable', () => {
    const own = deviceOptions('Refrigerants', { equipmentType: 'fire_suppression_system', storedType: 'fire_suppression_system' }, new Set(['chiller']));
    expect(own).toContain('fire_suppression_system');
    expect(own).not.toContain('chiller');
    expect(own).not.toContain('fire_extinguisher');
    const opened = linesFromRecord({ equipment: [
      { equipmentType: 'fire_suppression_system', capacityKg: 40, refillKg: 0, leakRateChoice: 'default' },
    ] }, () => 'l');
    expect(maxEquipmentLines('Refrigerants', opened)).toBe(7);
  });

  // PR #360 reviews: the stored device stays offered on its own line after the
  // line moved off it, and never on another line.
  it('keeps a stored fire device on its own line after a switch to a chiller, and off a new line', () => {
    const [opened] = linesFromRecord({ equipment: [
      { equipmentType: 'fire_suppression_system', capacityKg: 40, refillKg: 0, leakRateChoice: 'default' },
    ] }, () => 'l1');
    expect(opened.storedType).toBe('fire_suppression_system');
    const switched = { ...opened, equipmentType: 'chiller' as const };
    expect(deviceOptions('Refrigerants', switched, new Set())).toContain('fire_suppression_system');
    // A line added after the switch: the six cooling devices only, less the chiller line 1 holds.
    const added = newEquipmentLine('l2');
    expect(added.storedType).toBeUndefined();
    const offered = deviceOptions('Refrigerants', added, new Set(['chiller']));
    expect(offered).not.toContain('fire_suppression_system');
    expect(offered).toEqual(['split_air_conditioner', 'water_dispenser', 'refrigerator', 'mobile_air_conditioner', 'portable_air_conditioner']);
    // Not twice, and not while another line holds it.
    expect(deviceOptions('Refrigerants', opened, new Set()).filter((t) => t === 'fire_suppression_system')).toHaveLength(1);
    expect(deviceOptions('Refrigerants', switched, new Set(['fire_suppression_system']))).not.toContain('fire_suppression_system');
    expect(maxEquipmentLines('Refrigerants', [switched])).toBe(7);
    expect(maxEquipmentLines('Refrigerants', [added])).toBe(6);
  });
});

describe('refrigerant equipment lines (D7)', () => {
  it('totals the capacities as the record\'s quantity, and accepts a refill alone', () => {
    const lines = [line(), line({ id: 'l2', equipmentType: 'split_air_conditioner', capacity: 10.5, refill: 1 })];
    expect(equipmentTotal(lines)).toBe(30.5);
    expect(equipmentIssue(lines)).toBeNull();
    expect(equipmentParameters(lines)).toEqual({ equipment: [
      { equipmentType: 'chiller', capacityKg: 20, refillKg: 0, leakRateChoice: 'default' },
      { equipmentType: 'split_air_conditioner', capacityKg: 10.5, refillKg: 1, leakRateChoice: 'default' },
    ] });
    expect(equipmentIssue([line({ capacity: 0, refill: 2 })])).toBeNull();
    expect(equipmentTotal([line({ capacity: 0, refill: 2 })])).toBe(0);
  });

  it.each([
    ['no line', [], 'no_lines'],
    ['a line with no type', [line({ equipmentType: '' })], 'type_missing'],
    ['one type twice', [line(), line({ id: 'l2' })], 'type_repeated'],
    ['an empty or refused mass', [line({ refill: null })], 'value_missing'],
    ['neither a capacity nor a refill', [line({ capacity: 0 })], 'empty_line'],
    ['a total above the bound', [line({ capacity: ACTIVITY_VALUE_MAX }), line({ id: 'l2', equipmentType: 'refrigerator', capacity: ACTIVITY_VALUE_MAX })], 'too_large'],
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
      .toEqual([{ id: 'id-1', equipmentType: 'chiller', capacity: 5, refill: 0, unit: 'kg', leakRateChoice: 'alternative', storedType: 'chiller' }]);
    expect(linesFromRecord(null, id)).toEqual([newEquipmentLine('id-2')]);
  });
});

describe('the basis the form acts on (uat4-quick-fixes, BUG-11)', () => {
  it('reads a bill with no held basis as gross, and a held basis as held', () => {
    expect(effectiveGasBasis(null)).toBe('gross');
    expect(effectiveGasBasis('gross')).toBe('gross');
    expect(effectiveGasBasis('net')).toBe('net');
  });

  it('a new kWh or MWh bill nobody clicked on is previewed and saved as gross', () => {
    const acted = gasInputsInEffect(NO_GAS_INPUTS, 'natural_gas_energy');
    expect(gasEnergyIssue(acted, 'natural_gas_energy')).toBeNull();
    expect(gasParameters(acted, 'kWh', 8250)).toEqual({ cvBasis: 'gross' });
    expect(gasParameters(acted, 'MWh', 8250)).toEqual({ cvBasis: 'gross' });
    // The held state is not written: it still says nobody chose.
    expect(NO_GAS_INPUTS.cvBasis).toBeNull();
  });

  it('an opened record\'s stored net, and the author\'s net, are sent as net', () => {
    const opened = gasInputsFromRecord('Natural Gas', { cvBasis: 'net' });
    expect(gasParameters(gasInputsInEffect(opened, 'natural_gas_energy'), 'kWh', 8250)).toEqual({ cvBasis: 'net' });
    const picked = { ...NO_GAS_INPUTS, cvBasis: 'net' as const };
    expect(gasInputsInEffect(picked, 'natural_gas_energy')).toEqual(picked);
  });

  it.each([
    ['a volume reading', 'natural_gas'],
    ['a refrigerant record', 'refrigerant'],
    ['a record with no extra inputs', null],
  ] as const)('leaves %s untouched: no basis appears where no choice is shown', (_case, mode) => {
    expect(gasInputsInEffect(NO_GAS_INPUTS, mode)).toBe(NO_GAS_INPUTS);
    const net = { ...NO_GAS_INPUTS, cvBasis: 'net' as const };
    expect(gasInputsInEffect(net, mode)).toBe(net);
  });

  it('every way the held basis is cleared lands on gross, never net', () => {
    const storedNet = { unit: 'kWh', cvBasis: 'net' as const };
    // A unit change between a volume and a bill's energy, on a record that stores net elsewhere.
    const afterDetour = basisAfterUnitChange('standard_cubic_metres', 'MWh', null, storedNet);
    expect(afterDetour).toBeNull();
    expect(effectiveGasBasis(afterDetour)).toBe('gross');
    // A net figure that left the TR rules had its basis cleared; back under them it is gross.
    expect(clearsNetEnergyQuantity('Natural Gas', null, 'kWh', 'net')).toBe(true);
    expect(gasInputsInEffect({ ...NO_GAS_INPUTS, cvBasis: null }, 'natural_gas_energy').cvBasis).toBe('gross');
    // The one path that brings net back is the record's own stored basis on its own unit.
    expect(effectiveGasBasis(basisAfterUnitChange('cubic_metres', 'kWh', null, storedNet))).toBe('net');
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

  // Inputs that did not come through `gasInputsInEffect`: the guard still speaks.
  it.each(['en', 'tr'] as const)('%s says what is missing for a bill handed over with no basis, and selects neither', (locale) => {
    const html = render(locale, { issue: 'basis_missing' });
    const copy = MESSAGES[locale].dataEntry.inputs.cvBasis;
    expect(html).toContain(copy.help.replace(/'/g, '&#x27;'));
    expect(html).toContain(copy.missing.replace(/'/g, '&#x27;'));
    expect(html).toContain('aria-required="true"');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-checked="true"');
  });

  it.each([
    ['en', 'kWh', 'kWh on the bill (upper calorific value)', 'Net kWh (lower calorific value)'],
    ['en', 'MWh', 'MWh on the bill (upper calorific value)', 'Net MWh (lower calorific value)'],
    ['tr', 'kWh', 'Faturadaki kWh (üst ısıl değer)', 'Net kWh (alt ısıl değer)'],
    ['tr', 'MWh', 'Faturadaki MWh (üst ısıl değer)', 'Net MWh (alt ısıl değer)'],
  ] as const)('%s offers a %s bill\'s figure first and net second, in plain words (BUG-11)', (locale, unit, gross, net) => {
    const html = render(locale, { unit, basis: effectiveGasBasis(null) });
    expect(html).toContain(gross);
    expect(html).toContain(net);
    expect(html.indexOf(gross)).toBeLessThan(html.indexOf(net));
    // Gross first in the markup too, so keyboard order follows the reading order.
    expect([...html.matchAll(/role="radio"[^>]*value="([a-z]+)"|value="([a-z]+)"[^>]*role="radio"/g)].map((m) => m[1] ?? m[2])).toEqual(['gross', 'net']);
    expect(checked(html)).toEqual(['gross']);
    expect(html).not.toContain('data-testid="gas-energy-basis-missing"');
    // Each label is tied to its own radio: a click on "Net" must never select gross.
    for (const [value, words] of [['gross', gross], ['net', net]] as const) {
      expect(html).toMatch(new RegExp(`<button[^>]*id="gas-energy-basis-${value}"[^>]*value="${value}"|<button[^>]*value="${value}"[^>]*id="gas-energy-basis-${value}"`));
      expect(html).toContain(`for="gas-energy-basis-${value}"`);
      const label = html.slice(html.indexOf(`for="gas-energy-basis-${value}"`));
      expect(label.slice(0, label.indexOf('</label>'))).toContain(words);
    }
    // The help line is read with the group.
    expect(html).toContain('aria-describedby="gas-energy-basis-help"');
    expect(html).toContain('id="gas-energy-basis-help"');
  });

  it('the help says upper is the default and net is the lower value, in both languages', () => {
    const en = MESSAGES.en.dataEntry.inputs.cvBasis.help;
    expect(en).toMatch(/upper calorific value, so that is the default/);
    expect(en).toMatch(/Choose net only if .* lower calorific value/);
    const tr = MESSAGES.tr.dataEntry.inputs.cvBasis.help;
    expect(tr).toMatch(/üst ısıl değer üzerinden belirtir; bu nedenle varsayılan olarak o seçilidir/);
    expect(tr).toMatch(/Net seçeneğini yalnızca .* alt ısıl değer/);
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

describe('what a save\'s answer does to the preview on screen (ng-kwh-form review)', () => {
  const snapshot = (factorReleaseId: string) => ({
    snapshotSchema: 3, factorId: 'f1', tCo2e: 1, factorRelease: { id: factorReleaseId }, conversion: null, parameterRows: [],
  }) as never;
  it.each([
    ['the preview on screen is on the saved record\'s release', snapshot('b'), snapshot('b'), 'keep'],
    ['the preview on screen is on an earlier release', snapshot('a'), snapshot('b'), 'revised'],
    // Clicked while the preview was pending, or after it was refused: nothing is shown to compare.
    ['no preview is on screen (pending or refused)', null, snapshot('b'), 'refresh'],
    ['no preview is on screen and the save was not calculated', null, { snapshotSchema: 3 }, 'refresh'],
    ['a preview is on screen and the save was not calculated', snapshot('a'), { snapshotSchema: 3 }, 'keep'],
  ])('%s: %s', (_case, shown, saved, effect) => {
    expect(savedCalculationEffect(shown as never, saved as never)).toBe(effect);
  });

  it('never carries the saved figures: its answer is a verdict, so a late one cannot overwrite a newer preview', () => {
    // The user typed 2,000 after saving 1,000; the preview for 2,000 (on release b) is on screen when the save answers.
    const forNewFigure = snapshot('b');
    const savedForOldFigure = snapshot('b');
    expect(savedCalculationEffect(forNewFigure, savedForOldFigure)).toBe('keep');
    // On an earlier release the screen is redone, not replaced by the saved 1,000.
    expect(savedCalculationEffect(snapshot('a'), savedForOldFigure)).toBe('revised');
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

  const equipment = (lines: EquipmentLineDraft[], category = 'Refrigerants') => ({
    category, lines, reference: READY, issue: null, epoch: 0, onChange: () => {}, onAdd: () => {}, onRemove: () => {},
  });

  it.each(['en', 'tr'] as const)('%s shows a refrigerator\'s default rate and offers no alternative', (locale) => {
    const html = render(locale, EquipmentLines, equipment([line({ equipmentType: 'refrigerator' })]));
    expect(html).toContain('data-testid="equipment-rate"');
    expect(html).toContain(locale === 'en' ? '0.1%' : '0,1%');
    expect(html).not.toContain(`${MESSAGES[locale].dataEntry.inputs.leakRate} 1"`);
  });

  // UAT round 4, BUG-12: the Fire Suppression lines as rendered.
  const fireLine = (over: Partial<EquipmentLineDraft> = {}) =>
    ({ ...newEquipmentLine('f1', 'g'), equipmentType: 'fire_extinguisher', ...over }) as EquipmentLineDraft;
  const FIRE_ROWS: ReferenceState = {
    ...READY,
    data: { ...(READY as { data: object }).data, parameters: [param('leak_rate', 'fire_extinguisher', 0.04)] },
  } as ReferenceState;

  it.each(['en', 'tr'] as const)('%s shows a gram line\'s unit selector, its kilograms beside it and the default rate alone', (locale) => {
    const html = render(locale, EquipmentLines, { ...equipment([fireLine({ capacity: 6000 })], 'Fire Suppression'), reference: FIRE_ROWS });
    const tFire = MESSAGES[locale].dataEntry.inputs.fireSuppression;
    expect(html).toContain(`aria-label="${tFire.unit} 1"`);
    expect(html).toContain('data-testid="equipment-kg"');
    expect(html).toContain('= 6 kg');
    expect(html).toContain(`${tFire.capacity} (g)`);
    const escaped = (text: string) => text.replace(/'/g, '&#x27;');
    expect(html).toContain(escaped(tFire.unitHelp));
    expect(html).toContain(escaped(tFire.annualOnly));
    expect(html).toContain('data-testid="equipment-rate"');
    expect(html).toContain('4%');
    expect(html).not.toContain(`${MESSAGES[locale].dataEntry.inputs.leakRate} 1"`);
  });

  it('totals 0.1 g as 0.0001 kg, never 0 (PR #360 review)', () => {
    const html = render('en', EquipmentLines, equipment([fireLine({ capacity: 0.1 })], 'Fire Suppression'));
    expect(html).toContain('= 0.0001 kg');
    expect(html).toMatch(/<span class="font-mono">0\.0001<\/span>/);
  });

  it('shows no kilogram line for a kilogram line, and no selector on a refrigerant line', () => {
    const kg = render('en', EquipmentLines, equipment([fireLine({ unit: 'kg', capacity: 6 })], 'Fire Suppression'));
    expect(kg).not.toContain('data-testid="equipment-kg"');
    expect(kg).toContain('Installed capacity (kg)');
    const refrigerant = render('en', EquipmentLines, equipment([line()]));
    expect(refrigerant).not.toContain(`aria-label="${MESSAGES.en.dataEntry.inputs.fireSuppression.unit} 1"`);
    expect(refrigerant).not.toContain('data-testid="equipment-kg"');
    expect(refrigerant).toContain(MESSAGES.en.dataEntry.inputs.capacity);
  });

  it('offers a chiller\'s alternative as a choice', () => {
    const html = render('en', EquipmentLines, equipment([line()]));
    expect(html).not.toContain('data-testid="equipment-rate"');
    expect(html).toContain(`aria-label="${MESSAGES.en.dataEntry.inputs.leakRate} 1"`);
  });
});

describe('selfGenerationFromRecord (self-gen-model)', () => {
  it('returns an Electricity record\'s stored block unchanged, as a copy', () => {
    const parameters = { ...SELF_GENERATION_BLOCK, exportedToGridKwh: null };
    const block = selfGenerationFromRecord({ category: 'Electricity', parameters });
    expect(block).toEqual(parameters);
    expect(block).not.toBe(parameters);
    expect(selfGenerationFromRecord({ category: 'Electricity', parameters: SELF_GENERATION_BLOCK })).toEqual(SELF_GENERATION_BLOCK);
  });

  it('returns null for a plain grid record, an all-null block and any other category', () => {
    expect(selfGenerationFromRecord({ category: 'Electricity', parameters: null })).toBeNull();
    expect(selfGenerationFromRecord({ category: 'Electricity' })).toBeNull();
    expect(selfGenerationFromRecord({ category: 'Electricity', parameters: {} })).toBeNull();
    expect(
      selfGenerationFromRecord({ category: 'Electricity', parameters: { generationTopology: null, selfGeneratedKwh: null } }),
    ).toBeNull();
    expect(selfGenerationFromRecord({ category: 'Natural Gas', parameters: { cvBasis: 'net' } })).toBeNull();
    expect(selfGenerationFromRecord({ category: 'Natural Gas', parameters: SELF_GENERATION_BLOCK })).toBeNull();
  });
});

describe('the self-generation section (self-gen-form, design 1, 3 and 4)', () => {
  const form = (over: Partial<SelfGenerationForm> = {}): SelfGenerationForm => ({
    source: 'solar',
    generatedKwh: 400_000,
    exportedKwh: null,
    facilityKwh: null,
    ...over,
  });

  it('round-trips every stored shape the CHECK accepts, record to form to block', () => {
    const shapes = [
      { generationTopology: 'A', selfGenerationSource: 'wind', selfGeneratedKwh: 0 },
      { generationTopology: 'A', selfGenerationSource: 'solar', selfGeneratedKwh: 400_000, exportedToGridKwh: null, facilityConsumptionKwh: null },
      { generationTopology: 'A', selfGenerationSource: 'natural_gas_chp', selfGeneratedKwh: 400_000, exportedToGridKwh: 400_000, facilityConsumptionKwh: 1_000_000.5 },
      { generationTopology: 'A', selfGenerationSource: 'diesel_generator', selfGeneratedKwh: 12.25, facilityConsumptionKwh: 1e-300 },
    ];
    for (const parameters of shapes) {
      const sent = selfGenerationBlock('Electricity', selfGenerationFormFromRecord({ category: 'Electricity', parameters }));
      // What the record holds, null fields being absent ones.
      const held = Object.fromEntries(Object.entries(parameters).filter(([, v]) => v !== null));
      expect(sent, JSON.stringify(parameters)).toEqual(held);
    }
  });

  it('reads a plain record, a block of nulls and any other category as an empty section', () => {
    expect(selfGenerationFormFromRecord({ category: 'Electricity', parameters: null })).toEqual(EMPTY_SELF_GENERATION_FORM);
    expect(
      selfGenerationFormFromRecord({
        category: 'Electricity',
        parameters: { generationTopology: null, selfGenerationSource: null, selfGeneratedKwh: null },
      }),
    ).toEqual(EMPTY_SELF_GENERATION_FORM);
    expect(selfGenerationFormFromRecord({ category: 'Natural Gas', parameters: SELF_GENERATION_BLOCK })).toEqual(
      EMPTY_SELF_GENERATION_FORM,
    );
  });

  it('sends no block without a source, and topology A with one', () => {
    expect(selfGenerationBlock('Electricity', EMPTY_SELF_GENERATION_FORM)).toBeNull();
    expect(selfGenerationBlock('Electricity', form({ source: null }))).toBeNull();
    expect(selfGenerationBlock('Electricity', form())).toEqual({
      generationTopology: 'A',
      selfGenerationSource: 'solar',
      selfGeneratedKwh: 400_000,
    });
    // An empty generation is sent as null, which the form holds back anyway.
    expect(selfGenerationBlock('Electricity', form({ generatedKwh: null }))).toEqual({
      generationTopology: 'A',
      selfGenerationSource: 'solar',
      selfGeneratedKwh: null,
    });
  });

  it('sends no block for any other category, and the same block again with Electricity', () => {
    const typed = form({ exportedKwh: 10, facilityKwh: 900_000 });
    for (const category of ['Natural Gas', 'Refrigerants', 'Fuel', 'Water', '']) {
      expect(selfGenerationBlock(category, typed), category).toBeNull();
    }
    expect(selfGenerationBlock('Electricity', typed)).toEqual({
      generationTopology: 'A',
      selfGenerationSource: 'solar',
      selfGeneratedKwh: 400_000,
      exportedToGridKwh: 10,
      facilityConsumptionKwh: 900_000,
    });
  });

  it('carries a copied voided record\'s block through the copy\'s prefill', () => {
    const copied = copyPrefill({
      subsidiaryId: 's', locationId: null, reportingYear: 2026, reportingPeriod: 'quarterly', periodValue: 'Q4',
      category: 'Electricity', activityType: null, activityValue: 600000, activityUnit: 'kWh', input: null,
      parameters: { ...SELF_GENERATION_BLOCK },
    });
    expect(selfGenerationBlock(copied.category, selfGenerationFormFromRecord(copied))).toEqual(SELF_GENERATION_BLOCK);
  });

  it('names each issue, in the stated order', () => {
    const issue = (over: Partial<SelfGenerationForm>, unreadable = false) =>
      selfGenerationFormIssue('Electricity', form(over), unreadable);
    expect(issue({})).toBeNull();
    expect(issue({ generatedKwh: 0 })).toBeNull();
    expect(issue({}, true)).toBe('unreadable');
    // An unread field outranks a missing one: the user typed something.
    expect(issue({ generatedKwh: null }, true)).toBe('unreadable');
    expect(issue({ generatedKwh: -1, exportedKwh: -1 })).toBe('generated_negative');
    expect(issue({ exportedKwh: -1, facilityKwh: 0 })).toBe('exported_negative');
    expect(issue({ facilityKwh: 0 })).toBe('facility_not_positive');
    expect(issue({ facilityKwh: -5 })).toBe('facility_not_positive');
    expect(issue({ facilityKwh: 1e-300 })).toBeNull();
    expect(issue({ facilityKwh: 1e-301 })).toBe('facility_not_positive');
    expect(issue({ generatedKwh: null })).toBe('generated_missing');
    expect(issue({ generatedKwh: null, exportedKwh: 5 })).toBe('generated_missing');
    expect(issue({ exportedKwh: 500_000 })).toBe('exported_above_generated');
    expect(issue({ exportedKwh: 400_000 })).toBeNull();
    expect(issue({ exportedKwh: 399_999 })).toBeNull();
    // Exports of zero are a valid statement, not a missing one.
    expect(issue({ exportedKwh: 0 })).toBeNull();
    expect(issue({ generatedKwh: 0, exportedKwh: 0 })).toBeNull();
  });

  it('holds nothing back without a source or outside Electricity', () => {
    expect(selfGenerationFormIssue('Electricity', form({ source: null, generatedKwh: -1 }), true)).toBeNull();
    expect(selfGenerationFormIssue('Natural Gas', form({ generatedKwh: null }), true)).toBeNull();
  });

  it('reminds of the fuel record for a fuel source only', () => {
    expect(selfGenerationReminder('natural_gas_chp')).toBe('natural_gas_chp');
    expect(selfGenerationReminder('diesel_generator')).toBe('diesel_generator');
    expect(selfGenerationReminder('solar')).toBeNull();
    expect(selfGenerationReminder('wind')).toBeNull();
    expect(selfGenerationReminder(null)).toBeNull();
  });

  it('says a category move removes the stored block only in Edit mode, off Electricity, for a record that held one', () => {
    expect(selfGenerationRemovalNotice(true, true, 'Natural Gas')).toBe(true);
    expect(selfGenerationRemovalNotice(true, true, '')).toBe(true);
    expect(selfGenerationRemovalNotice(true, true, 'Electricity')).toBe(false);
    expect(selfGenerationRemovalNotice(true, false, 'Natural Gas')).toBe(false);
    expect(selfGenerationRemovalNotice(false, true, 'Natural Gas')).toBe(false);
  });
});

describe('SelfGenerationInputs (self-gen-form)', () => {
  const render = (locale: 'en' | 'tr', props: object) =>
    renderToStaticMarkup(createElement(IntlProvider, {
      locale, timeZone: 'UTC', messages: MESSAGES[locale],
      children: createElement(SelfGenerationInputs, {
        form: EMPTY_SELF_GENERATION_FORM, issue: null, balance: null, epoch: 0, onChange: () => {}, ...props,
      } as never),
    }));
  const solar: SelfGenerationForm = { source: 'solar', generatedKwh: 400_000, exportedKwh: null, facilityKwh: null };
  const copy = (locale: 'en' | 'tr') => MESSAGES[locale].dataEntry.inputs.selfGeneration;
  /** A sentence as the static markup escapes it. */
  const escaped = (text: string) => text.replace(/'/g, '&#x27;');

  it('asks for a source and nothing more while none is chosen', () => {
    const html = render('en', {});
    expect(html).toContain('data-testid="self-generation-source"');
    // The fields stay mounted, hidden, so typed text survives None and back (outside review).
    expect(html).toMatch(/<div[^>]*hidden=""[^>]*data-testid="self-generation-fields"/);
    expect(html).not.toContain(escaped(copy('en').caseA));
  });

  it('opens the three kWh fields and both statements for a source', () => {
    for (const locale of ['en', 'tr'] as const) {
      const html = render(locale, { form: solar });
      for (const id of ['input-self-generated', 'input-self-exported', 'input-self-facility']) expect(html).toContain(`id="${id}"`);
      expect(html).not.toMatch(/<div[^>]*hidden=""[^>]*data-testid="self-generation-fields"/);
      expect(html).toContain(escaped(copy(locale).caseA));
      expect(html).toContain(escaped(copy(locale).importStatement));
      expect(html).not.toContain('data-testid="self-generation-reminder"');
    }
  });

  it('reminds of the fuel record for a fuel source', () => {
    expect(render('en', { form: { ...solar, source: 'natural_gas_chp' } })).toContain(escaped(copy('en').reminder.natural_gas_chp));
    expect(render('tr', { form: { ...solar, source: 'diesel_generator' } })).toContain(escaped(copy('tr').reminder.diesel_generator));
  });

  it('says the issue and marks the field it concerns', () => {
    const html = render('en', { form: { ...solar, exportedKwh: 500_000 }, issue: 'exported_above_generated' });
    expect(html).toContain(escaped(copy('en').issues.exported_above_generated));
    expect(html).toMatch(/id="input-self-exported"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*id="input-self-exported"/);
    expect(html).not.toMatch(/id="input-self-generated"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*id="input-self-generated"/);
  });

  it('warns on a balance gap with both figures in the reader\'s format, and says nothing on a balanced one', () => {
    const gap = { importKwh: 600_000, expectedImportKwh: 500_000, warns: true };
    expect(render('en', { form: solar, balance: gap })).toContain('600,000 kWh');
    const tr = render('tr', { form: solar, balance: gap });
    expect(tr).toContain('data-testid="self-generation-balance"');
    expect(tr).toContain('600.000 kWh');
    expect(tr).toContain('500.000 kWh');
    expect(render('en', { form: solar, balance: { ...gap, warns: false } })).not.toContain('data-testid="self-generation-balance"');
    // Small figures keep their digits (outside review): 0.004 against 0.003 is not "0 against 0".
    const tiny = render('en', { form: solar, balance: { importKwh: 0.004, expectedImportKwh: 0.003, warns: true } });
    expect(tiny).toContain('0.004 kWh');
    expect(tiny).toContain('0.003 kWh');
  });
});
