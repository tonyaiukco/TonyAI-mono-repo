import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SaxesParser } from 'saxes';
import {
  OFFICE_RELATIONSHIPS,
  PACKAGE_RELATIONSHIPS,
  SPREADSHEETML,
  columnLetters,
  xlsx,
} from '../../test/xlsx';
import {
  FIRST_SHEET_NOT_A_WORKSHEET,
  WORKBOOK_HAS_NO_SHEETS,
  readFirstWorksheet,
  type MergedRange,
} from './xlsx-reader';
import { WORKBOOK_UNREADABLE } from './zip-reader';

const MIB = 1024 * 1024;

/** What the first sheet reads as: values by A1 reference, rows, merges. */
async function read(buffer: Buffer) {
  const values: Record<string, string> = {};
  const rowNumbers: number[] = [];
  const merges: MergedRange[] = [];
  await readFirstWorksheet(buffer, {
    row(rowNumber, cells) {
      rowNumbers.push(rowNumber);
      for (const cell of cells) {
        values[`${columnLetters(cell.column)}${rowNumber}`] = cell.value;
      }
    },
    merge(range) {
      merges.push(range);
    },
  });
  return { values, rowNumbers, merges };
}

/**
 * The refusal a caller gets — the class as well as the words, because anything
 * that is not an HttpException reaches the user as a 500.
 */
async function refusal(buffer: Buffer): Promise<string> {
  const error = await read(buffer).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BadRequestException);
  return (error as Error).message;
}

const inline = (ref: string, text: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const oneRow = (...cells: string[]) => `<row r="1">${cells.join('')}</row>`;
const cellFormats = (ids: readonly (number | null)[]) =>
  `<cellXfs count="${ids.length}">${ids
    .map((id) => (id === null ? '<xf/>' : `<xf numFmtId="${id}"/>`))
    .join('')}</cellXfs>`;

// Built rather than typed: an escape sequence typed into a file can arrive as
// the character it names, and these have to arrive as themselves.
const BACKSLASH = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);

describe('readFirstWorksheet — what a cell reads as', () => {
  it('reads each kind of cell as the string the user sees', async () => {
    const { values } = await read(
      xlsx({
        sharedStrings: [
          '<t>plain</t>',
          '<r><t xml:space="preserve">Meter </t></r><r><rPr><b/></rPr><t>replaced</t></r>',
          // A phonetic reading guide travels with the text; the cell shows none of it.
          '<t>Tokyo</t><rPh sb="0" eb="5"><t>toukyou</t></rPh>',
        ],
        sheetData: oneRow(
          '<c r="A1" t="s"><v>0</v></c>',
          '<c r="B1" t="s"><v>1</v></c>',
          '<c r="C1" t="s"><v>2</v></c>',
          inline('D1', 'inline &amp; escaped'),
          '<c r="E1"><v>1200.50</v></c>',
          '<c r="F1"><v>1E3</v></c>',
          '<c r="G1" t="b"><v>1</v></c>',
          '<c r="H1" t="b"><v>0</v></c>',
          '<c r="I1" t="e"><v>#REF!</v></c>',
          '<c r="J1" t="str"><f>A1&amp;"x"</f><v>plainx</v></c>',
          '<c r="K1"><f>SUM(1,2)</f><v>3</v></c>',
          '<c r="L1" t="e"><f>1/0</f><v>#DIV/0!</v></c>',
          '<c r="M1" t="inlineStr"><is><t>Osaka</t><rPh sb="0" eb="5"><t>oosaka</t></rPh></is></c>',
          '<c r="N1" t="inlineStr"><is><r><t xml:space="preserve">Meter </t></r><r><t>replaced</t></r></is></c>',
        ),
      }),
    );
    expect(values).toEqual({
      A1: 'plain',
      B1: 'Meter replaced',
      C1: 'Tokyo',
      D1: 'inline & escaped',
      E1: '1200.5',
      F1: '1000',
      G1: 'true',
      H1: 'false',
      I1: '#REF!',
      J1: 'plainx',
      K1: '3',
      // A formula whose result is an error reads as the error — refused later
      // for what the user sees, not as a blank.
      L1: '#DIV/0!',
      // An inline string's reading guide is left out too, and its runs are read.
      M1: 'Osaka',
      N1: 'Meter replaced',
    });
  });

  it('decodes the _xHHHH_ escapes Excel writes for characters XML cannot carry', async () => {
    const { values } = await read(
      xlsx({
        sharedStrings: ['<t>line one_x000D_line two</t>'],
        sheetData: oneRow(
          '<c r="A1" t="s"><v>0</v></c>',
          inline('B1', 'a_x0009_b'),
          inline('C1', 'a_x000d_b'),
        ),
      }),
    );
    // Uppercase hex only — what Excel writes, and all exceljs decoded.
    expect(values).toEqual({
      A1: `line one${CR}line two`,
      B1: `a${TAB}b`,
      C1: 'a_x000d_b',
    });
  });

  it('leaves out what shows nothing: styled blanks, empty string cells, formulas with no cached result', async () => {
    const { values, rowNumbers } = await read(
      xlsx({
        sheetData:
          oneRow(
            '<c r="A1" s="0"/>',
            '<c r="B1"><f>A2</f></c>',
            '<c r="C1" t="s"><v></v></c>',
            '<c r="D1" t="s"/>',
          ) + `<row r="2">${inline('A2', 'kept')}</row>`,
      }),
    );
    expect(values).toEqual({ A2: 'kept' });
    expect(rowNumbers).toEqual([2]);
  });

  it('reads a number under a date format as a timestamp — built-in or custom, in either case', async () => {
    const { values } = await read(
      xlsx({
        styles:
          '<numFmts count="3">' +
          '<numFmt numFmtId="164" formatCode="YYYY"/>' +
          `<numFmt numFmtId="165" formatCode="0.0${BACKSLASH} ${BACKSLASH}k${BACKSLASH}W${BACKSLASH}h"/>` +
          '<numFmt numFmtId="166" formatCode="#,##0 &quot;kWh&quot;"/>' +
          '</numFmts>' +
          // Excel writes cell STYLE formats first. Only `cellXfs` is what `s` indexes.
          '<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>' +
          cellFormats([0, 14, 164, 165, 166]),
        sheetData: oneRow(
          '<c r="A1" s="1"><v>46085</v></c>',
          '<c r="B1" s="2"><v>2024</v></c>',
          '<c r="C1" s="3"><v>1200</v></c>',
          '<c r="D1" s="4"><v>1200</v></c>',
          '<c r="E1"><v>46085</v></c>',
        ),
      }),
    );
    expect(values).toEqual({
      A1: '2026-03-04T00:00:00.000Z',
      // Excel shows 1905 in this cell — 2024 is that date's serial number — so
      // the year on screen is not the one the cell holds.
      B1: '1905-07-16T00:00:00.000Z',
      // Escaped letters and quoted text are literals, not date tokens.
      C1: '1200',
      D1: '1200',
      E1: '46085',
    });
  });

  it.each([
    [14, true],
    [22, true],
    [27, true],
    [45, true],
    [47, true],
    [58, true],
    [13, false],
    [37, false],
    [49, false],
    [59, false],
  ])('reads a number under built-in format %i as a date: %s', async (id, isDate) => {
    const { values } = await read(
      xlsx({ styles: cellFormats([0, id]), sheetData: oneRow('<c r="A1" s="1"><v>46085</v></c>') }),
    );
    // Without 22, an `m/d/yyyy h:mm` cell read as 46085.5 — a number the strict
    // parse would import as a consumption figure.
    expect(values.A1).toBe(isDate ? '2026-03-04T00:00:00.000Z' : '46085');
  });

  it('takes colours, locales, padding, differential formats and bare cell formats for what they are', async () => {
    const { values } = await read(
      xlsx({
        styles:
          '<numFmts count="4">' +
          '<numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/>' +
          '<numFmt numFmtId="165" formatCode="[$-409]d/m/yyyy"/>' +
          '<numFmt numFmtId="166" formatCode="0_d"/>' +
          '<numFmt numFmtId="167" formatCode="0.00"/>' +
          '</numFmts>' +
          cellFormats([0, 164, 165, 166, 167, null]) +
          '<dxfs count="1"><dxf><numFmt numFmtId="167" formatCode="d/m/yyyy"/></dxf></dxfs>',
        sheetData: oneRow(
          '<c r="A1" s="1"><v>1200</v></c>',
          '<c r="B1" s="2"><v>46085</v></c>',
          '<c r="C1" s="3"><v>1200</v></c>',
          '<c r="D1" s="4"><v>1200</v></c>',
          '<c r="E1" s="5"><v>46085</v></c>',
        ),
      }),
    );
    expect(values).toEqual({
      // `[Red]` is a colour, not a d.
      A1: '1200',
      // `[$-409]` is a locale; `d/m/yyyy` is the date.
      B1: '2026-03-04T00:00:00.000Z',
      // `_d` pads by the width of a d.
      C1: '1200',
      // A conditional format's own number format restyles no cell by itself.
      D1: '1200',
      // An `<xf>` naming no format is General.
      E1: '46085',
    });
  });

  it.each(['1', 'true'])('reads date1904="%s" as the 1904 date system', async (flag) => {
    const { values } = await read(
      xlsx({
        workbookPr: `date1904="${flag}"`,
        styles: cellFormats([0, 14]),
        sheetData: oneRow('<c r="A1" s="1"><v>0</v></c>'),
      }),
    );
    expect(values.A1).toBe('1904-01-01T00:00:00.000Z');
  });

  it("reads ISO date cells, and a time with no zone as UTC whatever the server's zone", async () => {
    const zone = process.env.TZ;
    // Three hours from UTC, so reading local time would show.
    process.env.TZ = 'Europe/Istanbul';
    try {
      const { values } = await read(
        xlsx({
          sheetData: oneRow(
            '<c r="A1" t="d"><v>2026-03-04T00:00:00</v></c>',
            '<c r="B1" t="d"><v>2026-03-04T03:00:00+03:00</v></c>',
            '<c r="C1" t="d"><v>2026-03-04</v></c>',
            '<c r="D1" t="d"><v>2026-03-04T00:00:00Z</v></c>',
          ),
        }),
      );
      expect(values).toEqual({
        A1: '2026-03-04T00:00:00.000Z',
        B1: '2026-03-04T00:00:00.000Z',
        C1: '2026-03-04T00:00:00.000Z',
        D1: '2026-03-04T00:00:00.000Z',
      });
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it('refuses a date no calendar can hold as a 400 that names the cell', async () => {
    const message = await refusal(
      xlsx({
        styles: cellFormats([0, 14]),
        sheetData: `${oneRow(inline('A1', 'x'))}<row r="2"><c r="G2" s="1"><v>1e12</v></c></row>`,
      }),
    );
    expect(message).toBe(
      "Row 2 has a date in column 7 that is out of range. Check the cell's value and its format.",
    );
  });
});

describe('readFirstWorksheet — which sheet, and where its cells sit', () => {
  const sheet = (text: string) =>
    `<worksheet xmlns="${SPREADSHEETML}"><sheetData>${oneRow(inline('A1', text))}</sheetData></worksheet>`;

  it("reads the first sheet in the workbook's own order, not the first file in the archive", async () => {
    const { values } = await read(
      xlsx({
        sheetXml: sheet('notes'),
        workbookXml: `<workbook xmlns="${SPREADSHEETML}" xmlns:r="${OFFICE_RELATIONSHIPS}"><sheets><sheet name="Records" sheetId="2" r:id="rId9"/><sheet name="Notes" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        workbookRelsXml: `<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="${OFFICE_RELATIONSHIPS}/worksheet" Target="/xl/worksheets/records.xml"/></Relationships>`,
        extraParts: [{ name: 'xl/worksheets/records.xml', data: sheet('records') }],
      }),
    );
    expect(values).toEqual({ A1: 'records' });
  });

  it('refuses a first sheet that names no relationship, rather than moving on to the next', async () => {
    const message = await refusal(
      xlsx({
        workbookXml: `<workbook xmlns="${SPREADSHEETML}" xmlns:r="${OFFICE_RELATIONSHIPS}"><sheets><sheet name="A" sheetId="1"/><sheet name="B" sheetId="2" r:id="rId1"/></sheets></workbook>`,
      }),
    );
    expect(message).toBe(WORKBOOK_UNREADABLE);
  });

  it('refuses a workbook that lists no sheets', async () => {
    const message = await refusal(
      xlsx({ workbookXml: `<workbook xmlns="${SPREADSHEETML}"><sheets/></workbook>` }),
    );
    expect(message).toBe(WORKBOOK_HAS_NO_SHEETS);
  });

  it('refuses a chart sheet in first place, saying so', async () => {
    const message = await refusal(
      xlsx({
        workbookRelsXml: `<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`,
      }),
    );
    expect(message).toBe(FIRST_SHEET_NOT_A_WORKSHEET);
  });

  it('reads a Strict OOXML workbook', async () => {
    const strictSpreadsheetMl = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
    const strictRelationships = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
    const { values } = await read(
      xlsx({
        workbookXml: `<workbook xmlns="${strictSpreadsheetMl}" xmlns:r="${strictRelationships}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        workbookRelsXml: `<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${strictRelationships}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        sheetXml: `<worksheet xmlns="${strictSpreadsheetMl}"><sheetData>${oneRow('<c r="A1"><v>5</v></c>')}</sheetData></worksheet>`,
      }),
    );
    expect(values).toEqual({ A1: '5' });
  });

  it('reads SpreadsheetML under any prefix, after a byte-order mark', async () => {
    const xml = `<x:worksheet xmlns:x="${SPREADSHEETML}"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>prefixed</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`;
    const { values } = await read(
      xlsx({ sheetXml: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]) }),
    );
    expect(values).toEqual({ A1: 'prefixed' });
  });

  it('places cells and rows that carry no reference where Excel would', async () => {
    const { values } = await read(
      xlsx({
        sheetData:
          '<row><c t="inlineStr"><is><t>a</t></is></c><c><v>2</v></c></row>' +
          '<row r="3"><c r="C3"><v>3</v></c><c><v>4</v></c></row>' +
          '<row><c><v>5</v></c></row>',
      }),
    );
    expect(values).toEqual({ A1: 'a', B1: '2', C3: '3', D3: '4', A4: '5' });
  });

  it('reports merged ranges by their corners, and single-cell ones not at all', async () => {
    const { merges } = await read(
      xlsx({
        sheetData: oneRow(inline('A1', 'x')),
        afterSheetData:
          '<mergeCells count="3"><mergeCell ref="B3:A2"/><mergeCell ref="C5"/><mergeCell ref="D1:D1"/></mergeCells>',
      }),
    );
    expect(merges).toEqual([{ ref: 'B3:A2', top: 2, left: 1, bottom: 3, right: 2 }]);
  });

  // A repeated or backwards reference would let one value silently overwrite
  // another, so cells must ascend the way Excel writes them.
  it.each([
    ['a row that goes backwards', `<row r="2">${inline('A2', 'x')}</row>${oneRow(inline('A1', 'y'))}`],
    ['a repeated row', `<row r="2">${inline('A2', 'x')}</row><row r="2">${inline('B2', 'y')}</row>`],
    ['a cell that goes backwards', oneRow(inline('B1', 'x'), inline('A1', 'y'))],
    ['a repeated cell', oneRow(inline('A1', 'x'), inline('A1', 'y'))],
    ['a cell that names another row', oneRow(inline('A2', 'x'))],
    ['a column past XFD', oneRow(inline('XFE1', 'x'))],
    // No cell reference, so only the row's own number can be refused.
    ['a row past 1,048,576', '<row r="1048577"><c><v>1</v></c></row>'],
  ])('refuses %s', async (_case, sheetData) => {
    expect(await refusal(xlsx({ sheetData }))).toBe(WORKBOOK_UNREADABLE);
  });
});

describe('readFirstWorksheet — what no well-behaved writer emits', () => {
  const attributes = Array.from({ length: 300 }, (_, i) => `a${i}="1"`).join(' ');
  const numberFormats = (count: number) =>
    `<numFmts count="${count}">${Array.from(
      { length: count },
      (_, i) => `<numFmt numFmtId="${164 + i}" formatCode="0"/>`,
    ).join('')}</numFmts>`;
  const twoRuns = (text: string) => `<r><t>${text}</t></r><r><t>${text}</t></r>`;

  it.each([
    ['a DOCTYPE', { sheetXml: `<!DOCTYPE worksheet><worksheet xmlns="${SPREADSHEETML}"><sheetData/></worksheet>` }],
    ['XML nested far deeper than any workbook', { sheetData: `<row r="1">${'<x>'.repeat(100)}${'</x>'.repeat(100)}</row>` }],
    ['one element with hundreds of attributes', { sheetData: `<row r="1" ${attributes}/>` }],
    ['a cell longer than Excel allows', { sheetData: oneRow(inline('A1', 'a'.repeat(32_768))) }],
    ['an inline rich-text string longer than Excel allows', { sheetData: oneRow(`<c r="A1" t="inlineStr"><is>${twoRuns('a'.repeat(20_000))}</is></c>`) }],
    ['a value longer than Excel allows', { sheetData: oneRow(`<c r="A1" t="str"><v>${'a'.repeat(32_768)}</v></c>`) }],
    ['a shared string longer than Excel allows', { sharedStrings: [`<t>${'a'.repeat(32_768)}</t>`], sheetData: oneRow('<c r="A1" t="s"><v>0</v></c>') }],
    ['a rich-text shared string longer than Excel allows', { sharedStrings: [twoRuns('a'.repeat(20_000))], sheetData: oneRow('<c r="A1" t="s"><v>0</v></c>') }],
    ['a shared-string index past the end', { sharedStrings: ['<t>only</t>'], sheetData: oneRow('<c r="A1" t="s"><v>1</v></c>') }],
    // Appended, each of these would read as one plausible value: 1200, or "ab".
    ['a shared string with two texts', { sharedStrings: ['<t>12</t><t>00</t>'], sheetData: oneRow('<c r="A1" t="s"><v>0</v></c>') }],
    ['an inline string with two texts', { sheetData: oneRow('<c r="A1" t="inlineStr"><is><t>12</t><t>00</t></is></c>') }],
    ['a cell with two values', { sheetData: oneRow('<c r="A1"><v>12</v><v>00</v></c>') }],
    // Runs only, so the count of direct texts cannot be what refuses it.
    ['a cell with two inline strings', { sheetData: oneRow('<c r="A1" t="inlineStr"><is><r><t>12</t></r></is><is><r><t>00</t></r></is></c>') }],
    ['an unknown cell type', { sheetData: oneRow('<c r="A1" t="x"><v>1</v></c>') }],
    ['a number cell that is not a number', { sheetData: oneRow('<c r="A1"><v>12abc</v></c>') }],
    // `Number('0x10')` is 16, so only the strict pattern refuses this one.
    ['a hexadecimal number', { sheetData: oneRow('<c r="A1"><v>0x10</v></c>') }],
    ['a date cell that is not ISO 8601', { sheetData: oneRow('<c r="A1" t="d"><v>March 4, 2026</v></c>') }],
    ['a number format code longer than any spreadsheet writes', { styles: `<numFmts count="1"><numFmt numFmtId="164" formatCode="${'0'.repeat(1_025)}"/></numFmts>` }],
    ['more number formats than any workbook holds', { styles: numberFormats(4_097) }],
    ['more cell formats than any workbook holds', { styles: cellFormats(Array.from({ length: 65_537 }, () => 0)) }],
    ['merges declared before the rows', { beforeSheetData: '<mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells>' }],
    ['malformed XML', { sheetData: '<row r="1">' }],
    ['a package with no relationships part', { omit: ['_rels/.rels'] }],
  ])('refuses %s as unreadable', async (_case, spec) => {
    expect(await refusal(xlsx(spec))).toBe(WORKBOOK_UNREADABLE);
  });

  /**
   * How much of the file saxes was handed before the refusal. The caps are
   * enforced as saxes reads — an attribute, or a tag, at a time — so parsing
   * stops inside the first slice. A check made when the tag CLOSES would read
   * all of it first, which is the allocation the cap exists to prevent.
   */
  async function charactersParsed(buffer: Buffer): Promise<number> {
    const write = vi.spyOn(SaxesParser.prototype, 'write');
    try {
      expect(await refusal(buffer)).toBe(WORKBOOK_UNREADABLE);
      return write.mock.calls.reduce((sum, [chunk]) => sum + String(chunk ?? '').length, 0);
    } finally {
      write.mockRestore();
    }
  }

  it('stops a tag at its first attribute over the cap, not at its end', async () => {
    const many = Array.from({ length: 400_000 }, (_, i) => `a${i}=""`).join(' ');
    expect(await charactersParsed(xlsx({ sheetData: `<row r="1" ${many}/>` }))).toBeLessThan(MIB);
  });

  it('stops at the first element nested too deep, not at the end of the nesting', async () => {
    expect(
      await charactersParsed(xlsx({ sheetData: `<row r="1">${'<x>'.repeat(400_000)}` })),
    ).toBeLessThan(MIB);
  });

  it('refuses in the words the web shows', () => {
    // Everything above compares against these constants, so a reword would
    // pass unnoticed. Changing one should be a decision, taken here.
    expect(WORKBOOK_UNREADABLE).toBe('The file could not be read as a workbook.');
    expect(WORKBOOK_HAS_NO_SHEETS).toBe('The workbook has no sheets.');
    expect(FIRST_SHEET_NOT_A_WORKSHEET).toBe(
      "The workbook's first sheet is not a worksheet. Move the sheet with the records to the front.",
    );
  });
});

describe('readFirstWorksheet — work that could hold the event loop', () => {
  // Time is the observable here because time is the defect: each of these ran
  // for seconds in one synchronous stretch before its fix (measured, beside
  // each) and runs in milliseconds after it. The bounds sit far from both.

  it('judges each number format once, however many cell formats share it', async () => {
    // Before: 65,536 cell formats sharing one 1 MB code held the event loop for
    // 56 s (security-rls). Codes are capped at 1,024 characters now, and an
    // unclosed bracket is the worst case for the regex that used to strip
    // brackets: 0.8 ms per code, 3.3 s for these 4,096 even judged once each.
    const code = '['.repeat(1_024);
    const formats = Array.from(
      { length: 4_096 },
      (_, i) => `<numFmt numFmtId="${164 + i}" formatCode="${code}"/>`,
    ).join('');
    const buffer = xlsx({
      styles:
        `<numFmts count="4096">${formats}</numFmts>` +
        cellFormats(Array.from({ length: 65_536 }, (_, i) => 164 + (i % 4_096))),
      sheetData: oneRow('<c r="A1" s="1"><v>5</v></c>'),
    });
    const started = performance.now();
    const { values } = await read(buffer);
    expect(values).toEqual({ A1: '5' });
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('refuses a long run of digits without backtracking over it', async () => {
    // Before: the number pattern took 582 ms over this one cell.
    const buffer = xlsx({ sheetData: oneRow(`<c r="A1"><v>${'1'.repeat(32_766)}x</v></c>`) });
    const started = performance.now();
    expect(await refusal(buffer)).toBe(WORKBOOK_UNREADABLE);
    expect(performance.now() - started).toBeLessThan(300);
  });
});
