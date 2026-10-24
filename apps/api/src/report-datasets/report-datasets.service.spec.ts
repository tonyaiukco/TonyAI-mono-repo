import { ForbiddenException, HttpException } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryBoundarySnapshot, ReportDataset, ReportDatasetRecord } from '@tonyai/shared-types';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { toErrorBody } from '../common/api-error';
import type { PrismaService } from '../prisma/prisma.service';
import { makeDataEntry, makeSuperAdmin } from '../../test/helpers';
import { readInventoryBoundary } from '../inventory-boundary/boundary-reader';
import { readCaptureContext, readCaptureFacts } from './dataset-reader';
import { canonicalDatasetContent, reportDatasetFingerprint } from './dataset-fingerprint';
import { capturedScopes, datasetGuardRefused, ReportDatasetsService, selectionOf } from './report-datasets.service';
import { DatasetCapturerGuard, DatasetReaderGuard } from './dataset-role.guard';

vi.mock('../inventory-boundary/boundary-reader', () => ({ readInventoryBoundary: vi.fn() }));
vi.mock('./dataset-reader', async (actual) => ({
  ...(await actual<typeof import('./dataset-reader')>()),
  readCaptureContext: vi.fn(),
  readCaptureFacts: vi.fn(),
}));

/**
 * The capture's service, DB-free (LP3-04 PR C; V1–V8): every refusal the
 * request decides comes before the freeze, the freeze is conditional and
 * audited in its own READ COMMITTED transaction, and the dataset is read,
 * fingerprinted and retained with its audit row in one REPEATABLE READ
 * snapshot. What the database does is the integration suite's.
 */

const BOUNDARY_ID = '0b1d0000-0000-4000-8000-000000000001';
const ORG = 'org-1';

const consultant = (over: Partial<RequestUser> = {}) => makeSuperAdmin({ id: 'user-consultant', role: 'consultant', ...over });
const viewer = () => makeSuperAdmin({ id: 'user-viewer', role: 'executive_viewer' });

const header = (over: Record<string, unknown> = {}) => ({
  id: BOUNDARY_ID, reportingYear: 2026, version: 2, frozenAt: null as Date | null,
  subsidiaries: [{ subsidiaryId: 'sub-1' }, { subsidiaryId: 'sub-2' }],
  ...over,
});

const snapshotBoundary = (decision: 'unconfirmed' | 'confirmed' = 'unconfirmed'): InventoryBoundarySnapshot => ({
  id: BOUNDARY_ID, version: 2, organisationId: ORG, reportingYear: 2026, subsidiaryIds: ['sub-1', 'sub-2'],
  decision, decidedBy: null, decidedAt: null, entities: [], applicability: [], attribution: [], sources: [],
});

const record = (id: string, subsidiaryId = 'sub-1'): ReportDatasetRecord => ({
  id, subsidiaryId, locationId: null, reportingYear: 2026, reportingPeriod: 'annual', periodValue: 'Annual',
  category: 'Natural Gas', activityType: null, scope: 1, status: 'approved', activityValue: 1, activityUnit: 'kWh',
  calculation: { factorId: 'legacy', tCo2e: 0.1 } as unknown as ReportDatasetRecord['calculation'],
  createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', reviewedBy: null,
  reviewedAt: null, submittedAt: null, voidedBy: null, voidedAt: null, voidReason: null, subsidiaryName: 'S', locationName: null,
});

function mockDb() {
  const isolation = { level: 'read committed' };
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('transaction_isolation')) return [{ isolation: isolation.level }];
      if (sql.includes('FOR UPDATE')) return [{ id: BOUNDARY_ID }];
      return [];
    }),
    inventoryBoundary: {
      findUniqueOrThrow: vi.fn(async (args: { select: Record<string, unknown> }) =>
        ('subsidiaries' in args.select ? header() : { frozenAt: new Date('2026-10-15T12:00:00Z') })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({ frozenAt: new Date('2026-10-15T12:00:00Z') })),
    },
    activityRecord: { count: vi.fn(async () => 3) },
    activityRecordEvidence: { count: vi.fn(async () => 2) },
    reportDataset: { create: vi.fn(async () => ({})), findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const order: string[] = [];
  const prisma = {
    reportDataset: tx.reportDataset,
    $queryRaw: vi.fn(async () => []),
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown, options: { isolationLevel: string }) => {
      isolation.level = options.isolationLevel === 'RepeatableRead' ? 'repeatable read' : 'read committed';
      order.push(options.isolationLevel);
      return work(tx);
    }),
  };
  return { prisma, tx, order };
}

const answered = (e: unknown) => (e instanceof HttpException ? toErrorBody(e.getStatus(), e.getResponse()).code : undefined);
const failure = async (p: Promise<unknown>) => p.then(() => { throw new Error('resolved'); }, (e: unknown) => e);

describe('ReportDatasetsService.capture', () => {
  let db: ReturnType<typeof mockDb>;
  let service: ReportDatasetsService;
  const admin = makeSuperAdmin();

  beforeEach(() => {
    vi.mocked(readInventoryBoundary).mockReset().mockResolvedValue(snapshotBoundary());
    vi.mocked(readCaptureContext).mockReset().mockResolvedValue({
      capturedAt: '2026-10-15T12:00:01.234Z', organisationName: 'Org', currentAccess: ['sub-1', 'sub-2', 'sub-3', 'sub-4', 'sub-5'],
    });
    vi.mocked(readCaptureFacts).mockReset().mockResolvedValue({ records: [record('r-1')], evidence: [], periodLocks: [], releases: new Map() });
    db = mockDb();
    service = new ReportDatasetsService(db.prisma as unknown as PrismaService, new AuditService(db.prisma as unknown as PrismaService));
  });

  const audited = () => db.tx.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);

  describe('refusals before anything is frozen (V2)', () => {
    it('refuses data_entry and executive_viewer outright, reading nothing', async () => {
      for (const user of [makeDataEntry(), viewer()]) {
        expect(await failure(service.capture(user, { boundaryId: BOUNDARY_ID }))).toBeInstanceOf(ForbiddenException);
      }
      expect(db.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a caller with no organisation', async () => {
      expect(await failure(service.capture(makeSuperAdmin({ organisationId: null }), { boundaryId: BOUNDARY_ID }))).toBeInstanceOf(ForbiddenException);
      expect(db.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses an extract of a subsidiary outside access as unknown, before any transaction", async () => {
      expect(answered(await failure(service.capture(admin, { boundaryId: BOUNDARY_ID, subsidiaryId: 'sub-9' })))).toBe('subsidiary_not_found');
      expect(db.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("answers another organisation's or an unknown version as not found, freezing nothing", async () => {
      db.tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
        (strings.join('?').includes('FOR UPDATE') ? [] : [{ isolation: 'read committed' }]));
      expect(answered(await failure(service.capture(admin, { boundaryId: BOUNDARY_ID })))).toBe('boundary_not_found');
      expect(db.tx.inventoryBoundary.updateMany).not.toHaveBeenCalled();
      expect(audited()).toEqual([]);
    });

    it('refuses an extract of a subsidiary the version does not declare, before freezing (P2-1)', async () => {
      // sub-3 is the caller's, but the version declares sub-1 and sub-2 only.
      expect(answered(await failure(service.capture(admin, { boundaryId: BOUNDARY_ID, subsidiaryId: 'sub-3' })))).toBe('subsidiary_not_found');
      expect(db.tx.inventoryBoundary.updateMany).not.toHaveBeenCalled();
      expect(db.tx.activityRecord.count).not.toHaveBeenCalled();
      expect(audited()).toEqual([]);
    });

    it('answers a version declaring no subsidiary, or one outside access, as not found (W3)', async () => {
      for (const subsidiaries of [[], [{ subsidiaryId: 'sub-1' }, { subsidiaryId: 'sub-9' }]]) {
        db.tx.inventoryBoundary.findUniqueOrThrow.mockResolvedValueOnce(header({ subsidiaries }));
        expect(answered(await failure(service.capture(admin, { boundaryId: BOUNDARY_ID })))).toBe('boundary_not_found');
      }
      expect(db.tx.inventoryBoundary.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a capture certain to be too broad — records or evidence links — before freezing', async () => {
      db.tx.activityRecord.count.mockResolvedValueOnce(5_001);
      expect(answered(await failure(service.capture(admin, { boundaryId: BOUNDARY_ID })))).toBe('query_too_broad');
      db.tx.activityRecordEvidence.count.mockResolvedValueOnce(10_001);
      expect(answered(await failure(service.capture(admin, { boundaryId: BOUNDARY_ID })))).toBe('query_too_broad');
      expect(db.tx.activityRecordEvidence.count).toHaveBeenLastCalledWith({
        where: { activityRecord: { subsidiaryId: { in: ['sub-1', 'sub-2'] }, reportingYear: 2026, scope: { in: [1, 2] } } },
      });
      expect(db.tx.inventoryBoundary.updateMany).not.toHaveBeenCalled();
    });

    it("counts the selection's Scope 1/2 records of the declared subsidiaries, or the extract's one", async () => {
      await service.capture(admin, { boundaryId: BOUNDARY_ID, scope: 2, category: 'Electricity' });
      expect(db.tx.activityRecord.count).toHaveBeenCalledWith({
        where: { subsidiaryId: { in: ['sub-1', 'sub-2'] }, reportingYear: 2026, scope: { in: [2] }, category: 'Electricity' },
      });
      await service.capture(admin, { boundaryId: BOUNDARY_ID, subsidiaryId: 'sub-2' });
      expect(db.tx.activityRecord.count).toHaveBeenLastCalledWith({
        where: { subsidiaryId: { in: ['sub-2'] }, reportingYear: 2026, scope: { in: [1, 2] } },
      });
    });

    it('lets only super_admin freeze an open version — a consultant is refused, nothing frozen (V1)', async () => {
      expect(await failure(service.capture(consultant(), { boundaryId: BOUNDARY_ID }))).toBeInstanceOf(ForbiddenException);
      expect(db.tx.inventoryBoundary.updateMany).not.toHaveBeenCalled();
      expect(db.order).toEqual(['ReadCommitted']);
    });

    it('lets a consultant capture a version already frozen, writing no freeze', async () => {
      db.tx.inventoryBoundary.findUniqueOrThrow.mockResolvedValueOnce(header({ frozenAt: new Date() }));
      await service.capture(consultant(), { boundaryId: BOUNDARY_ID });
      expect(db.tx.inventoryBoundary.updateMany).not.toHaveBeenCalled();
      expect(audited()).toEqual(['capture']);
    });
  });

  describe('the freeze (W8, PR B follow-up (4a))', () => {
    it('freezes an open version conditionally in READ COMMITTED, audits it, then captures in REPEATABLE READ', async () => {
      await service.capture(admin, { boundaryId: BOUNDARY_ID });
      expect(db.order).toEqual(['ReadCommitted', 'RepeatableRead']);
      expect(db.tx.inventoryBoundary.updateMany).toHaveBeenCalledWith({
        where: { id: BOUNDARY_ID, organisationId: ORG, frozenAt: null },
        data: { frozenAt: expect.any(Date) },
      });
      expect(db.tx.auditLog.create.mock.calls[0][0]).toMatchObject({
        data: {
          action: 'freeze', entity: 'inventory_boundary', entityId: BOUNDARY_ID,
          diff: { reportingYear: 2026, version: 2, frozenAt: '2026-10-15T12:00:00.000Z', cause: 'capture' },
        },
      });
      expect(audited()).toEqual(['freeze', 'capture']);
      // Its audit rows are written in their transactions, never on the root client.
      expect(db.prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('writes no freeze when none changed — another froze it first', async () => {
      db.tx.inventoryBoundary.updateMany.mockResolvedValueOnce({ count: 0 });
      await service.capture(admin, { boundaryId: BOUNDARY_ID });
      expect(audited()).toEqual(['capture']);
    });

    it('asserts the freeze took — a version still open after it is a defect', async () => {
      db.tx.inventoryBoundary.findUniqueOrThrow
        .mockResolvedValueOnce(header())
        .mockResolvedValueOnce({ frozenAt: null } as never);
      expect(await failure(service.capture(admin, { boundaryId: BOUNDARY_ID }))).toBeInstanceOf(Error);
      expect(audited()).toEqual([]);
    });
  });

  describe('the snapshot', () => {
    it("asserts the version frozen in the capture's snapshot (PR B follow-up (1))", async () => {
      db.tx.inventoryBoundary.findFirst.mockResolvedValueOnce({ frozenAt: null } as never);
      const e = await failure(service.capture(admin, { boundaryId: BOUNDARY_ID }));
      expect((e as Error).message).toMatch(/not frozen in the capture's snapshot/);
      expect(db.tx.reportDataset.create).not.toHaveBeenCalled();
    });

    it('answers boundary_not_found when the reader finds the version unreadable now (W3)', async () => {
      vi.mocked(readInventoryBoundary).mockResolvedValueOnce(null);
      expect(answered(await failure(service.capture(admin, { boundaryId: BOUNDARY_ID })))).toBe('boundary_not_found');
      expect(db.tx.reportDataset.create).not.toHaveBeenCalled();
    });

    it("reads the boundary with the snapshot's access, and the declared subsidiaries for an inventory", async () => {
      vi.mocked(readCaptureContext).mockResolvedValueOnce({ capturedAt: '2026-10-15T12:00:01.234Z', organisationName: 'Org', currentAccess: ['sub-1', 'sub-2'] });
      await service.capture(admin, { boundaryId: BOUNDARY_ID });
      expect(vi.mocked(readInventoryBoundary).mock.calls[0][1]).toEqual({ boundaryId: BOUNDARY_ID, organisationId: ORG, accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
      expect(vi.mocked(readCaptureFacts).mock.calls[0][1]).toEqual({ organisationId: ORG, reportingYear: 2026, resolvedSubsidiaryIds: ['sub-1', 'sub-2'], scopes: [1, 2] });
    });

    it("refuses an extract's subsidiary gone from the snapshot's access, or not in the version it read", async () => {
      vi.mocked(readCaptureContext).mockResolvedValueOnce({ capturedAt: '2026-10-15T12:00:01.234Z', organisationName: 'Org', currentAccess: ['sub-1'] });
      expect(answered(await failure(service.capture(admin, { boundaryId: BOUNDARY_ID, subsidiaryId: 'sub-2' })))).toBe('subsidiary_not_found');
      vi.mocked(readInventoryBoundary).mockResolvedValueOnce({ ...snapshotBoundary(), subsidiaryIds: ['sub-1'] });
      expect(answered(await failure(service.capture(admin, { boundaryId: BOUNDARY_ID, subsidiaryId: 'sub-2' })))).toBe('subsidiary_not_found');
      expect(db.tx.reportDataset.create).not.toHaveBeenCalled();
    });

    it('retains the exact text it fingerprinted, every column from it, with its audit row', async () => {
      const summary = await service.capture(admin, { boundaryId: BOUNDARY_ID, scope: 1 });
      const data = (db.tx.reportDataset.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
      const stored = JSON.parse(data.content as string) as ReportDataset;
      expect(stored).toMatchObject({
        schemaVersion: 1, capturedAt: '2026-10-15T12:00:01.234Z', organisationId: ORG, organisationName: 'Org',
        context: { year: 2026, scope: 1 }, selection: 'extract', resolvedSubsidiaryIds: ['sub-1', 'sub-2'],
      });
      expect(Object.keys(stored.context)).toEqual(['year', 'scope']);
      expect(reportDatasetFingerprint(stored)).toEqual(stored.fingerprint);
      expect(data).toMatchObject({
        id: stored.datasetId, organisationId: ORG, boundaryId: BOUNDARY_ID, reportingYear: 2026, selection: 'extract',
        fingerprintHex: stored.fingerprint.hex, referencedSubsidiaryIds: ['sub-1', 'sub-2'], capturedBy: admin.id,
        capturedAt: new Date('2026-10-15T12:00:01.234Z'),
      });
      expect(canonicalDatasetContent(stored)).toBeTypeOf('string');
      expect(db.tx.auditLog.create.mock.calls.at(-1)?.[0]).toMatchObject({
        data: { action: 'capture', entity: 'report_dataset', entityId: stored.datasetId, diff: { fingerprint: stored.fingerprint.hex, records: 1, selection: 'extract' } },
      });
      expect(summary).toMatchObject({ datasetId: stored.datasetId, capturedBy: admin.id, boundary: { id: BOUNDARY_ID, version: 2, decision: 'unconfirmed' } });
    });

    it('calls a selection with no filter an inventory, with the context its year alone', async () => {
      await service.capture(admin, { boundaryId: BOUNDARY_ID });
      const stored = JSON.parse((db.tx.reportDataset.create.mock.calls[0] as unknown as [{ data: { content: string } }])[0].data.content) as ReportDataset;
      expect(stored.selection).toBe('inventory');
      expect(stored.context).toEqual({ year: 2026 });
    });

    it("refuses to retain a dataset referencing a subsidiary outside the capturer's access", async () => {
      vi.mocked(readCaptureFacts).mockResolvedValueOnce({ records: [record('r-1', 'sub-9')], evidence: [], periodLocks: [], releases: new Map() });
      const e = await failure(service.capture(admin, { boundaryId: BOUNDARY_ID }));
      expect((e as Error).message).toMatch(/outside its capturer's access/);
      expect(db.tx.reportDataset.create).not.toHaveBeenCalled();
    });

    it("answers a TA016 as an internal error — a rule the capture held first, so a defect", async () => {
      db.tx.reportDataset.create.mockRejectedValueOnce(new Prisma.PrismaClientUnknownRequestError(
        'Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "TA016", message: "report dataset x: its columns and its content disagree", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
        { clientVersion: 'test' },
      ));
      const e = await failure(service.capture(admin, { boundaryId: BOUNDARY_ID }));
      expect(e).not.toBeInstanceOf(HttpException);
      expect((e as Error).message).toBe('The report dataset could not be retained.');
    });
  });
});

describe('datasetGuardRefused', () => {
  it('reads TA016 from the engine framing or a raw query, and nothing else', () => {
    expect(datasetGuardRefused(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2010', clientVersion: 't', meta: { code: 'TA016' } }))).toBe(true);
    expect(datasetGuardRefused(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2010', clientVersion: 't', meta: { code: 'TA014' } }))).toBe(false);
    expect(datasetGuardRefused(new Prisma.PrismaClientUnknownRequestError('message mentions code: "TA016" as text', { clientVersion: 't' }))).toBe(false);
    expect(datasetGuardRefused(new Error('TA016'))).toBe(false);
  });
});

describe('selectionOf and capturedScopes', () => {
  it('keeps only the filters sent', () => {
    expect(selectionOf({ boundaryId: 'b' })).toEqual({});
    expect(Object.keys(selectionOf({ boundaryId: 'b', subsidiaryId: undefined, scope: 2 }))).toEqual(['scope']);
  });
  it('captures Scope 1/2 records only — none for a Scope 3 selection', () => {
    expect(capturedScopes({})).toEqual([1, 2]);
    expect(capturedScopes({ scope: 2 })).toEqual([2]);
    expect(capturedScopes({ scope: 3 })).toEqual([]);
  });
});

describe('ReportDatasetsService reads', () => {
  let db: ReturnType<typeof mockDb>;
  let service: ReportDatasetsService;
  beforeEach(() => {
    db = mockDb();
    service = new ReportDatasetsService(db.prisma as unknown as PrismaService, new AuditService(db.prisma as unknown as PrismaService));
  });

  it('refuses data_entry on every read (W3, V7)', async () => {
    expect(await failure(service.get(makeDataEntry(), BOUNDARY_ID))).toBeInstanceOf(ForbiddenException);
    expect(await failure(service.list(makeDataEntry(), 2026))).toBeInstanceOf(ForbiddenException);
  });

  it('answers the stored text verbatim to a reader holding every referenced subsidiary', async () => {
    db.tx.reportDataset.findFirst.mockResolvedValueOnce({ content: '{"x":0.30000000000000004}', referencedSubsidiaryIds: ['sub-1'] });
    expect(await service.get(viewer(), 'd-1')).toBe('{"x":0.30000000000000004}');
  });

  it('answers report_dataset_not_found alike for an unknown one and one partly outside access', async () => {
    db.tx.reportDataset.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ content: '{}', referencedSubsidiaryIds: ['sub-1', 'sub-9'] });
    expect(answered(await failure(service.get(viewer(), 'd-1')))).toBe('report_dataset_not_found');
    expect(answered(await failure(service.get(viewer(), 'd-1')))).toBe('report_dataset_not_found');
  });

  it('lists nothing for a caller with no organisation', async () => {
    expect(await service.list(makeSuperAdmin({ organisationId: null }), 2026)).toEqual({ items: [], truncated: false });
  });
});

describe('the dataset routes\' guards', () => {
  const context = (user?: RequestUser) => ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as never;
  it('admits super_admin and consultant to capture, and no one else', () => {
    expect(new DatasetCapturerGuard().canActivate(context(makeSuperAdmin()))).toBe(true);
    expect(new DatasetCapturerGuard().canActivate(context(consultant()))).toBe(true);
    for (const user of [makeDataEntry(), viewer(), undefined]) {
      expect(() => new DatasetCapturerGuard().canActivate(context(user))).toThrow(ForbiddenException);
    }
  });
  it('admits every role but data_entry to read', () => {
    for (const user of [makeSuperAdmin(), consultant(), viewer()]) expect(new DatasetReaderGuard().canActivate(context(user))).toBe(true);
    for (const user of [makeDataEntry(), undefined]) expect(() => new DatasetReaderGuard().canActivate(context(user))).toThrow(ForbiddenException);
  });
});
