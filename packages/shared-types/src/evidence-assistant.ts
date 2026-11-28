import type { FileFuel, FuelBatchDTO, ManualFuel } from './fuel';
import type { EvidenceDTO } from './index';

export const EVIDENCE_READING_STATUSES = [
  'read', 'no_text', 'encrypted', 'unreadable', 'limit_exceeded', 'timed_out',
] as const;
export type EvidenceReadingStatus = (typeof EVIDENCE_READING_STATUSES)[number];

/**
 * Why a comparison shows no invoice. `reader_busy` (another file is being read)
 * and `reader_unavailable` (the reader's isolation is not proven here, or it
 * failed) are never stored: a later request tries again. A `timed_out` is
 * stored only when the read ran with its whole time limit (owner, 2026-11-28).
 */
export const EVIDENCE_ASSISTANT_UNREAD_REASONS = [
  'no_evidence', 'no_text', 'encrypted', 'unreadable', 'unreadable_row',
  'limit_exceeded', 'timed_out', 'reader_busy', 'reader_unavailable', 'unknown_series',
  'no_matching_invoice', 'several_matching_invoices', 'tanker',
] as const;
export type EvidenceAssistantUnreadReason = (typeof EVIDENCE_ASSISTANT_UNREAD_REASONS)[number];

/** An unread invoice is reported once for the entire comparison. */
export const EVIDENCE_ASSISTANT_LINE_STATES = ['consistent', 'possible_difference'] as const;
export type EvidenceAssistantLineState = (typeof EVIDENCE_ASSISTANT_LINE_STATES)[number];

/**
 * The two invoice series the reader knows (C10): `OZK…` Petrol Ofisi card
 * invoices and `DAU…` Duman invoices for Shell — decision 5's "two known
 * layouts". The API's `invoice-layout.ts` reads by this list; anything else is
 * `unknown_series`.
 */
export const EVIDENCE_INVOICE_SERIES = ['OZK', 'DAU'] as const;
export type EvidenceInvoiceSeries = (typeof EVIDENCE_INVOICE_SERIES)[number];

export interface EvidenceAssistantInvoiceDTO {
  invoiceNo: string;
  series: EvidenceInvoiceSeries;
  periodText: string | null;
  /** ISO dates, set only when the invoice prints a date range. */
  periodFrom: string | null;
  periodTo: string | null;
  buyerName: string | null;
  buyerTaxId: string | null;
  file: Pick<EvidenceDTO, 'id' | 'fileName' | 'source'>;
  /** One-based, inclusive page numbers in the attached file. */
  pageFrom: number;
  pageTo: number;
}

/**
 * One fuel line of a comparison. A batch's lines are always a file fuel (diesel
 * or petrol, the default); a manual record's line carries the record's own fuel,
 * which may be on-road LPG in litres (C6).
 */
export interface EvidenceAssistantLineDTO<F extends ManualFuel = FileFuel> {
  fuel: F;
  /** Decimal strings keep the precision of the invoice and fuel rows. */
  invoiceLitres: string | null;
  packageLitres: string | null;
  state: EvidenceAssistantLineState;
  periodShift: boolean;
}

type EvidenceAssistantComparisonBase = {
  enabled: true;
  tolerancePercent: number;
  invoice: EvidenceAssistantInvoiceDTO;
  unread?: never;
  otherLines: { product: string; litres: string }[];
};

type EvidenceAssistantComparisonDTO = EvidenceAssistantComparisonBase & (
  | { level: 'package'; lines: EvidenceAssistantLineDTO[] }
  | {
      level: 'invoice';
      lines: (EvidenceAssistantLineDTO & {
        /**
         * The figure compared at invoice level (B10): the sum of every live row
         * of the invoice for this fuel, in all its packages, other accounts' and
         * associates' excluded rows included. Not the invoice's own figure
         * (`invoiceLitres`) and not this package's (`packageLitres`): a panel
         * labels it as the invoice's rows in all packages.
         */
        invoiceLevelLitres: string | null;
      })[];
      shared: {
        accounts: number;
        /** Only siblings the caller can read. */
        siblings: Pick<FuelBatchDTO, 'id' | 'accountName' | 'subsidiaryName' | 'sequence'>[];
      };
    }
);

type EvidenceAssistantOffOrUnread =
  | { enabled: false }
  | { enabled: true; tolerancePercent: number; unread: { reason: EvidenceAssistantUnreadReason }; invoice?: never };

/** `GET /fuel-batches/:id/evidence-assistant`: lines are file fuels only. */
export type EvidenceAssistantDTO = EvidenceAssistantOffOrUnread | EvidenceAssistantComparisonDTO;

/**
 * `GET /activity-records/:id/evidence-assistant` (C6): a manual record is a
 * package of one record compared on its own figure. The shared-invoice rules
 * read fuel rows and accounts, which a manual record has not, so its comparison
 * is package-level only.
 */
export type EvidenceAssistantRecordDTO =
  | EvidenceAssistantOffOrUnread
  | (EvidenceAssistantComparisonBase & { level: 'package'; lines: EvidenceAssistantLineDTO<ManualFuel>[] });

export const EVIDENCE_SPLIT_NOT_ATTACHED_REASONS = [
  'no_eligible_batch', 'manual_attachment_required', 'unverified_part', 'attachment_failed',
] as const;
export type EvidenceSplitNotAttachedReason = (typeof EVIDENCE_SPLIT_NOT_ATTACHED_REASONS)[number];

export interface EvidenceSplitDTO {
  /** Number of invoices in the original PDF. */
  invoices: number;
  attached: { invoiceNo: string; fuelBatchId: string }[];
  notAttached: { invoiceNo: string; reason: EvidenceSplitNotAttachedReason }[];
  /** Retryable failures for eligible, visible targets only. */
  failedTargets: { invoiceNo: string; fuelBatchId: string; reason: 'attachment_failed' }[];
}

export interface FuelBatchEvidenceUploadDTO extends EvidenceDTO {
  split?: EvidenceSplitDTO;
}
