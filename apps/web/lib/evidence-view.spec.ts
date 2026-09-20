import { describe, expect, it } from 'vitest';
import {
  attachableRecords,
  attachBlockReason,
  attachButtonLabel,
  attachConfirmation,
  attachErrorMessage,
  attachSuccessMessage,
  detachSuccessMessage,
  recordLabel,
  removeFileLabel,
  sharedWithNote,
  toggleAttach,
} from './evidence-view';
import { selectableDrafts, type LockedPeriod, type SubmittableRow, type SubmittingUser } from './bulk-submit-view';
import { ApiError, SESSION_EXPIRED_MESSAGE } from './api';
import { EVIDENCE_MAX_LINKED_RECORDS, type EvidenceLinkedRecordDTO } from './types';

const ME: SubmittingUser = { id: 'user-me', role: 'data_entry' };
const ADMIN: SubmittingUser = { id: 'user-admin', role: 'super_admin' };

function draft(over: Partial<SubmittableRow> = {}): SubmittableRow {
  return {
    id: 'rec-1',
    subsidiaryId: 'sub-1',
    status: 'draft',
    category: 'Electricity',
    evidenceCount: 0,
    createdBy: ME.id,
    reportingYear: 2026,
    reportingPeriod: 'quarterly',
    periodValue: 'Q1',
    ...over,
  };
}

const lock = (over: Partial<LockedPeriod> = {}): LockedPeriod => ({
  subsidiaryId: 'sub-1',
  reportingYear: 2026,
  reportingPeriod: 'quarterly',
  periodValue: 'Q1',
  ...over,
});

function linked(over: Partial<EvidenceLinkedRecordDTO> = {}): EvidenceLinkedRecordDTO {
  return {
    id: 'rec-1',
    category: 'Electricity',
    reportingYear: 2026,
    periodValue: 'January',
    locationName: null,
    status: 'draft',
    ...over,
  };
}

describe('attachBlockReason — the upload’s refusals, in the evidence API’s order', () => {
  it('lets an own draft or rejected record in an open period take a file', () => {
    expect(attachBlockReason(draft(), ME, [])).toBeNull();
    expect(attachBlockReason(draft({ status: 'rejected' }), ME, [])).toBeNull();
  });

  it('refuses a review-only role before anything else', () => {
    expect(attachBlockReason(draft(), { id: ME.id, role: 'consultant' }, [])).toBe(
      'Your role cannot attach evidence.',
    );
  });

  it('refuses a record that can no longer change', () => {
    expect(attachBlockReason(draft({ status: 'submitted' }), ME, [])).toBe('Already submitted.');
    expect(attachBlockReason(draft({ status: 'under_review' }), ME, [])).toBe('Already under review.');
  });

  it('refuses a colleague’s record, except for a super_admin', () => {
    const theirs = draft({ createdBy: 'user-them' });
    expect(attachBlockReason(theirs, ME, [])).toBe('Entered by someone else.');
    expect(attachBlockReason(theirs, ADMIN, [])).toBeNull();
    // Authorship before status, as the API checks it.
    expect(attachBlockReason({ ...theirs, status: 'submitted' }, ME, [])).toBe('Entered by someone else.');
  });

  it('refuses a record in a locked period — its own period only', () => {
    expect(attachBlockReason(draft(), ME, [lock()])).toBe('Q1 2026 is locked.');
    expect(attachBlockReason(draft(), ME, [lock({ periodValue: 'Q2' })])).toBeNull();
    expect(attachBlockReason(draft(), ME, [lock({ subsidiaryId: 'sub-2' })])).toBeNull();
  });
});

describe('attachableRecords', () => {
  it('offers exactly the drafts the submit selection leaves out for want of a file', () => {
    // The reason this selection exists at all: an evidence-required draft
    // with no file has no submit checkbox, and it is the one that needs this.
    const waiting = draft({ id: 'rec-waiting', category: 'Electricity', evidenceCount: 0 });
    expect(selectableDrafts([waiting], ME, []).selectableIds).toEqual([]);
    expect(attachableRecords([waiting], ME, []).attachableIds).toEqual(['rec-waiting']);
  });

  it('explains only rows that look editable, and offers nothing without a user', () => {
    const rows = [
      draft({ id: 'a' }),
      draft({ id: 'b', createdBy: 'user-them' }),
      draft({ id: 'c', status: 'approved' }),
    ];
    expect(attachableRecords(rows, ME, [])).toEqual({
      attachableIds: ['a'],
      reasonById: { b: 'Entered by someone else.' },
    });
    expect(attachableRecords(rows, null, [])).toEqual({ attachableIds: [], reasonById: {} });
  });
});

describe('toggleAttach', () => {
  it('ticks and unticks', () => {
    expect(toggleAttach([], 'a')).toEqual({ selected: ['a'], refusedByCap: false });
    expect(toggleAttach(['a', 'b'], 'a')).toEqual({ selected: ['b'], refusedByCap: false });
  });

  it('refuses to grow past what one upload may carry, but still unticks at the cap', () => {
    const full = Array.from({ length: EVIDENCE_MAX_LINKED_RECORDS }, (_, i) => `r${i}`);
    expect(toggleAttach(full, 'one-more')).toEqual({ selected: full, refusedByCap: true });
    expect(toggleAttach(full, 'r0').selected).toHaveLength(EVIDENCE_MAX_LINKED_RECORDS - 1);
  });
});

describe('the words around one file for several records', () => {
  it('names a record the way the list does, with its site when it has one', () => {
    expect(recordLabel(linked())).toBe('Electricity · January 2026');
    expect(recordLabel(linked({ locationName: 'Izmir Plant' }))).toBe(
      'Electricity · January 2026 · Izmir Plant',
    );
  });

  it('labels the button by count', () => {
    expect(attachButtonLabel(0)).toBe('Attach one file');
    expect(attachButtonLabel(1)).toBe('Attach one file to 1 record');
    expect(attachButtonLabel(1200)).toBe('Attach one file to 1,200 records');
  });

  it('confirms by naming every record, and says the reviewer will see them', () => {
    const rows = [
      { category: 'Electricity' as const, periodValue: 'January', reportingYear: 2026, locationName: null },
      { category: 'Electricity' as const, periodValue: 'February', reportingYear: 2026, locationName: 'Izmir Plant' },
    ];
    expect(attachConfirmation('q1.pdf', rows)).toEqual({
      lead: '“q1.pdf” will be attached, as one file, to these 2 records. Reviewers see every record it backs.',
      records: ['Electricity · January 2026', 'Electricity · February 2026 · Izmir Plant'],
    });
    expect(attachConfirmation('jan.pdf', rows.slice(0, 1)).lead).toBe(
      '“jan.pdf” will be attached to this record:',
    );
  });

  it('names EVERY record in the confirmation, however many', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      category: 'Electricity' as const,
      periodValue: `M${i + 1}`,
      reportingYear: 2026,
      locationName: null,
    }));
    expect(attachConfirmation('year.pdf', many).records).toHaveLength(7);
  });

  it('reports the outcome by how many records the file now backs', () => {
    expect(attachSuccessMessage({ fileName: 'q1.pdf', linkedRecords: [linked(), linked({ id: 'r2' })] })).toBe(
      'q1.pdf now backs 2 records.',
    );
  });

  it('passes the server’s refusal through, and names an expired session', () => {
    expect(attachErrorMessage(new ApiError('1 of the 2 records cannot take this file…', 400))).toBe(
      '1 of the 2 records cannot take this file…',
    );
    expect(attachErrorMessage(new ApiError('Unauthorized', 401))).toBe(SESSION_EXPIRED_MESSAGE);
    expect(attachErrorMessage('boom')).toBe('The file could not be attached.');
  });
});

describe('a file shared with other records, where it is shown', () => {
  it('says nothing for a file that backs this record alone', () => {
    expect(sharedWithNote({ linkedRecords: [linked()] }, 'rec-1')).toBeNull();
    expect(removeFileLabel({ linkedRecords: [linked()] })).toBe('Remove');
  });

  it('names the OTHER records, three at most, and counts the rest', () => {
    const file = {
      linkedRecords: [
        linked({ id: 'rec-1' }),
        linked({ id: 'rec-2', periodValue: 'February' }),
        linked({ id: 'rec-3', periodValue: 'March' }),
        linked({ id: 'rec-4', periodValue: 'April' }),
        linked({ id: 'rec-5', periodValue: 'May' }),
      ],
    };
    expect(sharedWithNote(file, 'rec-1')).toBe(
      'Also backs 4 other records: Electricity · February 2026; Electricity · March 2026; Electricity · April 2026; +1 more',
    );
    expect(sharedWithNote({ linkedRecords: file.linkedRecords.slice(0, 2) }, 'rec-2')).toBe(
      'Also backs 1 other record: Electricity · January 2026',
    );
    // Taking a shared file off one record is not deleting it.
    expect(removeFileLabel(file)).toBe('Remove from this record');
  });

  it('after a remove, says whether the file is gone or still backs others', () => {
    const file = { fileName: 'q1.pdf', linkedRecords: [linked(), linked({ id: 'r2' }), linked({ id: 'r3' })] };
    expect(detachSuccessMessage({ fileDeleted: false }, file)).toBe(
      'Removed from this record — q1.pdf still backs 2 other records.',
    );
    expect(detachSuccessMessage({ fileDeleted: true }, { ...file, linkedRecords: [linked()] })).toBe(
      'Evidence removed',
    );
  });
});
