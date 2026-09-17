import { describe, expect, it } from 'vitest';
import { ACTIVITY_UNITS } from '@tonyai/shared-types';
import { storableUnit, storedUnit } from './storable-unit';
import { canonicalUnit, isKnownUnit } from './normalization';

describe('storedUnit — the spelling the column stores', () => {
  it('resolves every alias spelling to the vocabulary value', () => {
    for (const [entered, stored] of [
      ['kw h', 'kWh'],
      ['KWH', 'kWh'],
      [' kWh ', 'kWh'],
      ['MWH', 'MWh'],
      ['Kwh', 'kWh'],
      ['m3', 'cubic_metres'],
      ['m³', 'cubic_metres'],
      ['cubic metres', 'cubic_metres'],
      [`cubic${' '.repeat(40)}metres`, 'cubic_metres'],
      ['Sm³', 'standard_cubic_metres'],
      ['standard cubic metres', 'standard_cubic_metres'],
      ['therm', 'therms'],
      ['GJ', 'gj'],
      ['L', 'litres'],
      ['liters', 'litres'],
      ['UK gallon', 'uk_gallons'],
      ['us gallons', 'us_gallons'],
      ['pkm', 'passenger_kilometres'],
      ['km', 'kilometres'],
      ['t', 'tonnes'],
    ]) {
      expect(storedUnit(entered)).toBe(stored);
    }
  });

  it('is a fixed point on every value the vocabulary offers', () => {
    for (const { value } of ACTIVITY_UNITS) {
      expect(storedUnit(value)).toBe(value);
    }
  });

  it('agrees with the engine: the stored spelling resolves to the same rule key as the entered one', () => {
    // The point of storing the vocabulary value is that nothing downstream has
    // to resolve an alias again — but the engine must still price the stored
    // spelling identically to what was entered.
    for (const entered of ['kw h', 'MWH', 'm3', 'liters', 'Sm³', 'pkm']) {
      expect(canonicalUnit(storedUnit(entered))).toBe(canonicalUnit(entered));
    }
  });

  it('keeps an interior whitespace run from reaching the column even inside an alias', () => {
    const char = (code: number) => String.fromCharCode(code);
    for (const code of [0x0d, 0x0a, 0x09, 0x0b, 0x0c, 0x2028, 0x00a0, 0xfeff]) {
      expect(storedUnit(`us${char(code)}gallons`)).toBe('us_gallons');
      expect(storedUnit(`${char(code)}kWh${char(code)}`)).toBe('kWh');
    }
  });

  it('stores a known rule key that the vocabulary does not list as the key itself', () => {
    // `normal_cubic_metres` is blocked, so no record can be saved with it — but
    // the function must not invent a spelling for it either.
    expect(isKnownUnit('nm3')).toBe(true);
    expect(ACTIVITY_UNITS.some((u) => u.value === 'normal_cubic_metres')).toBe(false);
    expect(storedUnit('nm3')).toBe('normal_cubic_metres');
  });

  it('returns an unknown unit whitespace-normalised, unresolved, so a refusal can quote it', () => {
    // `@IsActivityUnit` refuses these before a service runs; this is the
    // contract for the value the message quotes back.
    expect(storedUnit('kilowatt  hours')).toBe('kilowatt hours');
    expect(storedUnit('  furlongs ')).toBe('furlongs');
    expect(storedUnit(storedUnit('kilowatt hours'))).toBe('kilowatt hours');
  });

  it('closes the KELVIN SIGN homoglyph: the stored token is the resolved one', () => {
    // U+212A lowercases to ASCII `k`, so the vocabulary accepts it; storing the
    // resolved value means the column never holds the look-alike.
    const kelvin = String.fromCharCode(0x212a);
    expect(isKnownUnit(`${kelvin}Wh`)).toBe(true);
    expect(storedUnit(`${kelvin}Wh`)).toBe('kWh');
  });
});

describe('storableUnit — the DTO transform is whitespace only', () => {
  it('collapses whitespace runs to one space and trims, nothing else', () => {
    expect(storableUnit({ value: `  kW${'\t'}h  ` })).toBe('kW h');
    expect(storableUnit({ value: 'MWH' })).toBe('MWH');
  });

  it('passes a non-string through untouched for the validators to refuse', () => {
    expect(storableUnit({ value: 42 })).toBe(42);
    expect(storableUnit({ value: undefined })).toBeUndefined();
  });
});
