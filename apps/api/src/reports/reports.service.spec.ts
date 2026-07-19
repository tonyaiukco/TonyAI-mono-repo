import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReportsService } from './reports.service';
import { buildReportHtml } from './report-html';
import { PrismaService } from '../prisma/prisma.service';
import { EmissionsService } from '../emissions/emissions.service';
import type { RequestUser } from '../auth/auth.types';
import type { ReportQueryDto } from './dto/report-query.dto';
import type { ActivityRecordStatus, EmissionsSummary } from '@tonyai/shared-types';

const now = new Date('2026-01-01T00:00:00.000Z');

const SUMMARY = {
  totals: { scope1: 100, scope2: 200, scope3: 0, total: 300 },
  byCategory: [
    { category: 'Electricity', scope: 2, tCo2e: 200, recordCount: 2, percentOfTotal: 66.7 },
    { category: 'Natural Gas', scope: 1, tCo2e: 100, recordCount: 1, percentOfTotal: 33.3 },
  ],
  bySubsidiary: [
    { subsidiaryId: 'sub-1', subsidiaryName: 'Energy', tCo2e: 300, recordCount: 3, percentOfTotal: 100 },
  ],
  trend: { monthly: [], quarterly: [], yearly: [] },
  recordCount: 3,
  statusesIncluded: ['submitted', 'under_review', 'approved', 'locked'] as ActivityRecordStatus[],
} satisfies EmissionsSummary;

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rec-1',
    subsidiaryId: 'sub-1',
    locationId: null,
    reportingYear: 2024,
    reportingPeriod: 'monthly',
    periodValue: 'January',
    category: 'Electricity',
    scope: 2,
    status: 'approved',
    activityValue: 1000,
    activityUnit: 'kWh',
    input: null,
    calculation: {
      tCo2e: 0.44,
      factorId: 'f-1',
      factorValue: 0.44,
      factorUnit: 'kgCO2e/kWh',
      methodology: 'location-based',
      source: 'demo',
      version: '2024.1',
      geographyCode: 'TR',
    },
    createdBy: 'admin-1',
    anomalyFlag: false,
    varianceReason: null,
    evidence: [{ fileName: 'invoice-jan.pdf' }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createPrismaMock() {
  return {
    activityRecord: {
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
    },
    organisation: {
      findUnique: vi.fn().mockResolvedValue({ legalName: 'TonyAI Holding Ltd.', tradingName: 'TonyAI Holding' }),
    },
    subsidiary: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'sub-1', legalName: 'Energy Legal', tradingName: 'Energy' },
        { id: 'sub-2', legalName: 'Gas Legal', tradingName: 'Gas' },
      ]),
    },
    auditLog: { create: vi.fn() },
  };
}
type PrismaMock = ReturnType<typeof createPrismaMock>;

const admin: RequestUser = {
  id: 'admin-1',
  email: 'admin@tonyai.local',
  role: 'super_admin',
  organisationId: 'org-1',
  accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
} as RequestUser;

const q: ReportQueryDto = {
  template: 'ghg_protocol_detail',
  year: 2024,
} as ReportQueryDto;

describe('ReportsService', () => {
  let prisma: PrismaMock;
  let emissions: { summary: ReturnType<typeof vi.fn> };
  let service: ReportsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    emissions = { summary: vi.fn().mockResolvedValue(SUMMARY) };
    service = new ReportsService(
      prisma as unknown as PrismaService,
      emissions as unknown as EmissionsService,
    );
  });

  // --- meta / status --------------------------------------------------------

  it('meta reports approved when every record is approved/locked', async () => {
    prisma.activityRecord.groupBy.mockResolvedValue([
      { status: 'approved', _count: { _all: 10 } },
      { status: 'locked', _count: { _all: 2 } },
    ]);
    const m = await service.meta(admin, 2024);
    expect(m.status).toBe('approved');
    expect(m.totalCount).toBe(12);
    expect(m.incompleteRatio).toBe(0);
  });

  it('meta reports draft when records await review (none incomplete)', async () => {
    prisma.activityRecord.groupBy.mockResolvedValue([
      { status: 'approved', _count: { _all: 8 } },
      { status: 'submitted', _count: { _all: 2 } },
    ]);
    const m = await service.meta(admin, 2024);
    expect(m.status).toBe('draft');
    expect(m.pendingCount).toBe(2);
  });

  it('meta reports contains_incomplete_data with drafts + the honest ratio', async () => {
    prisma.activityRecord.groupBy.mockResolvedValue([
      { status: 'approved', _count: { _all: 6 } },
      { status: 'draft', _count: { _all: 3 } },
      { status: 'rejected', _count: { _all: 1 } },
    ]);
    const m = await service.meta(admin, 2024);
    expect(m.status).toBe('contains_incomplete_data');
    expect(m.incompleteCount).toBe(4);
    expect(m.incompleteRatio).toBeCloseTo(0.4, 5);
  });

  it('meta is tenant-scoped and empty for an out-of-scope subsidiary', async () => {
    const m = await service.meta(admin, 2024, 'sub-999');
    expect(m.totalCount).toBe(0);
    expect(prisma.activityRecord.groupBy).not.toHaveBeenCalled();
  });

  // --- assembly -------------------------------------------------------------

  it('assemble scopes the ledger to the accessible subsidiaries and committed statuses', async () => {
    prisma.activityRecord.findMany.mockResolvedValue([makeRecord()]);
    await service.assemble(admin, q);
    expect(prisma.activityRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          subsidiaryId: { in: ['sub-1', 'sub-2'] },
          reportingYear: 2024,
          status: { in: ['submitted', 'under_review', 'approved', 'locked'] },
        }),
      }),
    );
  });

  it('assemble returns an empty ledger for an out-of-scope subsidiary (no query)', async () => {
    const data = await service.assemble(admin, { ...q, subsidiaryId: 'sub-999' } as ReportQueryDto);
    expect(data.records).toEqual([]);
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('assemble deduplicates factor snapshots by factorId and reports truthful evidence counts', async () => {
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord(),
      makeRecord({ id: 'rec-2', periodValue: 'February', evidence: [] }),
      makeRecord({
        id: 'rec-3',
        category: 'Natural Gas',
        calculation: { tCo2e: 1, factorId: 'f-2', factorValue: 0.18, factorUnit: 'kgCO2e/kWh', methodology: 'standard', source: 'demo', version: '2024.1', geographyCode: 'TR' },
      }),
    ]);
    const data = await service.assemble(admin, q);
    expect(data.factors).toHaveLength(2); // f-1 (deduped) + f-2
    expect(data.records[0].evidenceCount).toBe(1);
    expect(data.records[1].evidenceCount).toBe(0);
  });

  it('assemble includes the evidence appendix only when requested, listing file names', async () => {
    prisma.activityRecord.findMany.mockResolvedValue([makeRecord()]);
    const withOut = await service.assemble(admin, q);
    expect(withOut.evidenceSummary).toEqual([]);
    const withIn = await service.assemble(admin, { ...q, includeEvidenceSummary: true } as ReportQueryDto);
    expect(withIn.evidenceSummary).toEqual([
      expect.objectContaining({ fileCount: 1, fileNames: ['invoice-jan.pdf'] }),
    ]);
  });

  // --- CSV + audit ----------------------------------------------------------

  it('generateCsv emits a header + one quoted row per committed record and audits the generation', async () => {
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord({ activityValue: 12.5 }),
      makeRecord({ id: 'rec-2', periodValue: 'Feb, "cold"' }), // needs quoting
    ]);
    const csv = await service.generateCsv(admin, q);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('subsidiary,category');
    expect(lines[2]).toContain('"Feb, ""cold"""');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity: 'report',
          action: 'generate',
          diff: expect.objectContaining({ exportType: 'csv' }),
        }),
      }),
    );
  });

  // --- HTML builder (pure) --------------------------------------------------

  it('buildReportHtml renders totals, status and the data warning honestly', async () => {
    prisma.activityRecord.findMany.mockResolvedValue([makeRecord()]);
    prisma.activityRecord.groupBy.mockResolvedValue([
      { status: 'approved', _count: { _all: 6 } },
      { status: 'draft', _count: { _all: 4 } }, // 40% incomplete → warning
    ]);
    const data = await service.assemble(admin, q);
    const html = buildReportHtml(data);
    expect(html).toContain('TonyAI Holding');
    expect(html).toContain('Contains incomplete data');
    expect(html).toContain('Data warning');
    expect(html).toContain('300'); // total tCO₂e
    expect(html).toContain('Activity records ledger'); // detail template section
    expect(html).toContain('location-based'); // factor appendix
  });

  it('buildReportHtml escapes HTML in user-influenced names', async () => {
    prisma.subsidiary.findMany.mockResolvedValue([
      { id: 'sub-1', legalName: '<script>alert(1)</script>', tradingName: null },
    ]);
    prisma.activityRecord.findMany.mockResolvedValue([makeRecord()]);
    const data = await service.assemble(admin, q);
    const html = buildReportHtml(data);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  // --- review-pass hardening (qa-auditor findings) --------------------------

  it('meta never reports approved for a zero-record year (no fake approval)', async () => {
    prisma.activityRecord.groupBy.mockResolvedValue([]);
    const m = await service.meta(admin, 2023);
    expect(m.totalCount).toBe(0);
    expect(m.status).toBe('contains_incomplete_data');
  });

  it('generation is forbidden for data_entry (permissions matrix)', async () => {
    const entry = { ...admin, role: 'data_entry' } as RequestUser;
    await expect(service.generateCsv(entry, q)).rejects.toMatchObject({ status: 403 });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('generateExcel builds the three audit sheets', async () => {
    prisma.activityRecord.findMany.mockResolvedValue([makeRecord()]);
    const buffer = await service.generateExcel(admin, q);
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 2).toString()).toBe('PK'); // valid zip/xlsx magic
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Summary',
      'Raw Activity Data',
      'Factors Used',
    ]);
  });

  it('generateCsv neutralizes spreadsheet formula injection', async () => {
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord({ periodValue: '=HYPERLINK("evil")' }),
    ]);
    const csv = await service.generateCsv(admin, q);
    expect(csv).toContain(`"'=HYPERLINK`);
  });
});