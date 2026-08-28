import { describe, it, expect, beforeEach, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { ReportsService } from './reports.service';
import { buildReportHtml } from './report-html';
import { csvHeader, csvLedgerRow, csvWithdrawnRow } from './report-columns';
import type { ReportLedgerRow, ReportWithdrawnRow } from './report-data';
import { PrismaService } from '../prisma/prisma.service';
import { EmissionsService } from '../emissions/emissions.service';
import type { RequestUser } from '../auth/auth.types';
import type { ReportQueryDto } from './dto/report-query.dto';
import type { ActivityRecordStatus, EmissionsSummary } from '@tonyai/shared-types';

import { AuditService } from '../audit/audit.service';

/**
 * Audit writes go through the shared AuditService. A single shared spy lets the
 * specs assert WHAT was audited; the row shape it stamps (actor role +
 * organisation) is covered by audit.service.spec.ts.
 */
/**
 * A stubbed browser — not a launched one.
 *
 * The rule this module has always followed is "never launch Chromium in a unit
 * test", and it stands. But it left `generatePdf` with NO unit coverage at all,
 * so the PDF path could log a zero into the append-only generation log — the
 * one place a report's restatement count survives — with the suite green and
 * the E2E, which only checks that bytes arrive, none the wiser. Stubbing the
 * launch pins what the PDF path DOES without paying for what it renders with.
 */
const pdfPage = {
  setContent: vi.fn(),
  pdf: vi.fn(async () => Buffer.from('%PDF-1.4 stub')),
  close: vi.fn(),
};
vi.mock('puppeteer', () => ({
  default: {
    launch: vi.fn(async () => ({
      connected: true,
      newPage: vi.fn(async () => pdfPage),
      close: vi.fn(),
    })),
  },
}));

const audit = { record: vi.fn() };
const auditMock = () => audit as unknown as AuditService;

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
  calculatedRecordCount: 3,
  uncalculatedRecordCount: 0,
  statusesIncluded: ['submitted', 'under_review', 'approved', 'locked'] as ActivityRecordStatus[],
} satisfies EmissionsSummary;

/** The `<th>` labels of the table under a given `<h2>`, in document order.
 *  Module scope because two blocks read it: the column-order goldens, and the
 *  cell-binding assertions that zip these against the row beneath them. */
function headersUnder(html: string, heading: string): string[] {
  const start = html.indexOf(`<h2>${heading}</h2>`);
  expect(start).toBeGreaterThan(-1);
  const thead = html.slice(start, html.indexOf('</thead>', start));
  // `<th(?:\s…)?>` and not `<th[^>]*>`: the latter also matches the opening
  // `<thead>`, which swallows the first real header.
  return [...thead.matchAll(/<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/g)].map((m) => m[1]);
}

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
    // Defaulted to an EVALUATED verdict, the common case for a committed record
    // with a figure. Left undefined these read as "the rule never ran", which
    // silently turns every fixture in the file into a not-evaluated record.
    anomalyBaselinePriorCount: 3,
    anomalyBaselineTCo2e: 10,
    varianceReason: null,
    // Always present on a row Prisma returns — null for a company-level record
    // that was never withdrawn, which is the overwhelmingly common case.
    location: null,
    voidReason: null,
    voidedAt: null,
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

/**
 * Answer `findMany` the way the database does: by status.
 *
 * `assemble` runs two reads — the committed ledger and the withdrawn set — and
 * a mock that returns one array to both makes every approved record show up as
 * withdrawn as well. That is not a harmless fixture detail: the PDF's
 * "withdrawn" section would then be exercised by tests that never voided
 * anything, and a writer that leaked voided rows into the ledger would look
 * correct here.
 */
function stubRecords(prisma: PrismaMock, records: Record<string, unknown>[]): void {
  prisma.activityRecord.findMany.mockImplementation((args: unknown) => {
    const q = args as {
      where?: { status?: { in?: string[] } };
      include?: { evidence?: unknown; location?: unknown };
    };
    const wanted = q?.where?.status?.in ?? [];
    const include = q?.include ?? {};
    return Promise.resolve(
      records
        .filter((r) => wanted.includes(r.status as string))
        .map((r) => ({
          ...r,
          // Prisma hands back a relation only when the query ASKED for it.
          // Returning it regardless made both includes untestable: deleting
          // `location: { select: { name: true } }` from the query — which turns
          // every row in every export into "Whole company" — killed nothing in
          // 657 tests, and the same held for `evidence`, under a spec named
          // "truthful evidence counts".
          evidence: include.evidence ? r.evidence : undefined,
          location: include.location ? r.location : undefined,
        })),
    );
  });
}

const admin: RequestUser = {
  id: 'admin-1',
  email: 'admin@tonyai.local',
  fullName: 'Admin User',
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

    audit.record.mockClear();
    prisma = createPrismaMock();
    emissions = { summary: vi.fn().mockResolvedValue(SUMMARY) };
    service = new ReportsService(
      prisma as unknown as PrismaService,
      emissions as unknown as EmissionsService,
      auditMock(),
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

  it('leaves withdrawn records out of the denominator, so the ratio still means something', async () => {
    prisma.activityRecord.groupBy.mockResolvedValue([
      { status: 'approved', _count: { _all: 10 } },
      { status: 'draft', _count: { _all: 2 } },
      { status: 'voided', _count: { _all: 5 } },
    ]);

    const m = await service.meta(admin, 2024);

    // `committed + incomplete` is meant to EXHAUST `totalCount` — that identity
    // is what makes `incompleteRatio` a ratio of anything. A voided record
    // belongs to neither, and the report's own ledger does not contain it, so
    // leaving it in the denominator would dilute the data-quality figure with
    // records the document never shows.
    expect(m.totalCount).toBe(12);
    expect(m.committedCount + m.incompleteCount).toBe(m.totalCount);
    expect(m.incompleteRatio).toBeCloseTo(2 / 12);
  });

  it('does not call a year approved when every record in it was withdrawn', async () => {
    prisma.activityRecord.groupBy.mockResolvedValue([
      { status: 'voided', _count: { _all: 3 } },
    ]);

    // Nothing is reported for the year, so "approved" would be a compliance
    // claim about an empty inventory.
    const m = await service.meta(admin, 2024);
    expect(m.totalCount).toBe(0);
    expect(m.status).toBe('contains_incomplete_data');
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
    // Every count, not just the total: the empty shape is hand-written, so a
    // field left behind there reports a number for a tenant we cannot see.
    expect(m).toMatchObject({
      totalCount: 0,
      committedCount: 0,
      incompleteCount: 0,
      pendingCount: 0,
      incompleteRatio: 0,
      voidedCount: 0,
    });
    expect(prisma.activityRecord.groupBy).not.toHaveBeenCalled();
  });

  // --- assembly -------------------------------------------------------------

  it('assemble scopes the ledger to the accessible subsidiaries and committed statuses', async () => {
    stubRecords(prisma, [makeRecord()]);
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
    // Both reads, not just the ledger: the withdrawn set is tenant-scoped by the
    // same intersection and must not fall outside the empty-scope early return.
    expect(data.withdrawn).toEqual([]);
    expect(data.withdrawnTotals).toEqual({ count: 0, tCo2e: 0, uncalculatedCount: 0 });
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('assemble deduplicates factor snapshots by factorId and reports truthful evidence counts', async () => {
    stubRecords(prisma, [
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
    stubRecords(prisma, [makeRecord()]);
    const withOut = await service.assemble(admin, q);
    expect(withOut.evidenceSummary).toEqual([]);
    const withIn = await service.assemble(admin, { ...q, includeEvidenceSummary: true } as ReportQueryDto);
    expect(withIn.evidenceSummary).toEqual([
      expect.objectContaining({ fileCount: 1, fileNames: ['invoice-jan.pdf'] }),
    ]);
  });

  // --- CSV + audit ----------------------------------------------------------

  it('generateCsv emits a header + one quoted row per committed record and audits the generation', async () => {
    stubRecords(prisma, [
      makeRecord({ activityValue: 12.5 }),
      makeRecord({ id: 'rec-2', periodValue: 'Feb, "cold"' }), // needs quoting
    ]);
    const csv = await service.generateCsv(admin, q);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('subsidiary,reporting_entity,category');
    expect(lines[2]).toContain('"Feb, ""cold"""');
    expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({
          entity: 'report',
          action: 'generate',
          diff: expect.objectContaining({ exportType: 'csv' }),
        }),
      );
  });

  it('the anomaly column says "not evaluated" instead of leaving a blank the rule never earned', async () => {
    // A blank in that column has always meant "checked, nothing unusual".
    // Since the rule needs three priors, a blank would also cover "never
    // checked" — 30 of 96 committed records on the dev database — inside the
    // artifact an auditor keeps. Same instinct as `Not calculated`.
    stubRecords(prisma, [
      makeRecord({ id: 'rec-clean' }),
      makeRecord({ id: 'rec-flagged', periodValue: 'February', anomalyFlag: true }),
      makeRecord({
        id: 'rec-thin',
        periodValue: 'March',
        anomalyBaselinePriorCount: 2,
        anomalyBaselineTCo2e: null,
      }),
      makeRecord({
        id: 'rec-no-figure',
        periodValue: 'April',
        anomalyBaselinePriorCount: null,
        anomalyBaselineTCo2e: null,
      }),
      makeRecord({
        id: 'rec-zero-window',
        periodValue: 'May',
        anomalyBaselinePriorCount: 3,
        anomalyBaselineTCo2e: 0,
      }),
    ]);

    const rows = (await service.generateCsv(admin, q)).trim().split('\n');
    const cellFor = (period: string) =>
      rows.find((r) => r.includes(period))!.split(',');

    // Checked and clean: still a blank, as it always was.
    expect(cellFor('January')).toContain('');
    expect(rows.find((r) => r.includes('February'))).toContain('yes');
    // ...and the three absences each say which one they are, because "no
    // figure to compare" and "not enough history" have different remedies.
    expect(rows.find((r) => r.includes('March'))).toContain('Not evaluated (2 of 3 priors)');
    expect(rows.find((r) => r.includes('April'))).toContain('Not evaluated (no figure)');
    // A full window that averages zero yields no ratio — reported as its own
    // absence rather than as "3 of 3", which would read as evaluated.
    expect(rows.find((r) => r.includes('May'))).toContain('Not evaluated (baseline is zero)');
  });

  // --- HTML builder (pure) --------------------------------------------------

  it('buildReportHtml renders totals, status and the data warning honestly', async () => {
    stubRecords(prisma, [makeRecord()]);
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
    stubRecords(prisma, [makeRecord()]);
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
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('generateExcel builds the three audit sheets', async () => {
    stubRecords(prisma, [makeRecord()]);
    const buffer = await service.generateExcel(admin, q);
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 2).toString()).toBe('PK'); // valid zip/xlsx magic
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Summary',
      'Raw Activity Data',
      // Present even with nothing withdrawn: a sheet list that depends on the
      // data cannot be consumed by anything automated.
      'Withdrawn Records',
      'Factors Used',
    ]);
  });

  describe('a record with no emission factor (WP17 — Water)', () => {
    // These specs mock TWO records, so the summary the assembler receives has
    // to describe two as well — otherwise the tile-vs-ledger reconciliation
    // below would be asserted against a fixture that cannot occur.
    beforeEach(() => {
      emissions.summary.mockResolvedValue({
        ...SUMMARY,
        recordCount: 2,
        calculatedRecordCount: 1,
        uncalculatedRecordCount: 1,
      });
    });

    // The snapshot a factor-less category stores: no tCo2e, no factorId.
    const waterRecord = () =>
      makeRecord({
        id: 'rec-water',
        category: 'Water',
        scope: 3,
        activityValue: 250,
        activityUnit: 'cubic_metres',
        evidence: [{ fileName: 'water-jan.pdf' }],
        calculation: {
          category: 'Water',
          geographyCode: 'TR',
          reportingYear: 2024,
          scope: 3,
          inputValue: 250,
          inputUnit: 'cubic_metres',
          reasonCode: 'no_emission_factor',
          reason: 'No emission factor is available for "Water"',
        },
      });

    it('the ledger carries null, not 0 — a report must not assert an unmeasured zero', async () => {
      stubRecords(prisma, [waterRecord()]);

      const meta = await service.assemble(admin, q);
      const row = meta.records.find((r) => r.category === 'Water');

      expect(row).toBeDefined();
      expect(row!.tCo2e).toBeNull();
      // The distinction that matters: `0` and `null` are both falsy, so a test
      // asserting "not truthy" would pass on the very bug this replaces.
      expect(row!.tCo2e).not.toBe(0);
    });

    it('the CSV writes "Not calculated" for the water row and a NUMBER for the calculated one', async () => {
      // Two records on purpose. Asserting only that the water row says the
      // label passes just as happily against a writer that prints the label for
      // EVERY row — i.e. against a destroyed tCO₂e column.
      stubRecords(prisma, [makeRecord(), waterRecord()]);

      const csv = await service.generateCsv(admin, q);
      const lines = csv.trim().split('\n');
      const electricity = lines.find((l) => l.includes('Electricity'))!;
      const water = lines.find((l) => l.includes('Water'))!;

      expect(water).toContain('Not calculated');
      expect(electricity).not.toContain('Not calculated');
      expect(electricity.split(',')).toContain('0.44');
      // Positional, not a blanket "no empty cells": the withdrawal columns are
      // legitimately empty on a counted row, so the old `/,,/` guard would now
      // fail for a reason that has nothing to do with a dropped figure. What
      // must hold is that the tCO₂e COLUMN itself is never blank — an empty
      // cell there sums as zero downstream, the same misstatement in a hat.
      const header = lines[0].split(',');
      const tco2e = header.indexOf('tco2e');
      expect(water.split(',')[tco2e]).toBe('Not calculated');
      expect(electricity.split(',')[tco2e]).toBe('0.44');
    });

    it('the Excel ledger writes the label for water and a numeric cell for the calculated row', async () => {
      stubRecords(prisma, [makeRecord(), waterRecord()]);

      const buffer = await service.generateExcel(admin, q);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = wb.getWorksheet('Raw Activity Data')!;

      const cellsByCategory = new Map<string, ExcelJS.CellValue>();
      sheet.eachRow((row, i) => {
        if (i === 1) return; // header
        // Columns 3 and 8 since WP20 inserted `Reporting entity` at 2.
        cellsByCategory.set(String(row.getCell(3).value), row.getCell(8).value);
      });

      expect(cellsByCategory.get('Water')).toBe('Not calculated');
      // The one that was silently broken: `?? 0` here writes a literal 0 into
      // an audit spreadsheet, and `?? ''` leaves a blank that SUMs as zero.
      expect(cellsByCategory.get('Electricity')).toBe(0.44);
      expect(typeof cellsByCategory.get('Electricity')).toBe('number');
    });

    it('the PDF prints the label for water, a number for the calculated row, and reconciles its own tile', async () => {
      stubRecords(prisma, [makeRecord(), waterRecord()]);
      const data = await service.assemble(admin, {
        ...q,
        template: 'ghg_protocol_detail',
      } as typeof q);

      const html = buildReportHtml(data);

      // The PDF is the artifact an auditor keeps, so the absence has to be
      // legible in it — not just correct in the object behind it.
      expect(html).toContain('Not calculated');
      // ...in exactly one LEDGER CELL: a writer that labelled every row would
      // satisfy the assertion above while destroying the whole tCO₂e column.
      // Matched on the cell, not the bare string, because the reconciliation
      // note above the table quotes the same label.
      const labelledCells = html.match(
        /<td class="num"><span class="note">Not calculated<\/span><\/td>/g,
      );
      expect(labelledCells).toHaveLength(1);
      // 0.44 rounded by the report's own 1-decimal formatter.
      expect(html).toContain('<td class="num">0.4</td>');
      // The "Committed records" tile counts every committed row, so it must not
      // disagree with the ledger printed directly beneath it.
      expect(data.summary.recordCount).toBe(2);
      expect(data.records).toHaveLength(2);
      expect(html).toContain('carry no emissions figure');
    });

    it('a factor-less record contributes no row to the Factors Used appendix', async () => {
      stubRecords(prisma, [waterRecord()]);

      const meta = await service.assemble(admin, q);

      // Nothing to be traceable to — an appendix row here would claim a
      // provenance the figure never had.
      expect(meta.factors).toHaveLength(0);
    });
  });

  it('generateCsv neutralizes spreadsheet formula injection', async () => {
    stubRecords(prisma, [
      makeRecord({ periodValue: '=HYPERLINK("evil")' }),
    ]);
    const csv = await service.generateCsv(admin, q);
    expect(csv).toContain(`"'=HYPERLINK`);
  });
  // --- WP20: the restatement disclosure -------------------------------------

  describe('withdrawn records are disclosed, not silently omitted', () => {
    const voidedRecord = (overrides: Record<string, unknown> = {}) =>
      makeRecord({
        id: 'rec-void',
        status: 'voided',
        periodValue: 'February',
        activityValue: 900,
        voidReason: 'Duplicate of the Istanbul HQ invoice for the same month.',
        voidedAt: new Date('2026-02-03T09:30:00.000Z'),
        ...overrides,
      });

    /** A withdrawn record in a category with no emission factor (WP17 — Water):
     *  nothing was removed from the totals by withdrawing it, and no writer may
     *  print a 0 that claims otherwise. */
    const voidedWaterRecord = () =>
      voidedRecord({
        id: 'rec-void-water',
        category: 'Water',
        activityValue: 250,
        activityUnit: 'cubic_metres',
        periodValue: 'April',
        calculation: { category: 'Water', reason: 'no_factor_for_category' },
        voidReason: 'Meter read against the wrong building.',
      });

    const columns = (csv: string) => {
      const lines = csv.trim().split('\n');
      const header = lines[0].split(',');
      const at = (line: string, name: string) => line.split(',')[header.indexOf(name)];
      // A strict numeric test: `Number('')` is 0 AND finite, so filtering on
      // `Number.isFinite` treats a BLANK cell as a legitimate zero — which is
      // exactly the dropped-figure bug these sums exist to catch.
      const numeric = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null);
      const sum = (name: string, rows = lines.slice(1)) =>
        rows
          .map((l) => numeric(at(l, name)))
          .filter((n): n is number => n !== null)
          .reduce((a, b) => a + b, 0);
      return { lines, header, at, numeric, sum };
    };

    it('meta reports the withdrawn count without letting it back into the ratio', async () => {
      prisma.activityRecord.groupBy.mockResolvedValue([
        { status: 'approved', _count: { _all: 6 } },
        { status: 'submitted', _count: { _all: 2 } },
        { status: 'under_review', _count: { _all: 1 } },
        { status: 'draft', _count: { _all: 2 } },
        { status: 'voided', _count: { _all: 4 } },
      ] as unknown as { status: ActivityRecordStatus; _count: { _all: number } }[]);

      const m = await service.meta(admin, 2024);

      // Pending rows are in the fixture on purpose: without them, a count that
      // swept `submitted` in with `voided` would report queued records as
      // withdrawn, drop them from `totalCount` AND inflate the data-quality
      // ratio — three compliance figures wrong at once — with the suite green.
      expect(m.voidedCount).toBe(4);
      expect(m.pendingCount).toBe(3);
      expect(m.totalCount).toBe(11);
      expect(m.committedCount).toBe(9);
      expect(m.incompleteCount).toBe(2);
      expect(m.committedCount + m.incompleteCount).toBe(m.totalCount);
      expect(m.incompleteRatio).toBeCloseTo(2 / 11);
    });

    it('reports zero withdrawals for a year with no records at all', async () => {
      prisma.activityRecord.groupBy.mockResolvedValue([]);
      expect((await service.meta(admin, 2023)).voidedCount).toBe(0);
    });

    it('reads the withdrawn set separately and keeps voided rows out of the ledger', async () => {
      stubRecords(prisma, [makeRecord(), voidedRecord()]);

      const data = await service.assemble(admin, q);

      expect(prisma.activityRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            subsidiaryId: { in: ['sub-1', 'sub-2'] },
            reportingYear: 2024,
            status: { in: ['voided'] },
          }),
          // The include is half the feature: without the location join every
          // row in every export reads "Whole company", and without evidence the
          // ledger's file counts are all zero. `objectContaining` on `where`
          // alone constrains neither.
          include: {
            evidence: { select: { fileName: true } },
            location: { select: { name: true } },
          },
        }),
      );
      // The ledger is the committed set and nothing else — a voided row leaking
      // into it would put a withdrawn figure back into every total that sums it.
      expect(data.records.map((r) => r.status)).toEqual(['approved']);
      expect(data.withdrawn).toHaveLength(1);
      expect(data.withdrawn[0]).toMatchObject({
        category: 'Electricity',
        periodValue: 'February',
        status: 'voided',
        voidReason: 'Duplicate of the Istanbul HQ invoice for the same month.',
        voidedAt: '2026-02-03 09:30',
      });
      expect(data.withdrawnTotals).toEqual({ count: 1, tCo2e: 0.44, uncalculatedCount: 1 - 1 });
    });

    it('sums what left in tonnes, and says how many rows had nothing to remove', async () => {
      stubRecords(prisma, [makeRecord(), voidedRecord(), voidedWaterRecord()]);

      const { withdrawnTotals } = await service.assemble(admin, q);

      // Materiality is measured in tonnes, not rows — and a factor-less row
      // must not be folded in silently, or "0.44 tCO₂e withdrawn" beside two
      // rows implies both carried tonnage.
      expect(withdrawnTotals).toEqual({ count: 2, tCo2e: 0.44, uncalculatedCount: 1 });
    });

    it('names the reporting entity on every row — committed and withdrawn alike', async () => {
      stubRecords(prisma, [
        makeRecord({ locationId: 'loc-1', location: { name: 'Istanbul HQ' } }),
        makeRecord({ id: 'rec-2', periodValue: 'March' }),
        voidedRecord({ locationId: 'loc-2', location: { name: 'Izmir Freight Hub' } }),
      ]);

      const csv = await service.generateCsv(admin, q);
      const { lines, at } = columns(csv);
      const site = lines.find((l) => l.includes('January'))!;
      const company = lines.find((l) => l.includes('March'))!;
      const withdrawn = lines.find((l) => l.includes('February'))!;

      expect(at(site, 'reporting_entity')).toBe('Istanbul HQ');
      expect(at(company, 'reporting_entity')).toBe('Whole company');
      // The withdrawn row too, and asserted beside `subsidiary`: the two halves
      // of a double-counted month differ ONLY in the reporting entity, and
      // naming the wrong one in the disclosure defeats the feature. A swap of
      // the two cells passes any assertion that checks one of them alone.
      expect(at(withdrawn, 'reporting_entity')).toBe('Izmir Freight Hub');
      expect(at(withdrawn, 'subsidiary')).toBe('Energy');
    });

    it('discloses a withdrawal in the same table without adding it to any total', async () => {
      stubRecords(prisma, [
        makeRecord(),
        makeRecord({ id: 'rec-2', periodValue: 'March', activityValue: 2000 }),
        voidedRecord(),
      ]);

      const csv = await service.generateCsv(admin, q);
      const { lines, at, sum } = columns(csv);
      const withdrawn = lines.find((l) => l.includes('February'))!;
      const counted = lines.find((l) => l.includes('January'))!;

      expect(at(withdrawn, 'status')).toBe('voided');
      expect(at(withdrawn, 'void_reason')).toContain('Duplicate of the Istanbul HQ');
      expect(at(withdrawn, 'voided_at_utc')).toBe('2026-02-03 09:30');
      // What left is stated — in its OWN columns.
      expect(at(withdrawn, 'voided_tco2e')).toBe('0.44');
      expect(at(withdrawn, 'voided_activity_value')).toBe('900');
      // ...and EVERY column a reader could aggregate carries the marker on a
      // withdrawn row. Protecting tCO₂e alone still overstated total energy
      // consumption — itself a reported figure (GRI 302-1, CSRD E1-5) — and
      // made the CSV disagree with the Excel from the same request.
      for (const column of ['tco2e', 'activity_value', 'evidence_files', 'anomaly_flag']) {
        expect(at(withdrawn, column)).toBe('Withdrawn');
      }
      expect(sum('tco2e')).toBe(0.88);
      expect(sum('activity_value')).toBe(3000);
      expect(sum('evidence_files')).toBe(2);
      // The voided block is empty on a counted row: it was never withdrawn.
      for (const column of ['void_reason', 'voided_tco2e', 'voided_activity_value', 'voided_at_utc']) {
        expect(at(counted, column)).toBe('');
      }
    });

    it('says "Not calculated" for a withdrawn row that never had a figure', async () => {
      stubRecords(prisma, [makeRecord(), voidedWaterRecord()]);

      const csv = await service.generateCsv(admin, q);
      const { lines, at } = columns(csv);
      const water = lines.find((l) => l.includes('Water'))!;

      // `?? 0` here writes a literal zero into the removed-tonnage column, and
      // `?? ''` leaves a blank that SUMs as one — the unmeasured zero, in the
      // disclosure this time.
      expect(at(water, 'voided_tco2e')).toBe('Not calculated');

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await service.generateExcel(admin, q)) as unknown as ArrayBuffer);
      const sheet = wb.getWorksheet('Withdrawn Records')!;
      expect(sheet.getRow(2).getCell(8).value).toBe('Not calculated');

      const html = buildReportHtml(await service.assemble(admin, q));
      expect(html).toContain('Total withdrawn');
      expect(html).toContain('carry no emissions figure');
      expect(html).not.toMatch(/<td class="num">0<\/td>\s*<td>2026-02/);
    });

    it('quotes a separator, a carriage return and a formula inside the reason', async () => {
      stubRecords(prisma, [
        voidedRecord({ voidReason: '=HYPERLINK("evil"), and a comma' }),
        voidedRecord({ id: 'rec-void-2', periodValue: 'May', voidReason: 'split\rrow' }),
      ]);

      const csv = await service.generateCsv(admin, q);

      // The reason is free text a user typed, so it needs the same treatment
      // every other user-influenced column already gets.
      expect(csv).toContain(`"'=HYPERLINK(""evil""), and a comma"`);
      // A BARE carriage return ends a record in most parsers: unquoted, the
      // tail of a reason becomes a fabricated ledger row that no database row
      // and no audit entry stands behind.
      expect(csv).toContain('"split\rrow"');
      expect(csv.trim().split('\n')).toHaveLength(3); // header + 2 rows, not 3
    });

    it('carries the withdrawn records on their own Excel sheet, with the total', async () => {
      stubRecords(prisma, [
        makeRecord({ locationId: 'loc-1', location: { name: 'Istanbul HQ' } }),
        voidedRecord({ locationId: 'loc-2', location: { name: 'Izmir Freight Hub' } }),
        voidedRecord({ id: 'rec-void-2', periodValue: 'May' }),
      ]);

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await service.generateExcel(admin, q)) as unknown as ArrayBuffer);
      const sheet = wb.getWorksheet('Withdrawn Records')!;
      const ledger = wb.getWorksheet('Raw Activity Data')!;
      const summary = wb.getWorksheet('Summary')!;

      // Two withdrawals, not one: a writer that listed only the first would
      // satisfy any single-row fixture, and a restatement that discloses one of
      // two is worse than none — it reads as complete.
      expect(sheet.rowCount).toBe(4); // header + 2 withdrawals + total
      expect(String(sheet.getRow(1).getCell(8).value)).toBe('tCO₂e removed');
      expect(String(sheet.getRow(1).getCell(9).value)).toBe('Withdrawn (UTC)');
      expect(sheet.getRow(2).getCell(2).value).toBe('Izmir Freight Hub');
      expect(sheet.getRow(2).getCell(8).value).toBe(0.44);
      expect(String(sheet.getRow(2).getCell(9).value)).toBe('2026-02-03 09:30');
      expect(String(sheet.getRow(2).getCell(10).value)).toContain('Duplicate of the Istanbul HQ');
      expect(sheet.getRow(3).getCell(5).value).toBe('May');
      expect(String(sheet.getRow(4).getCell(1).value)).toBe('Total withdrawn');
      expect(sheet.getRow(4).getCell(8).value).toBeCloseTo(0.88);

      // The ledger's own entity column, and the Summary line's VALUE — a label
      // assertion alone lets Summary say "0 withdrawn" beside a sheet listing
      // two, which is this feature's failure mode one sheet over.
      expect(String(ledger.getRow(1).getCell(2).value)).toBe('Reporting entity');
      expect(ledger.getRow(2).getCell(2).value).toBe('Istanbul HQ');
      const summaryRow = (summary.getSheetValues() as unknown[][]).find(
        (row) => Array.isArray(row) && String(row[1] ?? '').startsWith('Withdrawn records'),
      )!;
      expect(summaryRow[2]).toBe(2);
      expect(String(summaryRow[3])).toContain('0.88');
    });

    it('states the restatement in the PDF — count, tonnage, and every row', async () => {
      stubRecords(prisma, [
        makeRecord(),
        makeRecord({ id: 'rec-2', periodValue: 'March' }),
        makeRecord({ id: 'rec-3', periodValue: 'June' }),
        voidedRecord(),
        voidedRecord({ id: 'rec-void-2', periodValue: 'May', voidReason: 'Second withdrawal.' }),
      ]);

      const html = buildReportHtml(await service.assemble(admin, q));

      // THREE committed against TWO withdrawn, deliberately unequal: on a
      // balanced fixture a banner built from `records.length` prints the right
      // number for the wrong reason, and the assertion below cannot tell.
      expect(html).toContain('2 records were withdrawn from this reporting year');
      expect(html).toContain('0.9 tCO₂e</strong> from the inventory');
      // The HEADING, not the phrase: the banner above quotes the section title,
      // so a bare `toContain('Withdrawn from this inventory')` is satisfied by
      // the banner alone and passes with the section renamed or gone.
      expect(html).toContain('<h2>Withdrawn from this inventory</h2>');
      expect(html).toContain('tCO₂e removed');
      expect(html).toContain('Withdrawn (UTC)');
      // The column's VALUE, not only its header: a restatement whose date is a
      // dash tells the reader nothing about when the inventory changed.
      expect(html).toContain('<td>2026-02-03 09:30</td>');
      expect(html).toContain('Reporting entity');
      // Both rows listed, not just the first.
      expect(html).toContain('Duplicate of the Istanbul HQ');
      expect(html).toContain('Second withdrawal.');
      expect(html).toContain('Total withdrawn');
    });

    it('discloses the restatement in the executive summary too, not only the detail template', async () => {
      stubRecords(prisma, [makeRecord(), voidedRecord()]);

      const html = buildReportHtml(
        await service.assemble(admin, { ...q, template: 'executive_summary' } as typeof q),
      );

      // The template the UI downloads by default, and the one a board reads.
      // Gating the disclosure on `isDetail` — as the ledger IS gated — would
      // hide it exactly where it matters most, and every other HTML spec in
      // this file uses the detail template, so nothing else would notice.
      expect(html).not.toContain('Activity records ledger');
      expect(html).toContain('Restatement:');
      expect(html).toContain('<h2>Withdrawn from this inventory</h2>');
    });

    it('escapes what the user wrote, in the ledger and in the disclosure', async () => {
      stubRecords(prisma, [
        makeRecord({ locationId: 'loc-1', location: { name: '<b>Istanbul</b>' } }),
        voidedRecord({
          locationId: 'loc-2',
          location: { name: '<i>Izmir</i>' },
          voidReason: '<script>alert(1)</script> misread invoice',
        }),
      ]);

      const html = buildReportHtml(await service.assemble(admin, q));

      // Location names are user-authored (`POST /locations`) and now print in
      // BOTH tables; the reason is 2,000 characters of free text.
      expect(html).not.toContain('<b>Istanbul</b>');
      expect(html).not.toContain('<i>Izmir</i>');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;b&gt;Istanbul');
      expect(html).toContain('&lt;i&gt;Izmir');
      expect(html).toContain('&lt;script&gt;');
    });

    it('renders the disclosure into the document the PDF is printed from', async () => {
      stubRecords(prisma, [makeRecord(), voidedRecord()]);

      const pdf = await service.generatePdf(admin, q);

      // The bytes come from a stub, so what is asserted is the HTML the real
      // Chromium would have been handed — the E2E proves a real PDF arrives,
      // and nothing before this proved what was inside it.
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      const html = pdfPage.setContent.mock.calls.at(-1)?.[0] as string;
      expect(html).toContain('Restatement:');
      expect(html).toContain('<h2>Withdrawn from this inventory</h2>');
    });

    it('says nothing about withdrawals when nothing was withdrawn', async () => {
      stubRecords(prisma, [makeRecord()]);

      const html = buildReportHtml(await service.assemble(admin, q));

      // An empty disclosure is a claim of its own; a clean year should read as
      // a clean year rather than as a report with an empty restatement table.
      expect(html).not.toContain('Restatement:');
      expect(html).not.toContain('Withdrawn from this inventory');
    });

    it('records what each artifact disclosed in the generation log', async () => {
      stubRecords(prisma, [makeRecord(), voidedRecord()]);
      const scoped = { ...q, subsidiaryId: 'sub-1' } as typeof q;

      await service.generateCsv(admin, scoped);
      await service.generateExcel(admin, scoped);
      await service.generatePdf(admin, scoped);

      // The record set moves afterwards, so this is not recoverable later: it
      // is the only place a generated report's restatement count survives.
      // Asserted for ALL THREE formats — pinning one leaves the others free to
      // log a zero — and with the scope, which makes the count meaningful.
      for (const exportType of ['csv', 'excel', 'pdf']) {
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ id: expect.any(String) }),
          expect.objectContaining({
            entity: 'report',
            action: 'generate',
            diff: expect.objectContaining({
              exportType,
              voidedCount: 1,
              // The SUMMARY's count, not `records.length` — one expression for
              // all three formats, so two exports of one selection cannot write
              // different counts into an append-only compliance log.
              recordCount: SUMMARY.recordCount,
              subsidiaryId: 'sub-1',
              year: 2024,
            }),
          }),
        );
      }
    });
  });

  // --- the column order every writer commits to -----------------------------

  /**
   * Golden assertions on column ORDER and MEMBERSHIP — one per format, per
   * table, plus the two total rows whose alignment is positional.
   *
   * They exist because the report writers hold THIRTEEN hand-maintained
   * literals (the PDF's `<th>`s and its `<td>`s, the Excel header and its rows,
   * the CSV header and its rows — once for the ledger and again for withdrawn
   * records — plus an Excel and a PDF total row) and nothing pinned their
   * order. Measured before writing these: a change that silently REORDERED
   * columns passed the whole suite. The CSV assertions read by column name, so
   * everything after position 3 was free to move; the PDF assertions are
   * label-based `toContain` over one HTML string, so its order was entirely
   * unconstrained; the Excel sheets pinned only a handful of positions.
   *
   * The three formats deliberately do NOT agree with one another. The PDF is a
   * printed A4 page: it drops the unit and anomaly columns and merges value
   * with unit, while carrying `Normalised` — which the other two lack — because
   * ISO 14064-1 §9.3.1 asks the reader to be able to recompute the figure. The
   * CSV alone carries the `voided_*` suffix, because its two row kinds share
   * one table rather than getting a second file. Every one of those divergences
   * is load-bearing, which is precisely why each writer needs its own golden:
   * there is no cross-format invariant to fall back on.
   */
  describe('the column order every writer commits to', () => {
    const withdrawnFixture = () =>
      makeRecord({
        id: 'rec-void',
        status: 'voided',
        periodValue: 'February',
        activityValue: 900,
        voidReason: 'Duplicate of the Istanbul HQ invoice for the same month.',
        voidedAt: new Date('2026-02-03T09:30:00.000Z'),
      });

    /** The `<tr>` containing a given phrase, whole. */
    const rowContaining = (html: string, phrase: string): string => {
      const i = html.indexOf(phrase);
      expect(i).toBeGreaterThan(-1);
      return html.slice(html.lastIndexOf('<tr>', i), html.indexOf('</tr>', i));
    };

    const excelHeader = async (sheetName: string): Promise<string[]> => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await service.generateExcel(admin, q)) as unknown as ArrayBuffer);
      const values = wb.getWorksheet(sheetName)!.getRow(1).values as string[];
      return values.slice(1); // exceljs pads index 0
    };

    it('CSV: the ledger header, in full and in order', async () => {
      stubRecords(prisma, [makeRecord(), withdrawnFixture()]);
      const csv = await service.generateCsv(admin, q);

      // Full-array equality, not a prefix. The previous assertion covered the
      // first three names, which left the twelve that carry every number.
      expect(csv.trim().split('\n')[0].split(',')).toEqual([
        'subsidiary', 'reporting_entity', 'category', 'reporting_period',
        'period_value', 'activity_value', 'activity_unit', 'tco2e', 'status',
        'evidence_files', 'anomaly_flag', 'voided_activity_value',
        'voided_tco2e', 'voided_at_utc', 'void_reason',
      ]);
    });

    it('CSV: every row has exactly as many cells as the header, on both row kinds', async () => {
      stubRecords(prisma, [makeRecord(), withdrawnFixture()]);
      const lines = (await service.generateCsv(admin, q)).trim().split('\n');

      // The withdrawn row's four `Withdrawn` markers are placed by POSITION,
      // with nothing tying a marker to its column name. An arity check is what
      // catches a marker gained or lost when the columns move: the fixture is
      // comma-free on purpose, so a plain split is exact here.
      const width = lines[0].split(',').length;
      expect(width).toBe(15);
      for (const line of lines.slice(1)) {
        expect(line.split(',')).toHaveLength(width);
      }
    });

    it('Excel: the ledger sheet header, in full and in order', async () => {
      stubRecords(prisma, [makeRecord()]);
      expect(await excelHeader('Raw Activity Data')).toEqual([
        'Subsidiary', 'Reporting entity', 'Category', 'Reporting period',
        'Period', 'Activity value', 'Unit', 'tCO₂e', 'Status',
        'Evidence files', 'Anomaly flag',
      ]);
    });

    it('Excel: the withdrawn sheet header, in full and in order', async () => {
      stubRecords(prisma, [makeRecord(), withdrawnFixture()]);
      expect(await excelHeader('Withdrawn Records')).toEqual([
        'Subsidiary', 'Reporting entity', 'Category', 'Reporting period',
        'Period', 'Activity value', 'Unit', 'tCO₂e removed',
        'Withdrawn (UTC)', 'Reason',
      ]);
    });

    it('Excel: the total row lands under the column it totals', async () => {
      stubRecords(prisma, [makeRecord(), withdrawnFixture()]);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await service.generateExcel(admin, q)) as unknown as ArrayBuffer);
      const sheet = wb.getWorksheet('Withdrawn Records')!;
      const header = (sheet.getRow(1).values as string[]).slice(1);
      const total = (sheet.getRow(3).values as unknown[]).slice(1);

      // The total row is seven empty strings and a number in a hand-counted
      // slot. Asserting the tonnage sits under `tCO₂e removed` — rather than at
      // literal index 8 — is what survives the columns being reordered, and
      // what fails if the padding stops matching the header.
      expect(total[0]).toBe('Total withdrawn');
      expect(total[header.indexOf('tCO₂e removed')]).toBe(0.44);
    });

    it('PDF: the ledger table headers, in full and in order', async () => {
      stubRecords(prisma, [makeRecord()]);
      const html = buildReportHtml(await service.assemble(admin, q));

      // Narrower than the other two BY DESIGN: no standalone unit column (it is
      // merged into Activity) and no anomaly column, because this is an A4
      // page. `Normalised` is here and nowhere else — ISO 14064-1 §9.3.1.
      expect(headersUnder(html, 'Activity records ledger')).toEqual([
        'Subsidiary', 'Reporting entity', 'Category', 'Period', 'Activity',
        'Normalised', 'tCO₂e', 'Status', 'Evidence',
      ]);
    });

    it('PDF: the withdrawn table headers, in full and in order', async () => {
      stubRecords(prisma, [makeRecord(), withdrawnFixture()]);
      const html = buildReportHtml(await service.assemble(admin, q));
      expect(headersUnder(html, 'Withdrawn from this inventory')).toEqual([
        'Subsidiary', 'Reporting entity', 'Category', 'Period', 'tCO₂e removed',
        'Withdrawn (UTC)', 'Reason',
      ]);
    });

    it('PDF: the total row spans exactly the width of the table above it', async () => {
      stubRecords(prisma, [makeRecord(), withdrawnFixture()]);
      const html = buildReportHtml(await service.assemble(admin, q));
      const width = headersUnder(html, 'Withdrawn from this inventory').length;

      // Two hardcoded colspans plus a cell — 4 + 1 + 2. Add a column to the
      // header and the arithmetic silently stops matching, which a browser
      // renders as a table with a short last row rather than as an error.
      const spanned = [...rowContaining(html, 'Total withdrawn').matchAll(/<td([^>]*)>/g)]
        .map((m) => Number(/colspan="(\d+)"/.exec(m[1])?.[1] ?? 1))
        .reduce((a, b) => a + b, 0);
      expect(spanned).toBe(width);
    });
  });

  // --- the cells, bound to the headers above them ----------------------------

  /**
   * What #72's goldens do NOT reach, measured before writing this: the PDF's
   * `<td>` order is pinned by nothing at all. Every existing PDF cell assertion
   * is `toContain` over the whole document, and the goldens extract `<th>`
   * only — so swapping two cells in the row template puts a period value under
   * the Category heading with the entire suite green, including all three PDF
   * goldens.
   *
   * These bind cell INDEX to header INDEX. They read by name, which is what
   * makes them legible, but the lookup is positional, which is what makes them
   * bite. This is the prerequisite for consolidating the column literals: the
   * PDF half of that refactor is unverifiable without it.
   */
  describe('the cells sit under the headers they belong to', () => {
    /** Inner text of the first data row's `<td>`s, in document order. */
    const firstRowCells = (html: string, heading: string): string[] => {
      const start = html.indexOf(`<h2>${heading}</h2>`);
      expect(start).toBeGreaterThan(-1);
      const bodyStart = html.indexOf('<tbody>', start);
      const row = html.slice(bodyStart, html.indexOf('</tr>', bodyStart));
      return [...row.matchAll(/<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/g)].map((m) =>
        m[1].replace(/\s+/g, ' ').trim(),
      );
    };

    /** Header label -> the cell rendered beneath it. Fails loudly on a width
     *  mismatch rather than silently zipping the shorter of the two. */
    const cellsByHeader = (html: string, heading: string): Record<string, string> => {
      const headers = headersUnder(html, heading);
      const cells = firstRowCells(html, heading);
      expect(cells).toHaveLength(headers.length);
      return Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
    };

    /** A record whose unit needs converting, so the `Normalised` column takes
     *  its REAL branch. No fixture in this file set these three fields, so
     *  every test that has ever run took the `&mdash;` path — the one column
     *  that exists for a named compliance reason (ISO 14064-1 §9.3.1) had zero
     *  cell coverage. */
    const convertedRecord = () =>
      makeRecord({
        category: 'Natural Gas',
        activityValue: 100,
        activityUnit: 'cubic_metres',
        calculation: {
          tCo2e: 0.2071,
          factorId: 'f-gas',
          factorValue: 0.18227,
          factorUnit: 'kgCO2e/kWh',
          methodology: 'location-based',
          source: 'demo',
          version: '2024.1',
          geographyCode: 'TR',
          normalizedValue: 1136,
          normalizedUnit: 'kWh',
          conversionFactor: 11.36,
        },
      });

    it('PDF ledger: every value under its own heading', async () => {
      stubRecords(prisma, [convertedRecord()]);
      const cells = cellsByHeader(
        buildReportHtml(await service.assemble(admin, q)),
        'Activity records ledger',
      );

      expect(cells['Subsidiary']).toBe('Energy');
      expect(cells['Category']).toBe('Natural Gas');
      expect(cells['Period']).toBe('January');
      expect(cells['Status']).toBe('approved');
      expect(cells['Evidence']).toBe('1');
      // Value AND unit in one cell: the PDF merges them because it is a
      // printed A4 page, which is why it has no standalone Unit column.
      expect(cells['Activity']).toBe('100 cubic_metres');
      // The compliance column, on its real branch at last. ISO 14064-1 §9.3.1
      // asks a reader to be able to recompute the figure, so the multiplier is
      // part of the cell and not decoration.
      expect(cells['Normalised']).toContain('1,136 kWh');
      expect(cells['Normalised']).toContain('11.36');
      // ONE decimal, because the PDF's formatter is `maximumFractionDigits: 1`
      // while the CSV emits full precision (0.2071). A real cross-format
      // divergence, pinned so a consolidation cannot quietly unify the two —
      // changing the printed rounding changes an artifact an auditor keeps.
      expect(cells['tCO₂e']).toBe('0.2');
    });

    it('PDF ledger: an unconvertible unit renders a dash, not a zero', async () => {
      stubRecords(prisma, [makeRecord()]);
      const cells = cellsByHeader(
        buildReportHtml(await service.assemble(admin, q)),
        'Activity records ledger',
      );
      // kWh needs no conversion, so there is nothing to state. A `0` here would
      // assert a measured quantity of zero.
      expect(cells['Normalised']).toBe('&mdash;');
      expect(cells['Activity']).toBe('1,000 kWh');
    });

    it('PDF withdrawn: every value under its own heading', async () => {
      stubRecords(prisma, [
        makeRecord(),
        makeRecord({
          id: 'rec-void',
          status: 'voided',
          periodValue: 'February',
          voidReason: 'Duplicate of the Istanbul HQ invoice for the same month.',
          voidedAt: new Date('2026-02-03T09:30:00.000Z'),
        }),
      ]);
      const cells = cellsByHeader(
        buildReportHtml(await service.assemble(admin, q)),
        'Withdrawn from this inventory',
      );

      expect(cells['Subsidiary']).toBe('Energy');
      expect(cells['Category']).toBe('Electricity');
      expect(cells['Period']).toBe('February');
      expect(cells['tCO₂e removed']).toBe('0.4'); // one decimal, as above
      expect(cells['Withdrawn (UTC)']).toBe('2026-02-03 09:30');
      expect(cells['Reason']).toContain('Duplicate of the Istanbul HQ');
      // The withdrawn table carries no activity quantity at all — an A4-width
      // decision, and the reason this table is 7 columns where Excel is 10.
      expect(Object.keys(cells)).not.toContain('Activity');
    });

    it('Excel: every data cell under its own header, both sheets', async () => {
      stubRecords(prisma, [
        convertedRecord(),
        makeRecord({
          id: 'rec-void',
          status: 'voided',
          periodValue: 'February',
          activityValue: 900,
          voidReason: 'Meter read against the wrong building.',
          voidedAt: new Date('2026-02-03T09:30:00.000Z'),
        }),
      ]);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await service.generateExcel(admin, q)) as unknown as ArrayBuffer);

      // #72 pinned row 1 — the HEADER — in full on both sheets. The DATA rows
      // were pinned at three positions on the ledger and four on withdrawn, so
      // a header and a row built by two traversals could fall out of step and
      // put Status under Evidence files with nothing failing.
      const pairs = (sheet: string) => {
        const ws = wb.getWorksheet(sheet)!;
        const header = (ws.getRow(1).values as string[]).slice(1);
        const data = (ws.getRow(2).values as unknown[]).slice(1);
        expect(data).toHaveLength(header.length);
        return Object.fromEntries(header.map((h, i) => [h, data[i]]));
      };

      const ledger = pairs('Raw Activity Data');
      expect(ledger['Subsidiary']).toBe('Energy');
      expect(ledger['Category']).toBe('Natural Gas');
      expect(ledger['Reporting period']).toBe('monthly');
      expect(ledger['Period']).toBe('January');
      expect(ledger['Unit']).toBe('cubic_metres');
      expect(ledger['Status']).toBe('approved');
      expect(ledger['Evidence files']).toBe(1);
      // Numbers, not strings: a stringified tCO₂e stops summing in the
      // workbook an auditor opens.
      expect(ledger['Activity value']).toBe(100);
      expect(typeof ledger['tCO₂e']).toBe('number');

      const withdrawn = pairs('Withdrawn Records');
      expect(withdrawn['Subsidiary']).toBe('Energy');
      expect(withdrawn['Period']).toBe('February');
      expect(withdrawn['Unit']).toBe('kWh');
      expect(withdrawn['Activity value']).toBe(900);
      expect(withdrawn['Withdrawn (UTC)']).toBe('2026-02-03 09:30');
      expect(withdrawn['Reason']).toContain('wrong building');
      expect(typeof withdrawn['tCO₂e removed']).toBe('number');
    });
  });


});

/**
 * The column vocabulary, and the guarantees that are types rather than tests.
 *
 * `apps/api/tsconfig.json` does not extend the root config and does not set
 * `strict`, so `strictFunctionTypes` is OFF in this package and parameters are
 * checked bivariantly — the usual "contravariance rejects the wrong row type"
 * protection does not exist here. What does hold is the writers' concrete
 * signatures, and these probes are what keep them honest: `pnpm typecheck`
 * includes `src`, so a `@ts-expect-error` that stops erroring FAILS THE BUILD
 * the day the guarantee is lost. That is the whole reason they are here rather
 * than in a comment.
 */
describe('report column descriptors', () => {
  const ledgerRow: ReportLedgerRow = {
    subsidiaryName: 'Energy', locationId: null, locationName: null,
    category: 'Electricity', periodValue: 'January', reportingPeriod: 'monthly',
    activityValue: 1000, activityUnit: 'kWh', tCo2e: 0.44, status: 'approved',
    evidenceCount: 1, anomalyFlag: false, anomalyEvaluated: true,
    anomalyBaselinePriorCount: 3,
  };
  const withdrawnRow: ReportWithdrawnRow = {
    ...ledgerRow, status: 'voided', voidReason: 'Duplicate invoice.',
    voidedAt: '2026-02-03 09:30',
  };

  it('refuses a withdrawn row in the ledger writer, at compile time', () => {
    // @ts-expect-error `'voided'` is not in `Exclude<ActivityRecordStatus, 'voided'>`.
    // This is the guarantee `ReportLedgerRow.status` exists to provide: a
    // withdrawn figure written as a counted ledger row is back inside every
    // total the record was deliberately taken out of.
    csvLedgerRow(withdrawnRow);
    // The right way round still compiles, so the probe above is about the
    // status and not about some unrelated shape mismatch.
    expect(csvLedgerRow(ledgerRow)).toContain('approved');
  });

  it('marks every aggregatable column on a withdrawn row, and only those', () => {
    const header = csvHeader().split(',');
    const cells = csvWithdrawnRow(withdrawnRow).split(',');
    const at = (name: string) => cells[header.indexOf(name)];

    // Hand-written, NOT derived from `BODY_COLUMNS`. Deriving it would make the
    // assertion "the marker appears wherever the descriptor says it should",
    // which is a tautology that passes with `anomaly_flag` dropped from the
    // set. This list is the independent statement of the requirement.
    for (const column of ['activity_value', 'tco2e', 'evidence_files', 'anomaly_flag']) {
      expect(at(column)).toBe('Withdrawn');
    }
    // A unit is a word and is not summable; the status is the discriminator and
    // must keep saying `voided`. Both sit BESIDE marked columns, which is what
    // proves "aggregatable" and not "on a withdrawn row" is the rule.
    expect(at('activity_unit')).toBe('kWh');
    expect(at('status')).toBe('voided');
    // ...and the disclosure block is never marked: blanking it would leave a
    // file saying a figure was withdrawn and refusing to say what.
    expect(at('voided_activity_value')).toBe('1000');
    expect(at('voided_tco2e')).toBe('0.44');
  });

  it('leaves the disclosure block empty on a counted row', () => {
    const header = csvHeader().split(',');
    const cells = csvLedgerRow(ledgerRow).split(',');
    for (const column of ['voided_activity_value', 'voided_tco2e', 'voided_at_utc', 'void_reason']) {
      expect(cells[header.indexOf(column)]).toBe('');
    }
  });
});
