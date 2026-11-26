/**
 * Synthetic fuel provider workbooks (inc28-fuel-bulk, design D19), in the three
 * shapes INC-2.8 §1 and §5 document: a Shell export (sheet `items`), a Petrol
 * Ofisi `SatisListesi`, and a tanker deliveries file. No real company, account
 * code, plate or card number: every value is made up for the tests.
 *
 * What they hold, so the adapters' specs (PR B) can name it:
 *  - every documented fuel name (six petrol, five diesel) and one no rule
 *    recognises (`Otogaz LPG`);
 *  - a shared Petrol Ofisi invoice, `OZK2025000011923`: 15 rows (669.38 L) of a
 *    controlled company's account, 1 row (19.63 L) of a second controlled
 *    account, and 4 rows (80.00 L) of an associate's account;
 *  - a period-shift row (Petrol Ofisi: 15 March carrying the second half's
 *    invoice) and a fill at 31 March 23:50 (Shell: March, second half);
 *  - two Shell fills of one card and station on one day, 08:10 and 17:45;
 *  - codes with leading zeros (`0071234` beside `71234`, `000456`);
 *  - a `Dönem` code that looks like a date (`2025-03-02`);
 *  - Turkish-format quantity text (`1.168,00`, `31,86`) beside numeric cells,
 *    and a dot-decimal text (`1168.5`) the adapters refuse;
 *  - a sale with no `Fatura Numarası`, and a `Satış ID` twice in one file;
 *  - the tanker file's title row above its header, money headers shifted
 *    against their data, and the last row `TOPLAM` with no `EVRAK NO`;
 *  - two refusals of a whole file: a header twice, and a Shell workbook with no
 *    `items` sheet.
 *
 * Deterministic: fixed workbook dates, and every archive entry's time zeroed,
 * so two runs write the same bytes (`fuel-fixtures.spec.ts`). Run with
 * `node apps/api/test/fixtures/fuel/generate.ts` (Node 22) to rewrite them.
 */
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Cell = string | number | Date | null;

const FIXED = new Date(Date.UTC(2025, 0, 1));
/** A local date-time as the file writes it; exceljs stores a Date as its UTC reading. */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min));

async function workbook(sheets: Array<{ name: string; rows: Cell[][] }>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TonyAI test fixtures';
  wb.lastModifiedBy = 'TonyAI test fixtures';
  wb.created = FIXED;
  wb.modified = FIXED;
  wb.lastPrinted = FIXED;
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const values of sheet.rows) {
      const row = ws.addRow(values.map((v) => (v === null ? undefined : v)));
      values.forEach((v, i) => {
        if (v instanceof Date) row.getCell(i + 1).numFmt = 'dd.mm.yyyy hh:mm:ss';
      });
    }
  }
  return zeroArchiveTimes(Buffer.from(await wb.xlsx.writeBuffer()));
}

/** Zero every entry's DOS time and date, in the local headers and the central directory. */
function zeroArchiveTimes(archive: Buffer): Buffer {
  const out = Buffer.from(archive);
  let eocd = out.length - 22;
  while (eocd >= 0 && out.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error('not a zip archive');
  const entries = out.readUInt16LE(eocd + 10);
  let offset = out.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries; i += 1) {
    if (out.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    out.writeUInt32LE(0, offset + 12);
    const local = out.readUInt32LE(offset + 42);
    if (out.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header');
    out.writeUInt32LE(0, local + 10);
    offset += 46 + out.readUInt16LE(offset + 28) + out.readUInt16LE(offset + 30) + out.readUInt16LE(offset + 32);
  }
  return out;
}

// ── Shell ───────────────────────────────────────────────────────────────────

export const SHELL_HEADER = [
  'Müşteri Kodu', 'Müşteri Adı', 'Kart No', 'Plaka', 'İşlem Tarihi', 'İstasyon Kodu', 'İstasyon Adı', 'Ürün',
  'Miktar (LT)', 'Birim Fiyat', 'Tutar',
];

function shellRows(): Cell[][] {
  const A = ['0071234', 'Örnek Lojistik Filo'];
  const B = ['71234', 'Örnek Enerji Filo'];
  const card = (n: number) => `7000-0000-0000-${String(n).padStart(4, '0')}`;
  const plate = (n: number) => `00 TST ${String(n).padStart(3, '0')}`;
  return [
    SHELL_HEADER,
    [...A, card(1), plate(1), at(2025, 3, 3, 8, 10), 'ST-0001', 'Test İstasyonu 1', 'Motorin Med', 40, 42.1, 1684],
    [...A, card(1), plate(1), at(2025, 3, 3, 17, 45), 'ST-0001', 'Test İstasyonu 1', 'Motorin Med', 40, 42.1, 1684],
    [...A, card(2), plate(2), at(2025, 3, 15, 12, 0), 'ST-0002', 'Test İstasyonu 2', 'Motorin Ultimate', 31.86, 43, 1369.98],
    [...A, card(2), plate(2), at(2025, 3, 16, 9, 30), 'ST-0002', 'Test İstasyonu 2', 'Motorin - Shell Vp Diesel', '31,86', 43, 1369.98],
    [...A, card(3), plate(3), at(2025, 3, 31, 23, 50), 'ST-0003', 'Test İstasyonu 3', 'MOTORIN-SHELL VP DIESEL', 55.5, 43, 2386.5],
    [...A, card(3), plate(3), '04.04.2025 07:15', 'ST-0003', 'Test İstasyonu 3', 'Kurşunsuz 95 - Shell Vp', '1.168,00', 41, 47888],
    [...B, card(4), plate(4), at(2025, 3, 5, 11, 0), 'ST-0004', 'Test İstasyonu 4', 'KURŞUNSUZ BENZİN SHELL - 95 VP', 25, 41, 1025],
    [...B, card(4), plate(4), at(2025, 3, 20, 14, 0), 'ST-0004', 'Test İstasyonu 4', 'Otogaz LPG', 30, 20, 600],
    [...B, card(5), plate(5), at(2025, 3, 21, 16, 0), 'ST-0005', 'Test İstasyonu 5', 'Kurşunsuz 95 Oktan', '1168.5', 41, 47908.5],
  ];
}

// ── Petrol Ofisi ────────────────────────────────────────────────────────────

export const PETROL_OFISI_HEADER = [
  'Satış ID', 'Filo Kod Adı', 'Filo', 'Plaka', 'Kart No', 'Tarih', 'Dönem', 'İstasyon', 'Tip', 'Miktar', 'Birim Fiyat',
  'Tutar', 'Fatura Numarası',
];
export const SHARED_INVOICE = 'OZK2025000011923';

function petrolOfisiRows(): Cell[][] {
  const controlled = ['PO-0001', 'Örnek Taşımacılık Filo'];
  const second = ['000456', 'Örnek İnşaat Filo'];
  const associate = ['PO-9001', 'Örnek İştirak Filo'];
  const rows: Cell[][] = [PETROL_OFISI_HEADER];
  let id = 100000;
  const sale = (account: string[], tarih: Cell, tip: string, miktar: Cell, invoice: string | null, donem = '2025-03-01') => {
    id += 1;
    rows.push([String(id), ...account, `00 TST ${id % 1000}`, `7000-1111-0000-${id % 10000}`, tarih, donem, 'Test PO', tip, miktar, 42, 0, invoice]);
  };
  // The shared invoice: 15 rows of the controlled account adding up to 669.38 L.
  const controlledLitres = [45.12, 44.9, 44.6, 44.75, 44.3, 44.81, 44.5, 44.62, 44.7, 44.48, 44.55, 44.66, 44.73, 44.58, 44.08];
  controlledLitres.forEach((l, i) => sale(controlled, at(2025, 3, 2 + (i % 13), 9, i), i % 2 ? 'Motorin Diesel' : 'Kurşunsuz 95 V/Max', l, SHARED_INVOICE));
  // One row of a second controlled account on the same invoice (19.63 L).
  sale(second, at(2025, 3, 6, 10, 0), 'Kurşunsuz 95 Ultimate', 19.63, SHARED_INVOICE);
  // Four rows of the associate's account on it (80.00 L).
  for (let i = 0; i < 4; i += 1) sale(associate, at(2025, 3, 7 + i, 8, 0), 'Kurşunsuz 95 Benzin', 20, SHARED_INVOICE);
  // A period-shift row: 15 March, invoiced in the second half; `Dönem` reads like a date.
  sale(controlled, at(2025, 3, 15, 18, 0), 'Motorin Med', '1.168,00', 'OZK2025000012000', '2025-03-02');
  // A sale with no invoice number.
  sale(controlled, at(2025, 3, 18, 8, 0), 'Motorin Med', 12, null);
  // A `Satış ID` twice in the file.
  rows.push([...rows[rows.length - 1]!]);
  return rows;
}

// ── Tanker ──────────────────────────────────────────────────────────────────

export const TANKER_HEADER = ['SIRA', 'EVRAK NO', 'AÇIKLAMA', 'MİKTAR', 'BİRİM FİYAT', 'TUTAR', 'KDV'];
export const TANKER_DELIVERIES = 5;

function tankerRows(): Cell[][] {
  const deliveries: Array<[string, string, number]> = [
    ['000101', 'ÖRNEK DEPO A.Ş.', 10000],
    ['000102', 'ÖRNEK DEPO A.Ş.', 12500.5],
    ['000103', 'ÖRNEK ŞANTİYE LTD.', 8000],
    ['000104', 'ÖRNEK İŞTİRAK A.Ş.', 5000],
    ['000105', 'ÖRNEK ŞANTİYE LTD.', 7250.25],
  ];
  const total = deliveries.reduce((sum, [, , l]) => sum + l, 0);
  return [
    ['PETROL OFİSİ TANKER ALIMLARI (TEST)'],
    [],
    TANKER_HEADER,
    // The money columns' data sit one column right of their headers.
    ...deliveries.map(([doc, desc, litres], i): Cell[] => [i + 1, doc, desc, litres, null, litres * 40, litres * 40 * 0.2]),
    [null, null, 'TOPLAM', total, null, total * 40, total * 40 * 0.2],
  ];
}

export async function buildFuelFixtures(): Promise<Record<string, Buffer>> {
  const shell = shellRows();
  const po = petrolOfisiRows();
  const ambiguous = po.map((r, i) => (i === 0 ? [...r, 'Miktar'] : [...r, 1]));
  return {
    'shell-items.xlsx': await workbook([
      { name: 'Özet', rows: [['Bu sayfa okunmaz'], ['Toplam', 1]] },
      { name: 'items', rows: shell },
    ]),
    'shell-without-items.xlsx': await workbook([{ name: 'Sheet1', rows: shell }]),
    'petrol-ofisi-satislistesi.xlsx': await workbook([{ name: 'SatisListesi', rows: po }]),
    'petrol-ofisi-miktar-twice.xlsx': await workbook([{ name: 'SatisListesi', rows: ambiguous }]),
    'tanker-alimlari.xlsx': await workbook([{ name: 'Sayfa1', rows: tankerRows() }]),
  };
}

/** Writes the fixtures beside this script: `node apps/api/test/fixtures/fuel/generate.ts` (Node 22). */
export async function writeFuelFixtures(dir: string): Promise<string[]> {
  const files = await buildFuelFixtures();
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return Object.keys(files);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith(join('fixtures', 'fuel', 'generate.ts'))) {
  void writeFuelFixtures(dirname(entry)).then((names) => {
    process.stdout.write(`wrote ${names.length} fixtures to ${dirname(entry)}\n`);
  });
}
