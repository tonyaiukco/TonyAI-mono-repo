import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_ASSISTANT_LINE_STATES,
  EVIDENCE_ASSISTANT_UNREAD_REASONS,
  EVIDENCE_READING_STATUSES,
  EVIDENCE_SPLIT_NOT_ATTACHED_REASONS,
} from './index';

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
});
