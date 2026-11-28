import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DUMAN_REFS, DUMAN_TWO_PAGE_INDEX, dumanInvoiceNo } from '../../test/fixtures/invoices/generate';
import { PdfReaderService, type TextOutcome } from './pdf-reader.service';
import { readInvoices, type ReadInvoicesResult } from './read-invoices';

/**
 * inc29-evidence-assistant task 5.2: every committed fixture read end to end,
 * the real worker first and `readInvoices` on its text, with the figures the
 * fixtures were written to hold.
 */

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'invoices');

describe('the synthetic invoices, read end to end', () => {
  const reader = new PdfReaderService();
  const read = async (name: string): Promise<ReadInvoicesResult> => {
    const outcome = (await reader.withSession(20_000, (s) => s.text(readFileSync(join(FIXTURES, name))))) as TextOutcome;
    if (outcome.kind !== 'text') throw new Error(`${name}: ${JSON.stringify(outcome)}`);
    return readInvoices(outcome.pages);
  };

  beforeAll(async () => {
    expect(await reader.start()).toBe('available');
  }, 30_000);
  afterAll(() => reader.onModuleDestroy());

  it('the shared invoice: 312.80 L diesel and 456.21 L petrol', async () => {
    const { invoices, routable } = await read('ozk-shared.pdf');
    expect(routable).toBe(false);
    expect(invoices).toEqual([{
      invoiceNo: 'OZK0000000000001', series: 'OZK',
      periodText: '01.03.2025 - 15.03.2025', periodFrom: '2025-03-01', periodTo: '2025-03-15',
      buyerName: 'ÖRNEK TAŞIMACILIK A.Ş.', buyerTaxId: '0000000000',
      pageFrom: 1, pageTo: 1, unreadReason: null,
      lines: [
        { product: 'Motorin Diesel', fuel: 'diesel', litres: '312.80' },
        { product: 'Kurşunsuz 95 V/Max', fuel: 'petrol', litres: '456.21' },
      ],
    }]);
  }, 20_000);

  it('the Duman PDF: 23 invoices with their page ranges, one of two pages', async () => {
    const { invoices, routable, pageOwner } = await read('duman-23.pdf');
    expect(routable).toBe(true);
    expect(pageOwner).toHaveLength(24);
    expect(invoices).toHaveLength(23);
    invoices.forEach((inv, i) => {
      const firstPage = i < DUMAN_TWO_PAGE_INDEX ? i + 1 : i + 2;
      const lastPage = i + 1 === DUMAN_TWO_PAGE_INDEX ? firstPage + 1 : firstPage;
      expect([inv.invoiceNo, inv.series, inv.pageFrom, inv.pageTo, inv.unreadReason]).toEqual([dumanInvoiceNo(i), 'DAU', firstPage, lastPage, null]);
      const [, month, half] = DUMAN_REFS[i]!.split('-');
      expect(inv.periodFrom).toBe(`2025-${month}-${half === '1' ? '01' : '16'}`);
    });
    const byRef = (ref: string) => invoices[DUMAN_REFS.indexOf(ref)]!;
    expect(byRef('2025-02-1').lines).toEqual([{ product: 'Motorin Med', fuel: 'diesel', litres: '7502.66' }]);
    expect(byRef('2025-03-1').lines).toEqual([{ product: 'Motorin Med', fuel: 'diesel', litres: '80.00' }]);
    expect(byRef('2025-03-2').lines).toEqual([{ product: 'Motorin Med', fuel: 'diesel', litres: '119.22' }]);
    expect(byRef('2025-06-1').lines).toEqual([
      { product: 'Motorin Med + Motorin Ultimate', fuel: 'diesel', litres: '563.60' },
      { product: 'Kurşunsuz 95 - Shell Vp', fuel: 'petrol', litres: '88.40' },
    ]);
    expect(byRef('2025-02-1')).toMatchObject({ buyerName: 'ÖRNEK LOJİSTİK A.Ş.', periodTo: '2025-02-15' });
  }, 20_000);

  it('the mixed invoice: petrol 150.00 and diesel 200.00; the AdBlue line apart', async () => {
    expect((await read('ozk-mixed.pdf')).invoices[0]!.lines).toEqual([
      { product: 'Motorin Med', fuel: 'diesel', litres: '200.00' },
      { product: 'Kurşunsuz 95 + Kurşunsuz 95 Benzin', fuel: 'petrol', litres: '150.00' },
    ]);
    expect((await read('ozk-adblue.pdf')).invoices[0]!.lines).toEqual([
      { product: 'Motorin', fuel: 'diesel', litres: '200.00' },
      { product: 'AdBlue', fuel: null, litres: '20.00' },
    ]);
  }, 20_000);

  it('the single invoice keeps its period code as text; the row-above invoice is unreadable', async () => {
    expect((await read('ozk-single.pdf')).invoices[0]).toMatchObject({
      invoiceNo: 'OZK0000000000002', periodText: '2025-03-02', periodFrom: null, periodTo: null, unreadReason: null,
      lines: [{ product: 'Motorin Med', fuel: 'diesel', litres: '1168.00' }],
    });
    expect((await read('ozk-row-above.pdf')).invoices[0]).toMatchObject({ unreadReason: 'unreadable_row', lines: [] });
  }, 20_000);

  it('the three-invoice PDF splits into three one-page invoices', async () => {
    const { invoices, routable } = await read('ozk-three.pdf');
    expect(routable).toBe(true);
    expect(invoices.map((i) => [i.invoiceNo, i.pageFrom, i.pageTo, i.unreadReason])).toEqual([
      ['OZK0000000000001', 1, 1, null], ['OZK0000000000002', 2, 2, null], ['OZK0000000000006', 3, 3, null],
    ]);
  }, 20_000);
});
