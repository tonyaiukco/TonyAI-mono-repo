import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  PETROL_OFISI_HEADER,
  SHARED_INVOICE,
  SHELL_DIESEL_NAMES,
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
    const col = (h: string) => SHELL_HEADER.indexOf(h);
    const body = rows.slice(1);
    // Two fills of one card and station on one day, at 08:10 and 17:45.
    const sameDay = body.filter((r) => r[col('Kart No')] === '7000-0000-0000-0001' && r[col('İstasyon Kodu')] === 'ST-0001');
    expect(sameDay.map((r) => (r[col('İşlem Tarihi')] as Date).toISOString())).toEqual([
      '2025-03-03T08:10:00.000Z',
      '2025-03-03T17:45:00.000Z',
    ]);
    // A fill late on the last day of March; a date written as text.
    expect(body.some((r) => (r[col('İşlem Tarihi')] as Date)?.toISOString?.() === '2025-03-31T23:50:00.000Z')).toBe(true);
    expect(body.map((r) => r[col('İşlem Tarihi')])).toContain('04.04.2025 07:15');
    // Quantities: numbers, Turkish-format text, and a dot-decimal text the adapters refuse.
    const litres = body.map((r) => r[col('Miktar (LT)')]);
    expect(litres).toEqual(expect.arrayContaining([31.86, '31,86', '1.168,00', '1168.5']));
    expect(body.map((r) => r[col('Ürün')])).toEqual(expect.arrayContaining([...SHELL_DIESEL_NAMES, 'Otogaz LPG']));
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
    const count = (code: string) => shared.filter((r) => r[account] === code).length;
    expect([count('PO-0001'), sum('PO-0001')]).toEqual([15, 669.38]);
    expect([count('000456'), sum('000456')]).toEqual([1, 19.63]);
    expect([count('PO-9001'), sum('PO-9001')]).toEqual([4, 80]);
    // Every documented 2025 name (INC-2.8 §2) across the two card files: six petrol, five diesel.
    const shell = await sheetRows(files['shell-items.xlsx']!, 'items');
    const names = new Set([
      ...rows.slice(1).map((r) => r[PETROL_OFISI_HEADER.indexOf('Tip')]),
      ...shell.slice(1).map((r) => r[SHELL_HEADER.indexOf('Ürün')]),
    ]);
    for (const name of [
      'Kurşunsuz 95 V/Max', 'Kurşunsuz 95 Oktan', 'Kurşunsuz 95 Ultimate', 'Kurşunsuz 95 - Shell Vp',
      'KURŞUNSUZ BENZİN SHELL - 95 VP', 'Kurşunsuz 95 Benzin',
      'Motorin Med', 'Motorin Ultimate', 'Motorin Diesel', 'Motorin - Shell Vp Diesel', 'MOTORIN-SHELL VP DIESEL',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    // `Dönem` is a text code that looks like a date; a `Satış ID` appears twice; one sale has no invoice.
    const period = PETROL_OFISI_HEADER.indexOf('Dönem');
    expect(rows.slice(1).every((r) => typeof r[period] === 'string')).toBe(true);
    const ids = rows.slice(1).map((r) => r[PETROL_OFISI_HEADER.indexOf('Satış ID')]);
    expect(new Set(ids).size).toBe(ids.length - 1);
    expect(rows.slice(1).filter((r) => r[invoice] === undefined)).not.toHaveLength(0);
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
    // The money headers do not name their data: `KDV` holds the unit price.
    expect(deliveries.every((r) => r[TANKER_HEADER.indexOf('KDV')] === 40)).toBe(true);
  });
});
