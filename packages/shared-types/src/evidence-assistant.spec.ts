import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_ASSISTANT_LINE_STATES,
  EVIDENCE_ASSISTANT_UNREAD_REASONS,
  EVIDENCE_READING_STATUSES,
  EVIDENCE_SPLIT_NOT_ATTACHED_REASONS,
} from './index';
import type { EvidenceAssistantDTO, EvidenceAssistantRecordDTO } from './index';

describe('evidence assistant contract', () => {
  it('pins stored reading statuses', () => {
    expect(EVIDENCE_READING_STATUSES).toEqual([
      'read', 'no_text', 'encrypted', 'unreadable', 'limit_exceeded', 'timed_out',
    ]);
  });

  it('pins comparison states and reasons for an unread invoice', () => {
    expect(EVIDENCE_ASSISTANT_LINE_STATES).toEqual(['consistent', 'possible_difference']);
    expect(EVIDENCE_ASSISTANT_UNREAD_REASONS).toEqual([
      'no_evidence', 'no_text', 'encrypted', 'unreadable', 'unreadable_row',
      'limit_exceeded', 'timed_out', 'reader_busy', 'unknown_series',
      'no_matching_invoice', 'several_matching_invoices', 'tanker',
    ]);
  });

  it('pins split refusal reasons', () => {
    expect(EVIDENCE_SPLIT_NOT_ATTACHED_REASONS).toEqual([
      'no_eligible_batch', 'manual_attachment_required', 'unverified_part', 'attachment_failed',
    ]);
  });

  it('keeps batch lines to file fuels and lets a manual record carry LPG (typed)', () => {
    const invoice = {
      invoiceNo: 'OZK0000000000001', series: 'OZK' as const, periodText: null, periodFrom: null, periodTo: null,
      buyerName: null, buyerTaxId: null, file: { id: 'f', fileName: 'x.pdf' }, pageFrom: 1, pageTo: 1,
    };
    const line = { invoiceLitres: '300', packageLitres: '300', state: 'consistent' as const, periodShift: false };
    const record: EvidenceAssistantRecordDTO = {
      enabled: true, tolerancePercent: 1, invoice, otherLines: [], level: 'package',
      lines: [{ ...line, fuel: 'lpg' }],
    };
    const batch: EvidenceAssistantDTO = {
      enabled: true, tolerancePercent: 1, invoice, otherLines: [], level: 'invoice',
      // @ts-expect-error a batch's line is a file fuel; LPG and marine gas oil are refused
      lines: [{ ...line, fuel: 'marine_gas_oil', invoiceLevelLitres: '300' }],
      shared: { accounts: 1, siblings: [] },
    };
    // @ts-expect-error the record route has no invoice-level comparison
    const recordShared: EvidenceAssistantRecordDTO = { ...batch };
    expect([record.enabled, batch.enabled, recordShared.enabled]).toEqual([true, true, true]);
  });
});
