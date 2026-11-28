import { describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import { fuelBatchScopeWhere } from '../fuel-batches/fuel-batch-scope';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';
import { EvidenceAssistantRuntime } from './evidence-assistant-runtime';
import { EvidenceAssistantService, neighbourShellRef } from './evidence-assistant.service';
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

function service(opts: { batch?: object | null; files?: object[]; enabled?: boolean; refused?: 'reader_busy' | 'reader_unavailable' }) {
  const prisma = {
    fuelBatch: { findFirst: vi.fn(async () => (opts.batch === undefined ? batch : opts.batch)), findMany: vi.fn(async () => []) },
    evidence: { findMany: vi.fn(async () => opts.files ?? []) },
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
    const out = await (svc as unknown as { storeReading(u: RequestUser, b: string, e: string, r: unknown): Promise<unknown> })
      .storeReading(superAdmin, batch.id, 'f1', { readerVersion: 'v', status: 'read', pageCount: 1, invoices: [] });
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
