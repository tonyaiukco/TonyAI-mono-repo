import { describe, expect, it } from 'vitest';
import {
  ELECTRICITY_SUPPLIER_KEY,
  RECORD_INVOICE_NO_KEY,
  RECORD_INVOICE_NO_MAX_LENGTH,
  RECORD_REFERENCE_LIMITS,
  RECORD_SUPPLIER_KEY,
  RECORD_SUPPLIER_MAX_LENGTH,
  electricitySupplierIssues,
  recordInvoiceNo,
  recordReferenceIssues,
  recordSupplier,
  storableRecordReferences,
} from './index';

describe('a record\'s invoice number and supplier (uat4-quick-fixes, BUG-16)', () => {
  it('pins the stored key names and their limits', () => {
    // Stored in records: a rename orphans every value saved under the old name.
    expect(RECORD_INVOICE_NO_KEY).toBe('invoice_no');
    expect(RECORD_SUPPLIER_KEY).toBe('supplier');
    expect(ELECTRICITY_SUPPLIER_KEY).toBe('utility_provider');
    expect(RECORD_REFERENCE_LIMITS).toEqual({ invoice_no: 64, supplier: 200 });
    expect(RECORD_INVOICE_NO_MAX_LENGTH).toBe(64);
    expect(RECORD_SUPPLIER_MAX_LENGTH).toBe(200);
    expect(Object.isFrozen(RECORD_REFERENCE_LIMITS)).toBe(true);
  });

  describe('recordSupplier', () => {
    it('reads an Electricity record\'s utility provider, and any other record\'s supplier', () => {
      expect(recordSupplier('Electricity', { utility_provider: 'Enerjisa' })).toBe('Enerjisa');
      expect(recordSupplier('Mobile Combustion', { supplier: 'Petrol Ofisi' })).toBe('Petrol Ofisi');
      expect(recordSupplier('Natural Gas', { supplier: '  Enerya ' })).toBe('Enerya');
    });

    it('goes by the category, never by the keys present', () => {
      expect(recordSupplier('Electricity', { supplier: 'Petrol Ofisi' })).toBeNull();
      expect(recordSupplier('Fuel', { utility_provider: 'Enerjisa' })).toBeNull();
      expect(recordSupplier('Electricity', { supplier: 'A', utility_provider: 'B' })).toBe('B');
    });

    it('is null for no input, a blank value and a value that is not text', () => {
      for (const input of [null, undefined, {}, [], 'supplier', { supplier: '' }, { supplier: '   ' }, { supplier: 7 }, { supplier: { name: 'x' } }]) {
        expect(recordSupplier('Fuel', input), JSON.stringify(input)).toBeNull();
      }
    });
  });

  describe('recordInvoiceNo', () => {
    it('reads the invoice number of any category, trimmed', () => {
      expect(recordInvoiceNo({ invoice_no: 'OZK2025000011923' })).toBe('OZK2025000011923');
      expect(recordInvoiceNo({ invoice_no: ' A-1 ' })).toBe('A-1');
    });

    it('is null for none, a blank and a value that is not text', () => {
      for (const input of [null, undefined, {}, { invoice_no: '' }, { invoice_no: ' ' }, { invoice_no: 2025000011923 }, { invoice_no: ['A-1'] }]) {
        expect(recordInvoiceNo(input), JSON.stringify(input)).toBeNull();
      }
    });
  });

  describe('recordReferenceIssues', () => {
    it('accepts absent, null, and text within each limit', () => {
      expect(recordReferenceIssues(null)).toEqual([]);
      expect(recordReferenceIssues(undefined)).toEqual([]);
      expect(recordReferenceIssues({})).toEqual([]);
      expect(recordReferenceIssues({ invoice_no: null, supplier: null })).toEqual([]);
      expect(recordReferenceIssues({ invoice_no: 'x'.repeat(64), supplier: 'y'.repeat(200) })).toEqual([]);
    });

    it('bounds the trimmed text: padding does not push a value over its limit', () => {
      expect(recordReferenceIssues({ invoice_no: `  ${'x'.repeat(64)}  ` })).toEqual([]);
    });

    it('refuses one character over each limit, naming the key', () => {
      expect(recordReferenceIssues({ invoice_no: 'x'.repeat(65) })).toEqual(['input.invoice_no must be at most 64 characters']);
      expect(recordReferenceIssues({ supplier: 'y'.repeat(201) })).toEqual(['input.supplier must be at most 200 characters']);
    });

    it.each([
      ['a number', 2025000011923],
      ['a boolean', true],
      ['an object', { no: 'A-1' }],
      ['a list', ['A-1']],
    ])('refuses %s under either key', (_case, value) => {
      expect(recordReferenceIssues({ invoice_no: value })).toEqual(['input.invoice_no must be text']);
      expect(recordReferenceIssues({ supplier: value })).toEqual(['input.supplier must be text']);
    });

    it('leaves every other key alone, whatever it holds', () => {
      expect(recordReferenceIssues({ utility_provider: 'z'.repeat(5000), total_kwh: 12, notes: { a: 1 }, quantity_unit: 'Liters' })).toEqual([]);
    });

    it('reads own keys only', () => {
      const inherited = Object.create({ invoice_no: 7 }) as Record<string, unknown>;
      expect(recordReferenceIssues(inherited)).toEqual([]);
    });
  });

  describe('electricitySupplierIssues: an Electricity record\'s supplier is its utility provider', () => {
    it('accepts none, null, and text up to 200 characters, padding aside', () => {
      expect(electricitySupplierIssues('Electricity', null)).toEqual([]);
      expect(electricitySupplierIssues('Electricity', {})).toEqual([]);
      expect(electricitySupplierIssues('Electricity', { utility_provider: null })).toEqual([]);
      expect(electricitySupplierIssues('Electricity', { utility_provider: 'Enerjisa' })).toEqual([]);
      expect(electricitySupplierIssues('Electricity', { utility_provider: 'y'.repeat(200) })).toEqual([]);
      expect(electricitySupplierIssues('Electricity', { utility_provider: ` ${'y'.repeat(200)} ` })).toEqual([]);
    });

    it('refuses 201 characters and a value that is not text, naming the key', () => {
      expect(electricitySupplierIssues('Electricity', { utility_provider: 'y'.repeat(201) }))
        .toEqual(['input.utility_provider must be at most 200 characters']);
      for (const value of [7, true, { name: 'Enerjisa' }, ['Enerjisa']]) {
        expect(electricitySupplierIssues('Electricity', { utility_provider: value })).toEqual(['input.utility_provider must be text']);
      }
    });

    it('leaves the value a stored record already holds alone, so its other fields can still be edited', () => {
      const long = 'z'.repeat(5000);
      expect(electricitySupplierIssues('Electricity', { utility_provider: long, notes: 'edited' }, { utility_provider: long })).toEqual([]);
      expect(electricitySupplierIssues('Electricity', { utility_provider: 7 }, { utility_provider: 7 })).toEqual([]);
    });

    it('holds a changed supplier to the bound, whatever the record held before', () => {
      const long = 'z'.repeat(5000);
      expect(electricitySupplierIssues('Electricity', { utility_provider: `${long}!` }, { utility_provider: long }))
        .toEqual(['input.utility_provider must be at most 200 characters']);
      expect(electricitySupplierIssues('Electricity', { utility_provider: long }, { notes: 'no supplier before' }))
        .toEqual(['input.utility_provider must be at most 200 characters']);
      expect(electricitySupplierIssues('Electricity', { utility_provider: long }, null))
        .toEqual(['input.utility_provider must be at most 200 characters']);
    });

    it('is a rule of Electricity only: another category\'s key of that name is not a supplier', () => {
      expect(electricitySupplierIssues('Fuel', { utility_provider: 'z'.repeat(5000) })).toEqual([]);
      expect(electricitySupplierIssues('Natural Gas', { utility_provider: 7 })).toEqual([]);
    });
  });

  describe('storableRecordReferences', () => {
    it('trims the two keys and drops a blank or null one', () => {
      expect(storableRecordReferences({ invoice_no: ' A-1 ', supplier: '  ', notes: ' kept as typed ' }))
        .toEqual({ invoice_no: 'A-1', notes: ' kept as typed ' });
      expect(storableRecordReferences({ invoice_no: null, supplier: 'Shell' })).toEqual({ supplier: 'Shell' });
    });

    it('is null when nothing is left, as an empty Additional context is', () => {
      expect(storableRecordReferences({ invoice_no: '', supplier: ' ' })).toBeNull();
      expect(storableRecordReferences({ invoice_no: null })).toBeNull();
    });

    it('returns the same object when there is nothing to change, and never edits the one given', () => {
      const untouched = { total_kwh: 12, invoice_no: 'A-1' };
      expect(storableRecordReferences(untouched)).toBe(untouched);
      const given = { invoice_no: ' A-1 ' };
      storableRecordReferences(given);
      expect(given).toEqual({ invoice_no: ' A-1 ' });
      const empty = {};
      expect(storableRecordReferences(empty)).toBe(empty);
    });

    it('leaves a value that is not text for the refusal, and anything that is not an object as given', () => {
      expect(storableRecordReferences({ invoice_no: 7 })).toEqual({ invoice_no: 7 });
      expect(storableRecordReferences(null)).toBeNull();
      expect(storableRecordReferences(undefined)).toBeUndefined();
      expect(storableRecordReferences('text')).toBe('text');
      const list = [' a '];
      expect(storableRecordReferences(list)).toBe(list);
    });
  });
});
