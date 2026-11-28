import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import {
  FILE_FUELS,
  FUEL_INVOICE_ROW_STATES,
  assistantRecordFuel,
  parseShellInvoiceRef,
  type EvidenceAssistantDTO,
  type EvidenceAssistantRecordDTO,
  type EvidenceAssistantInvoiceDTO,
  type EvidenceAssistantUnreadReason,
  type EvidenceInvoiceSeries,
  type FileFuel,
} from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { ResourceNotFoundError } from '../common/api-error';
import { recordScopeWhere } from '../activity-records/record-scope';
import { fuelBatchScopeWhere } from '../fuel-batches/fuel-batch-scope';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { EVIDENCE_BUCKET } from '../storage/buckets';
import { compare, compareRecord, differences } from './compare';
import { EvidenceAssistantRuntime } from './evidence-assistant-runtime';
import { READER_VERSION, fold, isInvoiceSeries } from './invoice-layout';
import { packageInvoices } from './package-invoice';
import type { ReaderSession, TransientReason } from './pdf-reader.service';
import { READER_LIMITS } from './reader-limits';
import { readInvoices, type ReadInvoice } from './read-invoices';
import { readingRow, readingSummary, type ReadingRow } from './upload-reading';

type Litres = Partial<Record<FileFuel, string>>;

/** One of the package's files with its reading by the current reader, if any. */
interface PackageFile {
  id: string;
  fileName: string;
  mimeType: string;
  storagePath: string;
  source: EvidenceAssistantInvoiceDTO['file']['source'];
  reading: ReadingRow | null;
}

/** An invoice's identity (INC-2.8 §1, §5, §6): Shell's is the account and the half-month. */
interface InvoiceIdentity {
  organisationId: string;
  source: string;
  invoiceRef: string;
  fuelAccountId: string | null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** What a reading stored at a comparison is checked against: the batch's, or the manual record's, files. */
type ReadingOwner = { fuelBatchId: string } | { activityRecordId: string };

/** The invoice number a manual record names (`input.invoice_no`, BUG-16), trimmed; null when it names none. */
export function recordInvoiceNo(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>).invoice_no;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The Shell half-month reference before or after `ref` (`2025-03-1` ↔ `2025-02-2`, `2025-03-2`). */
export function neighbourShellRef(ref: string, step: -1 | 1): string | null {
  const parsed = parseShellInvoiceRef(ref);
  if (!parsed) return null;
  const index = parsed.year * 24 + (parsed.month - 1) * 2 + (parsed.half - 1) + step;
  const year = Math.floor(index / 24);
  const month = Math.floor((index % 24) / 2) + 1;
  return `${year}-${pad2(month)}-${(index % 2) + 1}`;
}

/**
 * The evidence assistant's comparison (inc29-evidence-assistant, design D6,
 * D7): worked out when it is asked for, from the package's current rows and
 * files; nothing is stored but a reading of a file that had none (D4).
 */
@Injectable()
export class EvidenceAssistantService {
  private readonly logger = new Logger('EvidenceAssistant');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly runtime: EvidenceAssistantRuntime,
  ) {}

  /** `GET /fuel-batches/:id/evidence-assistant`. */
  async forBatch(user: RequestUser, fuelBatchId: string): Promise<EvidenceAssistantDTO> {
    // The batch's scope first, the assistant on or off (D7).
    const batch = await this.prisma.fuelBatch.findFirst({ where: { AND: [{ id: fuelBatchId }, fuelBatchScopeWhere(user)] } });
    if (!batch) throw new ResourceNotFoundError('fuel_batch_not_found');
    if (!this.runtime.enabled) return { enabled: false };
    const tolerancePercent = Number(this.runtime.config.tolerancePercent);
    const unread = (reason: EvidenceAssistantUnreadReason): EvidenceAssistantDTO => ({ enabled: true, tolerancePercent, unread: { reason } });
    if (batch.source === 'tanker') return unread('tanker');

    const files = await this.packageFiles(batch.id);
    if (files.length === 0) return unread('no_evidence');
    const transient = await this.readUnreadFiles(user, { fuelBatchId: batch.id }, files);
    // A PDF of the package still unread may hold another invoice of it, and so
    // turn one match into several: no answer from the others meanwhile
    // (review of PR B, P2).
    if (transient) return unread(transient);

    const found: Array<{ invoice: ReadInvoice; file: PackageFile }> = [];
    for (const file of files) for (const invoice of file.reading?.invoices ?? []) found.push({ invoice, file });
    const matches = packageInvoices(batch, found.map((f) => f.invoice));
    if (matches.length > 1) return unread('several_matching_invoices');
    if (matches.length === 0) return unread(this.noMatchReason(files));
    const match = found.find((f) => f.invoice === matches[0])!;
    if (match.invoice.unreadReason) return unread(match.invoice.unreadReason);

    const identity = this.identityOf(batch);
    const packageLitres = await this.packageLitres(batch.id);
    const live = await this.invoiceRows(identity, batch.id);
    const shared = live.outside > 0;
    // The period-shift rule looks at the account's neighbouring invoice. An
    // invoice shared by several accounts has one per account, and its
    // invoice-level comparison must read the same from each of its batches:
    // the rule is not applied to it (review of PR B, second round, P2).
    const neighbours = live.accounts <= 1 ? await this.neighbourDifferences(user, batch, identity) : [];
    const comparison = compare({
      tolerancePercent: this.runtime.config.tolerancePercent,
      invoiceLines: match.invoice.lines,
      packageLitres,
      invoiceLevelLitres: shared ? live.litres : null,
      neighbourDifferences: neighbours,
    });
    const base = {
      enabled: true as const,
      tolerancePercent,
      invoice: this.invoiceDTO(match.invoice, match.file),
      otherLines: comparison.otherLines,
    };
    if (!shared) {
      return { ...base, level: 'package', lines: comparison.lines.map(({ invoiceLevelLitres: _, ...line }) => line) };
    }
    return {
      ...base,
      level: 'invoice',
      lines: comparison.lines,
      shared: { accounts: live.accounts, siblings: await this.siblings(user, batch.id, identity) },
    };
  }

  /**
   * `GET /activity-records/:id/evidence-assistant` (C6): a manual fuel record
   * in litres compared as a package of one record, on its own figure. Its
   * invoice is the read invoice its invoice number names among its files; with
   * no number, the sole read invoice; two and no number, not read. Any other
   * record — a batch's (compared on its batch), not in litres, another
   * category — gets no comparison here: `{ enabled: false }`, as when off, so
   * no panel is shown. The record's scope first, the assistant on or off.
   */
  async forRecord(user: RequestUser, activityRecordId: string): Promise<EvidenceAssistantRecordDTO> {
    const record = await this.prisma.activityRecord.findFirst({
      where: { AND: [{ id: activityRecordId }, recordScopeWhere(user)] },
      include: { subsidiary: { select: { organisationId: true } } },
    });
    // A record that moved with its company to another organisation answers as unknown (as `loadScoped`).
    if (!record || record.subsidiary.organisationId !== user.organisationId) throw new ResourceNotFoundError('record_not_found');
    if (!this.runtime.enabled) return { enabled: false };
    // A voided record is not compared, as a batch's voided records are not (review of PR B, third round).
    const fuel = record.status === 'voided' ? null : assistantRecordFuel(record);
    if (fuel === null) return { enabled: false };
    const tolerancePercent = Number(this.runtime.config.tolerancePercent);
    const unread = (reason: EvidenceAssistantUnreadReason): EvidenceAssistantRecordDTO => ({ enabled: true, tolerancePercent, unread: { reason } });

    const files = await this.filesWhere({ links: { some: { activityRecordId: record.id } } });
    if (files.length === 0) return unread('no_evidence');
    const transient = await this.readUnreadFiles(user, { activityRecordId: record.id }, files);
    // A PDF still unread may hold the invoice: no answer from the others meanwhile.
    if (transient) return unread(transient);

    const found: Array<{ invoice: ReadInvoice; file: PackageFile }> = [];
    for (const file of files) for (const invoice of file.reading?.invoices ?? []) found.push({ invoice, file });
    const named = recordInvoiceNo(record.input);
    // One invoice printed in two files is one; the copy that was read wins (as `packageInvoices`).
    const byNumber = new Map<string, { invoice: ReadInvoice; file: PackageFile }>();
    for (const entry of found) {
      const key = fold(entry.invoice.invoiceNo.trim());
      if (named !== null && key !== fold(named)) continue;
      const held = byNumber.get(key);
      if (!held || (held.invoice.unreadReason !== null && entry.invoice.unreadReason === null)) byNumber.set(key, entry);
    }
    const matches = [...byNumber.values()];
    if (matches.length > 1) return unread('several_matching_invoices');
    if (matches.length === 0) return unread(this.noMatchReason(files));
    const match = matches[0]!;
    if (match.invoice.unreadReason) return unread(match.invoice.unreadReason);
    const comparison = compareRecord({
      tolerancePercent: this.runtime.config.tolerancePercent,
      invoiceLines: match.invoice.lines,
      fuel,
      litres: String(record.activityValue),
    });
    return {
      enabled: true,
      tolerancePercent,
      invoice: this.invoiceDTO(match.invoice, match.file),
      otherLines: comparison.otherLines,
      level: 'package',
      lines: [comparison.line],
    };
  }

  // ── The package's files and their readings ─────────────────────────────────

  private packageFiles(fuelBatchId: string): Promise<PackageFile[]> {
    return this.filesWhere({ links: { some: { activityRecord: { fuelBatchId, status: { not: 'voided' } } } } });
  }

  private async filesWhere(where: Prisma.EvidenceWhereInput): Promise<PackageFile[]> {
    const rows = await this.prisma.evidence.findMany({
      where,
      include: { readings: { where: { readerVersion: READER_VERSION } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((e) => ({
      id: e.id,
      fileName: e.fileName,
      mimeType: e.mimeType,
      storagePath: e.storagePath,
      source: e.sourceSha256 !== null && e.sourcePageFrom !== null && e.sourcePageTo !== null
        ? { sha256: e.sourceSha256, pageFrom: e.sourcePageFrom, pageTo: e.sourcePageTo }
        : undefined,
      reading: e.readings[0]
        ? readingRow(e.readings[0].status as ReadingRow['status'], e.readings[0].pageCount, e.readings[0].invoices as unknown as ReadInvoice[])
        : null,
    }));
  }

  /**
   * Reads the package's PDFs that have no reading by the current reader (D4):
   * attached before the deploy, while the assistant was off or the reader busy,
   * or read by an earlier reader. One session, one budget; never a neighbour's
   * file. Answers the transient reason of the first file it could not read.
   */
  private async readUnreadFiles(user: RequestUser, owner: ReadingOwner, files: PackageFile[]): Promise<TransientReason | null> {
    const pending = files.filter((f) => f.reading === null && f.mimeType === 'application/pdf');
    if (pending.length === 0) return null;
    let transient: TransientReason | null = null;
    try {
      const outcome = await this.runtime.reader.withSession(READER_LIMITS.requestMs, async (session) => {
        for (const file of pending) {
          // The request's one budget bounds the downloads too: none is
          // started past it, and one under way is cut at it (review of PR B, P2).
          const left = session.remainingMs();
          if (left <= 0) {
            transient ??= 'timed_out';
            break;
          }
          const reading = await this.readOne(session, file, left);
          if ('transient' in reading) {
            transient ??= reading.transient;
            continue;
          }
          file.reading = await this.storeReading(user, owner, file.id, reading);
        }
      });
      if (outcome && typeof outcome === 'object' && 'refused' in outcome) transient = outcome.refused;
    } catch (error) {
      this.logger.warn(`evidence_assistant_read failed (${error instanceof Error ? error.name : 'Error'})`);
      transient = 'reader_unavailable';
    }
    return transient;
  }

  private async readOne(session: ReaderSession, file: PackageFile, budgetMs: number): Promise<ReadingRow | { transient: TransientReason }> {
    const bytes = await this.downloadWithin(file.storagePath, budgetMs);
    if (bytes === null) return { transient: 'timed_out' };
    const text = await session.text(bytes);
    if (text.kind === 'transient') return { transient: text.reason };
    if (text.kind === 'unread') return readingRow(text.status, text.pageCount);
    return readingRow('read', text.pageCount, readInvoices(text.pages).invoices);
  }

  /** The file's bytes, or null once `budgetMs` has passed (the download is aborted). */
  private async downloadWithin(storagePath: string, budgetMs: number): Promise<Buffer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const download = this.storage.download(EVIDENCE_BUCKET, storagePath, controller.signal);
    // Settled after the race is lost: never an unhandled rejection.
    download.catch(() => undefined);
    const aborted = new Promise<null>((resolve) => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
    try {
      return await Promise.race([download, aborted]);
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Inserts a reading and its `read` audit row together, once per file and
   * reader version: the file must still back a live record of a batch the
   * caller can read; a concurrent first view that already inserted it wins, and
   * its reading is the answer (no second row, no second audit).
   */
  private async storeReading(user: RequestUser, owner: ReadingOwner, evidenceId: string, reading: ReadingRow): Promise<ReadingRow | null> {
    // A record's file: the record still live, in the caller's scope and organisation at the insert (review of groups 10–11).
    const liveRecord: Prisma.ActivityRecordWhereInput[] = [
      recordScopeWhere(user),
      { status: { not: 'voided' } },
      user.organisationId ? { subsidiary: { organisationId: user.organisationId } } : { id: { in: [] } },
    ];
    const link: Prisma.ActivityRecordEvidenceWhereInput = 'fuelBatchId' in owner
      ? { activityRecord: { status: { not: 'voided' }, fuelBatch: { AND: [{ id: owner.fuelBatchId }, fuelBatchScopeWhere(user)] } } }
      : { activityRecordId: owner.activityRecordId, activityRecord: { AND: liveRecord } };
    return this.prisma.$transaction(async (tx) => {
      const evidence = await tx.evidence.findFirst({
        where: {
          id: evidenceId,
          links: { some: link },
        },
        select: { id: true, subsidiaryId: true },
      });
      if (!evidence) return null;
      const inserted = await tx.$queryRaw<Array<{ evidence_id: string }>>`
        INSERT INTO evidence_readings (evidence_id, subsidiary_id, reader_version, status, page_count, invoices)
        VALUES (${evidence.id}::uuid, ${evidence.subsidiaryId}::uuid, ${reading.readerVersion}, ${reading.status},
                ${reading.pageCount}, ${JSON.stringify(reading.invoices)}::jsonb)
        ON CONFLICT (evidence_id, reader_version) DO NOTHING
        RETURNING evidence_id::text`;
      if (inserted.length === 0) {
        const winner = await tx.evidenceReading.findUnique({ where: { evidenceId_readerVersion: { evidenceId, readerVersion: reading.readerVersion } } });
        return winner ? readingRow(winner.status as ReadingRow['status'], winner.pageCount, winner.invoices as unknown as ReadInvoice[]) : null;
      }
      await this.audit.record(user, { action: 'read', entity: 'evidence', entityId: evidenceId, diff: { reading: readingSummary(reading), ...owner } }, tx);
      return reading;
    });
  }

  /** Why no invoice of the package was found, from what its files' readings say. */
  private noMatchReason(files: PackageFile[]): EvidenceAssistantUnreadReason {
    const readings = files.map((f) => f.reading).filter((r): r is ReadingRow => r !== null);
    if (readings.length === 0) return 'no_text';
    const read = readings.filter((r) => r.status === 'read');
    if (read.length === 0) return readings[0]!.status as EvidenceAssistantUnreadReason;
    const invoices = read.flatMap((r) => r.invoices);
    if (invoices.length > 0 && invoices.every((inv) => !isInvoiceSeries(inv.series))) return 'unknown_series';
    return 'no_matching_invoice';
  }

  private invoiceDTO(invoice: ReadInvoice, file: PackageFile): EvidenceAssistantInvoiceDTO {
    return {
      invoiceNo: invoice.invoiceNo,
      series: invoice.series as EvidenceInvoiceSeries,
      periodText: invoice.periodText,
      periodFrom: invoice.periodFrom,
      periodTo: invoice.periodTo,
      buyerName: invoice.buyerName,
      buyerTaxId: invoice.buyerTaxId,
      file: { id: file.id, fileName: file.fileName, ...(file.source ? { source: file.source } : {}) },
      pageFrom: invoice.pageFrom,
      pageTo: invoice.pageTo,
    };
  }

  // ── Rows ───────────────────────────────────────────────────────────────────

  private identityOf(batch: { organisationId: string; source: string; invoiceRef: string; fuelAccountId: string }): InvoiceIdentity {
    return {
      organisationId: batch.organisationId,
      source: batch.source,
      invoiceRef: batch.invoiceRef,
      fuelAccountId: batch.source === 'shell' ? batch.fuelAccountId : null,
    };
  }

  /** The package's litres per fuel: its `assigned` rows, exact. */
  private async packageLitres(fuelBatchId: string): Promise<Litres> {
    const rows = await this.prisma.$queryRaw<Array<{ fuel: string; litres: string }>>`
      SELECT fuel, sum(litres)::text AS litres FROM fuel_rows
      WHERE fuel_batch_id = ${fuelBatchId}::uuid AND state = 'assigned' AND fuel IS NOT NULL
      GROUP BY fuel`;
    return toLitres(rows);
  }

  /**
   * An invoice number is matched without regard to case everywhere it keys
   * the invoice — routing a part, totalling the invoice, listing its batches
   * — so the three never disagree (review of PR B, P2).
   */
  private identityWhere(identity: InvoiceIdentity): Prisma.Sql {
    return identity.fuelAccountId
      ? Prisma.sql`fuel_account_id = ${identity.fuelAccountId}::uuid AND upper(invoice_ref) = upper(${identity.invoiceRef})`
      : Prisma.sql`organisation_id = ${identity.organisationId}::uuid AND source = ${identity.source} AND upper(invoice_ref) = upper(${identity.invoiceRef})`;
  }

  /**
   * The invoice's live rows (B10): sums per fuel, the number of accounts, and
   * how many lie outside `fuelBatchId` (another account's, an associate's
   * excluded rows, another batch of the account). This read crosses the
   * reader's scope by design (C4) and answers sums and a count only.
   */
  private async invoiceRows(identity: InvoiceIdentity, fuelBatchId: string | null): Promise<{ litres: Litres; accounts: number; outside: number }> {
    const states = [...FUEL_INVOICE_ROW_STATES];
    const [totals] = await this.prisma.$queryRaw<Array<{ accounts: number; outside: number }>>`
      SELECT count(DISTINCT fuel_account_id)::int AS accounts,
             count(*) FILTER (WHERE fuel_batch_id IS DISTINCT FROM ${fuelBatchId}::uuid)::int AS outside
      FROM fuel_rows WHERE ${this.identityWhere(identity)} AND state = ANY(${states}::text[])`;
    const rows = await this.prisma.$queryRaw<Array<{ fuel: string; litres: string }>>`
      SELECT fuel, sum(litres)::text AS litres FROM fuel_rows
      WHERE ${this.identityWhere(identity)} AND state = ANY(${states}::text[]) AND fuel IS NOT NULL
      GROUP BY fuel`;
    return { litres: toLitres(rows), accounts: totals?.accounts ?? 0, outside: totals?.outside ?? 0 };
  }

  /** The invoice's other batches the caller can read, not withdrawn (C4). */
  private async siblings(user: RequestUser, fuelBatchId: string, identity: InvoiceIdentity) {
    const batches = await this.prisma.fuelBatch.findMany({
      where: {
        AND: [
          fuelBatchScopeWhere(user),
          {
            id: { not: fuelBatchId },
            organisationId: identity.organisationId,
            source: identity.source,
            invoiceRef: { equals: identity.invoiceRef, mode: 'insensitive' },
            status: { not: 'withdrawn' },
            ...(identity.fuelAccountId ? { fuelAccountId: identity.fuelAccountId } : {}),
          },
        ],
      },
      include: { fuelAccount: { select: { name: true } }, subsidiary: { select: { legalName: true, tradingName: true } } },
      orderBy: [{ id: 'asc' }],
    });
    return batches.map((b) => ({ id: b.id, accountName: b.fuelAccount.name, subsidiaryName: b.subsidiary.tradingName || b.subsidiary.legalName, sequence: b.sequence }));
  }

  // ── Neighbours (period shift) ──────────────────────────────────────────────

  /**
   * The same account's previous and next invoice's difference per fuel (B8):
   * Shell by half-month, Petrol Ofisi by first transaction time. A neighbour
   * counts only when the caller can read one of its batches, it has a stored
   * reading by the current reader naming exactly one invoice of it, and the
   * order is unambiguous, and none of its PDFs is still unread. Its files are
   * never read here. Applied only to an invoice of one account.
   */
  private async neighbourDifferences(
    user: RequestUser,
    batch: { fuelAccountId: string; source: string; invoiceRef: string; organisationId: string },
    identity: InvoiceIdentity,
  ): Promise<Litres[]> {
    const refs = batch.source === 'shell'
      ? [neighbourShellRef(batch.invoiceRef, -1), neighbourShellRef(batch.invoiceRef, 1)].filter((r): r is string => r !== null)
      : await this.petrolOfisiNeighbours(batch.fuelAccountId, batch.invoiceRef);
    const out: Litres[] = [];
    for (const ref of refs) {
      const neighbour = await this.prisma.fuelBatch.findMany({
        where: { AND: [fuelBatchScopeWhere(user), { fuelAccountId: batch.fuelAccountId, invoiceRef: { equals: ref, mode: 'insensitive' }, status: { not: 'withdrawn' } }] },
        orderBy: { id: 'asc' },
      });
      if (neighbour.length === 0) continue;
      const invoices: ReadInvoice[] = [];
      let pending = false;
      for (const nb of neighbour) {
        for (const file of await this.packageFiles(nb.id)) {
          // A neighbour's PDF not yet read may hold a second invoice of its
          // key: no balance from it until it is (review of PR B, second round, P2).
          if (file.reading === null && file.mimeType === 'application/pdf') pending = true;
          invoices.push(...(file.reading?.invoices ?? []));
        }
      }
      if (pending) continue;
      const matches = packageInvoices({ source: batch.source, invoiceRef: ref }, invoices);
      if (matches.length !== 1 || matches[0]!.unreadReason) continue;
      const rows = await this.invoiceRows({ ...identity, invoiceRef: ref }, null);
      out.push(differences(matches[0]!.lines, rows.litres));
    }
    return out;
  }

  /** The account's invoices just before and after this one by their first transaction; none when tied. */
  private async petrolOfisiNeighbours(fuelAccountId: string, invoiceRef: string): Promise<string[]> {
    const states = [...FUEL_INVOICE_ROW_STATES];
    const invoices = await this.prisma.$queryRaw<Array<{ invoice_ref: string; first: Date | null }>>`
      SELECT upper(invoice_ref) AS invoice_ref, min(transaction_at) AS first FROM fuel_rows
      WHERE fuel_account_id = ${fuelAccountId}::uuid AND state = ANY(${states}::text[])
      GROUP BY upper(invoice_ref) ORDER BY min(transaction_at) ASC NULLS LAST, upper(invoice_ref) ASC`;
    const at = invoices.findIndex((i) => i.invoice_ref === invoiceRef.toUpperCase());
    const mine = invoices[at];
    // An order that a tie decides is no order (D6: skip ambiguous ordering).
    const tied = (first: Date) => invoices.filter((i) => i.first?.getTime() === first.getTime()).length > 1;
    if (at < 0 || !mine?.first || tied(mine.first)) return [];
    const out: string[] = [];
    for (const step of [-1, 1]) {
      const other = invoices[at + step];
      if (other?.first && !tied(other.first)) out.push(other.invoice_ref);
    }
    return out;
  }
}

function toLitres(rows: Array<{ fuel: string; litres: string }>): Litres {
  const out: Litres = {};
  for (const row of rows) if ((FILE_FUELS as readonly string[]).includes(row.fuel)) out[row.fuel as FileFuel] = row.litres;
  return out;
}
