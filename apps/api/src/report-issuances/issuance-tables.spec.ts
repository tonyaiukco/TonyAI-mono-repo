import { describe, expect, it } from 'vitest';
import * as ExcelJS from 'exceljs';
import type { ReportDataset } from '@tonyai/shared-types';
import { complete, SUB } from '../../test/boundary-fixtures';
import { allExcludedBoundary, datasetOf, frozenBoundary, fullYear, priced, record, UNCALCULATED } from '../../test/issuance-fixtures';
import { deriveIssuance } from './issuance-gate';
import { buildIssuanceHtml, countedRecords } from './issuance-html';
import { ISSUED_CSV_COLUMNS, ISSUED_TABLES_RENDERER, issuedCsv, issuedWorkbook, type IssuedTablesDocument } from './issuance-tables';

/**
 * An issuance's Excel and CSV (LP4-03 K5): the retained dataset projected as
 * its PDF projects it. What must hold: the three formats count the same
 * records and the same tonnes; every CSV row names its issuance and dataset;
 * a withdrawn row never sums; nothing a person wrote can become a formula; and
 * the same issuance always gives the same rows.
 */

const ISSUANCE_ID = '1550a000-0000-4000-8000-000000000001';
const ISSUED_AT = '2026-10-21T12:00:00.000Z';

function doc(dataset: ReportDataset, over: Partial<IssuedTablesDocument> = {}): IssuedTablesDocument {
  const derived = deriveIssuance(dataset);
  return {
    issuanceId: ISSUANCE_ID, issuedAt: ISSUED_AT, dataset, status: derived.status, gaps: derived.gaps,
    language: 'en', template: 'ghg_protocol_detail', ...over,
  };
}

/** A year with a withdrawal, an uncalculated figure and odd tonnages. */
function mixed(): ReportDataset {
  const records = fullYear().map((r, i) => {
    if (r.id === 'r-03') return { ...r, status: 'voided' as const, voidReason: 'Duplicate of r-02', voidedBy: 'actor-v', voidedAt: '2026-10-01T00:00:00.000Z' };
    if (r.id === 'r-04') return { ...r, calculation: UNCALCULATED };
    return { ...r, calculation: priced(0.1 * (i + 1) + 0.0123) };
  });
  // The withdrawn month re-entered, as D04 asks.
  return datasetOf({ records: [...records, record('r-03b', { periodValue: 'March', calculation: priced(7.25) })] });
}

const csvRows = (csv: string) => {
  const [header, ...rows] = csv.replace(/^\uFEFF/, '').trimEnd().split('\n').map((l) => l.split(','));
  return { header, rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
};

describe('the issued CSV', () => {
  it('sums, per scope, to the retained dataset\'s figures — the PDF\'s tiles', () => {
    const dataset = mixed();
    const { rows } = csvRows(issuedCsv(doc(dataset)));
    for (const scope of [1, 2] as const) {
      const disclosed = dataset.scopes[scope - 1].tCo2e;
      const summed = rows
        .filter((r) => r.row_kind === 'counted' && r.scope === String(scope) && r.tco2e !== 'Not calculated')
        .reduce((sum, r) => sum + Number(r.tco2e), 0);
      expect(summed).toBeCloseTo(disclosed ?? 0, 9);
    }
    // Exactly the counted ids — the PDF's ledger — and the withdrawal on its own row.
    const counted = rows.filter((r) => r.row_kind === 'counted').map((r) => r.record_id);
    expect(counted).toEqual(countedRecords(dataset).map((r) => r.id));
    expect(rows.filter((r) => r.row_kind === 'withdrawn').map((r) => r.record_id)).toEqual(['r-03']);
  });

  it('carries the issuance, the dataset and its fingerprint on every row', () => {
    const dataset = mixed();
    const { header, rows } = csvRows(issuedCsv(doc(dataset)));
    expect(header).toEqual([...ISSUED_CSV_COLUMNS]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).toMatchObject({
        issuance_id: ISSUANCE_ID, dataset_id: dataset.datasetId,
        dataset_fingerprint: `sha256:${dataset.fingerprint.hex}`, issuance_status: 'partial',
      });
    }
  });

  it('never sums a withdrawn row: its aggregatable cells read Withdrawn, its values move to voided_*', () => {
    const { rows } = csvRows(issuedCsv(doc(mixed())));
    const withdrawn = rows.find((r) => r.row_kind === 'withdrawn')!;
    expect(withdrawn).toMatchObject({ tco2e: 'Withdrawn', activity_value: 'Withdrawn', voided_activity_value: '100', void_reason: 'Duplicate of r-02' });
    expect(withdrawn.voided_tco2e).toBe('1');
    expect(rows.find((r) => r.record_id === 'r-04')!.tco2e).toBe('Not calculated');
    // The ids behind the names, last (architect P3-3).
    expect(withdrawn).toMatchObject({ subsidiary_id: SUB, location_id: 'site-1' });
    expect(rows.find((r) => r.record_id === 'r-01')).toMatchObject({ subsidiary_id: SUB, location_id: 'site-1' });
    expect(rows.find((r) => r.record_id === 'g-Q1')).toMatchObject({ subsidiary_id: SUB, location_id: '' });
  });

  it('neutralises what a person wrote: a formula lead never reaches a cell raw', () => {
    const records = fullYear().map((r) => (r.id === 'r-05'
      ? { ...r, status: 'voided' as const, voidReason: '=HYPERLINK("https://example.invalid","x")', voidedAt: ISSUED_AT }
      : r));
    const csv = issuedCsv(doc(datasetOf({ records })));
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(csv).toContain("'=HYPERLINK");
  });

  it('names its issuance, dataset, fingerprint and status even with no ledger row — never a summable figure (Codex B9 P2-2)', () => {
    const excluded = allExcludedBoundary();
    const finalV1 = datasetOf({ boundary: excluded, records: [] });
    const finalV2 = datasetOf({ boundary: { ...excluded, version: 2 }, records: [] });
    const emptyExtract = datasetOf({ selection: { scope: 2 }, records: [] });
    const files = [
      issuedCsv(doc(finalV1)),
      issuedCsv(doc(finalV2, { issuanceId: '1550a000-0000-4000-8000-000000000002' })),
      issuedCsv(doc(emptyExtract, { issuanceId: '1550a000-0000-4000-8000-000000000003' })),
    ];
    expect(new Set(files).size).toBe(3);
    const expected = [
      [finalV1, ISSUANCE_ID, 'final'],
      [finalV2, '1550a000-0000-4000-8000-000000000002', 'final'],
      [emptyExtract, '1550a000-0000-4000-8000-000000000003', 'partial'],
    ] as const;
    files.forEach((csv, i) => {
      const [dataset, issuanceId, status] = expected[i];
      expect(deriveIssuance(dataset).status).toBe(status);
      const { rows } = csvRows(csv);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        issuance_id: issuanceId, dataset_id: dataset.datasetId, dataset_fingerprint: `sha256:${dataset.fingerprint.hex}`,
        issuance_status: status, row_kind: 'issuance', record_id: '', tco2e: '', activity_value: '', voided_tco2e: '',
      });
    });
  });

  it('opens every file with its issuance row, the ledger after it', () => {
    const { rows } = csvRows(issuedCsv(doc(mixed())));
    expect(rows[0].row_kind).toBe('issuance');
    expect(rows.slice(1).every((r) => r.row_kind === 'counted' || r.row_kind === 'withdrawn')).toBe(true);
    expect(rows.filter((r) => r.row_kind === 'issuance')).toHaveLength(1);
  });

  it('is the same file every time for the same issuance', () => {
    const dataset = mixed();
    expect(issuedCsv(doc(dataset))).toBe(issuedCsv(doc(dataset)));
    expect(issuedCsv(doc(dataset)).charCodeAt(0)).toBe(0xfeff);
  });
});

describe('the issued workbook', () => {
  async function load(d: IssuedTablesDocument) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await issuedWorkbook(d)) as unknown as ArrayBuffer);
    return wb;
  }
  const rowsOf = (sheet: ExcelJS.Worksheet) => {
    const out: unknown[][] = [];
    sheet.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
    return out;
  };

  it('prints the dataset\'s scope figures as numbers and counts the PDF\'s records', async () => {
    const dataset = mixed();
    const wb = await load(doc(dataset));
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Summary', 'Gaps', 'Counted records', 'Exclusions', 'Withdrawn records']);
    const summary = rowsOf(wb.getWorksheet('Summary')!);
    const scope1 = summary.find((r) => r[0] === 'Scope 1')!;
    const scope2 = summary.find((r) => r[0] === 'Scope 2')!;
    expect(scope1[1]).toBeCloseTo(dataset.scopes[0].tCo2e!, 9);
    expect(scope2[1]).toBeCloseTo(dataset.scopes[1].tCo2e!, 9);
    expect(typeof scope2[1]).toBe('number');
    const ledger = rowsOf(wb.getWorksheet('Counted records')!).slice(1);
    expect(ledger.map((r) => r[0])).toEqual(countedRecords(dataset).map((r) => r.id));
    const numeric = ledger.map((r) => r[8]).filter((v): v is number => typeof v === 'number');
    expect(numeric.reduce((a, b) => a + b, 0)).toBeCloseTo((dataset.scopes[0].tCo2e ?? 0) + (dataset.scopes[1].tCo2e ?? 0), 9);
  });

  it('names its issuance, dataset, fingerprint and renderer, and says Scope 3 is not covered', async () => {
    const dataset = mixed();
    const summary = rowsOf((await load(doc(dataset))).getWorksheet('Summary')!);
    expect(summary).toContainEqual(['Issuance', ISSUANCE_ID]);
    expect(summary).toContainEqual(['Dataset', dataset.datasetId]);
    expect(summary).toContainEqual(['Dataset fingerprint', `sha256:${dataset.fingerprint.hex}`, 'tonyai-report-dataset-v1']);
    expect(summary).toContainEqual(['Tables renderer', ISSUED_TABLES_RENDERER]);
    expect(summary).toContainEqual(['Scope 3', 'Scope 3 is not covered by this inventory.']);
  });

  it('carries the issuance\'s clock, never the request\'s (QA M17)', async () => {
    const wb = await load(doc(mixed()));
    expect(wb.created.toISOString()).toBe(ISSUED_AT);
    expect(wb.modified.toISOString()).toBe(ISSUED_AT);
  });

  it('reads an extract\'s unselected scope as the PDF does, never as 0', async () => {
    const dataset = datasetOf({ selection: { scope: 2 } });
    const summary = rowsOf((await load(doc(dataset))).getWorksheet('Summary')!);
    expect(summary.find((r) => r[0] === 'Scope 1')![1]).toBe('Not in this extract');
    expect(buildIssuanceHtml({ ...doc(dataset), options: { includeMethodologyNotes: false, includeEvidenceSummary: false } }))
      .toContain('Not in this extract');
  });

  it('follows the issuance\'s language, its figures still numbers', async () => {
    const dataset = mixed();
    const wb = await load(doc(dataset, { language: 'tr' }));
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Özet', 'Eksikler', 'Sayılan kayıtlar', 'Hariç tutulanlar', 'Geri çekilen kayıtlar']);
    const summary = rowsOf(wb.getWorksheet('Özet')!);
    expect(summary.find((r) => r[0] === 'Kapsam 2')![1]).toBeCloseTo(dataset.scopes[1].tCo2e!, 9);
    const ledger = rowsOf(wb.getWorksheet('Sayılan kayıtlar')!);
    expect(ledger.some((r) => r[2] === 'Elektrik' && r[4] === 'Ocak')).toBe(true);
    expect(ledger.some((r) => r[2] === 'Doğal gaz' && r[4] === '1. çeyrek')).toBe(true);
  });

  it('lists each gap of a partial issuance with its entity, and the boundary\'s exclusions', async () => {
    const dataset = datasetOf({ boundary: frozenBoundary(complete(), 'unconfirmed'), records: [record('r-01')] });
    const d = doc(dataset);
    expect(d.status).toBe('partial');
    const wb = await load(d);
    const gaps = rowsOf(wb.getWorksheet('Gaps')!).slice(1);
    expect(gaps).toHaveLength(d.gaps.length);
    expect(gaps.some((g) => String(g[0]).startsWith('Coverage gap: Boundary not confirmed'))).toBe(true);
    expect(rowsOf(wb.getWorksheet('Exclusions')!).length).toBeGreaterThan(1);
    expect(JSON.stringify(rowsOf(wb.getWorksheet('Exclusions')!))).toContain('Company sub-a');
    void SUB;
  });
});
