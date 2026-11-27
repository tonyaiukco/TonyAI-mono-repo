import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { FUEL_TANKER_MAX_DELIVERIES } from '@tonyai/shared-types';
import { OFFICE_RELATIONSHIPS, SPREADSHEETML, row as sheetRow, xlsx } from '../../test/xlsx';
import { FUEL_HEADER_SEARCH_ROWS, FUEL_UNKEYED_ROWS_MAX, keyReading, readFuelFile } from './read-fuel-file';
import { createHash, createHmac } from 'node:crypto';
import { dedupeDigest, keyHashOf } from './adapters/adapter';
import { SHELL_HEADERS } from './adapters/shell';

/**
 * The three adapters over the synthetic fixtures (inc28-fuel-bulk D4, D19;
 * tasks 4.2 and 4.3). `test/fixtures/fuel/generate.ts` states what each
 * fixture holds; the figures below are read from it.
 */

const FIXTURES = join(__dirname, '../../test/fixtures/fuel');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

async function refusal(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BadRequestException);
  return (error as BadRequestException).getResponse() as { code: string; params?: Record<string, unknown> };
}

const sumLitres = (litres: readonly string[]) =>
  litres.reduce((sum, l) => sum + Math.round(Number(l) * 100), 0) / 100;

describe('readFuelFile — Shell', () => {
  it('reads sheet `items` by its column map, refusing the dot-decimal text', async () => {
    const reading = await readFuelFile(fixture('shell-items.xlsx'), 'shell');
    expect(reading.rowsRead).toBe(9);
    expect(reading.refused).toEqual([{ row: 10, code: 'fuel_quantity_unreadable' }]);
    expect(reading.duplicates).toEqual([]);
    expect(reading.rows.map((r) => [r.fileRow, r.accountCode, r.rawFuel, r.litres, r.transactionAt, r.invoiceRef])).toEqual([
      [2, '0071234', 'Motorin Med', '40', '2025-03-03T08:10:00', '2025-03-1'],
      [3, '0071234', 'Motorin Med', '40', '2025-03-03T17:45:00', '2025-03-1'],
      [4, '0071234', 'Motorin Ultimate', '31.86', '2025-03-15T12:00:00', '2025-03-1'],
      [5, '0071234', 'Motorin - Shell Vp Diesel', '31.86', '2025-03-16T09:30:00', '2025-03-2'],
      [6, '0071234', 'MOTORIN-SHELL VP DIESEL', '55.5', '2025-03-31T23:50:00', '2025-03-2'],
      [7, '0071234', 'Kurşunsuz 95 - Shell Vp', '1168.00', '2025-04-04T07:15:00', '2025-04-1'],
      [8, '71234', 'KURŞUNSUZ BENZİN SHELL - 95 VP', '25', '2025-03-05T11:00:00', '2025-03-1'],
      [9, '71234', 'Otogaz LPG', '30', '2025-03-20T14:00:00', '2025-03-2'],
    ]);
  });

  it('keeps leading zeros: 0071234 and 71234 are two accounts, each named as the file names it', async () => {
    const { rows } = await readFuelFile(fixture('shell-items.xlsx'), 'shell');
    expect([...new Set(rows.map((r) => `${r.accountCode}|${r.accountName}`))]).toEqual([
      '0071234|Örnek Lojistik Filo',
      '71234|Örnek Enerji Filo',
    ]);
  });

  it('puts a fill at 31 March 23:50 in March, second half', async () => {
    const { rows } = await readFuelFile(fixture('shell-items.xlsx'), 'shell');
    expect(rows.find((r) => r.fileRow === 6)).toMatchObject({ year: 2025, month: 3, invoiceRef: '2025-03-2' });
  });

  it('stores no card number, station code or plate in any draft row', async () => {
    const { rows } = await readFuelFile(fixture('shell-items.xlsx'), 'shell');
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/7000-|TST|ST-000|İstasyonu/);
  });

  it('refuses a workbook with no `items` sheet, saying so', async () => {
    expect((await refusal(readFuelFile(fixture('shell-without-items.xlsx'), 'shell'))).code).toBe(
      'fuel_file_sheet_missing',
    );
    // A Petrol Ofisi list has no `items` sheet either.
    expect((await refusal(readFuelFile(fixture('petrol-ofisi-satislistesi.xlsx'), 'shell'))).code).toBe(
      'fuel_file_sheet_missing',
    );
  });
});

describe('readFuelFile — Petrol Ofisi', () => {
  it('reads the sales list, refusing the sale with no invoice and reporting the repeated sale', async () => {
    const reading = await readFuelFile(fixture('petrol-ofisi-satislistesi.xlsx'), 'petrol_ofisi');
    expect(reading.rowsRead).toBe(23);
    expect(reading.rows).toHaveLength(21);
    expect(reading.refused).toEqual([{ row: 24, code: 'fuel_cell_missing' }]);
    expect(reading.duplicates).toEqual([{ row: 23, code: 'fuel_duplicate' }]);
  });

  it('holds the shared invoice figures of INC-2.8 §7, per account', async () => {
    const { rows } = await readFuelFile(fixture('petrol-ofisi-satislistesi.xlsx'), 'petrol_ofisi');
    const shared = rows.filter((r) => r.invoiceRef === 'OZK0000000000001');
    const litresOf = (code: string) => sumLitres(shared.filter((r) => r.accountCode === code).map((r) => r.litres));
    expect([litresOf('PO-0001'), litresOf('000456'), litresOf('PO-9001')]).toEqual([669.38, 19.63, 80]);
  });

  it('takes the period from `Tarih` and never reads `Dönem`', async () => {
    const { rows } = await readFuelFile(fixture('petrol-ofisi-satislistesi.xlsx'), 'petrol_ofisi');
    const shift = rows.find((r) => r.fileRow === 22)!;
    expect(shift).toMatchObject({
      year: 2025,
      month: 3,
      transactionAt: '2025-03-15T18:00:00',
      invoiceRef: 'OZK0000000000002',
      litres: '1168.00',
    });
    // `Dönem`'s codes (`2025-03-01`, `2025-03-02`) are no value of any row.
    const values = rows.flatMap((r) => Object.values(r));
    expect(values).not.toContain('2025-03-01');
    expect(values).not.toContain('2025-03-02');
    expect(JSON.stringify(rows)).not.toMatch(/7000-|TST/);
  });

  it('refuses a header present twice, naming it', async () => {
    const body = await refusal(readFuelFile(fixture('petrol-ofisi-miktar-twice.xlsx'), 'petrol_ofisi'));
    expect(body).toMatchObject({ code: 'fuel_file_columns_ambiguous', params: { columns: 'Miktar' } });
  });

  it('refuses a file of another source, naming the columns it lacks', async () => {
    const asTanker = await refusal(readFuelFile(fixture('petrol-ofisi-satislistesi.xlsx'), 'tanker'));
    expect(asTanker).toMatchObject({
      code: 'fuel_file_columns_missing',
      params: { columns: 'EVRAK NO, AÇIKLAMA, MİKTAR' },
    });
    // A sales list's sheet renamed `items` and uploaded as Shell: the columns it lacks are named.
    const salesAsItems = withSheetName(
      sheetRow(1, ['Satış ID', 'Filo Kod Adı', 'Filo', 'Tarih', 'Tip', 'Miktar', 'Fatura Numarası']),
      'items',
    );
    const asShell = await refusal(readFuelFile(salesAsItems, 'shell'));
    expect(asShell).toMatchObject({
      code: 'fuel_file_columns_missing',
      params: { columns: 'Müşteri Kodu, Müşteri Adı, Kart No, İşlem Tarihi, İstasyon Kodu, Ürün, Miktar (LT)' },
    });
  });
});

describe('readFuelFile — tanker', () => {
  it('finds the header under a title row, reads the three mapped columns, and refuses `TOPLAM`', async () => {
    const reading = await readFuelFile(fixture('tanker-alimlari.xlsx'), 'tanker');
    expect(reading.rowsRead).toBe(6);
    expect(reading.refused).toEqual([{ row: 9, code: 'fuel_key_missing' }]);
    expect(reading.rows.map((r) => [r.invoiceRef, r.accountCode, r.litres])).toEqual([
      ['000101', 'ÖRNEK DEPO A.Ş.', '10000'],
      ['000102', 'ÖRNEK DEPO A.Ş.', '12500.5'],
      ['000103', 'ÖRNEK ŞANTİYE LTD.', '8000'],
      ['000104', 'ÖRNEK İŞTİRAK A.Ş.', '5000'],
      ['000105', 'ÖRNEK ŞANTİYE LTD.', '7250.25'],
    ]);
    // The money columns' shifted headers are never read, and the total row's litres are not added.
    expect(sumLitres(reading.rows.map((r) => r.litres))).toBe(42750.75);
    expect(reading.rows.every((r) => r.rawFuel === null && r.year === null && r.transactionAt === null)).toBe(true);
  });

  it('refuses more deliveries than a tanker file may hold, stating the limit', async () => {
    const rows = [sheetRow(1, ['EVRAK NO', 'AÇIKLAMA', 'MİKTAR'])];
    for (let i = 0; i <= FUEL_TANKER_MAX_DELIVERIES; i += 1) rows.push(sheetRow(i + 2, [`D${i}`, 'X', 10]));
    const body = await refusal(readFuelFile(xlsx({ sheetData: rows.join('') }), 'tanker'));
    expect(body).toMatchObject({
      code: 'fuel_file_too_many_rows',
      params: { rows: FUEL_TANKER_MAX_DELIVERIES + 1, max: FUEL_TANKER_MAX_DELIVERIES },
    });
  });

  it('reads the full quota of deliveries with a TOPLAM row below it (C18; review of the fixes, P2)', async () => {
    const rows = [sheetRow(1, ['EVRAK NO', 'AÇIKLAMA', 'MİKTAR'])];
    for (let i = 0; i < FUEL_TANKER_MAX_DELIVERIES; i += 1) rows.push(sheetRow(i + 2, [`D${i}`, 'X', 10]));
    rows.push(sheetRow(FUEL_TANKER_MAX_DELIVERIES + 2, [null, 'TOPLAM', 10 * FUEL_TANKER_MAX_DELIVERIES]));
    const reading = await readFuelFile(xlsx({ sheetData: rows.join('') }), 'tanker');
    expect(reading.rows).toHaveLength(FUEL_TANKER_MAX_DELIVERIES);
    expect(reading.refused).toEqual([{ row: FUEL_TANKER_MAX_DELIVERIES + 2, code: 'fuel_key_missing' }]);
  });

  it('still bounds the rows with no key a file may add beyond its quota', async () => {
    const rows = [sheetRow(1, ['EVRAK NO', 'AÇIKLAMA', 'MİKTAR']), sheetRow(2, ['D0', 'X', 10])];
    for (let i = 0; i <= FUEL_TANKER_MAX_DELIVERIES + FUEL_UNKEYED_ROWS_MAX; i += 1) rows.push(sheetRow(i + 3, [null, 'note', 1]));
    expect((await refusal(readFuelFile(xlsx({ sheetData: rows.join('') }), 'tanker'))).code).toBe('fuel_file_too_many_rows');
  });

  it(`looks for the header in the first ${FUEL_HEADER_SEARCH_ROWS} rows only`, async () => {
    const rows = Array.from({ length: FUEL_HEADER_SEARCH_ROWS }, (_, i) => sheetRow(i + 1, [`title ${i}`]));
    rows.push(sheetRow(FUEL_HEADER_SEARCH_ROWS + 1, ['EVRAK NO', 'AÇIKLAMA', 'MİKTAR']));
    expect((await refusal(readFuelFile(xlsx({ sheetData: rows.join('') }), 'tanker'))).code).toBe(
      'fuel_file_columns_missing',
    );
  });
});

describe('readFuelFile — cells', () => {
  const tanker = (cells: string) =>
    xlsx({
      sharedStrings: ['<t>EVRAK NO</t>', '<t>AÇIKLAMA</t>', '<t>MİKTAR</t>'],
      sheetData:
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' + cells,
    });
  const delivery = (r: number, document: string, litres: string) =>
    `<row r="${r}">${document}<c r="B${r}" t="inlineStr"><is><t>DEPO</t></is></c>${litres}</row>`;
  const text = (ref: string, value: string) => `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
  const number = (ref: string, value: string) => `<c r="${ref}"><v>${value}</v></c>`;

  it('reads quantities by cell type, refusing text in any but Turkish format and anything not above zero', async () => {
    const reading = await readFuelFile(
      tanker(
        [
          delivery(2, text('A2', 'D2'), number('C2', '31.86')),
          delivery(3, text('A3', 'D3'), text('C3', '1.168,00')),
          delivery(4, text('A4', 'D4'), text('C4', '31,86')),
          delivery(5, text('A5', 'D5'), text('C5', '1168.5')),
          delivery(6, text('A6', 'D6'), text('C6', 'abc')),
          delivery(7, text('A7', 'D7'), number('C7', '0')),
          delivery(8, text('A8', 'D8'), number('C8', '-5')),
          delivery(9, text('A9', 'D9'), text('C9', '12.500,250')),
          delivery(10, number('A10', '000105'), number('C10', '1.2345')),
          delivery(11, text('A11', 'D11'), text('C11', '0,0004')),
        ].join(''),
      ),
      'tanker',
    );
    expect(reading.rows.map((r) => [r.invoiceRef, r.litres])).toEqual([
      ['D2', '31.86'],
      ['D3', '1168.00'],
      ['D4', '31.86'],
      ['D9', '12500.250'],
      // A numeric code cell is its digits.
      ['105', '1.2345'],
      ['D11', '0.0004'],
    ]);
    expect(reading.refused).toEqual([
      { row: 5, code: 'fuel_quantity_unreadable' },
      { row: 6, code: 'fuel_quantity_unreadable' },
      { row: 7, code: 'fuel_quantity_unreadable' },
      { row: 8, code: 'fuel_quantity_unreadable' },
    ]);
  });

  it('reads a numeric cell at Excel’s 15 significant digits: a formula’s noise is the figure Excel shows', async () => {
    const reading = await readFuelFile(
      tanker(
        [
          delivery(2, text('A2', 'D2'), number('C2', '3.3000000000000003')),
          delivery(3, text('A3', 'D3'), number('C3', '31.859999999999999')),
          delivery(4, text('A4', 'D4'), number('C4', '12.0000000000000001')),
          delivery(5, text('A5', 'D5'), number('C5', '1234.56789012345')),
          delivery(6, text('A6', 'D6'), number('C6', '1E-7')),
        ].join(''),
      ),
      'tanker',
    );
    expect(reading.rows.map((r) => r.litres)).toEqual(['3.3', '31.86', '12', '1234.56789012345', '0.0000001']);
  });

  it('refuses a document number over 64 characters for its own reason', async () => {
    const reading = await readFuelFile(tanker(delivery(2, text('A2', 'D'.repeat(65)), number('C2', '5'))), 'tanker');
    expect(reading.refused).toEqual([{ row: 2, code: 'fuel_reference_too_long' }]);
  });
});

describe('the dedupe digest (task 4.3)', () => {
  const header = sheetRow(1, Object.values(SHELL_HEADERS));
  const fill = (r: number, at: string, litres: string | number) =>
    sheetRow(r, ['0071234', 'Filo', '7000-0000-0000-0001', at, 'ST-0001', 'Motorin Med', litres]);

  it('makes two fills of one card and station on one day, at different times, two keys', async () => {
    const { rows } = await readFuelFile(fixture('shell-items.xlsx'), 'shell');
    const [morning, evening] = rows.filter((r) => r.transactionAt?.startsWith('2025-03-03'));
    expect(morning!.keyHash).not.toBe(evening!.keyHash);
  });

  it('makes one key of the same quantity as a number and as Turkish text', async () => {
    const reading = await readFuelFile(
      withSheetName([header, fill(2, '03.03.2025 08:10', 31.86), fill(3, '03.03.2025 08:10', '31,860')].join(''), 'items'),
      'shell',
    );
    expect(reading.rows).toHaveLength(1);
    expect(reading.duplicates).toEqual([{ row: 3, code: 'fuel_duplicate' }]);
  });

  it('reports the same row twice in a file once stored and once a duplicate', async () => {
    const reading = await readFuelFile(
      withSheetName([header, fill(2, '03.03.2025 08:10', 40), fill(3, '03.03.2025 08:10', 40)].join(''), 'items'),
      'shell',
    );
    expect(reading.rows.map((r) => r.fileRow)).toEqual([2]);
    expect(reading.duplicates).toEqual([{ row: 3, code: 'fuel_duplicate' }]);
  });

  it('is the source and its key, so one key of two sources is two hashes', () => {
    expect(keyHashOf('petrol_ofisi', ['100001'])).not.toBe(keyHashOf('tanker', ['100001']));
    expect(keyHashOf('tanker', ['a|b'])).not.toBe(keyHashOf('tanker', ['a', 'b']));
    expect(keyHashOf('tanker', ['000101'])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('an ISO date cell is read as written (WP9 PR B review, P2)', () => {
  const header = sheetRow(1, Object.values(SHELL_HEADERS));
  /** A Shell fill whose date is a `t="d"` cell holding `iso`. */
  const fill = (r: number, iso: string) =>
    sheetRow(r, ['0071234', 'Filo', '7000-0000-0000-0001', 'XDATEX', 'ST-0001', 'Motorin Med', 40]).replace(
      `<c r="D${r}" t="inlineStr"><is><t>XDATEX</t></is></c>`,
      `<c r="D${r}" t="d"><v>${iso}</v></c>`,
    );

  it('keeps the wall-clock fields of a date with a zone: the first half of April stays April', async () => {
    const reading = await readFuelFile(withSheetName([header, fill(2, '2025-04-01T00:30:00+03:00')].join(''), 'items'), 'shell');
    expect(reading.rows.map((r) => [r.transactionAt, r.year, r.month, r.invoiceRef])).toEqual([['2025-04-01T00:30:00', 2025, 4, '2025-04-1']]);
  });

  it('reads a date with no zone, or in UTC, as written too', async () => {
    const reading = await readFuelFile(
      withSheetName([header, fill(2, '2025-03-16T08:10:00'), fill(3, '2025-03-15T23:59:59Z')].join(''), 'items'),
      'shell',
    );
    expect(reading.rows.map((r) => [r.transactionAt, r.invoiceRef])).toEqual([
      ['2025-03-16T08:10:00', '2025-03-2'],
      ['2025-03-15T23:59:59', '2025-03-1'],
    ]);
  });

  it('refuses only the row of a date cell that is no date, and ignores one in a column it does not read (review of the fixes, P2)', async () => {
    // An unmapped column holding a bad date (column Z) on a good row, and a bad mapped date on another.
    const withStray = fill(2, '2025-03-03T08:10:00').replace('</row>', '<c r="Z2" t="d"><v>2025-13-01</v></c></row>');
    const reading = await readFuelFile(
      withSheetName([header, withStray, fill(3, '2025-13-01'), fill(4, '2025-03-04T09:00:00')].join(''), 'items'),
      'shell',
    );
    expect(reading.rows.map((r) => r.fileRow)).toEqual([2, 4]);
    expect(reading.refused).toEqual([{ row: 3, code: 'fuel_date_unreadable' }]);
  });

  it('refuses a day the calendar does not have rather than rolling it over', async () => {
    const reading = await readFuelFile(withSheetName([header, fill(2, '2025-02-30T08:00:00')].join(''), 'items'), 'shell');
    expect(reading.rows).toEqual([]);
    expect(reading.refused).toEqual([{ row: 2, code: 'fuel_date_unreadable' }]);
  });
});

describe('the stored digest is keyed per organisation (D5, revised)', () => {
  const keyA = Buffer.alloc(32, 0xa1);
  const keyB = Buffer.alloc(32, 0xb2);

  it('is HMAC-SHA256 of the key hash under the organisation key, 64 lowercase hex', () => {
    const hash = keyHashOf('shell', ['7000-0000-0000-0001', '2025-03-03T08:10:00', '40', 'ST-0001']);
    const digest = dedupeDigest(keyA, hash);
    expect(digest).toBe(createHmac('sha256', keyA).update(hash).digest('hex'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores no row of a Shell file under its plain hash, and gives two organisations two digests', async () => {
    const read = await readFuelFile(fixture('shell-items.xlsx'), 'shell');
    const a = keyReading(read, keyA);
    const b = keyReading(read, keyB);
    expect(a.rows).toHaveLength(read.rows.length);
    for (const [i, row] of a.rows.entries()) {
      expect(row).not.toHaveProperty('keyHash');
      expect(row.dedupeDigest).not.toBe(read.rows[i]!.keyHash);
      expect(row.dedupeDigest).not.toBe(b.rows[i]!.dedupeDigest);
      expect(row.dedupeDigest).toBe(dedupeDigest(keyA, read.rows[i]!.keyHash));
    }
    // The same key gives the same digests: a re-upload still finds its rows.
    expect(keyReading(read, Buffer.alloc(32, 0xa1)).rows.map((r) => r.dedupeDigest)).toEqual(a.rows.map((r) => r.dedupeDigest));
    // Keying keeps the file's distinct rows distinct.
    expect(new Set(a.rows.map((r) => r.dedupeDigest)).size).toBe(a.rows.length);
  });

  it('keeps everything else of the reading as it was read', async () => {
    const read = await readFuelFile(fixture('shell-items.xlsx'), 'shell');
    const keyed = keyReading(read, keyA);
    expect({ ...keyed, rows: [] }).toEqual({ ...read, rows: [] });
    expect(keyed.rows.map(({ dedupeDigest: _d, ...row }) => row)).toEqual(read.rows.map(({ keyHash: _k, ...row }) => row));
  });

  it('cannot be reproduced from the row fields without the key (the plain sha256 is not it)', () => {
    const parts = ['7000-0000-0000-0001', '2025-03-03T08:10:00', '40', 'ST-0001'];
    const plain = createHash('sha256').update(JSON.stringify(['shell', ...parts])).digest('hex');
    expect(keyHashOf('shell', parts)).toBe(plain);
    expect(dedupeDigest(keyA, plain)).not.toBe(plain);
  });
});

/** A one-sheet test workbook whose sheet is named as a source reads it. */
function withSheetName(sheetData: string, name: string): Buffer {
  return xlsx({
    sheetData,
    workbookXml: `<workbook xmlns="${SPREADSHEETML}" xmlns:r="${OFFICE_RELATIONSHIPS}"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  });
}
