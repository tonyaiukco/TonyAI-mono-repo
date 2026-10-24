import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@tonyai/db';
import type { InventoryBoundarySnapshot, ReportDataset, UserRole } from '@tonyai/shared-types';
import { complete } from '../../test/boundary-fixtures';
import { allLocks, datasetOf, frozenBoundary, rowOf } from '../../test/issuance-fixtures';
import type { RequestUser } from '../auth/auth.types';
import { errorCodeOf, toErrorBody } from '../common/api-error';
import { REPORT_ARTIFACTS_BUCKET } from '../storage/buckets';
import { UploadExpiredError } from '../storage/storage-intents.service';
import { StorageObjectMissingError } from '../storage/storage.service';
import type { IssuanceRow } from './issuance-store';
import { ISSUANCE_RENDERER } from './issuance-html';
import { ReportIssuancesService } from './report-issuances.service';

/**
 * The issuance service (LP3-04 PR D) without a database: the read rule and
 * roles (W3, W4), the gate's refusals before anything is rendered, and the
 * retained PDF's recovery — the intent begun before the bytes, adopted FIRST
 * in the row's transaction, abandoned on every failure (LP1-02). Real
 * PostgreSQL and Storage: test/int/report-issuance.int.spec.ts.
 */

const boundaryRead = vi.hoisted(() => ({ current: null as InventoryBoundarySnapshot | null }));
vi.mock('../inventory-boundary/boundary-reader', () => ({
  readInventoryBoundary: vi.fn(async () => boundaryRead.current),
}));
vi.mock('../common/capture-snapshot', () => ({
  CaptureSnapshot: { open: vi.fn(async () => ({})) },
}));

const ORG = 'org-a';
const PDF = Buffer.from('%PDF-1.4 issued');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const user = (role: UserRole, over: Partial<RequestUser> = {}): RequestUser => ({
  id: '0a000000-0000-4000-8000-00000000000a', email: 'x@tonyai.test', fullName: 'Someone', role,
  organisationId: ORG, accessibleSubsidiaryIds: ['sub-a', 'sub-b'], ...over,
});
const admin = user('super_admin');
const consultant = user('consultant');

let dataset: ReportDataset;
let datasetRow: ReturnType<typeof rowOf> | null;
let frozenAt: Date | null;
let calls: string[];
let tx: Record<string, Record<string, ReturnType<typeof vi.fn>>>;
let prisma: { $transaction: ReturnType<typeof vi.fn>; $queryRaw: ReturnType<typeof vi.fn> };
let audit: { record: ReturnType<typeof vi.fn> };
let pdf: { render: ReturnType<typeof vi.fn> };
let storage: { upload: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn> };
let intents: {
  beginUpload: ReturnType<typeof vi.fn>; adoptUpload: ReturnType<typeof vi.fn>;
  abandonUpload: ReturnType<typeof vi.fn>; abandonUnadoptedUpload: ReturnType<typeof vi.fn>;
};
let service: ReportIssuancesService;

function arrange(d: ReportDataset): void {
  dataset = d;
  datasetRow = rowOf(d);
  boundaryRead.current = d.boundary;
}

beforeEach(() => {
  calls = [];
  arrange(datasetOf());
  frozenAt = new Date('2026-10-15T00:00:00.000Z');
  tx = {
    reportDataset: { findFirst: vi.fn(async () => datasetRow) },
    profile: { findUnique: vi.fn(async () => ({ language: 'tr' })) },
    reportIssuance: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => { calls.push('create'); return { issuedAt: new Date('2026-10-21T12:00:00.123Z') }; }),
    },
    inventoryBoundary: { findFirst: vi.fn(async () => ({ frozenAt })) },
  };
  prisma = {
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    $queryRaw: vi.fn(async () => []),
  };
  audit = { record: vi.fn(async () => { calls.push('audit'); }) };
  pdf = { render: vi.fn(async () => { calls.push('render'); return { bytes: PDF, engine: 'HeadlessChrome/stub' }; }) };
  storage = {
    upload: vi.fn(async () => { calls.push('upload'); }),
    download: vi.fn(async () => { calls.push('download'); return Buffer.from(PDF); }),
  };
  intents = {
    beginUpload: vi.fn(async () => { calls.push('begin'); return 'intent-1'; }),
    adoptUpload: vi.fn(async () => { calls.push('adopt'); }),
    abandonUpload: vi.fn(async () => { calls.push('abandon'); }),
    abandonUnadoptedUpload: vi.fn(async () => { calls.push('abandon-unadopted'); }),
  };
  service = new ReportIssuancesService(prisma as never, audit as never, pdf as never, storage as never, intents as never);
});

afterEach(() => vi.unstubAllEnvs());

const issue = (who: RequestUser = admin, over: Record<string, unknown> = {}) =>
  service.issue(who, { datasetId: dataset.datasetId, template: 'ghg_protocol_detail', ...over } as never);
const refusal = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected a refusal'); }, (e: unknown) => e);

describe('issue — a final', () => {
  it('renders, retains and records a final: the stored bytes hashed, the issuer from the token, the language the profile\'s', async () => {
    const issued = await issue();
    expect(issued).toMatchObject({
      organisationId: ORG, datasetId: dataset.datasetId, status: 'final', gaps: [],
      datasetFingerprint: dataset.fingerprint, issuedBy: admin.id, issuedAt: '2026-10-21T12:00:00.123Z',
      language: 'tr', template: 'ghg_protocol_detail',
      options: { includeMethodologyNotes: false, includeEvidenceSummary: false },
      pdf: { mimeType: 'application/pdf', sizeBytes: PDF.length, fingerprint: { algorithm: 'sha256', hex: sha(PDF) } },
    });
    expect(issued.rendererVersion).toBe(`${ISSUANCE_RENDERER} (HeadlessChrome/stub)`);
    // Opaque: never the bucket path, never a URL.
    expect(issued.pdf.artifactId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(issued)).not.toContain('.pdf');
    const data = tx.reportIssuance.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      id: issued.issuanceId, organisationId: ORG, datasetId: dataset.datasetId, reportingYear: 2026, status: 'final', gaps: [],
      canonicalization: 'tonyai-report-dataset-v1', datasetFingerprintHex: dataset.fingerprint.hex,
      artifactId: issued.pdf.artifactId, storagePath: `${ORG}/${issued.pdf.artifactId}.pdf`, sha256: sha(PDF), sizeBytes: PDF.length,
      referencedSubsidiaryIds: datasetRow!.referencedSubsidiaryIds, issuedBy: admin.id, language: 'tr',
    });
    expect(data).not.toHaveProperty('issuedAt');
  });

  it('orders the recovery: intent begun before the bytes, the bytes read back, adoption FIRST in the row\'s transaction', async () => {
    await issue();
    expect(calls).toEqual(['render', 'begin', 'upload', 'download', 'adopt', 'create', 'audit']);
    expect(intents.beginUpload).toHaveBeenCalledWith(
      { bucket: REPORT_ARTIFACTS_BUCKET, path: expect.stringMatching(/^org-a\/[0-9a-f-]{36}\.pdf$/) },
      { reason: 'report_issuance.upload', organisationId: ORG },
    );
    expect(storage.upload).toHaveBeenCalledWith(REPORT_ARTIFACTS_BUCKET, expect.any(String), PDF, 'application/pdf');
    expect(intents.abandonUpload).not.toHaveBeenCalled();
    expect(intents.abandonUnadoptedUpload).not.toHaveBeenCalled();
  });

  it('reads in one REPEATABLE READ snapshot and writes the row in a transaction of its own', async () => {
    await issue();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  });

  it('audits the issuance in its transaction: dataset, fingerprint, status, gaps by code, language, renderer, PDF hash', async () => {
    const issued = await issue();
    expect(audit.record).toHaveBeenCalledWith(admin, {
      action: 'issue', entity: 'report_issuance', entityId: issued.issuanceId,
      diff: {
        datasetId: dataset.datasetId, datasetFingerprint: dataset.fingerprint.hex,
        boundaryId: dataset.boundary.id, boundaryVersion: dataset.boundary.version, selection: 'inventory',
        status: 'final', gaps: {}, language: 'tr', template: 'ghg_protocol_detail',
        options: { includeMethodologyNotes: false, includeEvidenceSummary: false },
        rendererVersion: issued.rendererVersion,
        pdf: { artifactId: issued.pdf.artifactId, sha256: sha(PDF), sizeBytes: PDF.length },
      },
    }, tx);
  });

  it('takes the language asked for over the profile\'s (D16), and the default without a profile', async () => {
    expect((await issue(admin, { language: 'en' })).language).toBe('en');
    tx.profile.findUnique.mockResolvedValueOnce(null);
    expect((await issue()).language).toBe('en');
  });
});

describe('issue — roles (W4)', () => {
  it('refuses a consultant a final, before anything is rendered: report_final_forbidden', async () => {
    const e = await refusal(issue(consultant));
    expect(errorCodeOf(e)).toBe('report_final_forbidden');
    expect(pdf.render).not.toHaveBeenCalled();
    expect(intents.beginUpload).not.toHaveBeenCalled();
  });

  it('lets a consultant issue a partial', async () => {
    arrange(datasetOf({ locks: allLocks().filter((l) => l.periodValue !== 'March') }));
    const issued = await issue(consultant);
    expect(issued.status).toBe('partial');
    expect(issued.gaps.map((g) => g.code)).toEqual(['unlocked_period']);
    expect(audit.record.mock.calls[0][1].diff.gaps).toEqual({ unlocked_period: 1 });
  });

  it.each(['data_entry', 'executive_viewer'] as const)('refuses %s before reading anything', async (role) => {
    const e = await refusal(issue(user(role)));
    expect((e as { getStatus(): number }).getStatus()).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('issue — the read rule: refusal is not found, byte for byte', () => {
  const body = async (p: Promise<unknown>) => JSON.stringify(toErrorBody(404, ((await refusal(p)) as { getResponse(): unknown }).getResponse()));

  it('answers a missing dataset, another organisation\'s and one outside current access alike', async () => {
    datasetRow = null;
    const missing = await body(issue());
    arrange(datasetOf());
    const outside = await body(issue(user('super_admin', { accessibleSubsidiaryIds: ['sub-a'] })));
    const none = await body(issue(user('super_admin', { accessibleSubsidiaryIds: [] })));
    expect(missing).toContain('report_dataset_not_found');
    expect(outside).toBe(missing);
    expect(none).toBe(missing);
    expect(tx.reportDataset.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: dataset.datasetId, organisationId: ORG } }));
    expect(pdf.render).not.toHaveBeenCalled();
  });

  it('applies the read rule before the role and repeat refusals — an unreadable dataset never answers 403 or 409 (`qa-auditor` M9a)', async () => {
    const outside = (role: UserRole) => user(role, { accessibleSubsidiaryIds: ['sub-a'] });
    // Final-qualifying, but not the consultant's to read: not found, not report_final_forbidden.
    expect(errorCodeOf(await refusal(issue(outside('consultant'))))).toBe('report_dataset_not_found');
    // Already issued, but not the caller's to read: not found, not report_already_issued.
    tx.reportIssuance.findFirst.mockResolvedValue({ id: 'earlier' });
    expect(errorCodeOf(await refusal(issue(outside('super_admin'))))).toBe('report_dataset_not_found');
    expect(tx.reportIssuance.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a caller without an organisation as not found', async () => {
    expect(errorCodeOf(await refusal(issue(user('super_admin', { organisationId: null }))))).toBe('report_dataset_not_found');
  });
});

describe('issue — refused before rendering', () => {
  it('answers a repeat of the same dataset, language, template and options: report_already_issued', async () => {
    tx.reportIssuance.findFirst.mockResolvedValueOnce({ id: 'earlier' });
    expect(errorCodeOf(await refusal(issue()))).toBe('report_already_issued');
    expect(tx.reportIssuance.findFirst).toHaveBeenCalledWith({
      where: { datasetId: dataset.datasetId, organisationId: ORG, language: 'tr', template: 'ghg_protocol_detail', includeMethodologyNotes: false, includeEvidenceSummary: false },
      select: { id: true },
    });
    expect(pdf.render).not.toHaveBeenCalled();
  });

  it('answers a tampered text as an internal error — a defect, never a refusal to act on', async () => {
    const tampered = JSON.parse(datasetRow!.content);
    tampered.records[0].calculation.tCo2e = 99;
    datasetRow = { ...datasetRow!, content: JSON.stringify(tampered) };
    const e = await refusal(issue());
    expect(errorCodeOf(e)).toBeUndefined();
    expect((e as Error).message).toBe('The report dataset could not be issued.');
    expect(pdf.render).not.toHaveBeenCalled();
  });

  it('answers a boundary that is not its frozen version — or a version not frozen — as an internal error', async () => {
    boundaryRead.current = frozenBoundary(complete(), 'unconfirmed');
    expect((await refusal(issue()) as Error).message).toBe('The report dataset could not be issued.');
    boundaryRead.current = null;
    expect((await refusal(issue()) as Error).message).toBe('The report dataset could not be issued.');
    boundaryRead.current = dataset.boundary;
    frozenAt = null;
    expect((await refusal(issue()) as Error).message).toBe('The report dataset could not be issued.');
    expect(pdf.render).not.toHaveBeenCalled();
  });

  it('refuses a page over REPORT_MAX_BYTES before the renderer (422)', async () => {
    vi.stubEnv('REPORT_MAX_BYTES', '1000');
    service = new ReportIssuancesService(prisma as never, audit as never, pdf as never, storage as never, intents as never);
    expect(errorCodeOf(await refusal(issue()))).toBe('query_too_broad');
    expect(pdf.render).not.toHaveBeenCalled();
  });
});

describe('issue — every failure after the intent abandons it (LP1-02)', () => {
  // Before the ownership transaction no row can own the bytes: they go even if
  // the sweeper took the intent meanwhile (Codex's B9 P2). From the
  // transaction on, only while the intent stands (a lost acknowledgement).
  const unadopted = () => {
    expect(intents.abandonUnadoptedUpload).toHaveBeenCalledWith('intent-1', { bucket: REPORT_ARTIFACTS_BUCKET, path: expect.any(String) }, { organisationId: ORG });
    expect(intents.abandonUpload).not.toHaveBeenCalled();
    expect(tx.reportIssuance.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  };

  it('Storage refuses the bytes: abandoned as unadopted, no row', async () => {
    const cause = new Error('storage down');
    storage.upload.mockRejectedValueOnce(cause);
    expect(await refusal(issue())).toBe(cause);
    unadopted();
  });

  it('the stored bytes are not the rendered ones: abandoned as unadopted, no row — the fingerprint is of the STORED bytes', async () => {
    storage.download.mockResolvedValueOnce(Buffer.from('%PDF-1.4 other'));
    expect((await refusal(issue()) as Error).message).toMatch(/stored PDF is not the rendered one/);
    unadopted();
  });

  it('the stored bytes cannot be read back: abandoned as unadopted, no row', async () => {
    const cause = new Error('read-back outage');
    storage.download.mockRejectedValueOnce(cause);
    expect(await refusal(issue())).toBe(cause);
    unadopted();
  });

  it('the sweeper took the upload during a slow render: 409 upload_expired, abandoned with that cause', async () => {
    const expired = new UploadExpiredError();
    intents.adoptUpload.mockRejectedValueOnce(expired);
    expect(errorCodeOf(await refusal(issue()))).toBe('upload_expired');
    expect(intents.abandonUpload).toHaveBeenCalledWith('intent-1', expect.anything(), expired, { organisationId: ORG });
    expect(tx.reportIssuance.create).not.toHaveBeenCalled();
  });

  it('a concurrent issue of the same key won the unique index: abandoned, report_already_issued', async () => {
    tx.reportIssuance.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002', clientVersion: 'x', meta: { target: ['dataset_id', 'language', 'template', 'include_methodology_notes', 'include_evidence_summary'] },
    }));
    expect(errorCodeOf(await refusal(issue()))).toBe('report_already_issued');
    expect(intents.abandonUpload).toHaveBeenCalled();
  });

  it('the guard refused the row (TA017): abandoned, an internal error', async () => {
    tx.reportIssuance.create.mockRejectedValueOnce(new Prisma.PrismaClientUnknownRequestError(
      'Error occurred during query execution: ConnectorError(... PostgresError { code: "TA017", message: "x" })', { clientVersion: 'x' },
    ));
    const e = await refusal(issue());
    expect((e as Error).message).toBe('The report could not be issued.');
    expect(intents.abandonUpload).toHaveBeenCalled();
  });

  it('the audit row fails: abandoned, the failure itself answered', async () => {
    const cause = new Error('audit down');
    audit.record.mockRejectedValueOnce(cause);
    expect(await refusal(issue())).toBe(cause);
    expect(intents.abandonUpload).toHaveBeenCalledWith('intent-1', expect.anything(), cause, { organisationId: ORG });
  });

  it('a failure in or after the ownership transaction never takes the unadopted path — a lost acknowledgement keeps its bytes', async () => {
    for (const fail of [
      () => intents.adoptUpload.mockRejectedValueOnce(new Error('adopt failed')),
      () => tx.reportIssuance.create.mockRejectedValueOnce(new Error('insert failed')),
      () => audit.record.mockRejectedValueOnce(new Error('audit failed')),
    ]) {
      intents.abandonUpload.mockClear(); intents.abandonUnadoptedUpload.mockClear();
      fail();
      await refusal(issue());
      expect(intents.abandonUpload).toHaveBeenCalledTimes(1);
      expect(intents.abandonUnadoptedUpload).not.toHaveBeenCalled();
    }
  });

  it('the renderer refused (busy or too large): no intent was ever begun', async () => {
    pdf.render.mockRejectedValueOnce(new Error('busy'));
    await refusal(issue());
    expect(intents.beginUpload).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

const issuanceRow = (over: Partial<IssuanceRow> = {}): IssuanceRow => ({
  id: '1550a000-0000-4000-8000-000000000001', organisation_id: ORG, dataset_id: 'ds', reporting_year: 2026,
  canonicalization: 'tonyai-report-dataset-v1', dataset_fingerprint_hex: 'a'.repeat(64), status: 'final', gaps: [],
  language: 'en', template: 'executive_summary', include_methodology_notes: false, include_evidence_summary: true,
  renderer_version: 'r', artifact_id: 'art', storage_path: `${ORG}/art.pdf`, size_bytes: PDF.length, sha256: sha(PDF),
  issued_by: 'issuer', issued_at: '2026-10-21T12:00:00.000Z', ...over,
});

describe('reads', () => {
  const summaryRow = (over: Record<string, unknown> = {}) => {
    const { gaps: _gaps, artifact_id: _artifact, storage_path: _path, organisation_id: _org, ...row } = issuanceRow();
    void _gaps; void _artifact; void _path; void _org;
    return {
      ...row, gap_count: 0, gap_counts: {}, captured_at: '2026-10-21T11:00:00.000Z', context: { year: 2026 },
      selection: 'inventory', boundary_id: 'b', version: 1, decision: 'confirmed', ...over,
    };
  };

  it('lists a year as summaries — gaps counted, never listed, and no object key (K7)', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([summaryRow({ status: 'partial', gap_count: 3, gap_counts: { coverage_gap: 2, unlocked_period: 1 } })])
      .mockResolvedValueOnce([{ id: 'current-final' }]);
    const list = await service.list(admin, 2026);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      issuanceId: issuanceRow().id, status: 'partial', gapCount: 3, gapCounts: { coverage_gap: 2, unlocked_period: 1 },
      pdf: { sizeBytes: PDF.length }, dataset: { capturedAt: '2026-10-21T11:00:00.000Z', boundary: { id: 'b', version: 1, decision: 'confirmed' } },
    });
    expect(list.items[0]).not.toHaveProperty('gaps');
    expect(JSON.stringify(list)).not.toContain('art.pdf');
    expect(JSON.stringify(list)).not.toContain('artifactId');
    // The year's newest final is named whether or not it is on the page.
    expect(list.currentFinalIssuanceId).toBe('current-final');
    expect(list.truncated).toBe(false);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('says a list is truncated when more than the limit are readable, and shows the limit', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce(Array.from({ length: 51 }, (_, i) => summaryRow({ id: `i-${i}` })))
      .mockResolvedValueOnce([]);
    const list = await service.list(admin, 2026, 'final');
    expect(list.items).toHaveLength(50);
    expect(list.truncated).toBe(true);
    expect(list.currentFinalIssuanceId).toBeNull();
  });

  it('reads nothing for a caller with no access or no organisation', async () => {
    const none = { items: [], truncated: false, currentFinalIssuanceId: null };
    expect(await service.list(user('super_admin', { accessibleSubsidiaryIds: [] }), 2026)).toEqual(none);
    expect(await service.list(user('super_admin', { organisationId: null }), 2026)).toEqual(none);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(['list', 'get', 'pdfOf'] as const)('%s refuses data_entry (W3)', async (method) => {
    const call = method === 'list' ? service.list(user('data_entry'), 2026) : service[method](user('data_entry'), 'id');
    expect(((await refusal(call)) as { getStatus(): number }).getStatus()).toBe(403);
  });

  it('answers an unreadable issuance as report_issuance_not_found', async () => {
    expect(errorCodeOf(await refusal(service.get(admin, 'id')))).toBe('report_issuance_not_found');
    expect(errorCodeOf(await refusal(service.pdfOf(admin, 'id')))).toBe('report_issuance_not_found');
    expect(storage.download).not.toHaveBeenCalled();
  });
});

describe('the PDF download — the retained bytes, verified, never rendered again', () => {
  it('serves the bytes that hash to the issuance', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([issuanceRow()]);
    const served = await service.pdfOf(user('executive_viewer'), 'id');
    expect(served.bytes.equals(PDF)).toBe(true);
    // Every final of a year has its own name: the issue date and a short id (PR D follow-up (11)).
    expect(served.filename).toBe('tonyai-report-2026-executive_summary-en-final-2026-10-21-1550a000.pdf');
    expect(storage.download).toHaveBeenCalledWith(REPORT_ARTIFACTS_BUCKET, `${ORG}/art.pdf`);
    expect(pdf.render).not.toHaveBeenCalled();
  });

  it('never serves bytes that differ from the issuance — an internal error', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([issuanceRow({ sha256: 'b'.repeat(64) })]);
    const e = await refusal(service.pdfOf(admin, 'id'));
    expect(errorCodeOf(e)).toBeUndefined();
    expect((e as Error).message).toMatch(/does not hash/);
    prisma.$queryRaw.mockResolvedValueOnce([issuanceRow({ size_bytes: 1 })]);
    expect((await refusal(service.pdfOf(admin, 'id')) as Error).message).toMatch(/does not hash/);
  });

  it('answers bytes gone from Storage as report_artifact_missing, never a 5xx', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([issuanceRow()]);
    storage.download.mockRejectedValueOnce(new StorageObjectMissingError(REPORT_ARTIFACTS_BUCKET, `${ORG}/art.pdf`));
    const e = await refusal(service.pdfOf(admin, 'id'));
    expect(errorCodeOf(e)).toBe('report_artifact_missing');
    expect((e as { getStatus(): number }).getStatus()).toBe(404);
  });
});

describe('the issuance preview (LP4-03 K7) — the gate, nothing written', () => {
  it('derives what an issue would, and says whether this caller may issue that final', async () => {
    expect(await service.preview(admin, dataset.datasetId)).toEqual({
      datasetId: dataset.datasetId, status: 'final', gaps: [], finalAllowed: true,
    });
    expect(await service.preview(consultant, dataset.datasetId)).toMatchObject({ status: 'final', finalAllowed: false });
    expect(pdf.render).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(tx.reportIssuance.create).not.toHaveBeenCalled();
    expect(prisma.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  });

  it('names a partial\'s gaps, as the issuance would carry them', async () => {
    arrange(datasetOf({ boundary: frozenBoundary(complete(), 'unconfirmed'), locks: allLocks() }));
    const preview = await service.preview(consultant, dataset.datasetId);
    expect(preview.status).toBe('partial');
    expect(preview.gaps.map((g) => g.coverageCode ?? g.code)).toContain('boundary_unconfirmed');
    expect(preview.finalAllowed).toBe(false);
  });

  it.each(['executive_viewer', 'data_entry'] as const)('refuses %s, who issues nothing', async (role) => {
    expect(((await refusal(service.preview(user(role), dataset.datasetId))) as { getStatus(): number }).getStatus()).toBe(403);
  });

  it('answers an unreadable dataset as report_dataset_not_found — no bypass for the issuer', async () => {
    const e = await refusal(service.preview(user('super_admin', { accessibleSubsidiaryIds: ['sub-a'] }), dataset.datasetId));
    expect(errorCodeOf(e)).toBe('report_dataset_not_found');
  });

  it('refuses a dataset whose text no longer verifies — never previews a tampered row', async () => {
    datasetRow = { ...rowOf(dataset), fingerprintHex: 'b'.repeat(64) };
    const e = await refusal(service.preview(admin, dataset.datasetId));
    expect(errorCodeOf(e)).toBeUndefined();
    expect((e as Error).message).toMatch(/could not be issued/);
  });
});

describe('the issued Excel and CSV (LP4-03 K5) — the retained dataset, re-verified', () => {
  const issuedRow = () => issuanceRow({ dataset_id: dataset.datasetId, dataset_fingerprint_hex: dataset.fingerprint.hex });

  it.each(['xlsx', 'csv'] as const)('projects the issuance\'s own dataset as %s, under one name with its PDF', async (format) => {
    prisma.$queryRaw.mockResolvedValueOnce([issuedRow()]);
    const { body, filename } = await service.tablesOf(user('executive_viewer'), 'id', format);
    expect(filename).toBe(`tonyai-report-2026-executive_summary-en-final-2026-10-21-1550a000.${format}`);
    if (format === 'csv') expect(String(body)).toContain(`,sha256:${dataset.fingerprint.hex},`);
    else expect((body as Buffer).subarray(0, 2).toString()).toBe('PK');
    expect(tx.reportDataset.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: dataset.datasetId, organisationId: ORG } }));
    expect(pdf.render).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses to project a dataset that is not the one the issuance was made from', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([issuanceRow({ dataset_id: dataset.datasetId, dataset_fingerprint_hex: 'c'.repeat(64) })]);
    const e = await refusal(service.tablesOf(admin, 'id', 'csv'));
    expect((e as Error).message).toMatch(/fingerprint is not the issuance's/);
  });

  it('answers an unreadable issuance as report_issuance_not_found, and data_entry 403', async () => {
    expect(errorCodeOf(await refusal(service.tablesOf(admin, 'id', 'xlsx')))).toBe('report_issuance_not_found');
    expect(((await refusal(service.tablesOf(user('data_entry'), 'id', 'csv'))) as { getStatus(): number }).getStatus()).toBe(403);
    expect(tx.reportDataset.findFirst).not.toHaveBeenCalled();
  });
});
