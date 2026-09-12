import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import {
  cellToString,
  extensionOf,
  parseRows,
  strictNumber,
} from './parse-rows';

const HEADER =
  'subsidiaryId,locationId,reportingYear,reportingPeriod,periodValue,category,activityValue,activityUnit,varianceReason';
const ROW = 'sub-1,,2024,monthly,January,Electricity,1200,kWh,';

const csv = (...lines: string[]) => Buffer.from([HEADER, ...lines].join('\n'));

describe('strictNumber', () => {
  it.each([
    ['1200', 1200],
    ['1200.5', 1200.5],
    ['  42  ', 42],
    ['-5', -5],
    ['0', 0],
  ])('reads %s', (raw, expected) => {
    expect(strictNumber(raw)).toBe(expected);
  });

  it.each([
    // Each of these is a real import defect, not a pedantic refusal.
    ['', 'a blank consumption cell is a MISSING figure; 0 is a reported one'],
    ['   ', 'whitespace is the same missing figure'],
    ['1,200', 'ambiguous across locales — 1200 or 1.2? guessing misstates CO2e'],
    ['1.200,5', 'European decimal comma, same ambiguity'],
    ['1e3', 'exponent notation is not what a meter reading looks like'],
    ['=SUM(A1)', 'a formula fails as a TYPE — the cheapest formula defence'],
    ['12kWh', 'a unit glued to the figure belongs in activityUnit'],
    ['NaN', 'Number() would accept this'],
    ['Infinity', 'Number() would accept this too'],
    ['0x10', 'Number() reads this as 16'],
  ])('refuses %s', (raw) => {
    expect(strictNumber(raw)).toBeNull();
  });

  it('refuses what Number() would happily coerce', () => {
    // The point of the regex: `Number('')` is 0, `Number('  ')` is 0,
    // `Number('0x10')` is 16. A permissive parse here writes emissions
    // figures nobody typed.
    for (const raw of ['', '  ', '0x10', '\t']) {
      expect(Number(raw)).not.toBeNaN();
      expect(strictNumber(raw)).toBeNull();
    }
  });
});

describe('extensionOf', () => {
  it.each([
    ['data.csv', '.csv'],
    ['DATA.CSV', '.csv'],
    ['q1.2024.xlsx', '.xlsx'],
    ['no-extension', null],
  ])('%s', (name, expected) => {
    expect(extensionOf(name)).toBe(expected);
  });
});

describe('cellToString', () => {
  it('reads the shapes an exceljs cell actually takes', () => {
    expect(cellToString('January')).toBe('January');
    expect(cellToString(1200)).toBe('1200');
    expect(cellToString(null)).toBe('');
    expect(cellToString(undefined)).toBe('');
    // Rich text: a cell someone bolded half of. Reading `.value` naively
    // yields "[object Object]", which would then fail validation as a mystery.
    expect(
      cellToString({ richText: [{ text: 'Meter ' }, { text: 'replaced' }] }),
    ).toBe('Meter replaced');
    // A formula resolves to its cached result — refusing formulas would
    // reject the most ordinary spreadsheet there is, one with a SUM column.
    expect(cellToString({ formula: 'SUM(A1:A3)', result: 3600 })).toBe('3600');
    // A formula that evaluated to an error names what the user sees, so the
    // row is refused for the right reason rather than as an empty cell.
    expect(cellToString({ formula: 'A1/0', error: '#DIV/0!' })).toBe('#DIV/0!');
  });
});

describe('parseRows — CSV', () => {
  it('reads a plain file', async () => {
    const rows = await parseRows(csv(ROW), 'data.csv');
    expect(rows).toHaveLength(1);
    expect(rows[0].row).toBe(2);
    expect(rows[0].cells.subsidiaryId).toBe('sub-1');
    expect(rows[0].cells.periodValue).toBe('January');
    expect(rows[0].cells.locationId).toBe('');
  });

  it('numbers rows the way the user’s editor does', async () => {
    // Header is line 1, so the first data row is line 2 — that is what the
    // error list has to say, or the user hunts the wrong line.
    const rows = await parseRows(csv(ROW, ROW, ROW), 'data.csv');
    expect(rows.map((r) => r.row)).toEqual([2, 3, 4]);
  });

  it('accepts the BOM its own export writes', async () => {
    // Re-importing a file TonyAI generated is the first thing a user tries;
    // #91 made the CSV export lead with a BOM so Excel reads Turkish
    // characters. Measured honestly: deleting the `.replace` in `parseRows`
    // does NOT fail this, because `mapHeader` trims and
    // `String.prototype.trim()` already strips U+FEFF (this repo wrote that
    // down in `common/csv-cell.ts`). Kept as an end-to-end property of the
    // round trip — it is the header TRIM that is load-bearing, and removing
    // that fails 38 tests.
    const withBom = Buffer.concat([
      Buffer.from('\uFEFF', 'utf8'),
      csv(ROW),
    ]);
    const rows = await parseRows(withBom, 'export.csv');
    expect(rows).toHaveLength(1);
    expect(rows[0].cells.subsidiaryId).toBe('sub-1');
  });

  it('survives CRLF line endings', async () => {
    const buffer = Buffer.from([HEADER, ROW].join('\r\n'));
    const rows = await parseRows(buffer, 'windows.csv');
    expect(rows).toHaveLength(1);
    // A stray \r on the last cell would be stored inside the variance reason.
    expect(rows[0].cells.activityUnit).toBe('kWh');
  });

  it('keeps a quoted comma inside one cell', async () => {
    const rows = await parseRows(
      csv('sub-1,,2024,monthly,January,Electricity,1200,kWh,"Meter replaced, twice"'),
      'data.csv',
    );
    expect(rows[0].cells.varianceReason).toBe('Meter replaced, twice');
  });

  it('ignores blank lines rather than refusing the file over one', async () => {
    // Every CSV writer ends with a newline.
    const rows = await parseRows(csv(ROW, '', ROW, ''), 'data.csv');
    expect(rows).toHaveLength(2);
  });

  it('matches headers regardless of case and surrounding space', async () => {
    const header =
      ' SubsidiaryID , locationId ,REPORTINGYEAR,reportingPeriod,periodValue,category,activityValue,activityUnit,varianceReason';
    const rows = await parseRows(Buffer.from([header, ROW].join('\n')), 'x.csv');
    expect(rows[0].cells.reportingYear).toBe('2024');
  });

  it('reads columns by NAME, not by position', async () => {
    // A user reorders columns in Excel all the time. Reading by position
    // would import the unit as the category with the suite none the wiser.
    const header =
      'category,subsidiaryId,activityUnit,activityValue,reportingYear,reportingPeriod,periodValue,locationId,varianceReason';
    const row = 'Electricity,sub-1,kWh,1200,2024,monthly,January,,';
    const rows = await parseRows(Buffer.from([header, row].join('\n')), 'x.csv');
    expect(rows[0].cells.category).toBe('Electricity');
    expect(rows[0].cells.activityUnit).toBe('kWh');
    expect(rows[0].cells.activityValue).toBe('1200');
  });

  it('refuses an unrecognised column instead of dropping it', async () => {
    // Dropping it would import every row with a missing value and look like a
    // data problem rather than a header problem.
    const header = `${HEADER},tco2e`;
    await expect(
      parseRows(Buffer.from([header, `${ROW},99`].join('\n')), 'x.csv'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a missing required column, naming it', async () => {
    const header = HEADER.replace(',activityValue', '');
    await expect(
      parseRows(Buffer.from([header].join('\n')), 'x.csv'),
    ).rejects.toThrow(/activityValue/);
  });

  it('refuses a duplicated column rather than picking one', async () => {
    const header = `${HEADER},category`;
    await expect(
      parseRows(Buffer.from([header, `${ROW},Fuel`].join('\n')), 'x.csv'),
    ).rejects.toThrow(/more than once/);
  });

  it('refuses an unknown extension', async () => {
    await expect(parseRows(csv(ROW), 'data.txt')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('parseRows — XLSX', () => {
  async function workbookBuffer(
    rows: (string | number)[][],
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Data');
    rows.forEach((r) => sheet.addRow(r));
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  it('reads a real workbook, numbers and all', async () => {
    const buffer = await workbookBuffer([
      HEADER.split(','),
      ['sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', ''],
    ]);
    const rows = await parseRows(buffer, 'data.xlsx');
    expect(rows).toHaveLength(1);
    // The cells are numbers in the sheet; they must arrive as strings so the
    // strict parse — not exceljs — decides what is a number.
    expect(rows[0].cells.activityValue).toBe('1200');
    expect(rows[0].cells.reportingYear).toBe('2024');
    expect(rows[0].row).toBe(2);
  });

  it('refuses a workbook whose header is wrong', async () => {
    const buffer = await workbookBuffer([['nope'], ['sub-1']]);
    await expect(parseRows(buffer, 'data.xlsx')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a file that is not a workbook at all', async () => {
    await expect(
      parseRows(Buffer.from('not a zip'), 'data.xlsx'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('parseRows — the row cap belongs to the parser', () => {
  it('refuses a file over the cap during parsing, not after', async () => {
    // The service's cap runs AFTER this function returns, so a parser that
    // builds the whole table first has already paid the cost.
    const rows = Array.from({ length: 1001 }, () => ROW);
    await expect(parseRows(csv(...rows), 'big.csv')).rejects.toThrow(
      /limit is 1000/,
    );
    // 1,000 is fine — the boundary, not an approximation of it.
    const ok = Array.from({ length: 1000 }, (_, i) =>
      ROW.replace(',2024,', `,${2000 + (i % 100)},`),
    );
    await expect(parseRows(csv(...ok), 'big.csv')).resolves.toHaveLength(1000);
  });
});

describe('parseRows — XLSX, the dangerous format', () => {
  async function workbook(
    build: (sheet: ExcelJS.Worksheet) => void,
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Data');
    build(sheet);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('reads columns by NAME when the user has reordered them', async () => {
    // The CSV path had this test; the XLSX path did not — and XLSX is the
    // format where reordering a column is a drag-and-drop. Reading by
    // position imports the unit as the category with the suite none the wiser.
    const buffer = await workbook((sheet) => {
      sheet.addRow([
        'category',
        'subsidiaryId',
        'activityUnit',
        'activityValue',
        'reportingYear',
        'reportingPeriod',
        'periodValue',
        'locationId',
        'varianceReason',
      ]);
      sheet.addRow([
        'Electricity',
        'sub-1',
        'kWh',
        1200,
        2024,
        'monthly',
        'January',
        '',
        '',
      ]);
    });

    const rows = await parseRows(buffer, 'reordered.xlsx');

    expect(rows[0].cells.category).toBe('Electricity');
    expect(rows[0].cells.activityUnit).toBe('kWh');
    expect(rows[0].cells.activityValue).toBe('1200');
  });

  it('reads a formula cell’s cached result end to end', async () => {
    const buffer = await workbook((sheet) => {
      sheet.addRow(HEADER.split(','));
      const row = sheet.addRow([
        'sub-1',
        '',
        2024,
        'monthly',
        'January',
        'Electricity',
        0,
        'kWh',
        '',
      ]);
      row.getCell(7).value = { formula: 'SUM(1,2)', result: 3600 } as never;
    });

    const rows = await parseRows(buffer, 'formula.xlsx');

    // Refusing formulas would reject the most ordinary spreadsheet there is.
    expect(rows[0].cells.activityValue).toBe('3600');
  });

  it('survives a workbook whose only data row sits at the bottom of the sheet', async () => {
    // The CRITICAL one. `sheet.rowCount` is the highest row INDEX, and
    // `getRow(r)` MATERIALISES a row — so walking `2..rowCount` over a 6.6 KB
    // file with one row at 1,048,576 allocated ~9.4M objects and killed the
    // process with a V8 FATAL heap error in 1.7s. Not catchable: no
    // exception, no filter, no audit row — the replica dies and takes every
    // other tenant's in-flight request with it.
    //
    // Excel's real maximum row, because that is the file this defends
    // against and because a smaller number does not kill the mutant: at
    // 200,000 the old index-walking loop finished in 469ms and the test
    // passed, proving nothing.
    const FAR = 1_048_576;
    const buffer = await workbook((sheet) => {
      sheet.addRow(HEADER.split(','));
      sheet.getRow(FAR).values = [
        'sub-1',
        '',
        2024,
        'monthly',
        'January',
        'Electricity',
        1200,
        'kWh',
        '',
      ];
    });

    // HEAP, not elapsed time. Both were measured against this exact file:
    // `eachRow` visits 1 row for ~0 MB, the index walk visits 1,048,575 for
    // **2,348 MB**. Timing does not separate them reliably — the old loop
    // finished in 2.6s here, inside any budget loose enough to be safe on a
    // slow CI runner — so a time assertion let the regression through when I
    // tried it. The allocation is the defect, so the allocation is the assert.
    const before = process.memoryUsage().heapUsed;
    const rows = await parseRows(buffer, 'sparse.xlsx');
    const grewMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

    expect(rows).toHaveLength(1);
    expect(rows[0].row).toBe(FAR);
    expect(rows[0].cells.activityValue).toBe('1200');
    expect(grewMb).toBeLessThan(200);
  });

  it('counts populated rows, not the sheet’s height, against the cap', async () => {
    const buffer = await workbook((sheet) => {
      sheet.addRow(HEADER.split(','));
      for (let i = 0; i < 1001; i += 1) {
        sheet.addRow([
          'sub-1',
          '',
          2000 + (i % 100),
          'monthly',
          'January',
          'Electricity',
          1200,
          'kWh',
          '',
        ]);
      }
    });

    await expect(parseRows(buffer, 'big.xlsx')).rejects.toThrow(/limit is 1000/);
  });

  it('reads a rich-text hyperlink cell rather than dropping the text', async () => {
    // `{ text: { richText: [...] }, hyperlink }` fell through to '' — silently
    // losing whatever the user had written in that cell.
    expect(
      cellToString({
        text: { richText: [{ text: 'Meter ' }, { text: 'replaced' }] },
        hyperlink: 'https://example.com',
      }),
    ).toBe('Meter replaced');
  });
});

describe('parseRows — only the first worksheet is data', () => {
  it('refuses a workbook whose header is on sheet 2', async () => {
    // The guarantee the template depends on, pinned where the code that
    // implements it lives. Every other XLSX fixture here is single-sheet, so
    // changing `worksheets[0]` to `worksheets[1] ?? worksheets[0]` left all
    // 42 of them green while breaking the template contract.
    const wb = new ExcelJS.Workbook();
    const notes = wb.addWorksheet('Notes');
    notes.addRow(['These are notes, not columns']);
    const data = wb.addWorksheet('Records');
    data.addRow(HEADER.split(','));
    data.addRow([
      'sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', '',
    ]);

    await expect(
      parseRows(Buffer.from(await wb.xlsx.writeBuffer()), 'two-sheets.xlsx'),
    ).rejects.toThrow(/column/i);
  });
});

