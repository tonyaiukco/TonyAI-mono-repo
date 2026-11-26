import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  PETROL_OFISI_HEADER,
  SHARED_INVOICE,
  SHELL_HEADER,
  TANKER_DELIVERIES,
  TANKER_HEADER,
  buildFuelFixtures,
} from './generate';

/**
 * inc28-fuel-bulk task 1.4: the synthetic fuel workbooks (design D19) are the
 * generator's output, byte for byte, every run; and each is in the shape its
 * source documents (INC-2.8 §1, §5), read here by a real reader (exceljs), not
 * by the adapters they will test.
 */

const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function sheetRows(bytes: Buffer, sheet: string): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(sheet);
  if (!ws) throw new Error(`no sheet ${sheet}`);
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    rows.push((row.values as unknown[]).slice(1));
  });
  return rows;
}

describe('the synthetic fuel workbooks (D19)', () => {
  it('are deterministic: two builds write the same bytes', async () => {
    const [a, b] = [await buildFuelFixtures(), await buildFuelFixtures()];
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const name of Object.keys(a)) expect(digest(a[name]!), name).toBe(digest(b[name]!));
  });

  it('are the files committed beside the script', async () => {
    const built = await buildFuelFixtures();
    for (const [name, bytes] of Object.entries(built)) {
      expect(digest(readFileSync(join(__dirname, name))), `${name}: run generate.ts`).toBe(digest(bytes));
    }
  });

  it('give Shell its header on the `items` sheet, beside a sheet that is not read', async () => {
    const files = await buildFuelFixtures();
    const rows = await sheetRows(files['shell-items.xlsx']!, 'items');
    expect(rows[0]).toEqual(SHELL_HEADER);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(files['shell-without-items.xlsx'] as unknown as ArrayBuffer);
    expect(wb.getWorksheet('items')).toBeUndefined();
    // Leading zeros kept in a text cell, and the same digits without them.
    expect(rows.slice(1).map((r) => r[0])).toEqual(expect.arrayContaining(['0071234', '71234']));
  });

  it('give Petrol Ofisi its header, the shared invoice and a header twice in the refused variant', async () => {
    const files = await buildFuelFixtures();
    const rows = await sheetRows(files['petrol-ofisi-satislistesi.xlsx']!, 'SatisListesi');
    expect(rows[0]).toEqual(PETROL_OFISI_HEADER);
    const invoice = PETROL_OFISI_HEADER.indexOf('Fatura Numarası');
    const litres = PETROL_OFISI_HEADER.indexOf('Miktar');
    const account = PETROL_OFISI_HEADER.indexOf('Filo Kod Adı');
    const shared = rows.slice(1).filter((r) => r[invoice] === SHARED_INVOICE);
    const sum = (code: string) =>
      shared.filter((r) => r[account] === code).reduce((s, r) => s + Math.round(Number(r[litres]) * 100), 0) / 100;
    expect(sum('PO-0001')).toBe(669.38);
    expect(sum('000456')).toBe(19.63);
    expect(sum('PO-9001')).toBe(80);
    const twice = await sheetRows(files['petrol-ofisi-miktar-twice.xlsx']!, 'SatisListesi');
    expect(twice[0]!.filter((h) => h === 'Miktar')).toHaveLength(2);
  });

  it('give the tanker file a title row above its header and a TOPLAM row with no document', async () => {
    const files = await buildFuelFixtures();
    const rows = await sheetRows(files['tanker-alimlari.xlsx']!, 'Sayfa1');
    expect(rows[2]).toEqual(TANKER_HEADER);
    const deliveries = rows.slice(3, 3 + TANKER_DELIVERIES);
    const total = rows[3 + TANKER_DELIVERIES]!;
    const doc = TANKER_HEADER.indexOf('EVRAK NO');
    const litres = TANKER_HEADER.indexOf('MİKTAR');
    expect(deliveries.every((r) => typeof r[doc] === 'string' && (r[doc] as string).startsWith('000'))).toBe(true);
    expect(total[doc]).toBeUndefined();
    expect(total[TANKER_HEADER.indexOf('AÇIKLAMA')]).toBe('TOPLAM');
    expect(total[litres]).toBe(deliveries.reduce((s, r) => s + Number(r[litres]), 0));
  });
});
