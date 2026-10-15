import { describe, expect, it, vi } from 'vitest';
import type { ReportDataset } from '@tonyai/shared-types';
import { DATASET_LIST_LIMIT, datasetRow, datasetSummary, listDatasetSummaries, readableBy, readDatasetContent } from './dataset-store';

/**
 * The retained datasets' store (LP3-04 PR C, V5, V7): the read rule, the row
 * a capture inserts — every column from the dataset itself — and the list.
 */

describe('readableBy — README: a non-empty referenced set wholly inside current access', () => {
  it('admits a set inside access', () => {
    expect(readableBy(['a', 'b'], ['a', 'b', 'c'])).toBe(true);
  });
  it('refuses one subsidiary outside it — never a redacted read', () => {
    expect(readableBy(['a', 'd'], ['a', 'b', 'c'])).toBe(false);
  });
  it('refuses an empty set: it references no one', () => {
    expect(readableBy([], ['a'])).toBe(false);
  });
});

const dataset = {
  schemaVersion: 1,
  datasetId: 'd-1',
  capturedAt: '2026-10-15T12:00:00.123Z',
  organisationId: 'org-1',
  context: { year: 2026, scope: 2 },
  selection: 'extract',
  boundary: { id: 'b-1', version: 3, decision: 'confirmed' },
  fingerprint: { algorithm: 'sha256', canonicalization: 'tonyai-report-dataset-v1', hex: 'f'.repeat(64) },
  scopes: [{ scope: 1, tCo2e: 0.30000000000000004 }],
} as unknown as ReportDataset;

describe('datasetRow', () => {
  it('takes every column from the dataset, and the exact text of it', () => {
    const row = datasetRow(dataset, ['s-1'], 'u-1');
    expect(row).toEqual({
      id: 'd-1', organisationId: 'org-1', boundaryId: 'b-1', reportingYear: 2026, selection: 'extract',
      context: { year: 2026, scope: 2 }, schemaVersion: 1, canonicalization: 'tonyai-report-dataset-v1',
      fingerprintHex: 'f'.repeat(64), referencedSubsidiaryIds: ['s-1'], capturedBy: 'u-1',
      capturedAt: new Date('2026-10-15T12:00:00.123Z'), content: JSON.stringify(dataset),
    });
    // Text, not jsonb: every double comes back as it went in.
    expect(JSON.parse(row.content).scopes[0].tCo2e).toBe(0.30000000000000004);
  });

  it('names the dataset in its summary, with its capturer', () => {
    expect(datasetSummary(dataset, 'u-1')).toEqual({
      datasetId: 'd-1', capturedAt: '2026-10-15T12:00:00.123Z', capturedBy: 'u-1', context: { year: 2026, scope: 2 },
      selection: 'extract', boundary: { id: 'b-1', version: 3, decision: 'confirmed' }, fingerprint: dataset.fingerprint,
    });
  });
});

describe('readDatasetContent', () => {
  const db = (found: { content: string; referencedSubsidiaryIds: string[] } | null) => ({
    reportDataset: { findFirst: vi.fn(async () => found) },
    $queryRaw: vi.fn(),
  });

  it("reads by id within the caller's organisation, and answers the stored text", async () => {
    const d = db({ content: '{"a":1}', referencedSubsidiaryIds: ['s-1'] });
    expect(await readDatasetContent(d as never, 'd-1', 'org-1', ['s-1'])).toBe('{"a":1}');
    expect(d.reportDataset.findFirst).toHaveBeenCalledWith({
      where: { id: 'd-1', organisationId: 'org-1' }, select: { content: true, referencedSubsidiaryIds: true },
    });
  });

  it('answers null — as for an unknown id — when a referenced subsidiary is outside access', async () => {
    expect(await readDatasetContent(db({ content: '{}', referencedSubsidiaryIds: ['s-1', 's-9'] }) as never, 'd-1', 'org-1', ['s-1'])).toBeNull();
    expect(await readDatasetContent(db(null) as never, 'd-1', 'org-1', ['s-1'])).toBeNull();
  });
});

describe('listDatasetSummaries', () => {
  it('reads nothing for a caller with no access', async () => {
    const d = { reportDataset: {}, $queryRaw: vi.fn() };
    expect(await listDatasetSummaries(d as never, 'org-1', 2026, [])).toEqual([]);
    expect(d.$queryRaw).not.toHaveBeenCalled();
  });

  it('filters by organisation, year and the subset rule in SQL, before its limit', async () => {
    const d = {
      reportDataset: {},
      $queryRaw: vi.fn(async () => [{
        id: 'd-1', captured_at: '2026-10-15T12:00:00.123Z', captured_by: 'u-1', context: { year: 2026 }, selection: 'inventory',
        boundary_id: 'b-1', version: 2, decision: 'unconfirmed', canonicalization: 'tonyai-report-dataset-v1', fingerprint_hex: 'e'.repeat(64),
      }]),
    };
    expect(await listDatasetSummaries(d as never, 'org-1', 2026, ['s-1', 's-2'])).toEqual([{
      datasetId: 'd-1', capturedAt: '2026-10-15T12:00:00.123Z', capturedBy: 'u-1', context: { year: 2026 }, selection: 'inventory',
      boundary: { id: 'b-1', version: 2, decision: 'unconfirmed' },
      fingerprint: { algorithm: 'sha256', canonicalization: 'tonyai-report-dataset-v1', hex: 'e'.repeat(64) },
    }]);
    const [strings, ...values] = d.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toMatch(/"referenced_subsidiary_ids" <@ \?::uuid\[\]/);
    expect(sql).toMatch(/d\."organisation_id" = \?::uuid\s+AND d\."reporting_year" = \?/);
    expect(sql).toMatch(/cardinality\(d\."referenced_subsidiary_ids"\) > 0/);
    expect(sql.indexOf('<@')).toBeLessThan(sql.indexOf('LIMIT'));
    expect(values).toEqual(['org-1', 2026, ['s-1', 's-2'], DATASET_LIST_LIMIT]);
    // The tag is the row's own, never assumed.
    expect(sql).toMatch(/d\."canonicalization" AS canonicalization/);
  });
});
