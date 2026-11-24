import { describe, expect, it } from 'vitest';
import { CONTEXT_FIELDS, contextFieldMessageKey, contextFieldSet, hasContextValue, storedContextNumber, type ContextFieldSet } from './context-fields';
import { CATEGORIES } from '@/lib/types';
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

describe('the invoice number and the supplier (uat4-quick-fixes, BUG-16)', () => {
  const ids = (set: ContextFieldSet) => CONTEXT_FIELDS[set].map((f) => f.id);

  it('every category offers an invoice number', () => {
    for (const category of CATEGORIES) {
      expect(ids(contextFieldSet(category)), category).toContain('invoice_no');
    }
  });

  it('every category but Electricity offers a supplier; Electricity keeps its utility provider and gets no second one', () => {
    for (const category of CATEGORIES) {
      const offered = ids(contextFieldSet(category));
      if (category === 'Electricity') {
        expect(offered).toContain('utility_provider');
        expect(offered).not.toContain('supplier');
      } else {
        expect(offered, category).toContain('supplier');
        expect(offered, category).not.toContain('utility_provider');
      }
    }
  });

  it('both are optional text, bounded where the API bounds them, with their words shared by every set', () => {
    for (const [set, fields] of Object.entries(CONTEXT_FIELDS) as [ContextFieldSet, (typeof CONTEXT_FIELDS)[ContextFieldSet]][]) {
      const invoice = fields.find((f) => f.id === 'invoice_no');
      expect(invoice, set).toMatchObject({ type: 'text', shared: true, maxLength: 64 });
      expect(contextFieldMessageKey(set, invoice!)).toBe('context.shared.invoice_no');
      const supplier = fields.find((f) => f.id === 'supplier');
      if (supplier) {
        expect(supplier, set).toMatchObject({ type: 'text', shared: true, maxLength: 200 });
        expect(contextFieldMessageKey(set, supplier)).toBe('context.shared.supplier');
      }
    }
  });

  it('a field of its own set keeps its set\'s words', () => {
    const provider = CONTEXT_FIELDS.electricity.find((f) => f.id === 'utility_provider')!;
    expect(contextFieldMessageKey('electricity', provider)).toBe('context.electricity.utility_provider');
  });

  it('the ids records already store are all still there', () => {
    // Stored keys of `input`: a removed or renamed id orphans what records hold.
    expect(ids('electricity')).toEqual(expect.arrayContaining(['total_kwh', 'renewable_kwh', 'billing_period_start', 'billing_period_end', 'utility_provider', 'notes']));
    expect(ids('fuel')).toEqual(expect.arrayContaining(['quantity', 'quantity_unit', 'purpose', 'fuel_notes']));
    expect(ids('other')).toEqual(expect.arrayContaining(['activity_value', 'activity_unit', 'notes']));
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

describe('hasContextValue (BUG-R2-05: a record with context opens the section)', () => {
  it('is false for no input, an empty object and blank values', () => {
    expect(hasContextValue(null)).toBe(false);
    expect(hasContextValue(undefined)).toBe(false);
    expect(hasContextValue({})).toBe(false);
    expect(hasContextValue({ supplier: '', note: '   ', meter: null })).toBe(false);
  });
  it('is true for any held value, zero included', () => {
    expect(hasContextValue({ supplier: 'Enerya' })).toBe(true);
    expect(hasContextValue({ distanceKm: 0 })).toBe(true);
    expect(hasContextValue({ note: '', distanceKm: 12 })).toBe(true);
  });
});
