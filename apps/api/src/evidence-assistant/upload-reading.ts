import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { EvidenceReadingStatus, EvidenceSplitNotAttachedReason } from '@tonyai/shared-types';
import { EvidenceAssistantRuntime } from './evidence-assistant-runtime';
import { READER_VERSION } from './invoice-layout';
import { packageInvoices, type PackageInvoiceKey } from './package-invoice';
import { storableText, type ReaderSession } from './pdf-reader.service';
import { READER_LIMITS } from './reader-limits';
import { readInvoices, type ReadInvoice } from './read-invoices';

/** One reading as `evidence_readings` stores it (D3). */
export interface ReadingRow {
  readerVersion: string;
  status: EvidenceReadingStatus;
  pageCount: number;
  invoices: ReadInvoice[];
}

/** One invoice's pages, cut from the uploaded PDF and read back. */
export interface InvoicePart {
  invoiceNo: string;
  series: string;
  /** In the uploaded PDF, one-based and inclusive. */
  pageFrom: number;
  pageTo: number;
  bytes: Buffer;
  sha256: string;
  reading: ReadingRow;
}

/**
 * What a batch upload stores (D4, D5):
 *  - `whole`: the uploaded file on the selected batch, with its reading when
 *    one belongs to the file (null when the assistant is off, the file is not a
 *    PDF, or the reader was busy, unavailable or cut short — tried again at the
 *    comparison);
 *  - `split`: the selected batch's own invoice as a part, and the other `OZK`
 *    invoices' verified parts for their own packages.
 */
export type UploadPlan =
  | { kind: 'whole'; reading: ReadingRow | null }
  | {
      kind: 'split';
      sourceSha256: string;
      /** Invoices in the uploaded PDF. */
      invoices: number;
      primary: InvoicePart;
      /** Verified `OZK` parts other than the primary, for their own batches. */
      others: InvoicePart[];
      notAttached: { invoiceNo: string; reason: EvidenceSplitNotAttachedReason }[];
    };

const WHOLE_UNREAD: UploadPlan = Object.freeze({ kind: 'whole', reading: null });

/** Every string of a reading made storable in jsonb (`storableText`): a second guard behind the reader's own. */
function storable<T>(value: T): T {
  if (typeof value === 'string') return storableText(value) as T;
  if (Array.isArray(value)) return value.map(storable) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, storable(v)])) as T;
  }
  return value;
}

export const readingRow = (status: EvidenceReadingStatus, pageCount: number, invoices: ReadInvoice[] = []): ReadingRow => ({
  readerVersion: READER_VERSION,
  status,
  pageCount,
  invoices: storable(invoices),
});

/** What an audit row says of a reading: its outcome, never its content (C7, D9). */
export function readingSummary(reading: ReadingRow): { status: string; pages: number; readerVersion: string } {
  return { status: reading.status, pages: reading.pageCount, readerVersion: reading.readerVersion };
}

/** A part's text, read back: exactly its invoice, on every one of its pages (D5 step 1). */
async function verifyPart(session: ReaderSession, bytes: Buffer, expected: ReadInvoice): Promise<ReadingRow | null> {
  const pages = expected.pageTo - expected.pageFrom + 1;
  const text = await session.text(bytes);
  if (text.kind !== 'text' || text.pageCount !== pages) return null;
  const back = readInvoices(text.pages);
  if (back.invoices.length !== 1 || back.pageOwner.some((owner) => owner !== expected.invoiceNo)) return null;
  const [invoice] = back.invoices;
  if (!invoice || invoice.invoiceNo !== expected.invoiceNo || invoice.pageFrom !== 1 || invoice.pageTo !== pages) return null;
  return readingRow('read', pages, back.invoices);
}

/**
 * Plans a batch upload's reading and split (inc29-evidence-assistant, D4, D5).
 * It writes nothing: `EvidenceService` stores what it returns through its one
 * write path. One reader session, one budget, for the read, the cut and every
 * part's check; a busy or unavailable reader, a failure or the budget's end
 * fall back to attaching the uploaded file whole — never to refusing it (B2).
 */
@Injectable()
export class UploadReadingService {
  private readonly logger = new Logger('EvidenceAssistantUpload');

  constructor(private readonly runtime: EvidenceAssistantRuntime) {}

  async plan(batch: PackageInvoiceKey, mimeType: string, bytes: Buffer, sha256: string): Promise<UploadPlan> {
    // A tanker package is never read (C8): nothing is stored of its file but the file
    // (architect review of PR B, P2 — its buyer and figures would otherwise be kept).
    if (!this.runtime.enabled || mimeType !== 'application/pdf' || batch.source === 'tanker') return WHOLE_UNREAD;
    try {
      const planned = await this.runtime.reader.withSession(READER_LIMITS.requestMs, (session) => this.read(session, batch, bytes, sha256));
      return 'refused' in planned ? WHOLE_UNREAD : planned;
    } catch (error) {
      // A reader that fails in any way never fails the upload (B2): stored whole, read at its comparison.
      this.logger.warn(`evidence_assistant_upload_read failed (${error instanceof Error ? error.name : 'Error'}); stored whole and unread`);
      return WHOLE_UNREAD;
    }
  }

  private async read(session: ReaderSession, batch: PackageInvoiceKey, bytes: Buffer, sha256: string): Promise<UploadPlan> {
    const text = await session.text(bytes);
    if (text.kind === 'transient') return WHOLE_UNREAD;
    if (text.kind === 'unread') return { kind: 'whole', reading: readingRow(text.status, text.pageCount) };
    const document = readInvoices(text.pages);
    const whole: UploadPlan = { kind: 'whole', reading: readingRow('read', text.pageCount, document.invoices) };
    // One invoice is attached whole; an unsure page structure is never split (D2).
    if (document.invoices.length < 2 || !document.routable) return whole;
    // Not exactly one invoice of the selected batch: the original stays on it
    // alone, for a manual check (C9, C11).
    const matches = packageInvoices(batch, document.invoices);
    if (matches.length !== 1) return whole;
    const primary = matches[0]!;
    const routed = [primary, ...document.invoices.filter((inv) => inv !== primary && inv.series === 'OZK')];
    const notAttached: { invoiceNo: string; reason: EvidenceSplitNotAttachedReason }[] = document.invoices
      .filter((inv) => !routed.includes(inv))
      .map((inv) => ({ invoiceNo: inv.invoiceNo, reason: 'manual_attachment_required' }));
    const cut = await session.cut(bytes, routed.map((inv) => [inv.pageFrom, inv.pageTo]));
    if (cut.kind !== 'parts') return whole;
    const parts: InvoicePart[] = [];
    for (const [i, inv] of routed.entries()) {
      const part = cut.parts[i]!;
      const reading = part.bytes ? await verifyPart(session, part.bytes, inv) : null;
      if (!part.bytes || !reading) {
        // The selected batch's own part failed: no routing at all (D5 step 1).
        if (inv === primary) return whole;
        notAttached.push({ invoiceNo: inv.invoiceNo, reason: 'unverified_part' });
        continue;
      }
      parts.push({
        invoiceNo: inv.invoiceNo,
        series: inv.series,
        pageFrom: inv.pageFrom,
        pageTo: inv.pageTo,
        bytes: part.bytes,
        sha256: createHash('sha256').update(part.bytes).digest('hex'),
        reading,
      });
    }
    const [first, ...others] = parts;
    return { kind: 'split', sourceSha256: sha256, invoices: document.invoices.length, primary: first!, others, notAttached };
  }
}
