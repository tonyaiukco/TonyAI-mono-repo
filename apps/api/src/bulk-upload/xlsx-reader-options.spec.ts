import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { columnLetters, xlsx } from '../../test/xlsx';
import {
  SHEET_MISSING,
  readFirstWorksheet,
  readWorksheet,
  type SheetCell,
  type WorksheetReadOptions,
} from './xlsx-reader';

/**
 * The reader's options a fuel file reads with (inc28-fuel-bulk D4, task 4.1):
 * a sheet by name, a cell's kind beside its text, inflation off the event loop
 * and a sheet read in short slices. `xlsx-reader.spec.ts` holds the template
 * import's reading, which passes none of them.
 */

const FIXTURES = join(__dirname, '../../test/fixtures/fuel');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

async function cellsOf(buffer: Buffer, options: WorksheetReadOptions = {}) {
  const cells: Record<string, SheetCell> = {};
  await readWorksheet(
    buffer,
    {
      row(rowNumber, row) {
        for (const cell of row) cells[`${columnLetters(cell.column)}${rowNumber}`] = cell;
      },
      merge() {},
    },
    options,
  );
  return cells;
}

async function refusalOf(promise: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BadRequestException);
  const body = (error as BadRequestException).getResponse() as { code?: unknown; message?: string };
  return { code: body.code, message: (error as Error).message };
}

describe('readWorksheet — a sheet by name', () => {
  it('reads the named sheet, not the first one, whatever the case of its name', async () => {
    for (const sheetName of ['items', 'ITEMS', 'Items']) {
      const cells = await cellsOf(fixture('shell-items.xlsx'), { sheetName });
      expect(cells.A1?.value).toBe('Müşteri Kodu');
      expect(Object.values(cells).some((cell) => cell.value === 'Bu sayfa okunmaz')).toBe(false);
    }
  });

  it('reads the first sheet without a name, as the template import does', async () => {
    const cells = await cellsOf(fixture('shell-items.xlsx'));
    expect(cells.A1?.value).toBe('Bu sayfa okunmaz');
  });

  it('refuses a workbook without the named sheet, saying so', async () => {
    const refusal = await refusalOf(cellsOf(fixture('shell-without-items.xlsx'), { sheetName: 'items' }));
    expect(refusal).toEqual({ code: 'fuel_file_sheet_missing', message: SHEET_MISSING('items') });
  });
});

describe('readWorksheet — a cell kind beside its text', () => {
  const styles =
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy hh:mm"/></numFmts><cellXfs count="2"><xf/><xf numFmtId="164"/></cellXfs>';
  const sheet = (workbookPr?: string) =>
    xlsx({
      styles,
      sharedStrings: ['<t>1.168,00</t>'],
      ...(workbookPr ? { workbookPr } : {}),
      sheetData:
        '<row r="1">' +
        '<c r="A1"><v>31.86</v></c>' +
        '<c r="B1" t="s"><v>0</v></c>' +
        '<c r="C1" t="inlineStr"><is><t>0071234</t></is></c>' +
        '<c r="D1" s="1"><v>45747.993055555555</v></c>' +
        '<c r="E1" t="d"><v>2025-03-31T23:50:00</v></c>' +
        '<c r="F1" t="b"><v>1</v></c>' +
        '<c r="G1" t="e"><v>#REF!</v></c>' +
        '<c r="H1" t="str"><f>A1&amp;""</f><v>31.86</v></c>' +
        '</row>',
    });

  it('names a number, a date-time, text, a boolean and an error, the text as before', async () => {
    const cells = await cellsOf(sheet());
    expect(
      Object.fromEntries(Object.entries(cells).map(([ref, cell]) => [ref, [cell.kind, cell.value]])),
    ).toEqual({
      A1: ['number', '31.86'],
      B1: ['text', '1.168,00'],
      C1: ['text', '0071234'],
      // 31 March 2025 23:50 as the file writes it: the timestamp's own fields, no zone shift.
      D1: ['date', '2025-03-31T23:50:00.000Z'],
      E1: ['date', '2025-03-31T23:50:00.000Z'],
      F1: ['boolean', 'true'],
      G1: ['error', '#REF!'],
      // A formula's text result is text, even when it reads like a number.
      H1: ['text', '31.86'],
    });
  });

  it('reads a date serial in the 1904 date system as a date of that system', async () => {
    const cells = await cellsOf(sheet('date1904="1"'));
    expect(cells.D1).toEqual({ column: 4, value: '2029-04-01T23:50:00.000Z', kind: 'date' });
  });

  it('gives the template reader the same values it read before the kind was added', async () => {
    const values: string[] = [];
    await readFirstWorksheet(sheet(), {
      row(_n, row) {
        values.push(...row.map((cell) => cell.value));
      },
      merge() {},
    });
    expect(values).toEqual([
      '31.86',
      '1.168,00',
      '0071234',
      '2025-03-31T23:50:00.000Z',
      '2025-03-31T23:50:00.000Z',
      'true',
      '#REF!',
      '31.86',
    ]);
  });
});

describe('readWorksheet — a large member off the event loop', () => {
  it('reads a sheet of tens of megabytes while a timer keeps firing', async () => {
    const rows: string[] = [];
    for (let r = 1; r <= 150_000; r += 1) {
      rows.push(
        `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>PO-${String(r % 997).padStart(4, '0')}</t></is></c>` +
          `<c r="B${r}"><v>${(r % 500) + 0.25}</v></c><c r="C${r}" t="inlineStr"><is><t>Motorin Med ${r}</t></is></c></row>`,
      );
    }
    const workbook = xlsx({ sheetData: rows.join('') });

    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(performance.now()), 5);
    const started = performance.now();
    let read = 0;
    try {
      await readWorksheet(
        workbook,
        {
          row() {
            read += 1;
          },
          merge() {},
        },
        { asyncInflate: true, sliceBytes: 64 * 1024, maxUnpackedBytes: 64 * 1024 * 1024 },
      );
    } finally {
      clearInterval(timer);
    }
    const ended = performance.now();

    expect(read).toBe(150_000);
    // The timer fired throughout: no gap between its ticks — nor before the
    // first and after the last — came near the whole read.
    const marks = [started, ...ticks, ended];
    const gaps = marks.slice(1).map((mark, i) => mark - marks[i]!);
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...gaps)).toBeLessThan(Math.max(250, (ended - started) / 4));
  }, 60_000);

  it('holds the unpack budget it is given', async () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`);
    const refusal = await refusalOf(
      cellsOf(xlsx({ sheetData: rows.join('') }), { asyncInflate: true, maxUnpackedBytes: 16 * 1024 }),
    );
    expect(refusal.code).toBe('bulk_workbook_too_large');
  });
});
