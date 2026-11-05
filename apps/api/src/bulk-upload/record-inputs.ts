import {
  ACTIVITY_VALUE_MAX,
  BULK_EQUIPMENT_COLUMNS,
  BULK_GAS_PARAMETER_COLUMNS,
  EQUIPMENT_TYPES,
  EQUIPMENT_TYPES_WITH_ALTERNATIVE,
  LEAK_RATE_CHOICES,
  REPORTING_PERIODS,
  canonicalPeriodValue,
  type BulkUploadColumn,
  type BulkUploadRowIssue,
  type EquipmentType,
  type LeakRateChoice,
  type NaturalGasRecordParameters,
  type RefrigerantEquipmentLine,
  type ReportingPeriod,
} from '@tonyai/shared-types';
import { quoteCallerText } from '../common/caller-text';
import { isCommaFigure, strictNumber, type ParsedRow } from './parse-rows';

/**
 * A record's calculation inputs read from a file (LP4-02 PR4, D3): the Natural
 * Gas columns of one row, or a refrigerant record's equipment lines, one file
 * row each (D7). Read as strictly as the activity value: dot-decimal only, a
 * blank never a zero. What these accept is then checked again by the record's
 * own DTO and service, so this is where a row learns WHICH cell is wrong.
 */

/** A refused cell, on the row that holds it. */
export type CellIssue = Omit<BulkUploadRowIssue, 'row'> & { row?: number };

/**
 * One record the importer writes: a file row, or the equipment lines of one
 * refrigerant record (`lines`, in file order, the first being this row).
 */
export interface RecordRow extends ParsedRow {
  lines?: ParsedRow[];
}

/** A Refrigerants row that carries an equipment line (D7). */
export function isEquipmentLine(cells: ParsedRow['cells']): boolean {
  return cells.category.trim() === 'Refrigerants' && BULK_EQUIPMENT_COLUMNS.some((c) => cells[c].trim() !== '');
}

/**
 * Which record an equipment line belongs to: the slot's columns and the gas.
 * Ids compare case-blind, the year as a number and the period value
 * canonically, so two spellings of
 * one record are one group; a spelling the DTO refuses keeps a group of its
 * own and is refused there, never merged into another record.
 */
function recordKey(cells: ParsedRow['cells']): string {
  const period = cells.reportingPeriod.trim();
  const value = cells.periodValue.trim();
  const canonical = (REPORTING_PERIODS as readonly string[]).includes(period)
    ? canonicalPeriodValue(period as ReportingPeriod, value)
    : null;
  return JSON.stringify([
    cells.subsidiaryId.trim().toLowerCase(),
    cells.locationId.trim().toLowerCase(),
    // As the DTO reads it: `2025`, `2025.0` and `02025` are one year, so
    // they are one record, never a record split into two that each understate.
    strictNumber(cells.reportingYear) ?? cells.reportingYear.trim(),
    period,
    canonical ?? value,
    cells.activityType.trim(),
  ]);
}

/**
 * Group a refrigerant's equipment lines into its one record, BEFORE the
 * duplicate check: two lines of one gas are one record, not a duplicate (D7).
 * Membership is by the record's key, not by a filled equipment cell: once any
 * row of a gas's record is an equipment line, every Refrigerants row with that
 * key joins it, so a sibling written the old way or left blank fails the whole
 * record instead of splitting off and letting part of it be written (Codex
 * review of #281). A record no row of which is an equipment line stays as it
 * was, one row each. The record sits where its first row was; every other row
 * keeps its place.
 */
export function groupEquipmentLines(rows: readonly ParsedRow[]): RecordRow[] {
  const isRefrigerant = (row: ParsedRow) => row.cells.category.trim() === 'Refrigerants';
  const lineKeys = new Set(rows.filter((row) => isEquipmentLine(row.cells)).map((row) => recordKey(row.cells)));
  const records: RecordRow[] = [];
  const groups = new Map<string, RecordRow>();
  for (const row of rows) {
    const key = isRefrigerant(row) ? recordKey(row.cells) : null;
    if (key === null || !lineKeys.has(key)) {
      records.push(row);
      continue;
    }
    const group = groups.get(key);
    if (group) {
      group.lines!.push(row);
      continue;
    }
    const record: RecordRow = { ...row, lines: [row] };
    groups.set(key, record);
    records.push(record);
  }
  return records;
}

/**
 * A number cell: dot-decimal, finite, in range. `required` refuses a blank;
 * otherwise a blank is null, the input left out.
 */
function numberCell(
  cells: ParsedRow['cells'],
  column: BulkUploadColumn,
  rule: { positive: boolean; max: number; required?: boolean },
): { value: number | null } | { issue: CellIssue } {
  const raw = cells[column];
  if (raw.trim() === '') {
    return rule.required
      ? { issue: { column, code: 'invalid', message: `${column} is required on an equipment line. Write 0 for none.` } }
      : { value: null };
  }
  const value = strictNumber(raw);
  if (value === null) {
    return isCommaFigure(raw)
      ? {
          issue: {
            column,
            code: 'wrong_decimal_separator',
            message: `"${quoteCallerText(raw)}" uses a comma. Write the figure with a point for decimals and no thousands separator, such as 1234.5.`,
          },
        }
      : { issue: { column, code: 'invalid', message: `"${quoteCallerText(raw)}" is not a number. Use a plain figure with no thousands separator.` } };
  }
  if (rule.positive ? value <= 0 : value < 0) {
    return { issue: { column, code: 'invalid', message: `${column} must be ${rule.positive ? 'above zero' : 'zero or more'}.` } };
  }
  if (value > rule.max) {
    return { issue: { column, code: 'invalid', message: `${column} must be at most ${rule.max}.` } };
  }
  return { value };
}

/** The shape CHECK's upper bound for a calorific value or a correction factor. */
const GAS_INPUT_MAX = 1e300;

/** The first filled column of `columns`, or null. */
function firstFilled(cells: ParsedRow['cells'], columns: readonly BulkUploadColumn[]): BulkUploadColumn | null {
  return columns.find((c) => cells[c].trim() !== '') ?? null;
}

function notThisCategory(column: BulkUploadColumn, category: string): CellIssue {
  return {
    column,
    code: 'invalid',
    message: `${column} applies to ${category} rows only. Leave it blank on this row.`,
  };
}

/**
 * A row's Natural Gas inputs (D3, D5): null when it carries none. Whether the
 * row's unit and geography take them is the engine's answer, on the row.
 */
export function gasParametersOf(
  cells: ParsedRow['cells'],
): { parameters: NaturalGasRecordParameters | null } | { issue: CellIssue } {
  const filled = firstFilled(cells, BULK_GAS_PARAMETER_COLUMNS);
  const equipment = firstFilled(cells, BULK_EQUIPMENT_COLUMNS);
  if (equipment !== null) return { issue: notThisCategory(equipment, 'Refrigerants') };
  if (filled === null) return { parameters: null };
  if (cells.category.trim() !== 'Natural Gas') return { issue: notThisCategory(filled, 'Natural Gas') };
  const parameters: NaturalGasRecordParameters = {};
  for (const column of BULK_GAS_PARAMETER_COLUMNS) {
    const read = numberCell(cells, column, { positive: true, max: GAS_INPUT_MAX });
    if ('issue' in read) return read;
    if (read.value !== null) parameters[column] = read.value;
  }
  if (parameters.ncvKcalPerSm3 !== undefined && parameters.billedGcvKcalPerSm3 !== undefined) {
    return {
      issue: {
        column: 'billedGcvKcalPerSm3',
        code: 'invalid',
        message: 'Give either ncvKcalPerSm3 or billedGcvKcalPerSm3 on a row, not both.',
      },
    };
  }
  return { parameters };
}

/** The columns every line of one record must state alike: the record's own. */
const RECORD_LEVEL_COLUMNS = ['activityUnit', 'varianceReason'] as const satisfies readonly BulkUploadColumn[];

/**
 * A refrigerant record's equipment lines (D7) and its quantity, the sum of
 * their capacities, summed in the engine's order. The first refused cell is
 * the record's one issue, on the line that holds it: a record is written whole
 * or not at all, since a line left out would understate the leak.
 */
export function equipmentOf(
  lines: readonly ParsedRow[],
): { total: number; equipment: RefrigerantEquipmentLine[] } | { issue: CellIssue } {
  const first = lines[0];
  const equipment: RefrigerantEquipmentLine[] = [];
  const seen = new Map<string, number>();
  for (const { row, cells } of lines) {
    const fail = (issue: CellIssue) => ({ issue: { ...issue, row } });
    if (cells.activityValue.trim() !== '') {
      return fail({
        column: 'activityValue',
        code: 'invalid',
        message: "Leave activityValue blank on an equipment line: the record's quantity is the sum of its capacityKg.",
      });
    }
    const gas = firstFilled(cells, BULK_GAS_PARAMETER_COLUMNS);
    if (gas !== null) return fail(notThisCategory(gas, 'Natural Gas'));
    for (const column of RECORD_LEVEL_COLUMNS) {
      if (cells[column].trim() !== first.cells[column].trim()) {
        return fail({
          column,
          code: 'invalid',
          message: `Every line of one gas's record states the same ${column}; this one differs from row ${first.row}.`,
        });
      }
    }
    const type = cells.equipmentType.trim();
    if (!(EQUIPMENT_TYPES as readonly string[]).includes(type)) {
      return fail({
        column: 'equipmentType',
        code: 'invalid',
        message: `${type === '' ? 'equipmentType is required on an equipment line' : `"${quoteCallerText(type)}" is not an equipment type`}. Use one of: ${EQUIPMENT_TYPES.join(', ')}.`,
      });
    }
    const earlier = seen.get(type);
    if (earlier !== undefined) {
      return fail({
        column: 'equipmentType',
        code: 'invalid',
        message: `Row ${earlier} already lists ${type} for this gas. Write one line per equipment type, with its total capacity.`,
      });
    }
    seen.set(type, row);
    const capacity = numberCell(cells, 'capacityKg', { positive: false, max: ACTIVITY_VALUE_MAX, required: true });
    if ('issue' in capacity) return fail(capacity.issue);
    const refill = numberCell(cells, 'refillKg', { positive: false, max: ACTIVITY_VALUE_MAX, required: true });
    if ('issue' in refill) return fail(refill.issue);
    if (capacity.value === 0 && refill.value === 0) {
      return fail({ column: 'capacityKg', code: 'invalid', message: 'An equipment line needs a capacity, a refill, or both.' });
    }
    const choice = cells.leakRateChoice.trim() === '' ? 'default' : cells.leakRateChoice.trim();
    if (!(LEAK_RATE_CHOICES as readonly string[]).includes(choice)) {
      return fail({
        column: 'leakRateChoice',
        code: 'invalid',
        message: `"${quoteCallerText(choice)}" is not a leak rate choice. Use ${LEAK_RATE_CHOICES.join(' or ')}, or leave it blank for the default.`,
      });
    }
    if (choice === 'alternative' && !EQUIPMENT_TYPES_WITH_ALTERNATIVE.includes(type as EquipmentType)) {
      return fail({
        column: 'leakRateChoice',
        code: 'invalid',
        message: `${type} has no alternative leak rate. Leave leakRateChoice blank or write default.`,
      });
    }
    equipment.push({
      equipmentType: type as EquipmentType,
      capacityKg: capacity.value as number,
      refillKg: refill.value as number,
      leakRateChoice: choice as LeakRateChoice,
    });
  }
  return { total: equipment.reduce((sum, line) => sum + line.capacityKg, 0), equipment };
}
