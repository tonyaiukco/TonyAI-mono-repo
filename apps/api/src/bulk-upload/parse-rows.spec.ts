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
import { isUtf8 } from 'node:buffer';
import { extensionOf, FILE_NOT_UTF8, parseRows, strictNumber } from './parse-rows';
import { WORKBOOK_NOT_UTF8, XLSX_MAX_UNPACKED_BYTES } from './xlsx-reader';

const HEADER =
  'subsidiaryId,locationId,reportingYear,reportingPeriod,periodValue,category,activityValue,activityUnit,varianceReason';
const ROW = 'sub-1,,2024,monthly,January,Electricity,1200,kWh,';

const csv = (...lines: string[]) => Buffer.from([HEADER, ...lines].join('\n'));

// Built from code points so this file never holds the characters themselves:
// a literal one is invisible in review, and a NUL can make git treat the file
// as binary.
const NUL = String.fromCharCode(0x0000);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const INVISIBLE_SEPARATOR = String.fromCharCode(0x2063);
const ZWJ = String.fromCharCode(0x200d);

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

  // cp1254 (Windows-1254) is what Excel's plain "CSV" export writes on a
  // Turkish Windows, so this is the likely file rather than the exotic one.
  // BYTE literals, because the encoding is the whole point: a source string
  // would already be UTF-8 by the time it reached the parser.
  const CP1254 = Buffer.from([0xd6, 0x6c, 0xe7, 0xfc, 0x6d]); // "Olcum" in cp1254

  it('refuses a CSV whose bytes are not UTF-8', async () => {
    const file = Buffer.concat([csv(ROW), CP1254]);
    await expect(parseRows(file, 'rapor.csv')).rejects.toThrow(BadRequestException);
    await expect(parseRows(file, 'rapor.csv')).rejects.toThrow(FILE_NOT_UTF8);
  });

  it('refuses the file the offending byte is in, not the row', async () => {
    // An encoding is a property of the FILE. Importing 499 good rows and
    // refusing one would leave the user to reconcile a half-written batch,
    // which is the one outcome worse than a refusal.
    const good = Array.from({ length: 499 }, () => ROW);
    const file = Buffer.concat([csv(...good, ROW), CP1254]);
    await expect(parseRows(file, 'rapor.csv')).rejects.toThrow(FILE_NOT_UTF8);
  });

  it('characterises the Node behaviour the guard exists for: a lossy decode', () => {
    // Not product coverage — no change to this repo can fail it, and it is
    // not counted as a test of the guard. It pins the DEPENDENCY assumption
    // the guard is built on: `Buffer#toString('utf8')` never throws. It
    // substitutes U+FFFD and returns, so without a guard the import succeeds
    // and writes the mojibake to a record that can never be edited. If a
    // future Node made that throw, the guard's shape would be the wrong one.
    expect(CP1254.toString('utf8')).toContain('\uFFFD');
  });

  it("refuses the NUL bytes of Excel's UTF-16 export", () => {
    // `isUtf8` alone would pass this file: U+0000 is valid UTF-8. The NUL
    // check is the half that refuses it, and this pins that division.
    const utf16 = Buffer.from(`${HEADER}\n${ROW}\n`, 'utf16le');
    expect(isUtf8(utf16)).toBe(true);
    expect(utf16.includes(0)).toBe(true);
    return expect(parseRows(utf16, 'rapor.csv')).rejects.toThrow(FILE_NOT_UTF8);
  });

  it('accepts the same text saved as UTF-8, byte for byte', async () => {
    // The positive control: the guard must refuse the ENCODING, not the
    // letters. Byte for byte, not "looks Turkish" — mojibake still contains
    // letters, so a loose assertion would pass on the bug this refuses.
    const reason = 'Ölçüm düzeltildi';
    const rows = await parseRows(
      Buffer.from(`${HEADER}\nsub-1,,2024,monthly,January,Electricity,1200,kWh,${reason}\n`, 'utf8'),
      'rapor.csv',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cells.varianceReason).toBe(reason);
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
      `Unrecognised column(s): "${'x'.repeat(40)}…", "b", "c", "d", "e" (+2 more). Expected: ${HEADER.split(',').join(', ')}.`,
    );
  });

  it('names the characters in a header cell it will not echo', async () => {
    // The sentence is also the 400 the import panel renders, where a U+202E
    // reverses everything after it — so each one is named, never shown.
    //
    // This fixture held a NUL until the UTF-8 guard landed; a NUL now fails
    // the file at the door (the test below), so it can no longer reach the
    // quoter through a CSV. `quoteCallerText` still names it, and
    // `caller-text.spec.ts` pins that — at the layer that owns it.
    const header = `${HEADER},tco${RLO}2${ZWSP}e`;
    const error = await parseRows(Buffer.from([header, ROW].join('\n')), 'x.csv').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(
      `Unrecognised column(s): "tco<U+202E>2<U+200B>e". Expected: ${HEADER.split(',').join(', ')}.`,
    );
  });

  it('refuses a NUL anywhere in the file, header included', async () => {
    // What this is and is not, checked rather than assumed (security-rls
    // corrected an earlier version of this comment that claimed both):
    //
    //   - It is NOT what keeps `bulk-upload.service.ts`'s duplicate-detection
    //     key safe. That key joins six segments with a NUL, and none of them
    //     can hold one: five are closed vocabularies or an id shape validated
    //     before `slotKey` is reached, and the stored side comes from Postgres
    //     columns, which cannot contain 0x00 at all. The invariant was already
    //     kept on both sides; this guard neither adds to it nor relies on it.
    //   - It is NOT the difference between a 500 and a row error either. The
    //     import wraps every row, so a Prisma refusal over a NUL comes back as
    //     `code: 'unexpected'`, "This row could not be imported."
    //
    // What it IS: a NUL cannot be stored in a text column, so without this the
    // file half-imports and the rows carrying one are refused individually,
    // under a sentence that says nothing about the real cause. An encoding
    // fault is a property of the FILE, and it should be answered as one. The
    // check also earns its place against `isUtf8` alone, which accepts a NUL
    // (U+0000 is valid UTF-8) and so would pass a BOM-less UTF-16 export.
    //
    // Scope, stated because it is easy to over-read: this is the CSV path.
    // The XLSX path can still reach a NUL through a `_xHHHH_` escape, which
    // needs no bad byte and so no byte check catches — filed as its own task,
    // because refusing it naively breaks valid surrogate PAIRS and the header
    // refusal that names what it cannot echo.
    const header = `${HEADER},t${NUL}e`;
    await expect(
      parseRows(Buffer.from([header, ROW].join('\n')), 'x.csv'),
    ).rejects.toThrow(FILE_NOT_UTF8);
  });

  it.each([
    ['zero-width spaces', ZWSP, '<U+200B x40>'],
    ['invisible separators, which the rule let through until 2026-09-16', INVISIBLE_SEPARATOR, '<U+2063 x40>'],
    ['zero-width joiners, which are kept in storage but never shown', ZWJ, '<U+200D x40>'],
  ])('writes forty %s as one marker, so padding cannot hide the name', async (_case, pad, marker) => {
    // Counted one by one, forty of them fill the excerpt and leave a bare `…`;
    // dropped without a trace, they vanish from the sentence refusing the cell.
    const header = `${HEADER},${pad.repeat(40)}tco2e`;
    const error = await parseRows(Buffer.from([header, ROW].join('\n')), 'x.csv').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(
      `Unrecognised column(s): "${marker}tco2e". Expected: ${HEADER.split(',').join(', ')}.`,
    );
  });

  it.each([
    [
      'a column name with a zero-width space in it',
      HEADER.replace('category', `category${ZWSP}`),
      'category<U+200B>',
    ],
    ['a header cell holding nothing but a zero-width space', `${HEADER},${ZWSP}`, '<U+200B>'],
  ])('still refuses %s, and names the character that sets it apart', async (_case, header, quoted) => {
    // The match stays on the raw cell (user decision, 2026-09-16): matched on
    // cleaned text, the first would import as `category` and the second would
    // count as a blank cell. Quoted cleaned, the first read "Unrecognised
    // column(s): category. Expected: …, category, …" and the second quoted
    // nothing at all.
    const error = await parseRows(Buffer.from([header, ROW].join('\n')), 'x.csv').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(
      `Unrecognised column(s): "${quoted}". Expected: ${HEADER.split(',').join(', ')}.`,
    );
  });

  it('delimits every quoted cell, so a header cannot forge the sentence', async () => {
    // Undelimited, this cell made the refusal name two columns the file had
    // got right — and the sentence is stored as evidence in an append-only
    // table. The delimiter itself is named when a cell contains one.
    const header = `${HEADER},"activityValue, category","a""b"`;
    const error = await parseRows(
      Buffer.from([header, ROW].join('\n')),
      'x.csv',
    ).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toBe(
      `Unrecognised column(s): "activityValue, category", "a<U+0022>b". Expected: ${HEADER.split(',').join(', ')}.`,
    );
    expect(message).not.toContain(': activityValue, category.');
  });

  it('bounds a quote in units and in code points, and not the other way round', async () => {
    // Most cells quote identically whichever bound is which. This one does
    // not: 40 units with 58 code points keeps three markers, 58 units with 40
    // code points only two.
    const cell = `${'ab'.repeat(3)}${ZWSP.repeat(9)}`.repeat(4) + 'z'.repeat(20);
    const error = await parseRows(
      Buffer.from([`${HEADER},${cell}`, ROW].join('\n')),
      'x.csv',
    ).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      `Unrecognised column(s): "${'ababab<U+200B x9>'.repeat(3)}ababab…". Expected: ${HEADER.split(',').join(', ')}.`,
    );
  });

  it('matches a column whose cell has invisible edges, and quotes the trimmed cell', async () => {
    // `trim()` takes U+FEFF, NBSP and U+2028 off a cell's edges before the
    // lookup, which is what lets this product's own BOM-prefixed export be
    // re-imported. Quoted raw, an unknown cell would name characters the match
    // never saw.
    const edge = (text: string) =>
      `${String.fromCharCode(0xfeff)}${String.fromCharCode(0xa0)}${text}${String.fromCharCode(0x2028)}`;
    const rows = await parseRows(
      Buffer.from([HEADER.replace('category', edge('category')), ROW].join('\n')),
      'x.csv',
    );
    expect(rows[0].cells.category).toBe('Electricity');

    const error = await parseRows(
      Buffer.from([`${HEADER},${edge('tco2e')}`, ROW].join('\n')),
      'x.csv',
    ).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      `Unrecognised column(s): "tco2e". Expected: ${HEADER.split(',').join(', ')}.`,
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

  it('names the characters in a header cell it will not echo', async () => {
    // The NUL is written as `_x0000_`, SpreadsheetML's escape for a character
    // XML cannot carry, which the reader decodes. A literal one never reaches
    // the reader — exceljs's writer drops it — so there would be no NUL to
    // name.
    const buffer = await workbookBuffer([
      [...HEADER.split(','), `t_x0000_co${RLO}2${ZWSP}e`],
      ['sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', '', 'x'],
    ]);
    expect(await refusal(buffer)).toBe(
      `Unrecognised column(s): "t<U+0000>co<U+202E>2<U+200B>e". Expected: ${HEADER.split(',').join(', ')}.`,
    );
  });

  it('reads two halves that pair as one character, and names halves that do not', async () => {
    // `_xHHHH_` carries UTF-16 code units, so a file can write either.
    const buffer = await workbookBuffer([
      [...HEADER.split(','), 't_xD83D__xDE00_', 'u_xDE00__xD83D_'],
      ['sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', '', 'x', 'y'],
    ]);
    expect(await refusal(buffer)).toBe(
      `Unrecognised column(s): "t${String.fromCodePoint(0x1f600)}", "u<U+DE00 U+D83D>". Expected: ${HEADER.split(',').join(', ')}.`,
    );
  });

  it('refuses a workbook part whose BYTES are not UTF-8', async () => {
    // The CSV rule, on the other format — and it had to be written at the
    // part, not the upload, because a .xlsx is a zip and `isUtf8` would refuse
    // every one of them.
    //
    // `StringDecoder('utf8')` in `parseXml` is lossy exactly as
    // `Buffer#toString` is, and the XML declaration does not save it: saxes
    // syntax-checks the encoding NAME and then ignores it, so a part that says
    // `windows-1254` is still read as UTF-8. Measured before this guard: a
    // single 0xFC byte in this cell reached the STORED `varianceReason` as
    // U+FFFD — free text no vocabulary check can catch, on an immutable row.
    //
    // The byte has to be laid in by hand: every JavaScript string is valid
    // UTF-8 once encoded, so no fixture built from source text can express it.
    const sheetXml = Buffer.concat([
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SPREADSHEETML}">` +
          `<sheetData>${HEADER_ROW}<row r="2">` +
          `<c r="A2" t="inlineStr"><is><t>sub-1</t></is></c>` +
          `<c r="I2" t="inlineStr"><is><t>d`,
      ),
      Buffer.from([0xfc]), // "ü" in cp1254; on its own, not valid UTF-8
      Buffer.from('zeltme</t></is></c></row></sheetData></worksheet>'),
    ]);

    // Its own sentence, not the generic "could not be read as a workbook":
    // by the guard's own reasoning the likeliest file to hit this is one that
    // opens perfectly in Excel, and nothing server-side would otherwise tell
    // an encoding refusal apart from a corrupt archive.
    expect(await refusal(xlsx({ sheetXml }))).toBe(WORKBOOK_NOT_UTF8);
  });

  describe('characters a spreadsheet can write but Postgres cannot store', () => {
    // `_xHHHH_` is SpreadsheetML's escape for what XML cannot carry, and
    // `decodeEscapes` turns it into a code UNIT. It needs no invalid byte, so
    // neither UTF-8 guard sees it — a perfectly well-formed workbook can spell
    // a NUL or half a character straight into a cell.
    //
    // Both were measured against this repo's Postgres before any of this was
    // written: `E'a\u0000b'` is `invalid Unicode escape value` and
    // `E'a\uD800b'` is `invalid Unicode surrogate pair`, while the astral PAIR
    // `E'a\U0001F600b'` stores and reads back as three code points. Without
    // the guard the row reaches Prisma and comes back as the report's generic
    // "could not be imported", which tells the user nothing about the cause.
    const row = (variance: string) => [
      'sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', variance,
    ];

    it.each([
      ['a NUL', '_x0000_', 'U+0000'],
      ['half a character, high', '_xD800_', 'U+D800'],
      ['half a character, low', '_xDE00_', 'U+DE00'],
      // The pair REVERSED: two surrogates, neither pairing with the other.
      ['two halves in the wrong order', '_xDE00__xD83D_', 'U+DE00'],
    ])('refuses %s in a data cell, naming the row, the column and the character', async (
      _label,
      escape,
      named,
    ) => {
      const buffer = await workbookBuffer([HEADER.split(','), row(`before${escape}after`)]);

      expect(await refusal(buffer)).toBe(
        `Row 2 has a character in its varianceReason cell that cannot be stored (${named}). ` +
          'A spreadsheet writes it as an escape rather than a typed character — clear the cell and enter the value again.',
      );
    });

    it('still reads a valid surrogate PAIR, which is how a workbook spells an emoji', async () => {
      // The control that kills the obvious fix. A first attempt refused every
      // surrogate inside `decodeEscapes` and broke this — the pair is ordinary
      // text, it stores fine, and refusing it would refuse what users type.
      const buffer = await workbookBuffer([
        HEADER.split(','),
        row('meter swapped _xD83D__xDE00_'),
      ]);

      const rows = await parseRows(buffer, 'emoji.xlsx');

      expect(rows).toHaveLength(1);
      expect(rows[0].cells.varianceReason).toBe(
        `meter swapped ${String.fromCodePoint(0x1f600)}`,
      );
    });

    it('keeps a legitimately escaped literal, which is not the same thing', async () => {
      // Excel writes a literal `_x0000_` by escaping the underscore first, as
      // `_x005F_x0000_`, and that decodes to the seven ordinary characters —
      // no NUL anywhere. Pinned because the obvious "simplification" is to
      // scan the RAW cell text for /_x0000_/, which would refuse this and pass
      // every other test in the file.
      const buffer = await workbookBuffer([
        HEADER.split(','),
        row('_x005F_x0000_'),
      ]);

      const rows = await parseRows(buffer, 'escaped.xlsx');

      expect(rows[0].cells.varianceReason).toBe('_x0000_');
    });

    it('sees it through a SHARED string too, not only an inline one', async () => {
      // exceljs's writer emits inline strings, so every fixture above reaches
      // one of `decodeEscapes`'s two call sites and none reaches the other.
      // Hand-built, because nothing in this repo writes a shared string.
      const buffer = xlsx({
        sharedStrings: ['<t>before_x0000_after</t>'],
        sheetData:
          `${HEADER_ROW}<row r="2">` +
          `<c r="A2" t="inlineStr"><is><t>sub-1</t></is></c>` +
          `<c r="I2" t="s"><v>0</v></c>` +
          `</row>`,
      });

      expect(await refusal(buffer)).toMatch(/^Row 2 has a character in its varianceReason cell/);
    });

    it('does not jump the row cap', async () => {
      // The cap is counted across the whole stream on purpose, so it can name
      // the real total. A refusal thrown from inside the row handler skipped
      // that: a 1,005-row file with one bad cell in row 4 reported the
      // character, and the user learned about the cap on the NEXT upload.
      const rows = Array.from({ length: 1005 }, (_, i) =>
        i === 2
          ? xmlRow(i + 2, ['sub-1', null, 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', 'x_x0000_y'])
          : dataRow(i + 2),
      ).join('');

      await expect(parseRows(xlsx({ sheetData: HEADER_ROW + rows }), 'big.xlsx')).rejects.toThrow(
        'The file has 1005 rows; the limit is 1000.',
      );
    });

    it('does not jump the value no header names', async () => {
      // Both families are reported in row order, and shape comes before
      // content — so row 2's stray value is named, not row 3's character.
      const buffer = xlsx({
        sheetData:
          `${HEADER_ROW}` +
          xmlRow(2, ['sub-1', null, 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', null, 'stray']) +
          xmlRow(3, ['sub-1', null, 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', 'x_x0000_y']),
      });

      expect(await refusal(buffer)).toBe(
        'Row 2 has a value in column 10, which has no header. Name the column or clear it.',
      );
    });

    it('leaves a HEADER cell to the refusal that names what it cannot echo', async () => {
      // Deliberately NOT this guard's business: `mapHeader` already refuses a
      // header carrying one, in a sentence that NAMES the character. That is
      // better than a generic refusal, it is pinned two describes above, and
      // it is why the check sits on data cells rather than in `decodeEscapes`.
      const buffer = await workbookBuffer([
        [...HEADER.split(','), 't_x0000_e'],
        [...row(''), 'x'],
      ]);

      expect(await refusal(buffer)).toMatch(/^Unrecognised column\(s\): "t<U\+0000>e"/);
    });
  });

  it('refuses a raw NUL in a part, for parity with the CSV rule', async () => {
    // Belt and braces, and labelled as such: saxes refuses a raw NUL
    // everywhere today, so this is unreachable through that dependency. It is
    // here on the same ground the doctype refusal is — that is a property of
    // a dependency version, not a rule of this reader — and so that the two
    // import paths are ONE rule rather than two that happen to agree.
    //
    // It does NOT cover `_x0000_`, which is plain ASCII decoded after the
    // parse and needs no bad byte. That one is filed as its own task.
    const sheetXml = Buffer.concat([
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SPREADSHEETML}">` +
          `<sheetData>${HEADER_ROW}<row r="2">` +
          `<c r="A2" t="inlineStr"><is><t>sub`,
      ),
      Buffer.from([0x00]),
      Buffer.from('-1</t></is></c></row></sheetData></worksheet>'),
    ]);

    expect(await refusal(xlsx({ sheetXml }))).toBe(WORKBOOK_NOT_UTF8);
  });

  it('still reads a part carrying the same letters as UTF-8', async () => {
    // The positive control, and the one that matters most here: OOXML parts
    // are full of non-ASCII text legitimately, so a guard that refused any of
    // it would be worse than the defect.
    const sheetXml = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SPREADSHEETML}">` +
        `<sheetData>${HEADER_ROW}<row r="2">` +
        `<c r="A2" t="inlineStr"><is><t>sub-1</t></is></c>` +
        `<c r="C2"><v>2024</v></c>` +
        `<c r="D2" t="inlineStr"><is><t>monthly</t></is></c>` +
        `<c r="E2" t="inlineStr"><is><t>January</t></is></c>` +
        `<c r="F2" t="inlineStr"><is><t>Electricity</t></is></c>` +
        `<c r="G2"><v>1200</v></c>` +
        `<c r="H2" t="inlineStr"><is><t>kWh</t></is></c>` +
        `<c r="I2" t="inlineStr"><is><t>Ölçüm düzeltildi</t></is></c>` +
        `</row></sheetData></worksheet>`,
      'utf8',
    );

    const rows = await parseRows(xlsx({ sheetXml }), 'utf8.xlsx');

    expect(rows).toHaveLength(1);
    expect(rows[0].cells.varianceReason).toBe('Ölçüm düzeltildi');
  });

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

  it.each([['Data'], ['Sheet1'], ['Sayfa1']])(
    'reads a single sheet called %s: the rule is POSITION, not the name',
    async (name) => {
      // `Records` is what the template CALLS sheet one; it is not a name the
      // reader looks for, and a user's own file is named by their Excel (the
      // last of these is what a Turkish install creates). A reader that
      // started matching on the name would refuse every file but the
      // template's, and no fixture here would have noticed.
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet(name);
      sheet.addRow(HEADER.split(','));
      sheet.addRow([
        'sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', '',
      ]);

      const rows = await parseRows(Buffer.from(await wb.xlsx.writeBuffer()), 'own.xlsx');

      expect(rows).toHaveLength(1);
      expect(rows[0].cells.activityValue).toBe('1200');
    },
  );

  it('counts a HIDDEN sheet as the first one', async () => {
    // `xlsx-reader` takes the first sheet in the workbook's own tab order,
    // "hidden sheets included" — its words, and until now its only statement
    // of the fact. It is the surprising half of the rule: the user sees
    // `Records` at the front and the importer does not, so the refusal has to
    // happen rather than the hidden sheet being skipped into a silent read of
    // the wrong one.
    const wb = new ExcelJS.Workbook();
    const hidden = wb.addWorksheet('Scratch', { state: 'hidden' });
    hidden.addRow(['not the columns']);
    const data = wb.addWorksheet('Records');
    data.addRow(HEADER.split(','));
    data.addRow([
      'sub-1', '', 2024, 'monthly', 'January', 'Electricity', 1200, 'kWh', '',
    ]);

    await expect(
      parseRows(Buffer.from(await wb.xlsx.writeBuffer()), 'hidden-first.xlsx'),
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
    // Merges down to Excel's last row, over blank rows of imported columns.
    // Walked row by row a hundred of them took 3.2 s (qa-auditor, measured);
    // found by binary search, no time at all.
    //
    // A THOUSAND of them, and the budget stays. Both alternatives were tried
    // against the row-by-row mutant and both FAILED to catch it:
    //
    //   - Heap, the pattern its sibling above uses: a walk is a loop, not an
    //     allocation, so the two implementations grow the heap alike.
    //   - Vitest's own 5 s timeout, with no assertion at all: the mutant ran
    //     for **31 s and the test PASSED**. The defect is a synchronous
    //     stretch, and a timeout is a timer on the loop it is holding, so it
    //     cannot fire. That is the whole point of the defect.
    //
    // Time is the only observable, so what is fixed instead is the MARGIN.
    // At a hundred merges the budget was 1,000 ms against a 3,200 ms defect
    // — 3x, close enough that a CI runner a few times slower than the laptop
    // it was measured on would pass the regression. Ten times the merges puts
    // the walk at ~31 s (measured) and leaves the binary search at 2.7 ms, so
    // the same 1,000 ms now sits 370x above healthy and 31x below the defect.
    const buffer = xlsx({
      sheetData: HEADER_ROW + dataRow(2),
      afterSheetData: merged(...Array.from({ length: 1_000 }, () => 'A3:I1048576')),
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

