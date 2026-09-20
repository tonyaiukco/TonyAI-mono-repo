import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  BULK_UPLOAD_COLUMNS,
  BULK_UPLOAD_MAX_ROWS,
  CATEGORIES,
  CATEGORY_UNITS,
  PERIOD_VALUES,
  REPORTING_PERIODS,
} from '@tonyai/shared-types';
import { buildTemplateWorkbook, type TemplateEntities } from './template-workbook';
import { parseRows } from './parse-rows';

/**
 * The template and the importer are two halves of one contract, and the
 * contract is unforgiving: `mapHeader` refuses any unrecognised, missing or
 * duplicated column, so a template that drifts by one cell is a file its own
 * product cannot read.
 *
 * So the load-bearing case here is a ROUND TRIP — generate the workbook, fill
 * a row in as a user would, and feed it back through `parseRows`. Asserting
 * the header against `BULK_UPLOAD_COLUMNS` would only prove the builder used
 * the constant it imports.
 */
const ENTITIES: TemplateEntities = {
  subsidiaries: [
    {
      id: '22222222-2222-2222-2222-222222220001',
      legalName: 'TonyAI Energy A.Ş.',
      tradingName: 'TonyAI Energy',
      geographyCode: 'TR',
    },
    {
      id: '22222222-2222-2222-2222-222222220002',
      legalName: 'TonyAI Gas Ltd.',
      tradingName: null,
      geographyCode: 'UK',
    },
  ],
  locations: [
    {
      id: '33333333-3333-3333-3333-333333330001',
      subsidiaryId: '22222222-2222-2222-2222-222222220001',
      name: 'Istanbul Plant',
      geographyCode: 'TR',
    },
  ],
};

async function load(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

function cellsOf(sheet: ExcelJS.Worksheet, row: number): string[] {
  const values: string[] = [];
  sheet.getRow(row).eachCell({ includeEmpty: true }, (cell, index) => {
    values[index - 1] = String(cell.value ?? '');
  });
  return values;
}

describe('buildTemplateWorkbook — the importer can read what it writes', () => {
  it('round-trips: fill a row in and the importer parses it', async () => {
    const template = await buildTemplateWorkbook(ENTITIES);
    const workbook = await load(template);
    const records = workbook.worksheets[0];

    // Exactly what a user does: type into the first empty row.
    records.getRow(2).values = [
      ENTITIES.subsidiaries[0].id,
      '',
      2024,
      'monthly',
      'January',
      'Electricity',
      45000,
      'kWh',
      '',
    ];
    const filled = Buffer.from(await workbook.xlsx.writeBuffer());

    const rows = await parseRows(filled, 'template.xlsx');

    expect(rows).toHaveLength(1);
    expect(rows[0].cells.subsidiaryId).toBe(ENTITIES.subsidiaries[0].id);
    expect(rows[0].cells.activityValue).toBe('45000');
    expect(rows[0].cells.locationId).toBe('');
  });

  it('parses to ZERO rows before anyone fills it in', async () => {
    // The trap this design exists to avoid: the importer only skips a row that
    // is blank in EVERY cell, so a pre-filled skeleton row carrying just an
    // entity id would be parsed, fail for a missing year, and hand the user an
    // error for a row they never touched.
    const rows = await parseRows(
      await buildTemplateWorkbook(ENTITIES),
      'template.xlsx',
    );
    expect(rows).toEqual([]);
  });

  it('keeps the reference sheet out of the importer’s reach', async () => {
    // The importer reads the first sheet and nothing else — which is the only
    // reason the entity names can exist in this file at all. If the importer
    // ever read a second sheet, every name and vocabulary row would arrive as
    // a broken record.
    const workbook = await load(await buildTemplateWorkbook(ENTITIES));
    expect(workbook.worksheets).toHaveLength(2);
    // Both names in order, which says the contract outright: the importer
    // reads sheet ONE whatever it is called, so "Records is first" is the
    // load-bearing half.
    //
    // Clearer, NOT new coverage — measured, because the first version of this
    // comment claimed otherwise. With `toHaveLength(2)` two lines up, pinning
    // index 1 already pinned index 0: swapping the two `addWorksheet` calls
    // fails twenty tests in this file with or without this line. The genuinely
    // untested half was the DOWNLOADED artefact, where `bulk-upload-panel`
    // only ever looked both sheets up by name; that one now pins index 0 too.
    expect(workbook.worksheets.map((w) => w.name)).toEqual(['Records', 'Reference']);
    expect(workbook.worksheets[1].actualRowCount).toBeGreaterThan(10);

    const rows = await parseRows(
      await buildTemplateWorkbook(ENTITIES),
      'template.xlsx',
    );
    expect(rows).toEqual([]);
  });

  it('writes exactly the importer’s columns, in its order', async () => {
    const workbook = await load(await buildTemplateWorkbook(ENTITIES));
    expect(cellsOf(workbook.worksheets[0], 1)).toEqual([
      ...BULK_UPLOAD_COLUMNS,
    ]);
  });
});

describe('buildTemplateWorkbook — the reference sheet', () => {
  async function referenceText(
    entities: TemplateEntities = ENTITIES,
  ): Promise<string> {
    const workbook = await load(await buildTemplateWorkbook(entities));
    const sheet = workbook.worksheets[1];
    const lines: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      lines.push(cellsOf(sheet, Number(row.number)).join(' | '));
    });
    return lines.join('\n');
  }

  it('names every reachable entity beside its id', async () => {
    const text = await referenceText();
    // The whole reason this is an XLSX and not a CSV.
    expect(text).toContain('22222222-2222-2222-2222-222222220001');
    expect(text).toContain('TonyAI Energy A.Ş.');
    expect(text).toContain('33333333-3333-3333-3333-333333330001');
    expect(text).toContain('Istanbul Plant');
    // A subsidiary with no trading name is named once, not "Gas Ltd. (null)".
    expect(text).toContain('TonyAI Gas Ltd.');
    expect(text).not.toContain('(null)');
  });

  it('says how to report for the whole company', async () => {
    expect(await referenceText()).toContain('Whole company');
  });

  it('warns that imported rows arrive as drafts', async () => {
    // `draft` is in neither COUNTED_STATUSES nor PENDING_REVIEW_STATUSES, so
    // an import moves no total and fills no review queue until the rows are
    // submitted. A user who is not told this reports it as a bug.
    const text = await referenceText();
    expect(text).toMatch(/drafts/i);
    expect(text).toMatch(/review queue/i);
  });

  it('lists each category’s own accepted units', async () => {
    // Against the constant, row by row. A substring check (`'kWh, MWh'`
    // appears somewhere) let a mutant render Natural Gas's units for EVERY
    // category — telling a user that Electricity accepts `therms`, which is
    // the silent wrong figure `CATEGORY_UNITS` exists to prevent — and stayed
    // green. It was also brittle the other way: reordering a correct list
    // broke it.
    const text = await referenceText();
    for (const category of CATEGORIES) {
      const units = CATEGORY_UNITS[category];
      if (units) {
        expect(text).toContain(`${category} | ${units.join(', ')}`);
      } else {
        expect(text).toMatch(
          new RegExp(`${category} \\| No emission factor`),
        );
      }
    }
  });

  it('lists each granularity’s own period vocabulary', async () => {
    const text = await referenceText();
    for (const period of REPORTING_PERIODS) {
      expect(text).toContain(`${period} | ${PERIOD_VALUES[period].join(', ')}`);
    }
  });

  it('keeps every instruction sentence', async () => {
    // Deleting the whole "How to use this template" block left 9 of 10 tests
    // green — and that block is what makes the file self-explanatory. Each
    // sentence is pinned by the thing it warns about, not by its wording.
    const text = await referenceText();
    expect(text).toMatch(/locationId blank/i);          // whole-company rows
    expect(text).toMatch(/ignored on upload/i);         // sheet 2 is free space
    expect(text).toMatch(/rename or reorder/i);         // mapHeader refuses
    expect(text).toContain(String(BULK_UPLOAD_MAX_ROWS)); // the row cap
  });

  it('explains an empty register instead of showing a bare header', async () => {
    // A brand-new tenant, or an account with no grants yet. A blank table
    // reads like a broken download.
    const text = await referenceText({ subsidiaries: [], locations: [] });
    expect(text).toMatch(/No reporting entities are available/i);
  });

  it('says so when the register was truncated', async () => {
    const text = await referenceText({ ...ENTITIES, truncated: true });
    expect(text).toMatch(/truncated/i);
  });

  it('neutralises a name that would be a formula in a CSV re-save', async () => {
    // Defence in depth, and the reason is narrower than it looks: OOXML
    // evaluates `<f>` elements and exceljs writes a string cell here, so
    // `=1+1` is inert when this workbook is OPENED. The hazard is the
    // re-save — someone exporting sheet 2 to CSV — which is exactly the hole
    // #81 closed on the other side.
    const text = await referenceText({
      subsidiaries: [
        {
          id: 'sub-1',
          legalName: '=1+1',
          tradingName: null,
          geographyCode: 'TR',
        },
      ],
      locations: [],
    });
    expect(text).not.toMatch(/\| =1\+1/);
    expect(text).toContain("'=1+1");
  });

  it('does not fall over when the caller can reach nothing', async () => {
    // A brand-new tenant, or a data_entry user with no grants yet. The
    // template must still describe the format rather than 500.
    const rows = await parseRows(
      await buildTemplateWorkbook({ subsidiaries: [], locations: [] }),
      'template.xlsx',
    );
    expect(rows).toEqual([]);
  });
});

describe('buildTemplateWorkbook — sheet 1 is a header and its dropdowns', () => {
  /** The validation attached to a column's first data cell, after a reload. */
  async function dropdownFor(
    column: string,
  ): Promise<{ type?: string; formulae?: unknown[] } | undefined> {
    const workbook = await load(await buildTemplateWorkbook(ENTITIES));
    const sheet = workbook.worksheets[0];
    const index = BULK_UPLOAD_COLUMNS.indexOf(
      column as (typeof BULK_UPLOAD_COLUMNS)[number],
    );
    return sheet.getRow(2).getCell(index + 1).dataValidation as
      | { type?: string; formulae?: unknown[] }
      | undefined;
  }

  it.each([
    ['reportingPeriod', REPORTING_PERIODS],
    ['category', CATEGORIES],
  ])('offers %s as a closed list', async (column, values) => {
    // Deleting the dropdowns entirely, or wiring a list to the wrong column,
    // left all ten tests green — and the dropdowns are half of what sheet 1
    // IS, the other half being nine header cells.
    const validation = await dropdownFor(column);
    expect(validation?.type).toBe('list');
    expect(String(validation?.formulae?.[0])).toBe(`"${values.join(',')}"`);
  });

  it('offers every period token, across granularities', async () => {
    const validation = await dropdownFor('periodValue');
    const formula = String(validation?.formulae?.[0]);
    for (const token of Object.values(PERIOD_VALUES).flat()) {
      expect(formula).toContain(token);
    }
  });

  it('offers NO unit dropdown, because a wrong unit is not detected', async () => {
    // The distinction that matters: a wrong period is refused with a precise
    // 400, while `therms` on Electricity passes the unit-family check and
    // produces a number. One flat unit list would manufacture exactly that.
    expect(await dropdownFor('activityUnit')).toBeUndefined();
  });

  it('covers the dropdowns to the last row the importer would accept', async () => {
    // Shrinking the range to one row left every test green, and a user pastes
    // hundreds of rows in.
    const workbook = await load(await buildTemplateWorkbook(ENTITIES));
    const sheet = workbook.worksheets[0];
    const index = BULK_UPLOAD_COLUMNS.indexOf('category') + 1;
    const last = sheet.getRow(BULK_UPLOAD_MAX_ROWS + 1).getCell(index);
    expect((last.dataValidation as { type?: string } | undefined)?.type).toBe(
      'list',
    );
  });
});

describe('buildTemplateWorkbook — the worked example', () => {
  it('carries NO real entity id', async () => {
    // A `draft` occupies the reporting slot exactly as a submitted record
    // does (the uniqueness index excludes only `voided`). So an example
    // carrying a real subsidiary — copied into sheet 1, value edited but
    // period left alone — imports, and then that entity's GENUINE figure for
    // the month is refused as a duplicate until someone finds the stray.
    const workbook = await load(await buildTemplateWorkbook(ENTITIES));
    const sheet = workbook.worksheets[1];
    let exampleRow: string[] | null = null;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = cellsOf(sheet, Number(row.number));
      if (cells[0] === 'EXAMPLE') exampleRow = cells;
    });

    expect(exampleRow).not.toBeNull();
    const cells = exampleRow as unknown as string[];
    for (const subsidiary of ENTITIES.subsidiaries) {
      expect(cells).not.toContain(subsidiary.id);
    }
    expect(cells[0]).toBe('EXAMPLE');
  });

  it('is a row the importer would actually accept', async () => {
    // Swapping the value and the unit in the example left every test green —
    // and being copied is the entire reason the example exists.
    const workbook = await load(await buildTemplateWorkbook(ENTITIES));
    const sheet = workbook.worksheets[1];
    let example: string[] | null = null;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = cellsOf(sheet, Number(row.number));
      if (cells[0] === 'EXAMPLE') example = cells;
    });
    // Drop the "EXAMPLE" marker column and put a usable id back, which is
    // exactly what the sheet tells the user to do.
    const cells = (example as unknown as string[]).slice(1);
    cells[0] = ENTITIES.subsidiaries[0].id;

    const out = new ExcelJS.Workbook();
    const records = out.addWorksheet('Records');
    records.addRow([...BULK_UPLOAD_COLUMNS]);
    records.addRow(cells);
    const rows = await parseRows(
      Buffer.from(await out.xlsx.writeBuffer()),
      'copied.xlsx',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].cells.activityValue).toBe('45000');
    expect(rows[0].cells.activityUnit).toBe('kWh');
    expect(rows[0].cells.category).toBe('Electricity');
  });
});

