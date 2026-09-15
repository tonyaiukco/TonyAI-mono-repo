import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { BULK_UPLOAD_MAX_SIZE_BYTES } from '@tonyai/shared-types';
import {
  OFFICE_RELATIONSHIPS,
  PACKAGE_RELATIONSHIPS,
  SPREADSHEETML,
  row as xmlRow,
  xlsx,
} from '../../test/xlsx';
import { extensionOf, parseRows, strictNumber } from './parse-rows';
import { XLSX_MAX_UNPACKED_BYTES } from './xlsx-reader';

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

describe('parseRows — XLSX cell values, as a real writer saves them', () => {
  // exceljs's WRITER, deliberately: it no longer does the reading, and its
  // output is the shape a user's file actually arrives in.
  const BASE: ExcelJS.CellValue[] = [
    'sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', '',
  ];

  async function cellsWith(index: number, value: ExcelJS.CellValue) {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Data');
    sheet.addRow(HEADER.split(','));
    sheet.addRow(BASE.map((cell, i) => (i === index ? value : cell)));
    const rows = await parseRows(Buffer.from(await wb.xlsx.writeBuffer()), 'values.xlsx');
    return rows[0].cells;
  }

  it('reads rich text as its text — a cell someone bolded half of', async () => {
    const cells = await cellsWith(8, {
      richText: [{ text: 'Meter ' }, { font: { bold: true }, text: 'replaced' }],
    });
    expect(cells.varianceReason).toBe('Meter replaced');
  });

  it('reads a formula as its cached result, and an error result as the error', async () => {
    // Refusing formulas would reject the most ordinary spreadsheet there is.
    expect((await cellsWith(6, { formula: 'SUM(A1:A3)', result: 3600 })).activityValue).toBe('3600');
    // Refused later naming what the user sees, rather than as an empty cell.
    expect(
      (await cellsWith(6, { formula: 'A1/0', result: { error: '#DIV/0!' } })).activityValue,
    ).toBe('#DIV/0!');
  });

  it('reads a hyperlink cell as the text it shows, and a boolean as true or false', async () => {
    expect(
      (await cellsWith(8, { text: 'Meter replaced', hyperlink: 'https://example.com' }))
        .varianceReason,
    ).toBe('Meter replaced');
    expect((await cellsWith(8, true)).varianceReason).toBe('true');
  });

  it('reads a date as a timestamp, which the numeric columns then refuse', async () => {
    const cells = await cellsWith(6, new Date(Date.UTC(2026, 2, 4)));
    expect(cells.activityValue).toBe('2026-03-04T00:00:00.000Z');
    expect(strictNumber(cells.activityValue)).toBeNull();
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

  it('bounds the header text it echoes back', async () => {
    // The sentence reaches the response and the audit row's `reason`; a 2 MiB
    // header row used to be stored there whole.
    const header = `${HEADER},${'x'.repeat(100)},b,c,d,e,f,g`;
    const error = await parseRows(Buffer.from([header, ROW].join('\n')), 'x.csv').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(
      `Unrecognised column(s): ${'x'.repeat(40)}…, b, c, d, e (+2 more). Expected: ${HEADER.split(',').join(', ')}.`,
    );
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

  // A blank header cell between activityUnit (8) and varianceReason (now 10).
  const GAPPED = HEADER.replace(',varianceReason', ',,varianceReason');

  it('keeps every column in place when a header cell is blank', async () => {
    // Cells are read by position. A compacted header shifted everything after
    // a blank cell one place left: the unlabelled column's text was stored as
    // the variance reason and the real reason was dropped, with no error.
    const rows = await parseRows(
      Buffer.from(
        [GAPPED, 'sub-1,,2024,monthly,January,Electricity,1200,kWh,,Meter replaced'].join('\n'),
      ),
      'x.csv',
    );
    expect(rows[0].cells.activityUnit).toBe('kWh');
    expect(rows[0].cells.varianceReason).toBe('Meter replaced');
  });

  // The class as well as the words: `toThrow(message)` compares messages only,
  // and a plain Error here would reach the caller as a 500.
  const csvRefusal = async (buffer: Buffer) => {
    const error = await parseRows(buffer, 'x.csv').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as Error).message;
  };

  it('refuses a value under a blank header rather than dropping it', async () => {
    expect(
      await csvRefusal(
        Buffer.from(
          [GAPPED, 'sub-1,,2024,monthly,January,Electricity,1200,kWh,stray note,Meter replaced'].join(
            '\n',
          ),
        ),
      ),
    ).toBe('Row 2 has a value in column 9, which has no header. Name the column or clear it.');
  });

  it('refuses a value past the last header, and ignores empty or whitespace trailing cells', async () => {
    await expect(parseRows(csv(`${ROW},,,`), 'x.csv')).resolves.toHaveLength(1);
    // A hand-edited file often ends its rows ", " — that is not a value.
    const tab = String.fromCharCode(9);
    await expect(parseRows(csv(`${ROW}, ,${tab}`), 'x.csv')).resolves.toHaveLength(1);
    expect(await csvRefusal(csv(`${ROW},stray`))).toBe(
      'Row 2 has a value in column 10, which has no header. Name the column or clear it.',
    );
  });

  it('refuses a row whose only value has no header, rather than skipping it as blank', async () => {
    expect(await csvRefusal(csv(ROW, ',,,,,,,,,note'))).toBe(
      'Row 3 has a value in column 10, which has no header. Name the column or clear it.',
    );
  });

  it('returns nothing for a file of blank lines rather than refusing it as too long', async () => {
    // Correctness only — the cost is not asserted here, because a timing test
    // is the observable this repo has already learned not to trust. The
    // service refuses the result as "no data rows".
    const newlines = Buffer.from(`${HEADER}${'\n'.repeat(200_000)}`);
    await expect(parseRows(newlines, 'blank.csv')).resolves.toEqual([]);
  });

  it('refuses an unknown extension', async () => {
    await expect(parseRows(csv(ROW), 'data.txt')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('parseRows — XLSX', () => {
  async function workbookBuffer(
    rows: (string | number | null)[][],
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

  it('keeps every column in place when a header cell is blank', async () => {
    // `null`, not `''`: a cleared cell is ABSENT from the sheet XML, which is
    // what Excel saves. `''` is a real cell, and it hid a refactor that
    // crashed on the hole.
    const buffer = await workbookBuffer([
      [...HEADER.split(',').slice(0, 8), null, 'varianceReason'],
      ['sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', null, 'Meter replaced'],
    ]);
    const rows = await parseRows(buffer, 'data.xlsx');
    expect(rows[0].cells.activityUnit).toBe('kWh');
    expect(rows[0].cells.varianceReason).toBe('Meter replaced');
  });

  // The class as well as the words: `toThrow(message)` compares messages only,
  // and a plain Error here would reach the caller as a 500.
  const refusal = async (buffer: Buffer) => {
    const error = await parseRows(buffer, 'data.xlsx').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as Error).message;
  };

  it('refuses a value under a blank header, or past the last one', async () => {
    const gapped = await workbookBuffer([
      [...HEADER.split(',').slice(0, 8), '', 'varianceReason'],
      ['sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', 'stray', 'Meter replaced'],
    ]);
    expect(await refusal(gapped)).toBe(
      'Row 2 has a value in column 9, which has no header. Name the column or clear it.',
    );
    const wide = await workbookBuffer([
      HEADER.split(','),
      ['sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', '', 'stray'],
    ]);
    expect(await refusal(wide)).toBe(
      'Row 2 has a value in column 10, which has no header. Name the column or clear it.',
    );
  });

  it('names the first value in a row that no header names, not the last', async () => {
    const buffer = await workbookBuffer([
      HEADER.split(','),
      ['sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', '', 'first', 'second'],
    ]);
    expect(await refusal(buffer)).toBe(
      'Row 2 has a value in column 10, which has no header. Name the column or clear it.',
    );
  });

  it('refuses a row whose only value has no header, rather than skipping it as blank', async () => {
    const buffer = await workbookBuffer([
      HEADER.split(','),
      ['sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', ''],
      [null, null, null, null, null, null, null, null, null, 'note'],
    ]);
    expect(await refusal(buffer)).toBe(
      'Row 3 has a value in column 10, which has no header. Name the column or clear it.',
    );
  });

  it('ignores a whitespace-only cell past the last header', async () => {
    const buffer = await workbookBuffer([
      HEADER.split(','),
      ['sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', '', ' '],
    ]);
    await expect(parseRows(buffer, 'data.xlsx')).resolves.toHaveLength(1);
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

  const thousand = () =>
    Array.from({ length: 1000 }, (_, i) => ROW.replace(',2024,', `,${2000 + (i % 100)},`));

  it('counts rows, not lines — a file ending in a newline is not one row longer', async () => {
    // Every CSV writer ends a file with a newline, and papaparse returns it as
    // one more, empty, row. Counting lines refused exactly 1,000 rows saved
    // from Excel as "1001 rows" — at the one size the cap advertises.
    const lf = Buffer.from(`${[HEADER, ...thousand()].join('\n')}\n`);
    await expect(parseRows(lf, 'big.csv')).resolves.toHaveLength(1000);

    // What Excel's "CSV UTF-8" writes: a BOM, CRLF, and a trailing CRLF.
    const excel = Buffer.from(`\uFEFF${[HEADER, ...thousand()].join('\r\n')}\r\n`);
    await expect(parseRows(excel, 'big.csv')).resolves.toHaveLength(1000);
  });

  it('does not let blank lines count towards the cap', async () => {
    const spaced = csv(...thousand().flatMap((line) => [line, '', ' , , ']));
    await expect(parseRows(spaced, 'big.csv')).resolves.toHaveLength(1000);
  });

  it('still refuses one populated row over, naming the real count', async () => {
    const over = Array.from({ length: 1001 }, () => ROW);
    const trailing = Buffer.from(`${[HEADER, ...over].join('\n')}\n\n`);
    await expect(parseRows(trailing, 'big.csv')).rejects.toThrow(
      'The file has 1001 rows; the limit is 1000. Split it and upload the parts.',
    );
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
    // A link whose text is formatted read as '' once — silently losing
    // whatever the user had written in that cell.
    const buffer = await workbook((sheet) => {
      sheet.addRow(HEADER.split(','));
      const row = sheet.addRow([
        'sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', '',
      ]);
      row.getCell(9).value = {
        text: { richText: [{ text: 'Meter ' }, { text: 'replaced' }] },
        hyperlink: 'https://example.com',
      } as never;
    });

    const rows = await parseRows(buffer, 'link.xlsx');

    expect(rows[0].cells.varianceReason).toBe('Meter replaced');
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

const MIB = 1024 * 1024;
const HEADER_ROW = xmlRow(1, HEADER.split(','));
const dataRow = (n: number, locationId: string | null = null) =>
  xmlRow(n, ['sub-1', locationId, 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', null]);

describe('parseRows — a hostile workbook costs nothing', () => {
  /**
   * Heap, not time, for the reason the far-row test gives: the defect is
   * allocation. exceljs's loader died on every one of these files under a
   * 256 MB heap (measured), so none of them can run against it here — a
   * regression takes the test process down, which fails the suite just the
   * same.
   */
  async function parsedCheaply(buffer: Buffer) {
    const before = process.memoryUsage().heapUsed;
    const rows = await parseRows(buffer, 'hostile.xlsx');
    const grewMb = (process.memoryUsage().heapUsed - before) / MIB;
    expect(grewMb).toBeLessThan(50);
    return rows;
  }

  it.each([
    [
      'a data validation over the whole sheet',
      { afterSheetData: '<dataValidations count="1"><dataValidation type="list" sqref="A1:XFD1048576"><formula1>"a,b"</formula1></dataValidation></dataValidations>' },
    ],
    [
      'a dropdown on a whole column — "select the column, add a list"',
      { afterSheetData: '<dataValidations count="1"><dataValidation type="list" sqref="D1:D1048576"><formula1>"monthly,quarterly"</formula1></dataValidation></dataValidations>' },
    ],
    [
      'a merge to the end of the sheet, clear of the data',
      { afterSheetData: '<mergeCells count="1"><mergeCell ref="K4:XFD1048576"/></mergeCells>' },
    ],
    [
      'a defined name over the whole sheet',
      { afterSheets: '<definedNames><definedName name="Everything">Records!$A$1:$XFD$1048576</definedName></definedNames>' },
    ],
    [
      'a column span to the last column',
      { beforeSheetData: '<cols><col min="1" max="16384" width="12" customWidth="1"/></cols>' },
    ],
  ])('reads the rows of a workbook with %s', async (_case, extra) => {
    const rows = await parsedCheaply(
      xlsx({ sheetData: HEADER_ROW + dataRow(2) + dataRow(3), ...extra }),
    );
    expect(rows.map((r) => r.row)).toEqual([2, 3]);
    expect(rows[1].cells.activityValue).toBe('1200');
  });

  it('refuses a sheet that unpacks past the limit — a zip bomb', async () => {
    const bomb = xlsx({ sheetData: HEADER_ROW + ' '.repeat(XLSX_MAX_UNPACKED_BYTES) });
    expect(bomb.length).toBeLessThan(BULK_UPLOAD_MAX_SIZE_BYTES);
    await expect(parseRows(bomb, 'bomb.xlsx')).rejects.toThrow(
      'The workbook is larger than 16 MB once unpacked. Remove unused formatting, or split it into smaller files.',
    );
  });

  it('counts every part it unpacks against one limit', async () => {
    // Shared strings (10 MB) and the sheet (7 MB) each fit; together they do not.
    const buffer = xlsx({
      sharedStrings: [' '.repeat(10 * MIB)],
      sheetData: HEADER_ROW + dataRow(2) + ' '.repeat(7 * MIB),
    });
    await expect(parseRows(buffer, 'split-bomb.xlsx')).rejects.toThrow(
      /larger than 16 MB once unpacked/,
    );
  });

  it('never unpacks a part the first sheet does not need', async () => {
    const rows = await parsedCheaply(
      xlsx({
        sheetData: HEADER_ROW + dataRow(2),
        extraParts: [
          { name: 'xl/worksheets/sheet2.xml', data: Buffer.alloc(24 * MIB, 0x20) },
          { name: 'docProps/thumbnail.jpeg', data: Buffer.alloc(24 * MIB, 0x00) },
        ],
      }),
    );
    expect(rows).toHaveLength(1);
  });

  it('never unpacks a sheet the workbook lists after the first', async () => {
    // Listed and related this time, not merely present in the archive: a
    // reader that opened every sheet the workbook names would spend the whole
    // budget on the second one.
    const rows = await parsedCheaply(
      xlsx({
        sheetData: HEADER_ROW + dataRow(2),
        workbookXml: `<workbook xmlns="${SPREADSHEETML}" xmlns:r="${OFFICE_RELATIONSHIPS}"><sheets><sheet name="Records" sheetId="1" r:id="rId1"/><sheet name="Big" sheetId="2" r:id="rId9"/></sheets></workbook>`,
        workbookRelsXml: `<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="${OFFICE_RELATIONSHIPS}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
        extraParts: [{ name: 'xl/worksheets/sheet2.xml', data: Buffer.alloc(24 * MIB, 0x20) }],
      }),
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a date no calendar can hold as a 400, not a 500', async () => {
    const buffer = xlsx({
      styles: '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>',
      sheetData: `${HEADER_ROW}<row r="2"><c r="A2" t="inlineStr"><is><t>sub-1</t></is></c><c r="G2" s="1"><v>1e12</v></c></row>`,
    });
    const error = await parseRows(buffer, 'date.xlsx').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(
      "Row 2 has a date in column 7 that is out of range. Check the cell's value and its format.",
    );
  });
});

describe('parseRows — merged cells', () => {
  const merged = (...refs: string[]) =>
    `<mergeCells count="${refs.length}">${refs.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`;

  it('refuses a merge that covers an imported cell of a kept row, naming the row and column', async () => {
    // B2:B3: row 3 SHOWS row 2's site on screen and holds none in the file.
    // The old loader copied "loc-1" down; a reader that ignores merges would
    // import row 3 as whole-company.
    const buffer = xlsx({
      sheetData: HEADER_ROW + dataRow(2, 'loc-1') + dataRow(3),
      afterSheetData: merged('B2:B3'),
    });
    const error = await parseRows(buffer, 'merged.xlsx').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(
      'Row 3 is inside the merged cells B2:B3, which cover its locationId cell. Unmerge the cells and fill in each row.',
    );
  });

  it('refuses a merge across two imported columns of one row', async () => {
    const buffer = xlsx({ sheetData: HEADER_ROW + dataRow(2), afterSheetData: merged('G2:H2') });
    await expect(parseRows(buffer, 'merged.xlsx')).rejects.toThrow(
      'Row 2 is inside the merged cells G2:H2, which cover its activityUnit cell.',
    );
  });

  it('refuses a merge over the header of an imported column', async () => {
    const buffer = xlsx({ sheetData: HEADER_ROW + dataRow(2), afterSheetData: merged('A1:B1') });
    await expect(parseRows(buffer, 'merged.xlsx')).rejects.toThrow(
      'Row 1 is inside the merged cells A1:B1, which cover its locationId cell.',
    );
  });

  it('lets through merges that cover nothing the import reads', async () => {
    const buffer = xlsx({
      sheetData: HEADER_ROW + dataRow(2, 'loc-1') + dataRow(5, 'loc-1'),
      // I2:K2 widens the last column into unimported ones; A3:I4 covers two
      // blank rows; M1:N9 sits off to the side.
      afterSheetData: merged('I2:K2', 'A3:I4', 'M1:N9'),
    });
    const rows = await parseRows(buffer, 'merged.xlsx');
    expect(rows.map((r) => r.row)).toEqual([2, 5]);
  });

  it('leaves the row cap to speak first for a file over it', async () => {
    const over = Array.from({ length: 1001 }, (_, i) => dataRow(i + 2)).join('');
    const buffer = xlsx({ sheetData: HEADER_ROW + over, afterSheetData: merged('B2:B3') });
    await expect(parseRows(buffer, 'big.xlsx')).rejects.toThrow(
      'The file has 1001 rows; the limit is 1000. Split it and upload the parts.',
    );
  });

  it('names the real count of a file over the cap, not the first row over', async () => {
    const over = Array.from({ length: 1005 }, (_, i) => dataRow(i + 2)).join('');
    await expect(parseRows(xlsx({ sheetData: HEADER_ROW + over }), 'big.xlsx')).rejects.toThrow(
      'The file has 1005 rows; the limit is 1000.',
    );
  });

  it('never walks a merged range row by row', async () => {
    // A hundred merges down to Excel's last row, over blank rows of imported
    // columns: walked row by row they took 3.2 s (qa-auditor, measured); found
    // by binary search, no time at all. Time is the defect, so it is asserted.
    const buffer = xlsx({
      sheetData: HEADER_ROW + dataRow(2),
      afterSheetData: merged(...Array.from({ length: 100 }, () => 'A3:I1048576')),
    });
    const started = performance.now();
    await expect(parseRows(buffer, 'merged.xlsx')).resolves.toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('leaves a sheet with merges and no rows to the header refusal', async () => {
    await expect(
      parseRows(xlsx({ afterSheetData: merged('A1:B2') }), 'empty.xlsx'),
    ).rejects.toThrow(/Missing required column/);
  });

  it('does not count whitespace-only rows towards the cap', async () => {
    const thousand = Array.from({ length: 1000 }, (_, i) => dataRow(i + 2)).join('');
    const buffer = xlsx({ sheetData: HEADER_ROW + thousand + xmlRow(1002, [' ', ' ']) });
    await expect(parseRows(buffer, 'spaced.xlsx')).resolves.toHaveLength(1000);
  });
});

