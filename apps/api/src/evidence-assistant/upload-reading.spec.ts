import { describe, expect, it, vi } from 'vitest';
import { EvidenceAssistantRuntime } from './evidence-assistant-runtime';
import { READER_VERSION } from './invoice-layout';
import type { CutOutcome, PdfReaderService, ReaderItem, ReaderPage, ReaderSession, TextOutcome } from './pdf-reader.service';
import { UploadReadingService } from './upload-reading';

/**
 * inc29-evidence-assistant task 7.4: the upload's branch logic (D4, D5) without
 * a database or a reader process — a scripted session answers each read and
 * cut, so every fallback to "attach whole" and every split outcome is pinned.
 */

const item = (s: string, x: number, y: number): ReaderItem => ({ s, x, y, w: s.length * 5, h: 10, k: false });

/** One invoice page in the fixtures' layout. */
function invoicePage(no: string, period = '01.03.2025 - 15.03.2025'): ReaderPage {
  return {
    w: 595, h: 842,
    items: [
      item('Fatura No:', 40, 750), item(no, 110, 750), item('Dönem:', 40, 720), item(period, 110, 720),
      item('Ürün', 40, 620), item('Miktar (lt)', 260, 620), item('Tutar (TL)', 460, 620),
      item('Motorin Med', 40, 600), item('100,00', 260, 600),
    ],
  };
}

const text = (pages: ReaderPage[]): TextOutcome => ({ kind: 'text', pageCount: pages.length, pages });
const PO = { source: 'petrol_ofisi', invoiceRef: 'OZK0000000000001' };
const SHELL = { source: 'shell', invoiceRef: '2025-03-1' };
const bytes = Buffer.from('%PDF-1.7 synthetic');

/** A service whose one reader session answers `texts` in turn and `cut` once. */
function planner(script: { texts?: TextOutcome[]; cut?: CutOutcome; refused?: 'reader_busy' | 'reader_unavailable'; enabled?: boolean; throws?: boolean }) {
  const texts = [...(script.texts ?? [])];
  const cut = vi.fn(async (_b: Buffer, ranges: Array<[number, number]>) =>
    script.cut ?? { kind: 'parts' as const, parts: ranges.map(([pageFrom, pageTo]) => ({ pageFrom, pageTo, bytes: Buffer.from(`part ${pageFrom}-${pageTo}`) })) },
  );
  const session: ReaderSession = {
    remainingMs: () => 10_000,
    text: async () => {
      if (script.throws) throw new Error('reader crashed');
      const next = texts.shift();
      if (!next) throw new Error('unexpected read');
      return next;
    },
    cut,
  };
  const reader = {
    withSession: vi.fn(async (_ms: number, fn: (s: ReaderSession) => Promise<unknown>) => (script.refused ? { refused: script.refused } : fn(session))),
  };
  const runtime = new EvidenceAssistantRuntime(reader as unknown as PdfReaderService, { enabled: script.enabled ?? true, tolerancePercent: '1' });
  return { service: new UploadReadingService(runtime), cut, reader };
}

const pdf = 'application/pdf';

describe('UploadReadingService.plan: attach whole (B2, D4)', () => {
  it('stores unread, and reads nothing, when off, for a non-PDF, a refused session or a failing reader', async () => {
    expect(await planner({ enabled: false }).service.plan(PO, pdf, bytes, 'a'.repeat(64))).toEqual({ kind: 'whole', reading: null });
    expect(await planner({}).service.plan(PO, 'image/jpeg', bytes, 'a'.repeat(64))).toEqual({ kind: 'whole', reading: null });
    expect(await planner({ refused: 'reader_busy' }).service.plan(PO, pdf, bytes, 'a'.repeat(64))).toEqual({ kind: 'whole', reading: null });
    expect(await planner({ refused: 'reader_unavailable' }).service.plan(PO, pdf, bytes, 'a'.repeat(64))).toEqual({ kind: 'whole', reading: null });
    expect(await planner({ throws: true }).service.plan(PO, pdf, bytes, 'a'.repeat(64))).toEqual({ kind: 'whole', reading: null });
  });

  it("stores a file's own unread outcome, and not a transient one", async () => {
    const unread = await planner({ texts: [{ kind: 'unread', status: 'encrypted', pageCount: 0 }] }).service.plan(PO, pdf, bytes, 'a'.repeat(64));
    expect(unread).toEqual({ kind: 'whole', reading: { readerVersion: READER_VERSION, status: 'encrypted', pageCount: 0, invoices: [] } });
    const transient = await planner({ texts: [{ kind: 'transient', reason: 'timed_out' }] }).service.plan(PO, pdf, bytes, 'a'.repeat(64));
    expect(transient).toEqual({ kind: 'whole', reading: null });
  });

  it('attaches one invoice whole, read', async () => {
    const { service, cut } = planner({ texts: [text([invoicePage('OZK0000000000001')])] });
    const plan = await service.plan(PO, pdf, bytes, 'a'.repeat(64));
    expect(plan).toMatchObject({ kind: 'whole', reading: { status: 'read', pageCount: 1 } });
    expect(cut).not.toHaveBeenCalled();
  });

  it('attaches whole when the PDF does not hold the batch’s invoice, or holds two of its half-month (C9, C11)', async () => {
    const other = planner({ texts: [text([invoicePage('OZK0000000000002'), invoicePage('OZK0000000000003')])] });
    expect(await other.service.plan(PO, pdf, bytes, 'a'.repeat(64))).toMatchObject({ kind: 'whole', reading: { status: 'read' } });
    expect(other.cut).not.toHaveBeenCalled();
    const twice = planner({ texts: [text([invoicePage('DAU0000000000001'), invoicePage('DAU0000000000002')])] });
    expect(await twice.service.plan(SHELL, pdf, bytes, 'a'.repeat(64))).toMatchObject({ kind: 'whole' });
    expect(twice.cut).not.toHaveBeenCalled();
  });

  it('attaches whole when the page structure is unsure', async () => {
    const unowned: ReaderPage = { w: 595, h: 842, items: [item('Cover page', 40, 700)] };
    const { service, cut } = planner({ texts: [text([unowned, invoicePage('OZK0000000000001'), invoicePage('OZK0000000000002')])] });
    expect(await service.plan(PO, pdf, bytes, 'a'.repeat(64))).toMatchObject({ kind: 'whole' });
    expect(cut).not.toHaveBeenCalled();
  });

  it('attaches whole when the cut fails, or the selected batch’s part fails isolation or its check', async () => {
    const pages = [invoicePage('OZK0000000000001'), invoicePage('OZK0000000000002')];
    expect(await planner({ texts: [text(pages)], cut: { kind: 'failed', reason: 'timed_out' } }).service.plan(PO, pdf, bytes, 'a'.repeat(64))).toMatchObject({ kind: 'whole' });
    const isolation: CutOutcome = { kind: 'parts', parts: [{ pageFrom: 1, pageTo: 1, bytes: null }, { pageFrom: 2, pageTo: 2, bytes: Buffer.from('x') }] };
    expect(await planner({ texts: [text(pages)], cut: isolation }).service.plan(PO, pdf, bytes, 'a'.repeat(64))).toMatchObject({ kind: 'whole' });
    // The part read back holds the other invoice's number.
    const wrong = planner({ texts: [text(pages), text([invoicePage('OZK0000000000002')]), text([invoicePage('OZK0000000000002')])] });
    expect(await wrong.service.plan(PO, pdf, bytes, 'a'.repeat(64))).toMatchObject({ kind: 'whole' });
  });
});

describe('UploadReadingService.plan: split (D5)', () => {
  it('routes the selected invoice and every other OZK invoice; withholds a part that fails its check', async () => {
    const pages = [invoicePage('OZK0000000000001'), invoicePage('OZK0000000000002'), invoicePage('OZK0000000000006')];
    const { service, cut } = planner({
      texts: [text(pages), text([pages[0]!]), text([pages[0]!]), text([pages[2]!])],
    });
    const plan = await service.plan(PO, pdf, bytes, 'f'.repeat(64));
    expect(cut).toHaveBeenCalledWith(bytes, [[1, 1], [2, 2], [3, 3]]);
    if (plan.kind !== 'split') throw new Error(plan.kind);
    expect(plan.sourceSha256).toBe('f'.repeat(64));
    expect(plan.invoices).toBe(3);
    expect(plan.primary).toMatchObject({ invoiceNo: 'OZK0000000000001', pageFrom: 1, pageTo: 1, reading: { status: 'read', pageCount: 1 } });
    expect(plan.primary.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The second part read back as the first invoice: withheld.
    expect(plan.others.map((p) => p.invoiceNo)).toEqual(['OZK0000000000006']);
    expect(plan.notAttached).toEqual([{ invoiceNo: 'OZK0000000000002', reason: 'unverified_part' }]);
  });

  it('routes a Duman invoice only to the selected batch; the others are reported for a manual attach (C9)', async () => {
    const pages = [invoicePage('DAU0000000000001', '01.03.2025 - 15.03.2025'), invoicePage('DAU0000000000002', '16.03.2025 - 31.03.2025')];
    const { service, cut } = planner({ texts: [text(pages), text([pages[0]!])] });
    const plan = await service.plan(SHELL, pdf, bytes, 'f'.repeat(64));
    expect(cut).toHaveBeenCalledWith(bytes, [[1, 1]]);
    expect(plan).toMatchObject({
      kind: 'split', primary: { invoiceNo: 'DAU0000000000001' }, others: [],
      notAttached: [{ invoiceNo: 'DAU0000000000002', reason: 'manual_attachment_required' }],
    });
  });

  it('never reads a tanker package’s PDF, so nothing of it is stored (C8)', async () => {
    const { service, cut, reader } = planner({ texts: [] });
    expect(await service.plan({ source: 'tanker', invoiceRef: '000101' }, pdf, bytes, 'f'.repeat(64))).toEqual({ kind: 'whole', reading: null });
    // No session at all: the reader is never asked (qa-auditor re-review: the plan's catch hid a read).
    expect(reader.withSession).not.toHaveBeenCalled();
    expect(cut).not.toHaveBeenCalled();
  });
});

describe('packageInvoices: one invoice in two files (architect review of PR B, P2)', () => {
  it('compares the copy that was read, whichever was attached first', async () => {
    const { packageInvoices } = await import('./package-invoice');
    const base = {
      invoiceNo: 'OZK0000000000001', series: 'OZK', periodText: null, periodFrom: null, periodTo: null,
      buyerName: null, buyerTaxId: null, pageFrom: 1, pageTo: 1, lines: [],
    };
    const unsure = { ...base, unreadReason: 'unreadable' as const };
    const clean = { ...base, unreadReason: null, lines: [{ product: 'Motorin', fuel: 'diesel' as const, litres: '1.00' }] };
    expect(packageInvoices(PO, [unsure, clean])).toEqual([clean]);
    expect(packageInvoices(PO, [clean, unsure])).toEqual([clean]);
    expect(packageInvoices(PO, [unsure])).toEqual([unsure]);
    // Two read copies whose figures differ are both kept: the caller answers the manual check (fourth round).
    const other = { ...clean, lines: clean.lines.map((l) => ({ ...l, litres: '999.00' })) };
    expect(packageInvoices(PO, [clean, other])).toEqual([clean, other]);
    expect(packageInvoices(PO, [clean, { ...clean }])).toEqual([clean]);
  });
});

describe('the storable text of a reading (qa-auditor review of PR B, P1)', () => {
  it('replaces NUL, control characters and lone surrogates with U+FFFD, never a blank, keeping pairs and the length', async () => {
    const { storableText } = await import('./pdf-reader.service');
    expect(storableText('Motorin\u0000Med')).toBe('Motorin\ufffdMed');
    expect(storableText('a\u0007b\u007fc')).toBe('a\ufffdb\ufffdc');
    expect(storableText('x\ud800y')).toBe('x\ufffdy');
    // A quantity of unmapped glyphs stays a cell that cannot be read, not an empty one.
    expect(storableText('\u0000\u0000\u0000').trim()).not.toBe('');
    expect(storableText('ok 😀')).toBe('ok 😀');
    const { readingRow } = await import('./upload-reading');
    const row = readingRow('read', 1, [{
      invoiceNo: 'OZK0000000000001', series: 'OZK', periodText: '\u0000', periodFrom: null, periodTo: null, buyerName: 'A\udc00',
      buyerTaxId: null, pageFrom: 1, pageTo: 1, unreadReason: null, lines: [{ product: 'Ad\u0000Blue', fuel: null, litres: '1' }],
    }]);
    expect(JSON.stringify(row.invoices)).not.toMatch(/\\u0000|\\udc00/);
    expect(row.invoices[0]!.lines[0]!.product).toBe('Ad\ufffdBlue');
  });
});

describe('a part read back must be exactly its invoice (D5 step 1)', () => {
  it('withholds the selected part when it reads back with another page count or owner', async () => {
    const pages = [invoicePage('OZK0000000000001'), invoicePage('OZK0000000000002')];
    // Two pages read back where one was cut.
    const twice = planner({ texts: [text(pages), text([pages[0]!, pages[0]!])] });
    expect(await twice.service.plan(PO, pdf, bytes, 'f'.repeat(64))).toMatchObject({ kind: 'whole' });
    // One page, but no invoice number on it: not owned.
    const unowned = planner({ texts: [text(pages), text([{ ...pages[0]!, items: pages[0]!.items.slice(2) }])] });
    expect(await unowned.service.plan(PO, pdf, bytes, 'f'.repeat(64))).toMatchObject({ kind: 'whole' });
    // A two-page invoice whose second page reads back unowned.
    const twoPage = [invoicePage('OZK0000000000001'), { ...invoicePage('OZK0000000000001'), items: invoicePage('OZK0000000000001').items.slice(2) }, invoicePage('OZK0000000000002')];
    const doc = text([invoicePage('OZK0000000000001'), invoicePage('OZK0000000000001'), invoicePage('OZK0000000000002')]);
    const halfOwned = planner({ texts: [doc, text(twoPage.slice(0, 2))] });
    expect(await halfOwned.service.plan(PO, pdf, bytes, 'f'.repeat(64))).toMatchObject({ kind: 'whole' });
  });

  it('matches a Shell invoice only on its exact half-month', async () => {
    const { packageInvoices } = await import('./package-invoice');
    const monthly = {
      invoiceNo: 'DAU0000000000003', series: 'DAU', periodText: null, periodFrom: '2025-02-01', periodTo: '2025-02-28',
      buyerName: null, buyerTaxId: null, pageFrom: 1, pageTo: 1, unreadReason: null, lines: [],
    };
    expect(packageInvoices({ source: 'shell', invoiceRef: '2025-02-1' }, [monthly])).toEqual([]);
    expect(packageInvoices({ source: 'shell', invoiceRef: '2025-02-2' }, [monthly])).toEqual([]);
    expect(packageInvoices({ source: 'shell', invoiceRef: '2025-02-2' }, [{ ...monthly, periodFrom: '2025-02-16' }])).toHaveLength(1);
  });
});
