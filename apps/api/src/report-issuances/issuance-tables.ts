import * as ExcelJS from 'exceljs';
import { IntlMessageFormat } from 'intl-messageformat';
import {
  isCalculated,
  LOCALE_FORMAT_TAGS,
  type Locale,
  type ReportDataset,
  type ReportDatasetRecord,
  type ReportIssuanceGap,
  type ReportTemplate,
} from '@tonyai/shared-types';
import { csvField, type CellValue } from '../common/csv-cell';
import { NOT_CALCULATED, WITHDRAWN } from '../common/report-markers';
import {
  countedRecords,
  coverageGapLabel,
  datasetNames,
  ISSUANCE_CATALOGUES,
  namedExclusions,
  scopeReading,
  withdrawnRecords,
  type IssuanceMessageKey,
} from './issuance-html';

/**
 * An issuance's Excel and CSV (LP4-03 K5; README "Issued reports"): the
 * RETAINED dataset projected exactly as the issued PDF projects it — the same
 * counted records (the scopes' `countedRecordIds`, never a live read), the same
 * figures, gaps, exclusions and withdrawals. Pure functions of the issuance and
 * its verified dataset: written on request, never stored, and the same
 * issuance always yields the same rows and figures — so the three formats of
 * one issuance reconcile by construction, and none can drift with live data.
 *
 * The workbook follows the issuance's language (D16) with numeric figures; the
 * CSV keeps English machine headers and dot-decimal figures, carries the
 * issuance, the dataset and its fingerprint on EVERY row (a row copied out of
 * the file still says where it came from), and neutralises every cell
 * (`csvField`). A withdrawn row shares the CSV's one table, so its aggregatable
 * cells read `Withdrawn` and its values move to the `voided_*` columns — the
 * live CSV's rule (`report-columns.ts`), so a SUM over `tco2e` is the
 * issuance's counted total.
 */

export const ISSUED_TABLES_RENDERER = 'tonyai-issuance-tables-v1';

export interface IssuedTablesDocument {
  issuanceId: string;
  issuedAt: string;
  dataset: ReportDataset;
  status: 'final' | 'partial';
  gaps: readonly ReportIssuanceGap[];
  language: Locale;
  template: ReportTemplate;
}

const GAP_KEY: Record<ReportIssuanceGap['code'], IssuanceMessageKey> = {
  filtered_extract: 'gapFilteredExtract',
  coverage_gap: 'gapCoverageGap',
  unapproved_record: 'gapUnapprovedRecord',
  unlocked_period: 'gapUnlockedPeriod',
  non_authoritative_calculation: 'gapNonAuthoritativeCalculation',
  gwp_set_mismatch: 'gapGwpSetMismatch',
};
const RECORD_STATUS_KEY: Record<string, IssuanceMessageKey> = {
  submitted: 'recordSubmitted', under_review: 'recordUnderReview', approved: 'recordApproved', locked: 'recordLocked',
};
const STANDING_KEY: Record<string, IssuanceMessageKey> = {
  authoritative: 'standingAuthoritative', non_authoritative: 'standingNonAuthoritative',
  uncalculated: 'standingUncalculated', legacy: 'standingLegacy',
};

const figureOf = (r: ReportDatasetRecord): number | null => (isCalculated(r.calculation) ? r.calculation.tCo2e : null);

/** The CSV's columns — appended, never inserted, from the first version on. */
export const ISSUED_CSV_COLUMNS = [
  'issuance_id', 'dataset_id', 'dataset_fingerprint', 'issuance_status', 'row_kind', 'record_id',
  'subsidiary', 'reporting_entity', 'category', 'activity_type', 'scope', 'reporting_period', 'period_value',
  'status', 'activity_value', 'activity_unit', 'tco2e', 'factor_standing',
  'voided_activity_value', 'voided_tco2e', 'voided_at_utc', 'void_reason',
  // The ids behind the names: a name is the record's or the boundary's as captured, an id never moves.
  'subsidiary_id', 'location_id',
] as const;

export function issuedCsv(doc: IssuedTablesDocument): string {
  const { dataset } = doc;
  const names = datasetNames(dataset);
  const standing = new Map(dataset.provenance.records.map((p) => [p.recordId, p.standing]));
  const identity = [doc.issuanceId, dataset.datasetId, `${dataset.fingerprint.algorithm}:${dataset.fingerprint.hex}`, doc.status];
  const common = (r: ReportDatasetRecord): CellValue[] => [
    r.id, r.subsidiaryName, names.entity(r.subsidiaryId, r.locationId, r), r.category, r.activityType ?? '', r.scope,
    r.reportingPeriod, r.periodValue, r.status,
  ];
  // The document's own row, first and always: an issuance with no counted or
  // withdrawn record (an all-excluded final, an empty extract) still names its
  // issuance, dataset, fingerprint and status — every other cell empty, so it
  // adds nothing to a sum (Codex's B9 P2-2 on LP4-03 PR A).
  const document: CellValue[] = [...identity, 'issuance', ...Array(ISSUED_CSV_COLUMNS.length - identity.length - 1).fill('')];
  const rows: CellValue[][] = [
    document,
    ...countedRecords(dataset).map((r) => [
      ...identity, 'counted', ...common(r),
      r.activityValue, r.activityUnit, figureOf(r) ?? NOT_CALCULATED, standing.get(r.id) ?? 'uncalculated',
      '', '', '', '',
      r.subsidiaryId, r.locationId ?? '',
    ]),
    ...withdrawnRecords(dataset).map((r) => [
      ...identity, 'withdrawn', ...common(r),
      WITHDRAWN, r.activityUnit, WITHDRAWN, '',
      r.activityValue, figureOf(r) ?? NOT_CALCULATED, r.voidedAt ?? '', r.voidReason ?? '',
      r.subsidiaryId, r.locationId ?? '',
    ]),
  ];
  // U+FEFF, as the live CSV: a double-clicked file otherwise mojibakes Turkish names.
  return String.fromCharCode(0xfeff) + [[...ISSUED_CSV_COLUMNS], ...rows].map((row) => row.map(csvField).join(',')).join('\n') + '\n';
}

export async function issuedWorkbook(doc: IssuedTablesDocument): Promise<Buffer> {
  const { dataset, language } = doc;
  const messages = ISSUANCE_CATALOGUES[language];
  const t = (key: IssuanceMessageKey, values?: Record<string, string | number>): string =>
    String(new IntlMessageFormat(messages[key], LOCALE_FORMAT_TAGS[language]).format(values));
  const label = (prefix: 'category' | 'period', value: string): string => {
    const key = `${prefix} ${value}` as IssuanceMessageKey;
    return key in messages ? messages[key] : value;
  };
  const names = datasetNames(dataset);
  const standing = new Map(dataset.provenance.records.map((p) => [p.recordId, p.standing]));
  const final = doc.status === 'final';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'TonyAI';
  // The issuance's own clock, never the request's: the same issuance, the same workbook.
  wb.created = new Date(doc.issuedAt);
  wb.modified = new Date(doc.issuedAt);

  const scopeCell = (s: ReportDataset['scopes'][0] | ReportDataset['scopes'][1]): CellValue => {
    const r = scopeReading(dataset, s);
    if (r.kind === 'not_in_extract') return t('scopeNotInExtract');
    if (r.kind === 'no_source') return t('scopeNoSource');
    return r.tCo2e ?? t('notCalculated');
  };
  const [scope1, scope2] = dataset.scopes;
  const summary = wb.addWorksheet(t('sheetSummary'));
  summary.addRows([
    [doc.template === 'executive_summary' ? t('titleExecutiveSummary') : t('titleGhgProtocolDetail')],
    [t('organisation'), dataset.organisationName],
    [t('reportingYear'), dataset.boundary.reportingYear],
    [t('rowStatus'), final ? t('statusFinal') : t('statusPartial'),
      final ? t('statusFinalNote') : t('statusPartialNote', { count: doc.gaps.length })],
    [t('rowSelection'), dataset.selection === 'inventory' ? t('selectionInventory') : t('selectionExtract')],
    [t('rowBoundary'), t('boundaryVersion', { version: dataset.boundary.version }),
      dataset.boundary.decision === 'confirmed' ? t('decisionConfirmed') : t('decisionUnconfirmed')],
    [],
    [t('scope', { scope: 1 }), scopeCell(scope1), t('countedRecords', { count: scope1.countedRecordIds.length })],
    [t('scope', { scope: 2 }), scopeCell(scope2), t('countedRecords', { count: scope2.countedRecordIds.length })],
    [t('rowScope3'), t('scope3NotCovered')],
    [],
    [t('identityHeading')],
    [t('identityIssuance'), doc.issuanceId],
    [t('identityDataset'), dataset.datasetId],
    [t('identityFingerprint'), `${dataset.fingerprint.algorithm}:${dataset.fingerprint.hex}`, dataset.fingerprint.canonicalization],
    [t('identityCaptured'), dataset.capturedAt],
    [t('identityIssued'), doc.issuedAt],
    [t('identityTables'), ISSUED_TABLES_RENDERER],
    [t('tablesNote')],
  ]);

  // Always present, even when empty, as the live workbook's sheets: a sheet
  // list that depends on the data cannot be read by anything automated.
  const gaps = wb.addWorksheet(t('sheetGaps'));
  gaps.addRow([t('colGap'), t('colEntity'), t('colCategory'), t('colSources'), t('colObligations'), t('colRecords')]);
  for (const g of doc.gaps) {
    gaps.addRow([
      g.code === 'coverage_gap' && g.coverageCode !== undefined
        ? `${t('gapCoverageGap')}: ${coverageGapLabel(g.coverageCode, language)}`
        : t(GAP_KEY[g.code]),
      g.entity === undefined ? '' : names.entity(g.entity.subsidiaryId, g.entity.locationId),
      g.category === undefined ? '' : label('category', g.category),
      g.sourceIds.length, g.obligationIds.length, g.recordIds.length,
    ]);
  }

  const ledger = wb.addWorksheet(t('sheetLedger'));
  ledger.addRow([t('colRecordId'), t('colEntity'), t('colCategory'), t('colScope'), t('colPeriod'), t('colStatus'),
    t('colActivityValue'), t('colUnit'), t('colEmissions'), t('colStanding')]);
  for (const r of countedRecords(dataset)) {
    ledger.addRow([
      r.id, names.entity(r.subsidiaryId, r.locationId, r), label('category', r.category), r.scope,
      label('period', r.periodValue),
      RECORD_STATUS_KEY[r.status] === undefined ? r.status : t(RECORD_STATUS_KEY[r.status]),
      r.activityValue, r.activityUnit, figureOf(r) ?? t('notCalculated'),
      t(STANDING_KEY[standing.get(r.id) ?? 'uncalculated']),
    ]);
  }

  const exclusions = wb.addWorksheet(t('sheetExclusions'));
  exclusions.addRow([t('colEntity'), t('colSource'), t('colCategory'), t('colReason')]);
  for (const x of namedExclusions(dataset)) {
    exclusions.addRow([
      names.entity(x.subsidiaryId, x.locationId), x.sourceName ?? '',
      x.category === null ? '' : label('category', x.category), x.reason,
    ]);
  }

  const withdrawn = wb.addWorksheet(t('sheetWithdrawn'));
  withdrawn.addRow([t('colRecordId'), t('colEntity'), t('colCategory'), t('colPeriod'), t('colActivityValue'), t('colUnit'),
    t('colEmissions'), t('colReason')]);
  for (const r of withdrawnRecords(dataset)) {
    withdrawn.addRow([
      r.id, names.entity(r.subsidiaryId, r.locationId, r), label('category', r.category), label('period', r.periodValue),
      r.activityValue, r.activityUnit, figureOf(r) ?? t('notCalculated'), r.voidReason ?? '',
    ]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
