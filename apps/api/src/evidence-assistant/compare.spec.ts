import { describe, expect, it } from 'vitest';
import { compare, compareRecord, differences, type ComparisonInput } from './compare';
import type { ReadInvoiceLine } from './read-invoices';

/**
 * inc29-evidence-assistant task 8.1: the comparison's arithmetic (D6) with the
 * documents' examples and the WP9 fuel fixture's shared invoice.
 */

const diesel = (litres: string): ReadInvoiceLine => ({ product: 'Motorin Med', fuel: 'diesel', litres });
const petrol = (litres: string): ReadInvoiceLine => ({ product: 'Kurşunsuz 95', fuel: 'petrol', litres });
const input = (over: Partial<ComparisonInput>): ComparisonInput => ({
  tolerancePercent: '1', invoiceLines: [], packageLitres: {}, invoiceLevelLitres: null, neighbourDifferences: [], ...over,
});

describe('compare (D6)', () => {
  it('7502.66 against 7502.66 is consistent (INC-2.9 §5)', () => {
    expect(compare(input({ invoiceLines: [diesel('7502.66')], packageLitres: { diesel: '7502.66' } }))).toEqual({
      level: 'package',
      lines: [{ fuel: 'diesel', invoiceLitres: '7502.66', packageLitres: '7502.66', invoiceLevelLitres: null, state: 'consistent', periodShift: false }],
      otherLines: [],
    });
  });

  it('a 31.86 L period-shift pair is consistent with its label, seen from either line', () => {
    // March first half: 111.86 in the package, 80.00 on the invoice; second half: 87.36 against 119.22.
    const first = { invoiceLines: [diesel('80.00')], packageLitres: { diesel: '111.86' } };
    const second = { invoiceLines: [diesel('119.22')], packageLitres: { diesel: '87.36' } };
    const dFirst = differences(first.invoiceLines, first.packageLitres);
    const dSecond = differences(second.invoiceLines, second.packageLitres);
    expect([dFirst, dSecond]).toEqual([{ diesel: '31.86' }, { diesel: '-31.86' }]);
    expect(compare(input({ ...first, neighbourDifferences: [dSecond] })).lines[0]).toMatchObject({ state: 'consistent', periodShift: true });
    expect(compare(input({ ...second, neighbourDifferences: [{}, dFirst] })).lines[0]).toMatchObject({ state: 'consistent', periodShift: true });
  });

  it('a neighbour that differs by another amount leaves the tolerance to decide', () => {
    const lines = compare(input({ invoiceLines: [diesel('80.00')], packageLitres: { diesel: '111.86' }, neighbourDifferences: [{ diesel: '-30.00' }] })).lines;
    expect(lines[0]).toMatchObject({ state: 'possible_difference', periodShift: false });
    // Within the tolerance a small shift is still searched first (B6): 31.86 on 7,500 L.
    const big = compare(input({ invoiceLines: [diesel('7500.00')], packageLitres: { diesel: '7531.86' }, neighbourDifferences: [{ diesel: '-31.86' }] }));
    expect(big.lines[0]).toMatchObject({ state: 'consistent', periodShift: true });
    const noNeighbour = compare(input({ invoiceLines: [diesel('7500.00')], packageLitres: { diesel: '7531.86' } }));
    expect(noNeighbour.lines[0]).toMatchObject({ state: 'consistent', periodShift: false });
  });

  it('the shared invoice: 312.80 L diesel and 456.21 L petrol at invoice level, the 80.00 L excluded petrol included', () => {
    // Three accounts: the controlled one's package holds 312.80 diesel and 356.58 petrol (669.38 L); a second
    // account 19.63 L petrol; the associate's 80.00 L petrol is excluded and in no package.
    const invoiceLines = [diesel('312.80'), { product: 'Kurşunsuz 95 V/Max', fuel: 'petrol' as const, litres: '456.21' }];
    const invoiceLevelLitres = { diesel: '312.80', petrol: '456.21' };
    const controlled = compare(input({ invoiceLines, packageLitres: { diesel: '312.80', petrol: '356.58' }, invoiceLevelLitres }));
    const second = compare(input({ invoiceLines, packageLitres: { petrol: '19.63' }, invoiceLevelLitres }));
    for (const result of [controlled, second]) {
      expect(result.level).toBe('invoice');
      expect(result.lines.map((l) => [l.fuel, l.invoiceLitres, l.invoiceLevelLitres, l.state])).toEqual([
        ['diesel', '312.80', '312.80', 'consistent'],
        ['petrol', '456.21', '456.21', 'consistent'],
      ]);
    }
    expect(second.lines.map((l) => l.packageLitres)).toEqual([null, '19.63']);
    // Without the associate's 80.00 L the invoice level would read a 17.5% difference.
    const without = compare(input({ invoiceLines, packageLitres: { petrol: '19.63' }, invoiceLevelLitres: { diesel: '312.80', petrol: '376.21' } }));
    expect(without.lines[1]).toMatchObject({ state: 'possible_difference' });
  });

  it('a difference exactly at 1 percent is consistent, one hundredth above is not', () => {
    expect(compare(input({ invoiceLines: [diesel('1000.00')], packageLitres: { diesel: '1010.00' } })).lines[0]!.state).toBe('consistent');
    expect(compare(input({ invoiceLines: [diesel('1000.00')], packageLitres: { diesel: '1010.01' } })).lines[0]!.state).toBe('possible_difference');
    expect(compare(input({ invoiceLines: [diesel('1000.00')], packageLitres: { diesel: '990.00' } })).lines[0]!.state).toBe('consistent');
    expect(compare(input({ invoiceLines: [diesel('1000.00')], packageLitres: { diesel: '989.99' } })).lines[0]!.state).toBe('possible_difference');
  });

  it('a fuel on one side only is a possible difference, whatever a neighbour or the tolerance says', () => {
    const result = compare(input({
      tolerancePercent: '100',
      invoiceLines: [diesel('200.00')],
      packageLitres: { diesel: '200.00', petrol: '50.00' },
      neighbourDifferences: [{ petrol: '-50.00' }],
    }));
    expect(result.lines).toEqual([
      { fuel: 'diesel', invoiceLitres: '200.00', packageLitres: '200.00', invoiceLevelLitres: null, state: 'consistent', periodShift: false },
      { fuel: 'petrol', invoiceLitres: null, packageLitres: '50.00', invoiceLevelLitres: null, state: 'possible_difference', periodShift: false },
    ]);
    const onInvoiceOnly = compare(input({ invoiceLines: [diesel('200.00'), petrol('10.00')], packageLitres: { diesel: '200.00' } }));
    expect(onInvoiceOnly.lines[1]).toMatchObject({ fuel: 'petrol', invoiceLitres: '10.00', packageLitres: null, state: 'possible_difference' });
  });

  it('tolerance 0: only an equal line is consistent', () => {
    expect(compare(input({ tolerancePercent: '0', invoiceLines: [diesel('1000.00')], packageLitres: { diesel: '1000.01' } })).lines[0]!.state).toBe('possible_difference');
    expect(compare(input({ tolerancePercent: '0', invoiceLines: [diesel('1000.00')], packageLitres: { diesel: '1000' } })).lines[0]!.state).toBe('consistent');
  });

  it('keeps an unnamed product apart, compared with nothing', () => {
    const result = compare(input({ invoiceLines: [diesel('200.00'), { product: 'AdBlue', fuel: null, litres: '20.00' }], packageLitres: { diesel: '200.00' } }));
    expect(result.otherLines).toEqual([{ product: 'AdBlue', litres: '20.00' }]);
    expect(result.lines).toHaveLength(1);
  });

  it('compares exactly, beyond a float’s precision', () => {
    const result = compare(input({ tolerancePercent: '0', invoiceLines: [diesel('0.3')], packageLitres: { diesel: '0.30000000000000000001' } }));
    expect(result.lines[0]!.state).toBe('possible_difference');
  });
});

describe('compareRecord: a manual record as a package of one (C6)', () => {
  const lines = [
    { product: 'Motorin Med', fuel: 'diesel' as const, litres: '1200.00' },
    { product: 'Kurşunsuz 95', fuel: 'petrol' as const, litres: '40.00' },
    { product: 'AdBlue', fuel: null, litres: '20.00' },
  ];

  it('puts the record beside the invoice line for its fuel, and lists the other lines uncompared', () => {
    expect(compareRecord({ tolerancePercent: '1', invoiceLines: lines, fuel: 'diesel', litres: '1200' })).toEqual({
      line: { fuel: 'diesel', invoiceLitres: '1200.00', packageLitres: '1200', state: 'consistent', periodShift: false },
      otherLines: [{ product: 'Kurşunsuz 95', litres: '40.00' }, { product: 'AdBlue', litres: '20.00' }],
    });
  });

  it('is consistent at the tolerance and a possible difference past it', () => {
    expect(compareRecord({ tolerancePercent: '1', invoiceLines: lines, fuel: 'diesel', litres: '1212' }).line.state).toBe('consistent');
    expect(compareRecord({ tolerancePercent: '1', invoiceLines: lines, fuel: 'diesel', litres: '1212.01' }).line.state).toBe('possible_difference');
  });

  it('is a possible difference when the invoice prints no line of the record’s fuel (LPG included)', () => {
    expect(compareRecord({ tolerancePercent: '1', invoiceLines: lines.slice(1), fuel: 'diesel', litres: '10' }).line).toMatchObject({ invoiceLitres: null, state: 'possible_difference' });
    expect(compareRecord({ tolerancePercent: '1', invoiceLines: lines, fuel: 'lpg', litres: '10' }).line).toMatchObject({ fuel: 'lpg', invoiceLitres: null, state: 'possible_difference' });
  });
});
