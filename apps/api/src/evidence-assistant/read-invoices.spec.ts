import { describe, expect, it } from 'vitest';
import { fold } from './invoice-layout';
import type { ReaderItem, ReaderPage } from './pdf-reader.service';
import { readInvoices } from './read-invoices';

/**
 * inc29-evidence-assistant task 5.1: `readInvoices()` on hand-built positioned
 * text, one case per scenario of `specs/fuel-invoice-reading` requirements 2 to
 * 5 and of D2's page structure. A character is 5 points wide at size 10, as in
 * the synthetic fixtures' layout (`test/fixtures/invoices/generate.ts`).
 */

const item = (s: string, x: number, y: number, size = 10): ReaderItem => ({ s, x, y, w: s.length * size * 0.5, h: size, k: false });

interface PageSpec {
  no?: string | null;
  label?: string;
  period?: string;
  buyer?: string | null;
  vkn?: string | null;
  header?: string | null;
  rows?: Array<[string | null, string | null, string?]>;
  mark?: string;
  total?: boolean;
  extra?: ReaderItem[];
}

function page(spec: PageSpec = {}): ReaderPage {
  const items: ReaderItem[] = [item('SYNTHETIC TEST FIXTURE', 40, 810, 8)];
  if (spec.no !== null) items.push(item(spec.label ?? 'Fatura No:', 40, 750), item(spec.no ?? 'OZK0000000000001', 110, 750));
  items.push(item('Dönem:', 40, 720), item(spec.period ?? '01.02.2025 - 15.02.2025', 110, 720));
  if (spec.buyer !== null) items.push(item('Sayın', 40, 690), item(spec.buyer ?? 'ÖRNEK METAL A.Ş.', 72, 690));
  if (spec.vkn !== null) items.push(item(`VKN: ${spec.vkn ?? '0000000000'}`, 40, 662));
  if (spec.header !== null) {
    items.push(item('Ürün', 40, 620), item(spec.header ?? 'Miktar (lt)', 260, 620), item('Birim Fiyat', 360, 620), item('Tutar (TL)', 460, 620));
  }
  let y = 600;
  for (const [product, quantity, amount] of spec.rows ?? [['Motorin Med', '7.502,66']]) {
    if (product !== null) items.push(item(product, 40, y));
    if (quantity !== null) items.push(item(quantity, 260, y), item('42,10', 360, y));
    if (amount !== undefined) items.push(item(amount, 460, y));
    y -= 16;
  }
  if (spec.total !== false) items.push(item('Genel Toplam', 40, y - 4), item('315.861,98', 460, y - 4));
  if (spec.mark) items.push(item(spec.mark, 40, 60, 8));
  items.push(...(spec.extra ?? []));
  return { w: 595.28, h: 841.89, items };
}

const one = (spec: PageSpec = {}) => {
  const result = readInvoices([page(spec)]);
  expect(result.invoices).toHaveLength(1);
  return result.invoices[0]!;
};

describe('readInvoices: the two known series (requirement 2)', () => {
  it('reads a Petrol Ofisi invoice of the OZK series and a Duman invoice of the DAU series', () => {
    expect(one({ no: 'OZK0000000000001' })).toMatchObject({ series: 'OZK', unreadReason: null });
    expect(one({ no: 'DAU0000000000244' })).toMatchObject({ series: 'DAU', unreadReason: null });
  });

  it('leaves an invoice of another series unread, and its document unsplit', () => {
    expect(one({ no: 'ABC2025000000001' })).toMatchObject({ series: 'ABC', unreadReason: 'unknown_series', lines: [] });
    const result = readInvoices([page({ no: 'OZK0000000000001' }), page({ no: 'ABC2025000000001' })]);
    expect(result.routable).toBe(false);
  });

  it('leaves a known number without the Miktar (lt) column unread', () => {
    expect(one({ no: 'DAU0000000000244', header: 'Miktar (kg)' })).toMatchObject({ unreadReason: 'unreadable', lines: [] });
    expect(one({ no: 'DAU0000000000244', header: null })).toMatchObject({ unreadReason: 'unreadable' });
  });

  it('reads nothing from a page with no invoice number', () => {
    expect(readInvoices([page({ no: null })])).toEqual({ invoices: [], pageOwner: [null], routable: false });
  });
});

describe('readInvoices: product and litres from one row (requirement 3)', () => {
  it('reads a Turkish-format quantity as a plain decimal', () => {
    expect(one({ rows: [['Motorin Med', '7.502,66']] }).lines).toEqual([{ product: 'Motorin Med', fuel: 'diesel', litres: '7502.66' }]);
  });

  it('never borrows a product from the row above: the invoice is unreadable', () => {
    const inv = one({ rows: [['Kurşunsuz 95', '60,00'], ['Motorin Med', null], [null, '150,00']] });
    expect(inv).toMatchObject({ unreadReason: 'unreadable_row', lines: [] });
  });

  it('never reads the money total as litres', () => {
    const inv = one({ rows: [['Motorin Med', '7.502,66', '315.861,98']] });
    expect(inv.lines).toEqual([{ product: 'Motorin Med', fuel: 'diesel', litres: '7502.66' }]);
  });

  it('stops at the total row even if it prints litres in the quantity column', () => {
    const inv = one({ rows: [['Motorin Med', '100,00'], ['Toplam', '100,00']], total: false });
    expect(inv.lines).toEqual([{ product: 'Motorin Med', fuel: 'diesel', litres: '100.00' }]);
  });

  it('leaves the invoice unread when a quantity has a letter in it', () => {
    expect(one({ rows: [['Motorin Med', '7.5O2,66']] })).toMatchObject({ unreadReason: 'unreadable_row', lines: [] });
  });

  it('reads a row pdf.js merged into one item by its characters’ positions', () => {
    const merged = page({ rows: [] });
    merged.items.push({ s: 'Motorin Med', x: 40, y: 600, w: 55, h: 10, k: false });
    // One item from the product to the quantity, as pdf.js may give two close cells.
    merged.items.push({ s: 'Ultimate 7.502,66', x: 100, y: 600, w: 190, h: 10, k: false });
    expect(readInvoices([merged]).invoices[0]!.lines).toEqual([{ product: 'Motorin Med Ultimate', fuel: 'diesel', litres: '7502.66' }]);
  });

  it('ignores a skewed item', () => {
    const skewed = page({ rows: [['Motorin Med', '100,00']] });
    skewed.items.push({ s: '999,99', x: 262, y: 584, w: 30, h: 10, k: true });
    expect(readInvoices([skewed]).invoices[0]!.lines).toEqual([{ product: 'Motorin Med', fuel: 'diesel', litres: '100.00' }]);
  });

  it('leaves an invoice whose table has no fuel row unread', () => {
    expect(one({ rows: [] })).toMatchObject({ unreadReason: 'unreadable', lines: [] });
  });
});

describe('readInvoices: totals per fuel (requirement 4)', () => {
  it('totals several rows of one fuel, with all three example names', () => {
    const inv = one({ rows: [['Kurşunsuz 95', '100,00'], ['Kurşunsuz 95 Benzin', '50,00'], ['Motorin Med', '200,00']] });
    expect(inv.lines).toEqual([
      { product: 'Motorin Med', fuel: 'diesel', litres: '200.00' },
      { product: 'Kurşunsuz 95 + Kurşunsuz 95 Benzin', fuel: 'petrol', litres: '150.00' },
    ]);
  });

  it('keeps a product the rule does not name as a line of its own', () => {
    const inv = one({ rows: [['Motorin', '200,00'], ['AdBlue', '20,00'], ['ADBLUE', '5,5']] });
    expect(inv.lines).toEqual([
      { product: 'Motorin', fuel: 'diesel', litres: '200.00' },
      { product: 'AdBlue', fuel: null, litres: '25.50' },
    ]);
  });

  it('keeps every digit the invoice prints, exactly', () => {
    const inv = one({ rows: [['Motorin Med', '0,1'], ['Motorin Med', '0,2'], ['Motorin Med', '1.000.000,123']] });
    expect(inv.lines).toEqual([{ product: 'Motorin Med', fuel: 'diesel', litres: '1000000.423' }]);
  });
});

describe('readInvoices: number, period and buyer (requirement 5)', () => {
  it('reads the buyer after the salutation, and the tax number below it', () => {
    expect(one({ buyer: 'ÖRNEK METAL A.Ş.', vkn: '0000000000' })).toMatchObject({ buyerName: 'ÖRNEK METAL A.Ş.', buyerTaxId: '0000000000' });
  });

  it("does not take the seller's tax number printed above the salutation", () => {
    const inv = one({ vkn: null, extra: [item('VKN: 1111111111', 300, 780)] });
    expect(inv).toMatchObject({ buyerName: 'ÖRNEK METAL A.Ş.', buyerTaxId: null });
  });

  it('reads a period printed as two dates as the first half of February', () => {
    expect(one({ period: '01.02.2025 - 15.02.2025' })).toMatchObject({
      periodText: '01.02.2025 - 15.02.2025', periodFrom: '2025-02-01', periodTo: '2025-02-15',
    });
  });

  it('keeps a code that looks like a date as text', () => {
    expect(one({ period: '2025-03-02' })).toMatchObject({ periodText: '2025-03-02', periodFrom: null, periodTo: null });
    expect(one({ period: '31.02.2025 - 15.03.2025' })).toMatchObject({ periodFrom: null, periodTo: null });
  });

  it('matches labels with İ and ı, upper or lower case, never by the process locale', () => {
    expect(fold('SAYIN MİKTAR (LT) DÖNEM Fatura NO')).toBe('sayin miktar (lt) donem fatura no');
    const inv = one({ label: 'FATURA NO:', header: 'MİKTAR (LT)', buyer: 'ÖRNEK METAL A.Ş.', extra: [] });
    expect(inv).toMatchObject({ unreadReason: null, buyerName: 'ÖRNEK METAL A.Ş.' });
    const upper = page({});
    upper.items = upper.items.map((i) => (i.s === 'Sayın' ? { ...i, s: 'SAYIN' } : i.s === 'Dönem:' ? { ...i, s: 'DÖNEM:' } : i));
    expect(readInvoices([upper]).invoices[0]).toMatchObject({ buyerName: 'ÖRNEK METAL A.Ş.', periodFrom: '2025-02-01' });
  });
});

describe('readInvoices: pages to invoices (D2)', () => {
  it('reads a two-page invoice across its pages', () => {
    const result = readInvoices([
      page({ no: 'DAU0000000000011', rows: [['Motorin Med', '410,00'], ['Motorin Ultimate', '120,50']], total: false, mark: 'Sayfa 1/2' }),
      page({ no: 'DAU0000000000011', rows: [['Kurşunsuz 95 - Shell Vp', '88,40'], ['Motorin Med', '33,10']], mark: 'Sayfa 2/2' }),
    ]);
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0]).toMatchObject({ pageFrom: 1, pageTo: 2, unreadReason: null });
    expect(result.invoices[0]!.lines).toEqual([
      { product: 'Motorin Med + Motorin Ultimate', fuel: 'diesel', litres: '563.60' },
      { product: 'Kurşunsuz 95 - Shell Vp', fuel: 'petrol', litres: '88.40' },
    ]);
    expect(result.routable).toBe(false);
  });

  it('continues a numberless page only on its page mark', () => {
    const proven = readInvoices([
      page({ no: 'OZK0000000000001', rows: [['Motorin Med', '10,00']], total: false, mark: 'Sayfa 1/2' }),
      page({ no: null, rows: [['Motorin Med', '5,00']], mark: 'Sayfa 2/2' }),
      page({ no: 'OZK0000000000002' }),
    ]);
    expect(proven.pageOwner).toEqual(['OZK0000000000001', 'OZK0000000000001', 'OZK0000000000002']);
    expect(proven.invoices[0]!.lines[0]!.litres).toBe('15.00');
    expect(proven.routable).toBe(true);
    const unproven = readInvoices([
      page({ no: 'OZK0000000000001', rows: [['Motorin Med', '10,00']], total: false }),
      page({ no: null, rows: [['Motorin Med', '5,00']] }),
      page({ no: 'OZK0000000000002' }),
    ]);
    expect(unproven.pageOwner).toEqual(['OZK0000000000001', null, 'OZK0000000000002']);
    expect(unproven.routable).toBe(false);
    // The unowned page prints a quantity header: its rows may be the invoice's, so no partial total.
    expect(unproven.invoices[0]).toMatchObject({ unreadReason: 'unreadable', lines: [] });
  });

  it('splits a document whose every page has one owner and whose invoices are contiguous', () => {
    const result = readInvoices([page({ no: 'OZK0000000000001' }), page({ no: 'OZK0000000000002' }), page({ no: 'OZK0000000000006' })]);
    expect(result.routable).toBe(true);
    expect(result.invoices.map((i) => [i.invoiceNo, i.pageFrom, i.pageTo])).toEqual([
      ['OZK0000000000001', 1, 1], ['OZK0000000000002', 2, 2], ['OZK0000000000006', 3, 3],
    ]);
  });

  it('does not route a document with an unowned first page', () => {
    const result = readInvoices([page({ no: null, rows: [], header: null, total: false }), page({ no: 'OZK0000000000001' }), page({ no: 'OZK0000000000002' })]);
    expect(result.pageOwner[0]).toBeNull();
    expect(result.routable).toBe(false);
    expect(result.invoices.every((i) => i.unreadReason === null)).toBe(true);
  });

  it('does not route, nor read, a page that prints two numbers', () => {
    const two = page({ no: 'OZK0000000000001', extra: [item('Fatura No:', 300, 735), item('OZK0000000000002', 360, 735)] });
    const result = readInvoices([two, page({ no: 'OZK0000000000003' })]);
    expect(result.pageOwner).toEqual([null, 'OZK0000000000003']);
    expect(result.routable).toBe(false);
    expect(result.invoices.filter((i) => i.unreadReason === 'unreadable').map((i) => i.invoiceNo).sort()).toEqual([
      'OZK0000000000001', 'OZK0000000000002',
    ]);
  });

  it('does not route a number that comes back after another invoice', () => {
    const result = readInvoices([page({ no: 'OZK0000000000001' }), page({ no: 'OZK0000000000002' }), page({ no: 'OZK0000000000001' })]);
    expect(result.routable).toBe(false);
    expect(result.invoices.find((i) => i.invoiceNo === 'OZK0000000000001')).toMatchObject({ unreadReason: 'unreadable' });
  });

  it('does not route a document with an invoice header it cannot read', () => {
    const result = readInvoices([page({ no: 'OZK0000000000001' }), page({ no: '12345' })]);
    expect(result.routable).toBe(false);
  });
});

describe('readInvoices: never a partial total (qa-auditor review of PR B)', () => {
  it('leaves an invoice unread when a numberless, markless page after it holds a figure in its column', () => {
    const result = readInvoices([
      page({ no: 'OZK0000000000001', rows: [['Motorin Med', '10,00']], total: false }),
      page({ no: null, header: null, rows: [['Motorin Med', '5,00']], total: false }),
    ]);
    expect(result.pageOwner).toEqual(['OZK0000000000001', null]);
    expect(result.invoices[0]).toMatchObject({ unreadReason: 'unreadable', lines: [] });
  });

  it('leaves it unread when only the second page prints a page mark', () => {
    const result = readInvoices([
      page({ no: 'OZK0000000000001', rows: [['Motorin Med', '10,00']], total: false }),
      page({ no: null, header: null, rows: [['Motorin Med', '5,00']], mark: 'Sayfa 2/2' }),
    ]);
    expect(result.invoices[0]).toMatchObject({ unreadReason: 'unreadable' });
  });

  it('reads an invoice whose next unowned page holds only text', () => {
    const terms = page({ no: null, header: null, rows: [], total: false });
    terms.items.push(item('Ödeme koşulları: 30 gün', 40, 500));
    const result = readInvoices([page({ no: 'OZK0000000000001', rows: [['Motorin Med', '10,00']] }), terms]);
    expect(result.invoices[0]).toMatchObject({ unreadReason: null, lines: [{ litres: '10.00' }] });
  });

  it('leaves it unread when a figure follows a total row (a subtotal mid-table)', () => {
    const inv = one({ rows: [['Motorin Med', '10,00'], ['Toplam PO-A', '10,00'], ['Motorin Med', '20,00'], ['Kurşunsuz 95', '7,00']], total: false });
    expect(inv).toMatchObject({ unreadReason: 'unreadable_row', lines: [] });
  });

  it('continues a numberless page only from the mark just before it', () => {
    const result = readInvoices([
      page({ no: 'OZK0000000000001', rows: [['Motorin Med', '10,00']], total: false, mark: 'Sayfa 1/3' }),
      page({ no: null, rows: [['Motorin Med', '5,00']], mark: 'Sayfa 3/3' }),
    ]);
    expect(result.pageOwner).toEqual(['OZK0000000000001', null]);
    expect(result.routable).toBe(false);
  });
});

describe('readInvoices: the re-review’s cases (qa-auditor re-review of PR B)', () => {
  it('a second quantity header on a page leaves the invoice unread', () => {
    const second = page({ rows: [['Motorin Med', '10,00']], total: false });
    second.items.push(item('Ürün', 40, 400), item('Miktar (lt)', 400, 400), item('Motorin Med', 40, 380), item('99,00', 400, 380));
    expect(readInvoices([second]).invoices[0]).toMatchObject({ unreadReason: 'unreadable' });
  });

  it('a figure above a later page’s repeated header leaves the invoice unread', () => {
    const p2 = page({ no: 'OZK0000000000001', rows: [['Motorin Med', '11,00']], mark: 'Sayfa 2/2' });
    p2.items.push(item('Motorin Med', 40, 640), item('55,00', 260, 640));
    const result = readInvoices([page({ no: 'OZK0000000000001', rows: [['Motorin Med', '10,00']], total: false, mark: 'Sayfa 1/2' }), p2]);
    expect(result.invoices[0]).toMatchObject({ unreadReason: 'unreadable' });
  });

  it('looks past a blank unowned page for rows', () => {
    const blank: ReaderPage = { w: 595, h: 842, items: [] };
    const result = readInvoices([page({ rows: [['Motorin Med', '10,00']], total: false }), blank, page({ no: null, header: null, rows: [['Motorin Med', '5,00']], total: false })]);
    expect(result.invoices[0]).toMatchObject({ unreadReason: 'unreadable' });
  });

  it('reads an invoice whose footer after the total holds words and numbers in the quantity column', () => {
    const footer = page({ rows: [['Motorin Med', '10,00']] });
    footer.items.push(item('Yalnız:', 40, 540), item('on dört lira', 260, 540), item('KDV', 40, 520), item('%20', 260, 520), item('IBAN:', 40, 500), item('TR12', 120, 500));
    expect(readInvoices([footer]).invoices[0]).toMatchObject({ unreadReason: null, lines: [{ litres: '10.00' }] });
  });

  it('reads an invoice followed by a bank page whose figures are not fuel rows', () => {
    const bank: ReaderPage = { w: 595, h: 842, items: [item('Banka bilgileri', 40, 700), item('0006 1234', 260, 680)] };
    expect(readInvoices([page({ rows: [['Motorin Med', '10,00']] }), bank]).invoices[0]).toMatchObject({ unreadReason: null });
  });

  it('continues only within the same page count (1/3 then 2/2 is not a continuation)', () => {
    const result = readInvoices([
      page({ no: 'OZK0000000000001', rows: [['Motorin Med', '10,00']], total: false, mark: 'Sayfa 1/3' }),
      page({ no: null, rows: [['Motorin Med', '5,00']], mark: 'Sayfa 2/2' }),
    ]);
    expect(result.pageOwner).toEqual(['OZK0000000000001', null]);
  });
});
