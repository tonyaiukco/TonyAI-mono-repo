import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as ExcelJS from 'exceljs';
import { Prisma } from '@tonyai/db';
import type { RequestUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import { PdfRenderer } from '../common/pdf-renderer';
import { csvHeader } from './report-columns';
import { buildReportHtml } from './report-html';
import { ReportsService } from './reports.service';
import type { ReportQueryDto } from './dto/report-query.dto';

/**
 * LP4-03's live report (K2–K4, K6, K8): one snapshot, Scope 1 + 2 the only
 * total, review status that never certifies, the boundary's coverage, the
 * caller's language, and a live mark on every format but the machine CSV.
 */

const calc = (tCo2e: number) => ({
  tCo2e, factorId: 'f-1', factorValue: 0.44, factorUnit: 'kgCO2e/kWh', methodology: 'location-based',
  source: 'demo', version: '2024.1', geographyCode: 'TR',
});

function rec(over: Record<string, unknown> = {}) {
  return {
    id: 'rec-1', subsidiaryId: 'sub-1', locationId: null, reportingYear: 2024, reportingPeriod: 'monthly',
    periodValue: 'January', category: 'Electricity', scope: 2, status: 'approved', activityValue: 1000,
    activityUnit: 'kWh', calculation: calc(0.44), createdBy: 'u', anomalyFlag: false, anomalyBaselinePriorCount: 3,
    anomalyBaselineTCo2e: 10, varianceReason: null, location: null, voidReason: null, voidedAt: null, voidedBy: null,
    createdAt: new Date('2024-02-01T00:00:00Z'), updatedAt: new Date('2024-02-01T00:00:00Z'),
    ...over,
  };
}

type Where = { subsidiaryId?: { in: string[] }; scope?: number | { in: number[] }; status?: { in: string[] }; category?: string };
const matches = (r: Record<string, unknown>, where: Where) =>
  (where.subsidiaryId === undefined || where.subsidiaryId.in.includes(r.subsidiaryId as string))
  && (where.scope === undefined || (typeof where.scope === 'number' ? r.scope === where.scope : where.scope.in.includes(r.scope as number)))
  && (where.status === undefined || where.status.in.includes(r.status as string))
  && (where.category === undefined || r.category === where.category);

/** The snapshot's client — and NOTHING on the root but `$transaction`, so a read outside it throws. */
function mocks(records: Record<string, unknown>[], language = 'en') {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join('').includes('transaction_isolation') ? [{ isolation: 'repeatable read' }] : [{ at: '2026-10-24 09:15' }]),
    profile: { findUnique: vi.fn(async () => ({ language })) },
    inventoryBoundary: { findFirst: vi.fn(async () => null) },
    organisation: { findUnique: vi.fn(async () => ({ legalName: 'Holding Ltd', tradingName: 'Holding' })) },
    subsidiary: { findMany: vi.fn(async () => [{ id: 'sub-1', legalName: 'Energy', tradingName: null }]) },
    activityRecord: {
      groupBy: vi.fn(async ({ where }: { where: Where }) => {
        const counts = new Map<string, number>();
        for (const r of records.filter((x) => matches(x, where))) counts.set(r.status as string, (counts.get(r.status as string) ?? 0) + 1);
        return [...counts].map(([status, n]) => ({ status, _count: { _all: n } }));
      }),
      findMany: vi.fn(async ({ where }: { where: Where }) => records.filter((r) => matches(r, where))),
    },
    activityRecordEvidence: { findMany: vi.fn(async () => []) },
    factorRelease: { findMany: vi.fn(async () => []) },
  };
  const root = { $transaction: vi.fn(async (read: (client: typeof tx) => Promise<unknown>) => read(tx)) };
  const audit = { record: vi.fn() };
  const service = new ReportsService(root as never, audit as unknown as AuditService, new PdfRenderer());
  return { tx, root, audit, service };
}

const user = { id: 'u-1', email: 'admin@tonyai.local', role: 'super_admin', organisationId: 'org-1', accessibleSubsidiaryIds: ['sub-1'] } as RequestUser;
const q = { template: 'ghg_protocol_detail', year: 2024, includeMethodologyNotes: true } as ReportQueryDto;

async function sheetRows(bytes: Buffer, name: string): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const rows: unknown[][] = [];
  wb.getWorksheet(name)!.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  return rows;
}

describe('one snapshot (K2)', () => {
  it('reads the preview and every export inside one REPEATABLE READ transaction — nothing on the root client', async () => {
    const { root, tx, service } = mocks([rec()]);
    await service.meta(user, 2024);
    await service.assemble(user, q);
    await service.generateCsv(user, q);
    expect(root.$transaction).toHaveBeenCalledTimes(3);
    for (const [, options] of root.$transaction.mock.calls as unknown as Array<[unknown, { isolationLevel: string }]>) {
      expect(options.isolationLevel).toBe(Prisma.TransactionIsolationLevel.RepeatableRead);
    }
    // CaptureSnapshot.open asserted the level on the snapshot's own connection.
    expect(tx.$queryRaw.mock.calls.some(([s]) => (s as TemplateStringsArray).join('').includes('transaction_isolation'))).toBe(true);
    // Read-only in the database too: one SET TRANSACTION READ ONLY per snapshot, before any read.
    expect((tx.$executeRaw.mock.calls as unknown as Array<[TemplateStringsArray]>).map(([s]) => s.join(''))).toEqual(Array(3).fill('SET TRANSACTION READ ONLY'));
    // Every record read is bounded — the preview's committed and Scope 3 reads included (QA M35).
    for (const [args] of tx.activityRecord.findMany.mock.calls as unknown as Array<[{ take?: number }]>) expect(args.take).toBe(5_001);
  });

  it('derives the tiles from the ledger it prints, and stamps the snapshot\'s own clock', async () => {
    const { service } = mocks([rec(), rec({ id: 'rec-2', periodValue: 'February', calculation: calc(1.06) })]);
    const data = await service.assemble(user, q);
    expect(data.summary.totals.total).toBeCloseTo(data.records.reduce((s, r) => s + (r.tCo2e ?? 0), 0), 12);
    expect(data.summary.recordCount).toBe(data.records.length);
    expect(data.generatedAt).toBe('2026-10-24 09:15');
    const meta = await service.meta(user, 2024);
    expect(meta.summary.totals).toEqual(data.summary.totals);
    expect(meta.committedCount).toBe(data.records.length);
  });
});

describe('Scope 3 is not covered (K4)', () => {
  const water = rec({ id: 'rec-w', category: 'Water', scope: 3, calculation: calc(5) });

  it('keeps a Scope 3 record out of the ledger, the totals and the counts — and says so', async () => {
    const { service } = mocks([rec(), water]);
    const data = await service.assemble(user, q);
    expect(data.records.map((r) => r.category)).toEqual(['Electricity']);
    expect(data.summary.totals).toMatchObject({ scope1: 0, scope2: 0.44, scope3: 0, total: 0.44 });
    expect(data.scope3).toEqual({ coverage: 'not_covered', recordCount: 1, calculatedTCo2e: 5, uncalculatedRecordCount: 0 });
    const meta = await service.meta(user, 2024);
    expect(meta.committedCount).toBe(1);
    expect(meta.scope3.recordCount).toBe(1);
    const html = buildReportHtml(data);
    expect(html).toContain('Scope 3 is not covered by this inventory. 1 committed Scope 3 record (5 tCO₂e calculated) is outside every figure in this report.');
    expect(html).toContain('<div class="l">Scope 1 + 2 total</div><div class="v">0.4 tCO₂e</div>');
    const csv = await service.generateCsv(user, q);
    expect(csv).not.toContain('Water');
    const summary = await sheetRows(await service.generateExcel(user, q), 'Summary');
    expect(summary).toContainEqual(['Scope 1 + 2 total (tCO₂e)', 0.44]);
    expect(summary.find((r) => r[0] === 'Scope 3')!.slice(0, 2)).toEqual(['Scope 3', 'Not covered']);
  });

  it('reads no Scope 1/2 record for a Scope 3 selection, and prints "Not covered", never 0', async () => {
    const { tx, service } = mocks([rec(), water]);
    const data = await service.assemble(user, { ...q, scope: 3 } as never);
    expect(data.records).toEqual([]);
    for (const [args] of tx.activityRecord.findMany.mock.calls as unknown as Array<[{ where: Where }]>) expect(args.where.scope).toBe(3);
    expect(tx.activityRecord.groupBy).not.toHaveBeenCalled();
    const html = buildReportHtml(data);
    expect(html).toContain('<div class="l">Scope 1</div><div class="v">Not covered</div>');
    expect(html).not.toContain('0 tCO₂e</div>');
    const summary = await sheetRows(await service.generateExcel(user, { ...q, scope: 3 } as never), 'Summary');
    expect(summary).toContainEqual(['Scope 1 (tCO₂e)', 'Not covered']);
    // A Scope 3 category with no scope is the same selection (qa-auditor re-review P2-1).
    const waterHtml = buildReportHtml(await service.assemble(user, { ...q, category: 'Water' } as never));
    expect(waterHtml).toContain('<div class="l">Scope 1</div><div class="v">Not covered</div>');
    expect(waterHtml).not.toContain('0 tCO₂e</div>');
    const waterSheet = await sheetRows(await service.generateExcel(user, { ...q, category: 'Water' } as never), 'Summary');
    expect(waterSheet).toContainEqual(['Scope 1 + 2 total (tCO₂e)', 'Not covered']);
    expect(summary).toContainEqual(['Scope 1 + 2 total (tCO₂e)', 'Not covered']);
  });
});

describe('one selection, three live formats: the same records and the same total (K4)', () => {
  it('reconciles with an uncalculated figure and two withdrawals, one of them uncalculated', async () => {
    const uncalculated = { reasonCode: 'no_emission_factor', reason: 'No factor', category: 'Electricity' };
    const voided = { status: 'voided', voidReason: 'Duplicate entry', voidedBy: 'u-2', voidedAt: new Date('2024-03-01T00:00:00Z') };
    const { service } = mocks([
      rec({ id: 'a', calculation: calc(12.5) }),
      rec({ id: 'b', periodValue: 'February', calculation: uncalculated }),
      rec({ id: 'c', periodValue: 'March', calculation: calc(100), ...voided }),
      rec({ id: 'd', periodValue: 'April', calculation: uncalculated, ...voided }),
    ]);
    const data = await service.assemble(user, q);
    expect(data.summary.totals.total).toBe(12.5);
    expect(data.summary).toMatchObject({ recordCount: 2, uncalculatedRecordCount: 1 });

    // CSV: one table, the whole tco2e column sums to the total — withdrawn rows read Withdrawn.
    const lines = (await service.generateCsv(user, q)).slice(1).trimEnd().split('\n').map((l) => l.split(','));
    const at = lines[0].indexOf('tco2e');
    const cells = lines.slice(1).map((l) => l[at]);
    expect(cells.sort()).toEqual(['12.5', 'Not calculated', 'Withdrawn', 'Withdrawn']);
    expect(cells.filter((c) => Number.isFinite(Number(c))).reduce((s, c) => s + Number(c), 0)).toBe(data.summary.totals.total);

    // Workbook: the same two counted rows, the same two withdrawn ones and their total row.
    const bytes = await service.generateExcel(user, q);
    expect((await sheetRows(bytes, 'Raw Activity Data')).slice(1)).toHaveLength(2);
    const withdrawn = (await sheetRows(bytes, 'Withdrawn Records')).slice(1);
    expect(withdrawn).toHaveLength(3);
    expect(await sheetRows(bytes, 'Summary')).toContainEqual(['Scope 1 + 2 total (tCO₂e)', 12.5]);

    // PDF: the same two ledger rows and the same total.
    const html = buildReportHtml(data);
    const ledger = html.slice(html.indexOf('<h2>Activity records ledger</h2>'), html.indexOf('<h2>Withdrawn from this inventory</h2>'));
    expect(ledger.match(/<tr><td>/g)).toHaveLength(2);
    expect(html).toContain('<div class="l">Scope 1 + 2 total</div><div class="v">12.5 tCO₂e</div>');
  });
});

describe('honest status and the live mark (K3, K8)', () => {
  it('calls an all-approved selection reviewed — never certified — and marks every format but the CSV live', async () => {
    const { service } = mocks([rec()]);
    const data = await service.assemble(user, q);
    expect(data.status).toBe('approved');
    const html = buildReportHtml(data);
    expect(html).toContain('All records approved — not an inventory certification');
    expect(html).not.toMatch(/<span class="badge">Approved<\/span>/);
    expect(html).toContain('Live report — not an issued report. Every figure here was read from the database at 2026-10-24 09:15 UTC');
    expect(html).toContain('No inventory boundary is declared for 2024. Coverage is unknown');
    const summary = await sheetRows(await service.generateExcel(user, q), 'Summary');
    expect(summary[0]).toEqual(['Live report — not an issued report; read at 2026-10-24 09:15 UTC']);
    expect(summary).toContainEqual(['Review status', 'All records approved — not an inventory certification']);
    expect(summary.find((r) => r[0] === 'Inventory coverage')![1]).toMatch(/^No inventory boundary is declared for 2024/);
    // The machine CSV keeps its one header row: no preamble.
    expect((await service.generateCsv(user, q)).slice(1).split('\n')[0]).toBe(csvHeader());
  });
});

describe('the report language (D16, K6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prints the PDF and the workbook in the caller\'s language and records it; the CSV stays English', async () => {
    const { service, audit } = mocks([rec({ calculation: calc(1234.56) })], 'tr');
    const data = await service.assemble(user, q);
    expect(data.language).toBe('tr');
    const html = buildReportHtml(data);
    expect(html).toContain('<html lang="tr">');
    expect(html).toContain('Kapsam 1 + 2 toplamı');
    expect(html).toContain('Tüm kayıtlar onaylı — envanter sertifikası değildir');
    expect(html).toContain('1.234,6 tCO₂e');
    expect(html).toContain('<td>Elektrik</td>');
    expect(html).toContain('<td>Ocak</td>');
    const bytes = await service.generateExcel(user, q);
    const ledger = await sheetRows(bytes, 'Ham faaliyet verileri');
    expect(ledger[0][0]).toBe('Bağlı şirket');
    expect(ledger[1]).toContain('Elektrik');
    expect(ledger[1]).toContain(1234.56);
    const csv = await service.generateCsv(user, q);
    expect(csv.slice(1).split('\n')[0]).toBe(csvHeader());
    expect(csv).toContain(',Electricity,');
    const diffs = audit.record.mock.calls.map(([, event]) => (event as { diff: Record<string, unknown> }).diff);
    expect(diffs.find((d) => d.exportType === 'excel')).toMatchObject({ language: 'tr', readAt: '2026-10-24 09:15', status: 'approved' });
    expect(diffs.find((d) => d.exportType === 'csv')).not.toHaveProperty('language');
  });

  it('never rounds a withdrawn or Scope 3 figure away in a note, in either language (Codex B9 P2-1)', async () => {
    const tiny = 1.5e-21;
    const records = [
      rec(),
      rec({ id: 'v', periodValue: 'March', calculation: calc(tiny), status: 'voided', voidReason: 'Duplicate entry', voidedBy: 'u-2', voidedAt: new Date('2024-03-01T00:00:00Z') }),
      rec({ id: 'w', category: 'Water', scope: 3, calculation: calc(tiny) }),
    ];
    const notes = async (language: 'en' | 'tr', sheet: string) => {
      const { service } = mocks(records, language);
      const rows = await sheetRows(await service.generateExcel(user, q), sheet);
      return rows.flat().filter((c): c is string => typeof c === 'string');
    };
    const en = await notes('en', 'Summary');
    expect(en).toContain('0.0000000000000000000015 tCO₂e removed');
    expect(en.some((c) => c.includes('(0.0000000000000000000015 tCO₂e calculated)'))).toBe(true);
    const tr = await notes('tr', 'Özet');
    expect(tr).toContain('0,0000000000000000000015 tCO₂e çıkarıldı');
    expect(tr.some((c) => c.includes('(0,0000000000000000000015 tCO₂e hesaplanmış)'))).toBe(true);
    // The withdrawn sheet keeps the number itself, as before.
    const { service } = mocks(records, 'tr');
    const withdrawn = await sheetRows(await service.generateExcel(user, q), 'Geri çekilen kayıtlar');
    expect(withdrawn.flat()).toContain(tiny);
  });

  it('lets the request name the language over the profile\'s', async () => {
    const { service } = mocks([rec()], 'tr');
    expect((await service.assemble(user, { ...q, language: 'en' })).language).toBe('en');
  });
});
