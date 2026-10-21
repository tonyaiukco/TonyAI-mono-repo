import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@tonyai/db';
import { ISSUANCE_LIST_LIMIT, readIssuanceRows, toIssuance, type IssuanceRow } from './issuance-store';

/**
 * The issuances' read rule, in SQL (LP3-04 PR D; `security-rls` F1): the
 * caller's organisation, then a non-empty referenced set wholly inside the
 * caller's current access — applied before the limit, so an unreadable
 * issuance never takes a readable one's place. Pinned here because every
 * reader role but data_entry is organisation-wide today, so the int spec alone
 * would not notice the subset rule gone.
 */

const query = () => ({ $queryRaw: vi.fn(async () => [] as IssuanceRow[]) });
const sqlOf = (d: ReturnType<typeof query>) => {
  const [strings, ...values] = d.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
  return { sql: strings.join('?'), values };
};
const fragment = (value: unknown) => (value as Prisma.Sql).strings.join('?');

describe('readIssuanceRows', () => {
  it('reads nothing for a caller with no access', async () => {
    const d = query();
    expect(await readIssuanceRows(d as never, 'org-1', [], { year: 2026 })).toEqual([]);
    expect(await readIssuanceRows(d as never, 'org-1', [], { id: 'i-1' })).toEqual([]);
    expect(d.$queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    ['a year', { year: 2026 }, 'i."reporting_year" = ?', 2026],
    ['one id', { id: 'i-1' }, 'i."id" = ?::uuid', 'i-1'],
  ] as const)('reads %s under the organisation and the subset rule, before the limit', async (_what, which, filter, value) => {
    const d = query();
    await readIssuanceRows(d as never, 'org-1', ['s-1', 's-2'], which);
    const { sql, values } = sqlOf(d);
    expect(sql).toMatch(/WHERE i\."organisation_id" = \?::uuid\s+AND \?\s+AND pg_catalog\.cardinality\(i\."referenced_subsidiary_ids"\) > 0\s+AND i\."referenced_subsidiary_ids" <@ \?::uuid\[\]/);
    expect(sql.indexOf('<@')).toBeLessThan(sql.indexOf('LIMIT'));
    expect(sql).toMatch(/ORDER BY i\."issued_at" DESC, i\."id" DESC\s+LIMIT \?$/);
    expect(values).toEqual(['org-1', expect.anything(), ['s-1', 's-2'], ISSUANCE_LIST_LIMIT]);
    expect(fragment(values[1])).toBe(filter);
    expect((values[1] as Prisma.Sql).values).toEqual([value]);
    // The object's key is read for the download only; the contract's shape drops it.
    expect(sql).toMatch(/i\."storage_path" AS storage_path/);
  });
});

describe('toIssuance', () => {
  const row: IssuanceRow = {
    id: 'i-1', organisation_id: 'org-1', dataset_id: 'd-1', reporting_year: 2026, canonicalization: 'tonyai-report-dataset-v1',
    dataset_fingerprint_hex: 'e'.repeat(64), status: 'final', gaps: [], language: 'tr', template: 'executive_summary',
    include_methodology_notes: true, include_evidence_summary: false, renderer_version: 'r', artifact_id: 'a-1',
    storage_path: 'org-1/a-1.pdf', size_bytes: 10, sha256: 'f'.repeat(64), issued_by: 'u-1', issued_at: '2026-10-21T12:00:00.000Z',
  };

  it('maps a row to the contract — fingerprints tagged, the artifact opaque, the key dropped', () => {
    const issued = toIssuance(row);
    expect(issued).toEqual({
      issuanceId: 'i-1', organisationId: 'org-1', datasetId: 'd-1',
      datasetFingerprint: { algorithm: 'sha256', canonicalization: 'tonyai-report-dataset-v1', hex: 'e'.repeat(64) },
      issuedAt: '2026-10-21T12:00:00.000Z', issuedBy: 'u-1', language: 'tr', template: 'executive_summary', rendererVersion: 'r',
      options: { includeMethodologyNotes: true, includeEvidenceSummary: false },
      pdf: { artifactId: 'a-1', mimeType: 'application/pdf', sizeBytes: 10, fingerprint: { algorithm: 'sha256', hex: 'f'.repeat(64) } },
      status: 'final', gaps: [],
    });
    expect(JSON.stringify(issued)).not.toContain('org-1/a-1.pdf');
  });

  it('keeps a partial\'s gaps as stored', () => {
    const gaps = [{ code: 'filtered_extract' as const, sourceIds: [], obligationIds: [], recordIds: [] }];
    expect(toIssuance({ ...row, status: 'partial', gaps })).toMatchObject({ status: 'partial', gaps });
  });
});
