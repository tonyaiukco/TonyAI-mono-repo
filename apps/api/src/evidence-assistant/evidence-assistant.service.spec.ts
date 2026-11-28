import { describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import { fuelBatchScopeWhere } from '../fuel-batches/fuel-batch-scope';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';
import { EvidenceAssistantRuntime } from './evidence-assistant-runtime';
import { recordScopeWhere } from '../activity-records/record-scope';
import { EvidenceAssistantService, neighbourShellRef, recordInvoiceNo } from './evidence-assistant.service';
import type { PdfReaderService } from './pdf-reader.service';

/**
 * inc29-evidence-assistant task 8.3: the comparison service without a
 * database — the scope every batch read carries, and the answers that need no
 * figures (off, tanker, no file, the reader busy).
 */

const superAdmin: RequestUser = {
  id: '00000000-0000-4000-8000-0000000000a1', role: 'super_admin', organisationId: '00000000-0000-4000-8000-0000000000f1',
  accessibleSubsidiaryIds: ['00000000-0000-4000-8000-0000000000c1'],
} as RequestUser;

const batch = {
  id: '00000000-0000-4000-8000-0000000000b1', organisationId: superAdmin.organisationId, subsidiaryId: superAdmin.accessibleSubsidiaryIds[0],
  source: 'petrol_ofisi', invoiceRef: 'OZK0000000000001', fuelAccountId: '00000000-0000-4000-8000-0000000000e1', status: 'submitted',
};

function service(opts: { batch?: object | null; record?: object | null; files?: object[]; enabled?: boolean; refused?: 'reader_busy' | 'reader_unavailable' }) {
  const prisma = {
    fuelBatch: { findFirst: vi.fn(async () => (opts.batch === undefined ? batch : opts.batch)), findMany: vi.fn(async () => []) },
    evidence: { findMany: vi.fn(async () => opts.files ?? []) },
    activityRecord: { findFirst: vi.fn(async () => opts.record ?? null) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(),
  };
  const reader = { withSession: vi.fn(async () => ({ refused: opts.refused ?? 'reader_busy' })) } as unknown as PdfReaderService;
  const runtime = new EvidenceAssistantRuntime(reader, { enabled: opts.enabled ?? true, tolerancePercent: '1' });
  const storage = { download: vi.fn(async () => Buffer.from('%PDF-1.7')) } as unknown as StorageService;
  return { svc: new EvidenceAssistantService(prisma as unknown as PrismaService, {} as AuditService, storage, runtime), prisma, reader, storage };
}

describe('EvidenceAssistantService.forBatch (D6, D7)', () => {
  it("reads the batch through the caller's batch scope, and answers 404 outside it, the assistant on or off", async () => {
    for (const enabled of [true, false]) {
      const { svc, prisma } = service({ batch: null, enabled });
      await expect(svc.forBatch(superAdmin, batch.id)).rejects.toMatchObject({ response: { code: 'fuel_batch_not_found' } });
      expect(prisma.fuelBatch.findFirst).toHaveBeenCalledWith({ where: { AND: [{ id: batch.id }, fuelBatchScopeWhere(superAdmin)] } });
    }
  });

  it('answers { enabled: false } and nothing else when off, reading no file', async () => {
    const { svc, prisma } = service({ enabled: false });
    expect(await svc.forBatch(superAdmin, batch.id)).toEqual({ enabled: false });
    expect(prisma.evidence.findMany).not.toHaveBeenCalled();
  });

  it('answers tanker without looking at its files (C8), and no_evidence for a batch with none', async () => {
    const tanker = service({ batch: { ...batch, source: 'tanker', invoiceRef: '000101' } });
    expect(await tanker.svc.forBatch(superAdmin, batch.id)).toEqual({ enabled: true, tolerancePercent: 1, unread: { reason: 'tanker' } });
    expect(tanker.prisma.evidence.findMany).not.toHaveBeenCalled();
    expect(await service({}).svc.forBatch(superAdmin, batch.id)).toEqual({ enabled: true, tolerancePercent: 1, unread: { reason: 'no_evidence' } });
  });

  it('answers reader_busy for an unread file while the reader is busy, downloading nothing', async () => {
    const file = { id: 'f1', fileName: 'x.pdf', mimeType: 'application/pdf', storagePath: 'p', sourceSha256: null, sourcePageFrom: null, sourcePageTo: null, readings: [] };
    const busy = service({ files: [file] });
    expect(await busy.svc.forBatch(superAdmin, batch.id)).toEqual({ enabled: true, tolerancePercent: 1, unread: { reason: 'reader_busy' } });
    expect(busy.storage.download).not.toHaveBeenCalled();
    const unavailable = service({ files: [file], refused: 'reader_unavailable' });
    expect(await unavailable.svc.forBatch(superAdmin, batch.id)).toMatchObject({ unread: { reason: 'reader_unavailable' } });
  });

  it("only the batch's own files are read: their links are to the batch's live records", async () => {
    const { svc, prisma } = service({});
    await svc.forBatch(superAdmin, batch.id);
    expect(prisma.evidence.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { links: { some: { activityRecord: { fuelBatchId: batch.id, status: { not: 'voided' } } } } },
    }));
  });
});

describe('neighbourShellRef (B8)', () => {
  it('steps half-months across months and years', () => {
    expect(neighbourShellRef('2025-03-1', -1)).toBe('2025-02-2');
    expect(neighbourShellRef('2025-03-1', 1)).toBe('2025-03-2');
    expect(neighbourShellRef('2025-03-2', 1)).toBe('2025-04-1');
    expect(neighbourShellRef('2025-01-1', -1)).toBe('2024-12-2');
    expect(neighbourShellRef('2025-12-2', 1)).toBe('2026-01-1');
    expect(neighbourShellRef('OZK0000000000001', 1)).toBeNull();
  });
});

describe('Petrol Ofisi neighbours and the reading store (qa-auditor review of PR B)', () => {
  const at = (iso: string) => new Date(iso);
  const neighbours = async (rows: Array<{ invoice_ref: string; first: Date | null }>, ref: string) => {
    const { svc, prisma } = service({});
    prisma.$queryRaw.mockResolvedValueOnce(rows as never);
    return (svc as unknown as { petrolOfisiNeighbours(a: string, r: string): Promise<string[]> }).petrolOfisiNeighbours('acc', ref);
  };

  it('takes the invoice just before and after by first transaction', async () => {
    const rows = [
      { invoice_ref: 'OZK1', first: at('2025-03-01T08:00:00Z') },
      { invoice_ref: 'OZK2', first: at('2025-03-16T08:00:00Z') },
      { invoice_ref: 'OZK3', first: at('2025-04-01T08:00:00Z') },
    ];
    expect(await neighbours(rows, 'OZK2')).toEqual(['OZK1', 'OZK3']);
    expect(await neighbours(rows, 'OZK1')).toEqual(['OZK2']);
  });

  it('takes none where a tie decides the order', async () => {
    const tie = [
      { invoice_ref: 'OZK1', first: at('2025-03-01T08:00:00Z') },
      { invoice_ref: 'OZK2', first: at('2025-03-16T08:00:00Z') },
      { invoice_ref: 'OZK9', first: at('2025-03-16T08:00:00Z') },
    ];
    expect(await neighbours(tie, 'OZK2')).toEqual([]);
    expect(await neighbours(tie, 'OZK1')).toEqual([]);
  });

  it('stores no reading when the file no longer backs a live record of a batch the caller can read', async () => {
    const tx = {
      evidence: { findFirst: vi.fn(async () => null) },
      $queryRaw: vi.fn(),
      evidenceReading: { findUnique: vi.fn() },
    };
    const { svc, prisma } = service({});
    prisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    const out = await (svc as unknown as { storeReading(u: RequestUser, o: object, e: string, r: unknown): Promise<unknown> })
      .storeReading(superAdmin, { fuelBatchId: batch.id }, 'f1', { readerVersion: 'v', status: 'read', pageCount: 1, invoices: [] });
    expect(out).toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.evidence.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'f1',
        links: { some: { activityRecord: { status: { not: 'voided' }, fuelBatch: { AND: [{ id: batch.id }, fuelBatchScopeWhere(superAdmin)] } } } },
      }),
    }));
  });
});

describe('the pre-merge review’s cases (review of PR B)', () => {
  const shellBatch = { ...batch, source: 'shell', invoiceRef: '2025-03-1' };
  const dau = {
    invoiceNo: 'DAU0000000000244', series: 'DAU', periodText: '01.03.2025 - 15.03.2025', periodFrom: '2025-03-01', periodTo: '2025-03-15',
    buyerName: null, buyerTaxId: null, pageFrom: 1, pageTo: 1, unreadReason: null, lines: [{ product: 'Motorin Med', fuel: 'diesel', litres: '10.00' }],
  };
  const readFile = { id: 'f1', fileName: 'a.pdf', mimeType: 'application/pdf', storagePath: 'p1', sourceSha256: null, sourcePageFrom: null, sourcePageTo: null, readings: [{ status: 'read', pageCount: 1, invoices: [dau] }] };
  const pendingFile = { id: 'f2', fileName: 'b.pdf', mimeType: 'application/pdf', storagePath: 'p2', sourceSha256: null, sourcePageFrom: null, sourcePageTo: null, readings: [] };

  it('answers no comparison while a PDF of the package is still unread: it may hold a second invoice of the half-month', async () => {
    const { svc } = service({ batch: shellBatch, files: [readFile, pendingFile] });
    expect(await svc.forBatch(superAdmin, batch.id)).toEqual({ enabled: true, tolerancePercent: 1, unread: { reason: 'reader_busy' } });
  });

  const withSession = (remaining: () => number) => vi.fn(async (_ms: number, fn: (s: unknown) => Promise<unknown>) => fn({
    remainingMs: remaining,
    text: vi.fn(async () => ({ kind: 'transient', reason: 'timed_out' })),
  }));

  it('starts no download once the request’s budget is spent', async () => {
    const { svc, reader, storage } = service({ batch: shellBatch, files: [pendingFile, { ...pendingFile, id: 'f3', storagePath: 'p3' }] });
    (reader as unknown as { withSession: unknown }).withSession = withSession(() => 0);
    expect(await svc.forBatch(superAdmin, batch.id)).toMatchObject({ unread: { reason: 'timed_out' } });
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('cuts a download under way at the budget, aborting it, and releases the reader', async () => {
    const { svc, reader, storage } = service({ batch: shellBatch, files: [pendingFile] });
    (reader as unknown as { withSession: unknown }).withSession = withSession(() => 30);
    let signal: AbortSignal | undefined;
    (storage.download as unknown as ReturnType<typeof vi.fn>).mockImplementation((_b: string, _p: string, s?: AbortSignal) => {
      signal = s;
      return new Promise(() => undefined);
    });
    const started = Date.now();
    expect(await svc.forBatch(superAdmin, batch.id)).toMatchObject({ unread: { reason: 'timed_out' } });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signal?.aborted).toBe(true);
  });

  it('matches the invoice number without regard to case when listing the invoice’s other batches', async () => {
    const { svc, prisma } = service({});
    await (svc as unknown as { siblings(u: RequestUser, b: string, i: object): Promise<unknown> })
      .siblings(superAdmin, batch.id, { organisationId: batch.organisationId, source: 'petrol_ofisi', invoiceRef: 'ozk0000000000001', fuelAccountId: null });
    expect(prisma.fuelBatch.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [fuelBatchScopeWhere(superAdmin), expect.objectContaining({ invoiceRef: { equals: 'ozk0000000000001', mode: 'insensitive' } })] },
    }));
  });
});

describe('EvidenceAssistantService.forRecord (C6, task 11.1)', () => {
  it("stores a record's reading only while the record is in the caller's scope and organisation", async () => {
    const tx = { evidence: { findFirst: vi.fn(async () => null) }, $queryRaw: vi.fn(), evidenceReading: { findUnique: vi.fn() } };
    const { svc, prisma } = service({});
    prisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    const recordId = '00000000-0000-4000-8000-0000000000d1';
    const out = await (svc as unknown as { storeReading(u: RequestUser, o: object, e: string, r: unknown): Promise<unknown> })
      .storeReading(superAdmin, { activityRecordId: recordId }, 'f1', { readerVersion: 'v', status: 'read', pageCount: 1, invoices: [] });
    expect(out).toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.evidence.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'f1', links: { some: { activityRecordId: recordId, activityRecord: { AND: [recordScopeWhere(superAdmin), { status: { not: 'voided' } }, { subsidiary: { organisationId: superAdmin.organisationId } }] } } } },
    }));
  });

  const manual = {
    id: '00000000-0000-4000-8000-0000000000d1', subsidiary: { organisationId: superAdmin.organisationId }, fuelBatchId: null,
    category: 'Mobile Combustion', activityType: 'on_road_diesel', activityUnit: 'litres', activityValue: 1200, input: { invoice_no: 'OZK0000000000001' },
  };

  it("reads the record through the caller's record scope, and answers 404 outside it or in another organisation, on or off", async () => {
    for (const enabled of [true, false]) {
      const { svc, prisma } = service({ record: null, enabled });
      await expect(svc.forRecord(superAdmin, manual.id)).rejects.toMatchObject({ response: { code: 'record_not_found' } });
      expect(prisma.activityRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ id: manual.id }, recordScopeWhere(superAdmin)] } }));
      const moved = service({ record: { ...manual, subsidiary: { organisationId: 'another' } }, enabled });
      await expect(moved.svc.forRecord(superAdmin, manual.id)).rejects.toMatchObject({ response: { code: 'record_not_found' } });
    }
  });

  it('answers { enabled: false } when off, and for a record it does not compare, reading no file', async () => {
    for (const [label, record, enabled] of [
      ['off', manual, false],
      ['a batch’s record', { ...manual, fuelBatchId: batch.id }, true],
      ['LPG in kilograms', { ...manual, category: 'Fuel', activityType: 'lpg', activityUnit: 'kg' }, true],
      ['another category', { ...manual, category: 'Electricity', activityType: 'grid', activityUnit: 'kWh' }, true],
      ['on-road LPG in litres (no invoice rule names LPG)', { ...manual, activityType: 'on_road_lpg' }, true],
      ['a voided record', { ...manual, status: 'voided' }, true],
    ] as const) {
      const { svc, prisma } = service({ record, enabled });
      expect(await svc.forRecord(superAdmin, manual.id), label).toEqual({ enabled: false });
      expect(prisma.evidence.findMany).not.toHaveBeenCalled();
    }
  });

  it('answers no_evidence for a manual litres record with no file', async () => {
    expect(await service({ record: manual }).svc.forRecord(superAdmin, manual.id)).toEqual({ enabled: true, tolerancePercent: 1, unread: { reason: 'no_evidence' } });
  });

  it('reads the invoice number the record names, trimmed, and nothing from anything else', () => {
    expect(recordInvoiceNo({ invoice_no: '  OZK0000000000001 ' })).toBe('OZK0000000000001');
    for (const input of [null, undefined, [], 'OZK1', { invoice_no: '' }, { invoice_no: '   ' }, { invoice_no: 12 }, { invoiceNo: 'OZK1' }]) {
      expect(recordInvoiceNo(input)).toBeNull();
    }
  });
});

describe('forRecord: which invoice and which answer (qa-auditor review of groups 10–11)', () => {
  const manual = {
    id: '00000000-0000-4000-8000-0000000000d2', subsidiary: { organisationId: superAdmin.organisationId }, fuelBatchId: null, status: 'submitted',
    category: 'Mobile Combustion', activityType: 'on_road_diesel', activityUnit: 'litres', activityValue: 100, input: { invoice_no: 'OZK0000000000001' },
  };
  const invoice = (unreadReason: string | null, litres = '100.00') => ({
    invoiceNo: 'OZK0000000000001', series: 'OZK', periodText: null, periodFrom: null, periodTo: null, buyerName: null, buyerTaxId: null,
    pageFrom: 1, pageTo: 1, unreadReason, lines: unreadReason ? [] : [{ product: 'Motorin Med', fuel: 'diesel', litres }],
  });
  const file = (id: string, invoices: object[] | null, mimeType = 'application/pdf') => ({
    id, fileName: `${id}.pdf`, mimeType, storagePath: id, sourceSha256: null, sourcePageFrom: null, sourcePageTo: null,
    readings: invoices === null ? [] : [{ status: 'read', pageCount: 1, invoices }],
  });

  it('compares the copy that was read when an earlier copy of the same invoice was not', async () => {
    const { svc } = service({ record: manual, files: [file('a', [invoice('unreadable')]), file('b', [invoice(null)])] });
    expect(await svc.forRecord(superAdmin, manual.id)).toMatchObject({ invoice: { file: { id: 'b' } }, lines: [{ state: 'consistent' }] });
  });

  it('answers the matched invoice’s own unread reason, never an orange line with no figure', async () => {
    const { svc } = service({ record: manual, files: [file('a', [invoice('unreadable_row')])] });
    expect(await svc.forRecord(superAdmin, manual.id)).toEqual({ enabled: true, tolerancePercent: 1, unread: { reason: 'unreadable_row' } });
  });

  it('answers the reader’s passing reason while a PDF of the record is still unread', async () => {
    const { svc } = service({ record: manual, files: [file('a', [invoice(null)]), file('b', null)] });
    expect(await svc.forRecord(superAdmin, manual.id)).toEqual({ enabled: true, tolerancePercent: 1, unread: { reason: 'reader_busy' } });
  });
});

describe('forRecord: copies and candidates (review of PR B, fourth round)', () => {
  const base = {
    id: '00000000-0000-4000-8000-0000000000d3', subsidiary: { organisationId: superAdmin.organisationId }, fuelBatchId: null, status: 'submitted',
    category: 'Mobile Combustion', activityType: 'on_road_diesel', activityUnit: 'litres', activityValue: 1200, input: { invoice_no: 'OZK0000000000001' },
  };
  const invoice = (invoiceNo: string, litres: string | null, unreadReason: string | null = null) => ({
    invoiceNo, series: invoiceNo.slice(0, 3), periodText: null, periodFrom: null, periodTo: null, buyerName: null, buyerTaxId: null,
    pageFrom: 1, pageTo: 1, unreadReason, lines: litres === null ? [] : [{ product: 'Motorin Med', fuel: 'diesel', litres }],
  });
  const file = (id: string, invoices: object[]) => ({
    id, fileName: `${id}.pdf`, mimeType: 'application/pdf', storagePath: id, sourceSha256: null, sourcePageFrom: null, sourcePageTo: null,
    readings: [{ status: 'read', pageCount: 1, invoices }],
  });

  it('answers the manual check when two read copies of its invoice disagree, in either order', async () => {
    for (const order of [['1200.00', '1800.00'], ['1800.00', '1200.00']]) {
      const { svc } = service({ record: base, files: order.map((l, i) => file(`f${i}`, [invoice('OZK0000000000001', l)])) });
      expect(await svc.forRecord(superAdmin, base.id), order.join()).toEqual({ enabled: true, tolerancePercent: 1, unread: { reason: 'several_matching_invoices' } });
    }
  });

  it('compares one invoice printed identically in two files', async () => {
    const { svc } = service({ record: base, files: [file('a', [invoice('OZK0000000000001', '1200.00')]), file('b', [invoice('ozk0000000000001', '1200.00')])] });
    expect(await svc.forRecord(superAdmin, base.id)).toMatchObject({ lines: [{ state: 'consistent' }] });
  });

  it('with no number, takes the sole read invoice beside one the reader could not read', async () => {
    const record = { ...base, input: null };
    const { svc } = service({ record, files: [file('a', [invoice('OZK0000000000001', '1200.00')]), file('b', [invoice('ABC0000000000009', null, 'unknown_series')])] });
    expect(await svc.forRecord(superAdmin, base.id)).toMatchObject({ invoice: { invoiceNo: 'OZK0000000000001' }, lines: [{ state: 'consistent' }] });
    const none = service({ record, files: [file('b', [invoice('ABC0000000000009', null, 'unknown_series')])] });
    expect(await none.svc.forRecord(superAdmin, base.id)).toMatchObject({ unread: { reason: 'unknown_series' } });
  });
});
