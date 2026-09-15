import ExcelJS from 'exceljs';
import {
  BULK_UPLOAD_COLUMNS,
  BULK_UPLOAD_MAX_ROWS,
  BULK_UPLOAD_REQUIRED_COLUMNS,
  CATEGORIES,
  CATEGORY_UNITS,
  PERIOD_VALUES,
  REPORTING_PERIODS,
  WHOLE_COMPANY_ENTITY_LABEL,
  type BulkUploadColumn,
  type Category,
} from '@tonyai/shared-types';
import { neutraliseCell } from '../common/csv-cell';

/** The reporting entities a template is built for. */
export interface TemplateEntities {
  subsidiaries: {
    id: string;
    legalName: string;
    tradingName: string | null;
    geographyCode: string;
  }[];
  locations: {
    id: string;
    subsidiaryId: string;
    name: string;
    geographyCode: string;
  }[];
  /** True when the query hit its cap, so the register below is incomplete. */
  truncated?: boolean;
}

const SHEET_RECORDS = 'Records';
const SHEET_REFERENCE = 'Reference';

/** 1-based column index of a template column, for data validation ranges. */
function columnIndex(name: BulkUploadColumn): number {
  return BULK_UPLOAD_COLUMNS.indexOf(name) + 1;
}

/**
 * An Excel inline list formula.
 *
 * Two limits it has to respect, both silent failures rather than errors:
 * Excel truncates an inline list past 255 characters, and it splits entries on
 * the comma — so a vocabulary term containing one would appear as two choices
 * neither of which is valid. Both are asserted rather than assumed, because
 * the vocabularies are free to grow.
 */
function listFormula(values: readonly string[]): string {
  const withComma = values.find((v) => v.includes(','));
  if (withComma) {
    throw new Error(
      `A dropdown value contains a comma, which Excel would split into two entries: "${withComma}"`,
    );
  }
  const formula = `"${values.join(',')}"`;
  if (formula.length > 255) {
    throw new Error(
      `A dropdown list is ${formula.length} characters; Excel truncates past 255.`,
    );
  }
  return formula;
}

/**
 * exceljs ships `worksheet.dataValidations` at runtime but omits it from its
 * `Worksheet` typings, so the range API needs a narrow declaration.
 *
 * The typed alternative is `cell.dataValidation = …`, which would mean
 * materialising three cells on every one of the thousand rows the importer
 * accepts — three thousand objects written into a file that has no data in it
 * — to say the same thing a range says once.
 */
interface RangeValidations {
  dataValidations: {
    add(range: string, validation: ExcelJS.DataValidation): void;
  };
}

/**
 * Build the downloadable import template.
 *
 * **Sheet 1 carries the nine columns and NOTHING else — not even pre-filled
 * entity rows.** That is the whole design constraint, and it is not a style
 * choice: `mapHeader` refuses any unrecognised column, so a helpful
 * `subsidiaryName` beside the id would make the template itself un-uploadable;
 * and the importer only skips rows that are blank in *every* cell, so a
 * skeleton row carrying just an id would be parsed, fail for a missing year,
 * and hand the user an error for a row they never filled in. A template whose
 * own unedited rows come back as errors is worse than no template.
 *
 * **Sheet 2 is invisible to the importer** — `readFirstWorksheet` reads the
 * workbook's first sheet and nothing else — so it is where the reference
 * data lives: which id is which entity, what geography it reports under, the
 * vocabularies, and a worked example. That asymmetry is the only reason this
 * is an XLSX and not a CSV: a CSV has one surface, so a CSV template could
 * only ever be a header plus a column of opaque ids, which is the problem the
 * template exists to solve.
 *
 * Dropdowns go on the three vocabularies where a wrong pick is always
 * DETECTED. `periodValue`'s list is flat across granularities, so it does
 * offer `January` to an annual row — but `requireCanonicalPeriodValue` refuses
 * that with a precise 400, and the three vocabularies are disjoint, so the
 * user is never silently wrong.
 *
 * `activityUnit` deliberately gets none, and the distinction is the point: its
 * valid values depend on the category in the same row, and a wrong pick there
 * is not detected — `therms` on Electricity passes the unit-FAMILY check and
 * produces a number. That is the silent wrong figure `CATEGORY_UNITS` was
 * written to prevent, so the units are listed per category on sheet 2 instead
 * of offered as one flat list.
 */
export async function buildTemplateWorkbook(
  entities: TemplateEntities,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TonyAI';
  workbook.created = new Date();

  // -- Sheet 1: exactly the importer's columns -------------------------------
  const records = workbook.addWorksheet(SHEET_RECORDS);
  const header = records.addRow([...BULK_UPLOAD_COLUMNS]);
  header.font = { bold: true };
  header.eachCell((cell, index) => {
    const column = BULK_UPLOAD_COLUMNS[index - 1];
    const required = (
      BULK_UPLOAD_REQUIRED_COLUMNS as readonly string[]
    ).includes(column);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: required ? 'FFD1FAE5' : 'FFF3F4F6' },
    };
    records.getColumn(index).width = Math.max(column.length + 4, 14);
  });
  records.views = [{ state: 'frozen', ySplit: 1 }];

  // Applied over the row cap, so the dropdowns still work on the last row the
  // importer would accept.
  const lastRow = BULK_UPLOAD_MAX_ROWS + 1;
  // Typed to the column union, not to `string`: a typo used to make
  // `getColumn(0)` return undefined and 500 the whole download at runtime.
  const dropdowns: [BulkUploadColumn, readonly string[]][] = [
    ['reportingPeriod', REPORTING_PERIODS],
    ['periodValue', Object.values(PERIOD_VALUES).flat()],
    ['category', CATEGORIES],
  ];
  for (const [column, values] of dropdowns) {
    const letter = records.getColumn(columnIndex(column)).letter;
    const validations = (records as unknown as Partial<RangeValidations>)
      .dataValidations;
    // Degrade to a template without dropdowns rather than 500 every download:
    // the property is absent from exceljs's typings, so a rename would be
    // invisible to `tsc` and fatal at runtime.
    if (typeof validations?.add !== 'function') continue;
    validations.add(
      `${letter}2:${letter}${lastRow}`,
      {
        type: 'list',
        allowBlank: true,
        formulae: [listFormula(values)],
      },
    );
  }

  // -- Sheet 2: everything the importer must never see -----------------------
  const reference = workbook.addWorksheet(SHEET_REFERENCE);
  reference.getColumn(1).width = 40;
  reference.getColumn(2).width = 40;
  reference.getColumn(3).width = 28;
  reference.getColumn(4).width = 16;

  function section(title: string): void {
    reference.addRow([]);
    const row = reference.addRow([title]);
    row.font = { bold: true, size: 12 };
  }

  function head(cells: string[]): void {
    const row = reference.addRow(cells);
    row.font = { bold: true };
  }

  /**
   * Every tenant-written cell goes through the export neutraliser.
   *
   * Defence in depth, NOT the mechanism — measured rather than assumed. OOXML
   * evaluates `<f>` elements, and exceljs emits one only for an explicit
   * `{ formula }` value, so a string cell containing `=1+1` is inert when the
   * workbook is opened: the generated file carries zero `<f>` elements. The
   * call stays because this file is routinely re-saved as CSV, where #81's
   * hole is real.
   *
   * It is applied to ids as well as names, which is currently harmless and
   * would not be if the id columns stopped being `uuid`: a neutralised value
   * reaches the importer verbatim, so a leading apostrophe on an id that could
   * start with `=+-@` would come back as a 404 on the row the user copied it
   * into.
   */
  function text(value: string | null | undefined): string {
    return neutraliseCell(value ?? '');
  }

  const first = reference.addRow(['How to use this template']);
  first.font = { bold: true, size: 14 };
  reference.addRow([
    `Fill in the "${SHEET_RECORDS}" sheet. Every column there is required except locationId and varianceReason.`,
  ]);
  reference.addRow([
    `Leave locationId blank to report for the whole company (shown below as "${WHOLE_COMPANY_ENTITY_LABEL}").`,
  ]);
  reference.addRow([
    `This sheet is ignored on upload, so you can keep notes here. Do not rename or reorder the columns on "${SHEET_RECORDS}" — the import refuses a file whose header it does not recognise.`,
  ]);
  reference.addRow([
    `Up to ${BULK_UPLOAD_MAX_ROWS} rows per file. Imported rows arrive as drafts: they are not counted towards any total and do not appear in the review queue until they are submitted.`,
  ]);

  section('Your reporting entities');
  head(['subsidiaryId', 'Subsidiary', 'locationId', 'Location', 'Geography']);
  if (entities.truncated) {
    // Said out loud, because a register that quietly omits a site sends the
    // user hunting for an id that exists.
    reference.addRow([
      'This list was truncated because your organisation has more reporting entities than one template can carry. Entities missing here can still be imported — ask an administrator for the ids.',
    ]);
  }
  if (entities.subsidiaries.length === 0) {
    // A legitimate state — a brand-new tenant, or an account with no grants
    // yet — and a bare header would read like a broken download.
    reference.addRow([
      'No reporting entities are available to your account yet. Ask an administrator for access, then download the template again.',
    ]);
  }
  const locationsBySubsidiary = new Map<string, TemplateEntities['locations']>();
  for (const location of entities.locations) {
    const list = locationsBySubsidiary.get(location.subsidiaryId) ?? [];
    list.push(location);
    locationsBySubsidiary.set(location.subsidiaryId, list);
  }
  for (const subsidiary of entities.subsidiaries) {
    const name = subsidiary.tradingName
      ? `${subsidiary.legalName} (${subsidiary.tradingName})`
      : subsidiary.legalName;
    reference.addRow([
      text(subsidiary.id),
      text(name),
      '',
      WHOLE_COMPANY_ENTITY_LABEL,
      text(subsidiary.geographyCode),
    ]);
    for (const location of locationsBySubsidiary.get(subsidiary.id) ?? []) {
      reference.addRow([
        text(subsidiary.id),
        text(name),
        text(location.id),
        text(location.name),
        text(location.geographyCode),
      ]);
    }
  }

  section('Units, by category');
  head(['category', 'Accepted units']);
  for (const category of CATEGORIES) {
    const units = CATEGORY_UNITS[category as Category];
    reference.addRow([
      category,
      units
        ? units.join(', ')
        : 'No emission factor is seeded for this category yet, so its unit is not constrained.',
    ]);
  }

  section('Periods');
  head(['reportingPeriod', 'Accepted periodValue']);
  for (const period of REPORTING_PERIODS) {
    reference.addRow([period, PERIOD_VALUES[period].join(', ')]);
  }

  // A worked example, with NO real entity id in it.
  //
  // The whole affordance of an example is that it gets copied into sheet 1 —
  // and a `draft` occupies the reporting slot exactly as a submitted record
  // does (the uniqueness index excludes only `voided`). So an example carrying
  // a real subsidiary, edited in the value but not in the period, imports and
  // then refuses that entity's GENUINE figure for the month as a duplicate
  // until someone finds and deletes the stray. CLAUDE.md is explicit that a
  // placeholder must be labelled as one rather than left to look authoritative.
  section('A worked example — replace every value before you use it');
  head(['', ...BULK_UPLOAD_COLUMNS]);
  reference.addRow([
    'EXAMPLE',
    '<paste a subsidiaryId from the table above>',
    '',
    2024,
    'monthly',
    'January',
    'Electricity',
    45000,
    'kWh',
    '',
  ]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
