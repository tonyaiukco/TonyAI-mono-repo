import { describe, expect, it } from 'vitest';
import { CONTEXT_FIELDS, contextFieldSet, storedContextNumber } from './context-fields';
import { checkDecimal, parseLocaleDecimal, retypeForLocale, typedText, typedValue } from '@/lib/i18n/number';

describe('contextFieldSet', () => {
  it('maps the categories that had their own fields, and every other to `other`', () => {
    expect(contextFieldSet('Electricity')).toBe('electricity');
    expect(contextFieldSet('Fuel')).toBe('fuel');
    expect(contextFieldSet('Business Travel')).toBe('businessTravel');
    expect(contextFieldSet('Waste')).toBe('waste');
    expect(contextFieldSet('Water')).toBe('water');
    expect(contextFieldSet('Logistics')).toBe('logistics');
    expect(contextFieldSet('Natural Gas')).toBe('other');
    expect(contextFieldSet('Refrigerants')).toBe('other');
  });

  it('keeps the stored ids unique within a set — they are keys of a record’s `input`', () => {
    for (const fields of Object.values(CONTEXT_FIELDS)) {
      expect(new Set(fields.map((f) => f.id)).size).toBe(fields.length);
    }
  });
});

describe('storedContextNumber', () => {
  it('reads a JSON number, and the dot-decimal text `<input type="number">` saved before LP4-04', () => {
    expect(storedContextNumber(1234.5)).toBe(1234.5);
    expect(storedContextNumber('1234.5')).toBe(1234.5);
    expect(storedContextNumber('0.25')).toBe(0.25);
    expect(storedContextNumber('.5')).toBe(0.5);
    expect(storedContextNumber('1e3')).toBe(1000);
    // A negative `type="number"` allowed: read as the number it is (the field then refuses it).
    expect(storedContextNumber('-5')).toBe(-5);
  });

  it('is not a number for anything else — never a guess at a separator', () => {
    for (const value of ['', '  ', '1.234,5', '1,5', 'abc', null, undefined, Number.NaN, Infinity, {}]) {
      expect(storedContextNumber(value), String(value)).toBeNull();
    }
  });
});

describe('a context number across a language switch (M4)', () => {
  it('Turkish `1.234,5` is saved as 1234.5 and reopens in English as the same number', () => {
    const typed = parseLocaleDecimal('1.234,5', 'tr');
    const check = checkDecimal(typed, 'non_negative');
    expect(check.ok && check.value).toBe(1234.5);
    // What the save sends is that number; reopened under English it reads the same.
    expect(typedValue(1234.5, 'en').text).toBe('1234.5');
    expect(retypeForLocale(typedText('1.234,5', 'tr'), 'en').text).toBe('1234.5');
  });

  it('a value saved before LP4-04 as dot text opens in Turkish as the number it meant', () => {
    const n = storedContextNumber('1234.5');
    expect(typedValue(n, 'tr').text).toBe('1234,5');
  });

  it('refuses a negative quantity rather than saving it', () => {
    expect(checkDecimal(parseLocaleDecimal('-3', 'en'), 'non_negative').ok).toBe(false);
  });
});
