import { describe, it, expect, beforeEach, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { ReportsService } from './reports.service';
import { buildReportHtml } from './report-html';
import {
  BODY_COLUMNS,
  DISCLOSURE_COLUMNS,
  MARKED_WITHOUT_DISCLOSURE,
  csvHeader,
  csvLedgerRow,
  csvWithdrawnRow,
  pdfClass,
  pdfLedgerHeadRow,
  pdfLedgerRow,
  pdfWithdrawnHeadRow,
  pdfWithdrawnRow,
  excelLedgerHeader,
  excelWithdrawnHeader,
  excelWithdrawnRow,
  excelWithdrawnTotalRow,
  excelLedgerRow,
} from './report-columns';
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
    voidedBy: null,
    evidenceLinks: [{ evidence: { id: 'ev-jan', fileName: 'invoice-jan.pdf' } }],
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
      include?: { evidenceLinks?: unknown; location?: unknown };
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
          // 657 tests, and the same held for the evidence relation, under a
          // spec named "truthful evidence counts".
          evidenceLinks: include.evidenceLinks ? r.evidenceLinks : undefined,
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
      makeRecord({ id: 'rec-2', periodValue: 'February', evidenceLinks: [] }),
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
      expect.objectContaining({ fileCount: 1, fileNames: ['invoice-jan.pdf'], alsoBacks: [0] }),
    ]);
    expect(withIn.evidenceFileTotal).toBe(1);
  });

  it('a file backing several records is listed under each, marked, and counted once', async () => {
    // WP8 PR7: one quarterly invoice evidencing three months. Per record the
    // ledger still says "1 file" — that is true of each — while the appendix
    // marks the sharing for the reader and the total counts the file once.
    const shared = { evidence: { id: 'ev-q1', fileName: 'q1-invoice.pdf' } };
    stubRecords(prisma, [
      makeRecord({ id: 'rec-1', periodValue: 'January', evidenceLinks: [shared] }),
      makeRecord({ id: 'rec-2', periodValue: 'February', evidenceLinks: [shared] }),
      makeRecord({
        id: 'rec-3',
        periodValue: 'March',
        evidenceLinks: [shared, { evidence: { id: 'ev-meter', fileName: 'meter.jpg' } }],
      }),
    ]);

    const data = await service.assemble(admin, { ...q, includeEvidenceSummary: true } as ReportQueryDto);

    expect(data.records.map((r) => r.evidenceCount)).toEqual([1, 1, 2]);
    expect(data.evidenceFileTotal).toBe(2);
    expect(data.evidenceSummary.map((e) => e.alsoBacks)).toEqual([[2], [2], [2, 0]]);
    const html = buildReportHtml(data);
    expect(html).toContain('q1-invoice.pdf <span class="note">(also backs 2 other records)</span>');
    expect(html).toContain('meter.jpg</td>');
    expect(html).toContain('2 distinct files back these records');
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
        evidenceLinks: [{ evidence: { id: 'ev-water', fileName: 'water-jan.pdf' } }],
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

    it('a negative figure stays a NUMBER in both flat formats, so the two files agree', async () => {
      // The branch `neutraliseCell` exists for, pinned above the pure function
      // because its justification is a claim about TWO writers. `-` leads a
      // formula and every negative number: stringify first and the CSV ships
      // `'-12.5`, which Excel's SUM skips, while the xlsx writes a real numeric
      // cell for the same column — one query, two files, two different totals.
      //
      // Built through the calculation snapshot, not the create path: `@Min(0)`
      // on the DTO refuses a negative today, which is exactly why this closes
      // the branch BEFORE bulk upload (WP8) parses figures out of a user's
      // spreadsheet and makes it reachable.
      const negative = makeRecord({
        calculation: { ...makeRecord().calculation, tCo2e: -12.5 },
      });
      stubRecords(prisma, [negative]);
      const csv = await service.generateCsv(admin, q);
      const header = csv.trim().split('\n')[0].split(',');
      const cell = csv.trim().split('\n')[1].split(',')[header.indexOf('tco2e')];

      expect(cell).toBe('-12.5');
      expect(cell.startsWith("'")).toBe(false);

      stubRecords(prisma, [negative]);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await service.generateExcel(admin, q)) as unknown as ArrayBuffer);
      const excel = wb.getWorksheet('Raw Activity Data')!.getRow(2).getCell(8).value;

      expect(typeof excel).toBe('number');
      // The property that matters is not either value alone: it is that the
      // two files say the same thing about the same figure.
      expect(cell).toBe(String(excel));
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
        voidedBy: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
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
            evidenceLinks: {
              select: { evidence: { select: { id: true, fileName: true } } },
              orderBy: [{ linkedAt: 'asc' }, { evidenceId: 'asc' }],
            },
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

    it('binds each withdrawal to its OWN actor, in all three formats', async () => {
      // The property the eighth PDF column exists for, and the one nothing
      // asserted. Every withdrawn fixture in this file carried the same id (or
      // none), so stamping withdrawal #1's actor onto every withdrawn row —
      // in the service mapper or at any of the three writer call sites —
      // passed all 129 tests. A filed report that attributes a withdrawal to
      // the wrong person is a worse artifact than one with no actor column,
      // and it is the exact failure the column was chosen over a section note
      // to avoid.
      const ALICE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
      const BOB = 'c0ffee00-dead-4bee-9f00-123456789abc';
      stubRecords(prisma, [
        makeRecord(),
        voidedRecord({ id: 'v-alice', periodValue: 'February', voidedBy: ALICE }),
        voidedRecord({ id: 'v-bob', periodValue: 'March', voidedBy: BOB }),
      ]);

      const { lines, at } = columns(await service.generateCsv(admin, q));
      expect(at(lines.find((l) => l.includes('February'))!, 'voided_by')).toBe(ALICE);
      expect(at(lines.find((l) => l.includes('March'))!, 'voided_by')).toBe(BOB);

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await service.generateExcel(admin, q)) as unknown as ArrayBuffer);
      const ws = wb.getWorksheet('Withdrawn Records')!;
      const head = (ws.getRow(1).values as string[]).slice(1);
      const actor = head.indexOf('Withdrawn by (user id)');
      const period = head.indexOf('Period');
      const sheet = [2, 3].map((n) => (ws.getRow(n).values as unknown[]).slice(1));
      expect(sheet.find((r) => r[period] === 'February')![actor]).toBe(ALICE);
      expect(sheet.find((r) => r[period] === 'March')![actor]).toBe(BOB);

      const html = buildReportHtml(await service.assemble(admin, q));
      const rowFor = (p: string) =>
        [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => m[0]).find((tr) => tr.includes(`>${p}<`))!;
      expect(rowFor('February')).toContain(ALICE);
      expect(rowFor('February')).not.toContain(BOB);
      expect(rowFor('March')).toContain(BOB);
      expect(rowFor('March')).not.toContain(ALICE);
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
      // The actor, so this fixture's `voidedBy` is load-bearing rather than
      // decoration: without this line the CSV has no value assertion for the
      // column anywhere in the service-level suite.
      expect(at(withdrawn, 'voided_by')).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7');
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

    it('Excel: the total row is exactly as wide as the header, and its note lands under Reason', async () => {
      stubRecords(prisma, [makeRecord(), voidedRecord(), voidedWaterRecord()]);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await service.generateExcel(admin, q)) as unknown as ArrayBuffer);
      const sheet = wb.getWorksheet('Withdrawn Records')!;
      const header = (sheet.getRow(1).values as string[]).slice(1);
      const total = (sheet.getRow(4).values as unknown[]).slice(1);

      // ARITY, asserted independently of the header's own derivation — and this
      // is the assertion the refactor needed rather than deserved. Deriving the
      // total row from the LEDGER's list instead of the withdrawn sheet's (the
      // plausible copy-paste, twelve lines up) passed all 61 tests: the tonnage
      // sits at index 7 in both lists by coincidence, so every name lookup
      // agreed, while the row ran one cell past the last column and dropped the
      // uncalculated-count disclosure entirely.
      expect(total).toHaveLength(header.length);

      const at = (name: string) => total[header.indexOf(name)];
      expect(at('tCO₂e removed')).toBe(0.44);
      // The note is a factual claim about the file, and nothing held it: saying
      // "3 of these carry no emissions figure" when one does is a misstatement
      // in an artifact an auditor keeps.
      expect(at('Reason')).toBe('1 of these carry no emissions figure');
      // ...and every other column is blank, so a stray total on another atom —
      // an activity figure summing kWh and cubic metres, say — cannot appear.
      expect(header.filter((h) => total[header.indexOf(h)] !== '')).toEqual([
        'Subsidiary', 'tCO₂e removed', 'Reason',
      ]);
    });

    it('Excel: the withdrawn sheet is header-only when nothing was withdrawn', async () => {
      stubRecords(prisma, [makeRecord()]);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await service.generateExcel(admin, q)) as unknown as ArrayBuffer);
      const sheet = wb.getWorksheet('Withdrawn Records')!;
      // The sheet is deliberately always present — a workbook whose sheet list
      // depends on the data cannot be read by anything automated. But a clean
      // year must not get a "Total withdrawn … 0" row, which reads as a
      // measured zero rather than as nothing having been withdrawn.
      expect(sheet.rowCount).toBe(1);
      expect(String(sheet.getRow(1).getCell(1).value)).toBe('Subsidiary');
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
        voidedBy: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
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
        'voided_tco2e', 'voided_at_utc', 'void_reason', 'voided_by',
      ]);
    });

    it('CSV: the file opens with a UTF-8 BOM, before the first header byte', async () => {
      stubRecords(prisma, [makeRecord()]);
      const csv = await service.generateCsv(admin, q);

      // NOT trimmed, and that is the entire point of this test. Every other CSV
      // assertion in this file calls `.trim()` first, and `String.prototype.trim()`
      // strips U+FEFF — so before this existed, deleting the BOM left the whole
      // suite green and the only thing that would have failed was one Playwright
      // line. Asserted on BYTES, because what fails without it is a byte-level
      // decode: the response header says `charset=utf-8`, but that is gone once
      // the file is on disk, and Excel-on-Windows then reads a double-clicked
      // .csv with the ANSI codepage and mojibakes every Turkish name in it.
      expect(Buffer.from(csv, 'utf8').subarray(0, 3)).toEqual(
        Buffer.from([0xef, 0xbb, 0xbf]),
      );

      // ...and it is the WRITER's BOM, not the vocabulary's: inside `csvHeader()`
      // it would land within the first FIELD, where `csvField` re-examines it.
      expect(csvHeader().startsWith('subsidiary,')).toBe(true);
      expect(csv.slice(1).startsWith('subsidiary,')).toBe(true);
    });

    it('CSV: every row has exactly as many cells as the header, on both row kinds', async () => {
      stubRecords(prisma, [makeRecord(), withdrawnFixture()]);
      const lines = (await service.generateCsv(admin, q)).trim().split('\n');

      // The withdrawn row's four `Withdrawn` markers are placed by POSITION,
      // with nothing tying a marker to its column name. An arity check is what
      // catches a marker gained or lost when the columns move: the fixture is
      // comma-free on purpose, so a plain split is exact here.
      const width = lines[0].split(',').length;
      expect(width).toBe(16);
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
        'Withdrawn (UTC)', 'Reason', 'Withdrawn by (user id)',
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
        'Withdrawn (UTC)', 'Reason', 'Withdrawn by',
      ]);
    });

    it('PDF: the total figure lands under the column it totals, formatted', async () => {
      stubRecords(prisma, [
        makeRecord(),
        makeRecord({ id: 'rec-void', status: 'voided', periodValue: 'February',
          voidReason: 'Duplicate of the Istanbul HQ invoice for the same month.',
          voidedAt: new Date('2026-02-03T09:30:00.000Z') }),
      ]);
      const html = buildReportHtml(await service.assemble(admin, q));
      const headers = headersUnder(html, 'Withdrawn from this inventory');
      const row = rowContaining(html, 'Total withdrawn');

      // The span arithmetic was asserted; where the figure LANDS was not. `4/1/2`
      // and `3/1/3` both sum to seven, and the second puts the tonnage under
      // "Period". Walk the spans to find the figure's real column index.
      let index = 0;
      let landed: string | null = null;
      for (const m of row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)) {
        const span = Number(/colspan="(\d+)"/.exec(m[1])?.[1] ?? 1);
        if (m[2].includes('<strong>') && !m[2].includes('Total withdrawn')) {
          landed = headers[index];
        }
        index += span;
      }
      expect(landed).toBe('tCO₂e removed');

      // ...and it is the right number, formatted like every other figure on the
      // page. Printing `count` here made the footer contradict the banner three
      // lines above it, with the whole suite green.
      expect(row).toContain('<strong>0.4</strong>');
      // Right-aligned, like the column it sits under.
      expect(row).toMatch(/<td class="num"[^>]*><strong>0\.4<\/strong><\/td>/);
    });

    it('PDF: every numeric column is right-aligned, head and cell alike', async () => {
      stubRecords(prisma, [
        makeRecord({
          calculation: {
            tCo2e: 0.2071, factorId: 'f-gas', factorValue: 0.18227,
            factorUnit: 'kgCO2e/kWh', methodology: 'location-based',
            source: 'demo', version: '2024.1', geographyCode: 'TR',
            normalizedValue: 1136, normalizedUnit: 'kWh', conversionFactor: 11.36,
          },
        }),
      ]);
      const html = buildReportHtml(await service.assemble(admin, q));
      const start = html.indexOf('<h2>Activity records ledger</h2>');
      const thead = html.slice(start, html.indexOf('</thead>', start));
      const bodyStart = html.indexOf('<tbody>', start);
      const firstRow = html.slice(bodyStart, html.indexOf('</tr>', bodyStart));

      // `class="num"` has to be on BOTH, and the cell-binding tests check index
      // rather than class — so a mismatch between the two literals was invisible.
      // Sourcing them from one descriptor is the fix; this is what says so.
      // Only `tCO₂e` was pinned before, so dropping `num` from the other three
      // was silent.
      const heads = [...thead.matchAll(/<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/g)];
      const cells = [...firstRow.matchAll(/<td([^>]*)>/g)];
      expect(cells).toHaveLength(heads.length);
      const NUMERIC = ['Activity', 'Normalised', 'tCO₂e', 'Evidence'];
      heads.forEach((h, i) => {
        const wantNum = NUMERIC.includes(h[1]);
        expect(h[0].includes('class="num"')).toBe(wantNum);
        expect(cells[i][1].includes('class="num"')).toBe(wantNum);
      });
    });

    it('PDF: the total row spans exactly the width of the table above it', async () => {
      stubRecords(prisma, [makeRecord(), withdrawnFixture()]);
      const html = buildReportHtml(await service.assemble(admin, q));
      const width = headersUnder(html, 'Withdrawn from this inventory').length;

      // The trailing span is DERIVED (`PDF_WITHDRAWN.length - 5`), so adding a
      // column moves both sides of this equality together and it cannot fail
      // from that any more — the eighth column proved it by landing green. What
      // it still holds: the derivation being replaced by a literal, and the
      // leading `4` drifting. What it did NOT hold until the line below, since
      // both keep the sum at the table's width: widening the tonnage to two
      // columns while shortening the filler to match, which straddles the
      // bolded figure across two columns of a filed page.
      const spanned = [...rowContaining(html, 'Total withdrawn').matchAll(/<td([^>]*)>/g)]
        .map((m) => Number(/colspan="(\d+)"/.exec(m[1])?.[1] ?? 1))
        .reduce((a, b) => a + b, 0);
      expect(spanned).toBe(width);
      expect(/<td class="num"([^>]*)>/.exec(rowContaining(html, 'Total withdrawn'))![1]).not.toContain(
        'colspan',
      );
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
          voidedBy: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
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
      // The opaque id, printed verbatim and never resolved to a name.
      expect(cells['Withdrawn by']).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7');
      // The withdrawn table carries no activity quantity at all — an A4-width
      // decision, and the reason this table is 8 columns where Excel is 11.
      expect(Object.keys(cells)).not.toContain('Activity');
    });

    it('PDF withdrawn: an absent actor prints the em dash, not an empty cell', async () => {
      // `voided_by` is nullable in the schema (no FK, by design), so the branch
      // exists and needs a defined rendering. It takes the em dash because its
      // two siblings in this table do — where the CSV and Excel take `''` — and
      // an empty printed cell reads as a column the writer forgot rather than
      // as an actor the record does not carry.
      stubRecords(prisma, [
        makeRecord(),
        makeRecord({
          id: 'rec-void',
          status: 'voided',
          periodValue: 'February',
          voidReason: 'Duplicate of the Istanbul HQ invoice for the same month.',
          voidedAt: new Date('2026-02-03T09:30:00.000Z'),
          voidedBy: null,
        }),
      ]);
      const cells = cellsByHeader(
        buildReportHtml(await service.assemble(admin, q)),
        'Withdrawn from this inventory',
      );

      expect(cells['Withdrawn by']).toBe('—');
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
          voidedBy: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
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
      expect(withdrawn['Withdrawn by (user id)']).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7');
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
    voidedAt: '2026-02-03 09:30', voidedBy: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  };

  it('refuses a withdrawn row in the ledger writer, at compile time', () => {
    // @ts-expect-error `'voided'` is not in `Exclude<ActivityRecordStatus, 'voided'>`.
    // This is the guarantee `ReportLedgerRow.status` exists to provide: a
    // withdrawn figure written as a counted ledger row is back inside every
    // total the record was deliberately taken out of.
    csvLedgerRow(withdrawnRow);
    // The right way round still compiles, so the probe above is about the
    // status and not about some unrelated shape mismatch.
    expect(csvLedgerRow(ledgerRow).split(',')[csvHeader().split(',').indexOf('status')]).toBe('approved');
  });

  it('refuses a withdrawn row in the EXCEL ledger writer too', () => {
    // F1 shipped three writer entry points with one probe; F2 added three more
    // with none, so the "concrete signatures plus `@ts-expect-error`" guarantee
    // was half-applied. Widening `excelLedgerRow` to accept both row kinds
    // typechecked clean and passed the whole suite — a second door into the
    // counted ledger sheet.
    // @ts-expect-error `'voided'` is not in `Exclude<ActivityRecordStatus, 'voided'>`.
    excelLedgerRow(withdrawnRow);
    expect(excelLedgerRow(ledgerRow)[excelLedgerHeader().indexOf('Status')]).toBe('approved');
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
    // ...and ONLY those. Every other body column keeps its real value, which is
    // what proves "aggregatable" and not "on a withdrawn row" is the rule. The
    // first cut of this test asserted two of the nine and called itself "only
    // those": marking `reporting_period` passed the entire suite.
    const unmarked: Record<string, string> = {
      subsidiary: 'Energy', reporting_entity: 'Whole company',
      category: 'Electricity', reporting_period: 'monthly',
      period_value: 'January', activity_unit: 'kWh', status: 'voided',
    };
    for (const [column, value] of Object.entries(unmarked)) {
      expect(at(column)).toBe(value);
    }
    // ...and the disclosure block is never marked: blanking it would leave a
    // file saying a figure was withdrawn and refusing to say what.
    expect(at('voided_activity_value')).toBe('1000');
    expect(at('voided_tco2e')).toBe('0.44');
    // Including the actor: it is a disclosure, so the marker rule must not
    // reach it either. A `WITHDRAWN` here would name no one while looking like
    // an answer.
    expect(at('voided_by')).toBe('7c9e6679-7425-40de-944b-e07fc1f90ae7');
  });

  it('accounts for every marker, so deleting the compile-time guard fails here too', () => {
    // `_markerParity` can be deleted outright: it compiles, and the suite stays
    // green. This restates the same accounting invariant at runtime so the
    // guard cannot be removed silently.
    //
    // NOT the harmful tautology the sibling test avoids: that one would derive
    // the EXPECTED MARKER SET from `BODY_COLUMNS` and assert the writer matches
    // it. This asserts that every aggregatable column is either restated by a
    // disclosure column or listed as deliberately undisclosed — a claim about
    // the declarations' consistency, which is what the type check states.
    const restated = new Set<string>(
      DISCLOSURE_COLUMNS.map((d) => d.restates).filter((k) => k !== null),
    );
    const exempt = new Set<string>(MARKED_WITHOUT_DISCLOSURE);
    for (const column of BODY_COLUMNS.filter((c) => c.aggregatable)) {
      const key: string = column.key;
      expect(restated.has(key) || exempt.has(key)).toBe(true);
    }
    // And nothing is exempted that is not actually marked — an unbounded escape
    // hatch would let a column be excused from a rule it never had.
    for (const key of MARKED_WITHOUT_DISCLOSURE) {
      expect(BODY_COLUMNS.find((c) => (c.key as string) === key)?.aggregatable).toBe(true);
    }
  });

  it('leaves the disclosure block empty on a counted row', () => {
    const header = csvHeader().split(',');
    const cells = csvLedgerRow(ledgerRow).split(',');
    for (const column of [
      'voided_activity_value', 'voided_tco2e', 'voided_at_utc', 'void_reason', 'voided_by',
    ]) {
      expect(cells[header.indexOf(column)]).toBe('');
    }
  });

  /**
   * The printed actor column's wrap opt-in.
   *
   * `brk` is a one-word flag whose whole effect lives in CSS, which makes it the
   * kind of thing a later cleanup deletes ("this class isn't in the stylesheet
   * I'm reading"). Nothing else fails when it goes: the column still renders,
   * every golden still passes, and the only symptom is a 36-char id with
   * nowhere to break widening the withdrawn table off the A4 page — in a PDF
   * nobody re-renders during review.
   */
  it('marks the actor column as breakable, on both the header and the cell', () => {
    expect(pdfWithdrawnHeadRow()).toContain('<th class="brk">Withdrawn by</th>');
    expect(pdfWithdrawnRow(withdrawnRow)).toContain(
      `<td class="brk">${withdrawnRow.voidedBy}</td>`,
    );
    // ...and nowhere else: it is the only column whose value is an unbreakable
    // token, and applying it broadly is what narrows unrelated columns. The
    // LEDGER is the table that regression was measured on (Status 67px → 57px),
    // so it is the one this has to check — the withdrawn table alone let
    // `brk: true` on a ledger column through.
    expect(pdfWithdrawnHeadRow().match(/class="brk"/g)).toHaveLength(1);
    expect(pdfLedgerHeadRow()).not.toContain('brk');
    expect(pdfLedgerRow(ledgerRow)).not.toContain('brk');
  });

  it('derives the withdrawn total row from the withdrawn sheet, not the body columns', () => {
    // Until the actor column landed, this was held by an arity assertion: the
    // sheet had 10 slots against 11 excel-bearing body columns, so the
    // copy-paste from `excelLedgerRow` produced a row of the wrong length. The
    // eleventh column made both lists 11 and that check stopped discriminating
    // — silently, with the suite green. The `Reason` slot carries the
    // uncalculated-count note and exists on THIS list only, so reading it by
    // name is what distinguishes the two derivations. The totals are built
    // here rather than taken from a fixture: the surviving assertion elsewhere
    // only fires when a fixture happens to include an uncalculated record.
    const header = excelWithdrawnHeader();
    const total = excelWithdrawnTotalRow({ count: 2, tCo2e: 1.5, uncalculatedCount: 1 });

    expect(total).toHaveLength(header.length);
    expect(total[header.indexOf('tCO₂e removed')]).toBe(1.5);
    expect(total[header.indexOf('Reason')]).toBe('1 of these carry no emissions figure');
    expect(total[header.indexOf('Withdrawn by (user id)')]).toBe('');
  });

  it('leaves the actor cell empty in the data formats when a withdrawal carries none', () => {
    // The PDF's em dash was pinned; its CSV and Excel counterparts were not, so
    // `?? ''` could become `?? 'unknown'` — a filed artifact naming an actor
    // nobody is — or lose the guard entirely, which prints the literal `null`
    // through `csvField(String(null))`. The divergence between the two
    // renderings is deliberate and now pinned on both sides of it.
    const noActor = { ...withdrawnRow, voidedBy: null };
    const header = csvHeader().split(',');

    expect(csvWithdrawnRow(noActor).split(',')[header.indexOf('voided_by')]).toBe('');
    expect(
      excelWithdrawnRow(noActor)[excelWithdrawnHeader().indexOf('Withdrawn by (user id)')],
    ).toBe('');
    expect(pdfWithdrawnRow(noActor)).toContain('<td class="brk">—</td>');
  });

  it('emits one class attribute however many flags a column sets', () => {
    // `<td class="num" class="brk">` is valid-looking HTML where the browser
    // keeps the first and drops the rest, so the second flag would do nothing.
    // No shipped column sets both, which is exactly why this is asserted on the
    // helper rather than on a rendered row.
    const slot = (num?: boolean, brk?: boolean) => ({ label: 'x', num, brk, cell: () => 'v' });
    expect(pdfClass(slot(true, true))).toBe(' class="num brk"');
    expect(pdfClass(slot(true, false))).toBe(' class="num"');
    expect(pdfClass(slot(false, true))).toBe(' class="brk"');
    expect(pdfClass(slot())).toBe('');
  });
});

/**
 * The forged-ledger-row control, held on EVERY column rather than on two.
 *
 * A per-column bypass sweep measured the gap before this test existed: routing
 * one column around the cell writer failed something for only 2 of the 15 —
 * `period_value` and `void_reason`. `subsidiary`, `reporting_entity` and all
 * four `voided_*` columns were silent, and the first two are user-supplied free
 * text. A location named `Warehouse\rTotal,,,,,,,,,,999999,,,,` puts a
 * fabricated row in a filed CSV behind no database row and no audit entry.
 *
 * RE-MEASURED on this branch, because the figure above is about `main` and a
 * stale coverage number reads as a current one: the ledger now catches **6 of
 * 16** (`subsidiary`, `reporting_entity`, `category`, `reporting_period`,
 * `period_value`, `activity_unit`) and the withdrawn row **7 of 16** (those six
 * plus `void_reason`) — up from 2, which is what the withdrawn matrix below
 * bought. The ten and nine that survive are `activity_value`, `tco2e`,
 * `status`, `evidence_files`, `anomaly_flag`, the `voided_*` block and the
 * `WITHDRAWN` markers: every one is system-generated, and none can carry a
 * character a user typed. Every column that CAN is covered in both writers.
 *
 * The shipped writer is uniform, so this is coverage rather than a defect. It
 * lands here because THIS package created the structure the risk needs: on
 * `main` all fifteen cells were inline expressions in one array literal inside
 * `generateCsv`, visible in a screenful; they are now eleven lambdas in another
 * file, and F2/F3 add per-format renderers where a different escaper (HTML for
 * the PDF) is genuinely needed. That is the moment someone puts escaping inside
 * a renderer, and 14 of 16 columns would not notice.
 */
describe('no column can opt out of CSV neutralisation', () => {
  /** Simultaneously a formula, a field-splitter and a record-splitter. */
  const HOSTILE = '=HYPERLINK("evil"),\rTotal,,,999999';

  /**
   * The same attack behind whitespace. A spreadsheet skips leading whitespace
   * before deciding a cell is a formula, so a guard anchored at index 0 sees a
   * harmless space and lets the payload through — unprefixed AND, carrying no
   * separator of its own here, unquoted.
   */
  const PAYLOADS = [
    ['bare', HOSTILE],
    ['space-led', `   ${HOSTILE}`],
    ['tab-led', `\t${HOSTILE}`],
    ['nbsp-led', `\u00A0@SUM(A1)`],
    // The pure shape of the defect, and the reason it was invisible: no
    // separator of its own, so the quote test does not catch it either and the
    // payload reaches the file completely untouched. The three above all carry
    // HOSTILE's `,` and `\r`, so they are quoted whatever the guard does.
    ['space-led, no separator', '   =SUM(A1)'],
  ] as const;

  /**
   * Would a spreadsheet execute this cell on open?
   *
   * It strips leading whitespace FIRST, and that is the whole point: asserting
   * `/^[=+\-@]/` against the raw cell asks the writer's own regex about the
   * writer, and `   =SUM(A1)` passes it while executing.
   */
  const executable = (cell: string) => /^[=+\-@]/.test(cell.replace(/^\s+/, ''));

  /** A minimal RFC-4180 reader, written independently of the writer: counting
   *  `\n` would miss exactly the `\r` forgery this exists to catch. */
  const records = (csv: string): string[][] => {
    const out: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < csv.length; i++) {
      const c = csv[i];
      if (quoted) {
        if (c === '"' && csv[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && csv[i + 1] === '\n') i++;
        row.push(field); out.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); out.push(row); }
    return out;
  };

  const base: ReportLedgerRow = {
    subsidiaryName: 'Energy', locationId: null, locationName: null,
    category: 'Electricity', periodValue: 'January', reportingPeriod: 'monthly',
    activityValue: 1000, activityUnit: 'kWh', tCo2e: 0.44, status: 'approved',
    evidenceCount: 1, anomalyFlag: false, anomalyEvaluated: true,
    anomalyBaselinePriorCount: 3,
  };

  /**
   * Every string-typed field that can reach a cell.
   *
   * `locationName` is the one that does not mean what its case names say: it
   * reaches the cell through `entityLabel`, which calls `.trim()`, and JS
   * `trim()` strips space, tab, NBSP and BOM — so its four payloads all arrive
   * at the writer identical to `bare`. Kept because the bare case is real
   * coverage of the column; do not read its whitespace variants as evidence
   * that the whitespace path is exercised there.
   */
  const STRING_FIELDS = [
    'subsidiaryName', 'locationName', 'category', 'periodValue',
    'reportingPeriod', 'activityUnit',
  ] as const;

  it.each(
    STRING_FIELDS.flatMap((field) =>
      PAYLOADS.map(([label, payload]) => [field, label, payload] as const),
    ),
  )('neutralises a %s payload arriving through %s', (field, _label, payload) => {
    const row = { ...base, [field]: payload } as ReportLedgerRow;
    const csv = `${csvHeader()}\n${csvLedgerRow(row)}\n`;
    const parsed = records(csv);

    // ONE header and ONE data row. A bare `\r` reaching the file unquoted
    // splits the row, and the extra line is a ledger entry nobody wrote.
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toHaveLength(csvHeader().split(',').length);
    // ...and nothing a spreadsheet would execute on open.
    for (const cell of parsed[1]) expect(executable(cell)).toBe(false);
  });

  /**
   * The withdrawn writer takes the SAME matrix, and it earned it: a measured
   * bypass sweep on the one hand-built case this replaces caught 2 columns of
   * 15, against the ledger's 6. `reporting_entity`, `category`, `period_value`
   * and `activity_unit` all carry user free text on a withdrawn row and none
   * of them was covered. The realistic regression — escaping migrating into a
   * `CsvSlot.cell` — hits both writers, so the ledger case would catch it; a
   * withdrawn-only special case would not, and this file already contains one
   * (the `WITHDRAWN` marker).
   */
  const WITHDRAWN_FIELDS = [...STRING_FIELDS, 'voidReason'] as const;

  it.each(
    WITHDRAWN_FIELDS.flatMap((field) =>
      PAYLOADS.map(([label, payload]) => [field, label, payload] as const),
    ),
  )('neutralises a %s payload arriving through %s on the withdrawn row', (field, _label, payload) => {
    const row = {
      ...base, status: 'voided', voidReason: 'superseded',
      voidedAt: '2026-02-03 09:30', [field]: payload,
    } as ReportWithdrawnRow;
    const parsed = records(`${csvHeader()}\n${csvWithdrawnRow(row)}\n`);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toHaveLength(csvHeader().split(',').length);
    for (const cell of parsed[1]) expect(executable(cell)).toBe(false);
  });
});
