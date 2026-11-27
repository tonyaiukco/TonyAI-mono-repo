import type { FileFuel, FuelBatchDTO } from './fuel';
import type { EvidenceDTO } from './index';

export const EVIDENCE_READING_STATUSES = [
  'read', 'no_text', 'encrypted', 'unreadable', 'limit_exceeded', 'timed_out',
] as const;
export type EvidenceReadingStatus = (typeof EVIDENCE_READING_STATUSES)[number];

export const EVIDENCE_ASSISTANT_UNREAD_REASONS = [
  'no_evidence', 'no_text', 'encrypted', 'unreadable', 'unreadable_row',
  'limit_exceeded', 'timed_out', 'reader_busy', 'unknown_series',
  'no_matching_invoice', 'several_matching_invoices', 'tanker',
] as const;
export type EvidenceAssistantUnreadReason = (typeof EVIDENCE_ASSISTANT_UNREAD_REASONS)[number];

/** An unread invoice is reported once for the entire comparison. */
export const EVIDENCE_ASSISTANT_LINE_STATES = ['consistent', 'possible_difference'] as const;
export type EvidenceAssistantLineState = (typeof EVIDENCE_ASSISTANT_LINE_STATES)[number];

export interface EvidenceAssistantInvoiceDTO {
  invoiceNo: string;
  series: 'OZK' | 'DAU';
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

export interface EvidenceAssistantLineDTO {
  fuel: FileFuel;
  /** Decimal strings keep the precision of the invoice and fuel rows. */
  invoiceLitres: string | null;
  packageLitres: string | null;
  state: EvidenceAssistantLineState;
  periodShift: boolean;
}

type EvidenceAssistantComparisonDTO = {
  enabled: true;
  tolerancePercent: number;
  invoice: EvidenceAssistantInvoiceDTO;
  unread?: never;
  otherLines: { product: string; litres: string }[];
} & (
  | { level: 'package'; lines: EvidenceAssistantLineDTO[] }
  | {
      level: 'invoice';
      lines: (EvidenceAssistantLineDTO & { invoiceLevelLitres: string | null })[];
      shared: {
        accounts: number;
        /** Only siblings the caller can read. */
        siblings: Pick<FuelBatchDTO, 'id' | 'accountName' | 'subsidiaryName' | 'sequence'>[];
      };
    }
);

export type EvidenceAssistantDTO =
  | { enabled: false }
  | { enabled: true; tolerancePercent: number; unread: { reason: EvidenceAssistantUnreadReason }; invoice?: never }
  | EvidenceAssistantComparisonDTO;

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
