import { describe, it, expect } from 'vitest';
import { BULK_SUBMIT_ISSUE_CODES, BULK_SUBMIT_MAX_IDS } from '@/lib/types';
import type {
  BulkSubmitIssue,
  BulkSubmitReportDTO,
  BulkUploadAcceptedRow,
} from '@/lib/types';
import { ApiError } from '@/lib/api';
import {
  draftsSubmitLabel,
  eligibleForSubmit,
  failuresToShow,
  isPeriodLockedFor,
  MAX_FAILURES_SHOWN,
  needsEvidenceBeforeSubmit,
  selectableDrafts,
  selectAllEligible,
  submitBlockReason,
  submitConfirmation,
  submitErrorMessage,
  SUBMIT_ISSUE_LABEL,
  summariseSubmit,
  toggleSelected,
} from '@/lib/bulk-submit-view';
import type { LockedPeriod, SubmittableRow } from '@/lib/bulk-submit-view';

function imported(over: Partial<BulkUploadAcceptedRow> = {}): BulkUploadAcceptedRow {
  return {
    row: 2,
    recordId: 'rec-1',
    subsidiaryId: 'sub-1',
    locationId: null,
    reportingYear: 2024,
    reportingPeriod: 'monthly',
    periodValue: 'January',
    category: 'Business Travel',
    tCo2e: 1.5,
    anomalous: false,
    ...over,
  };
}

function report(over: Partial<BulkSubmitReportDTO> = {}): BulkSubmitReportDTO {
  return { requested: 1, submitted: [], failed: [], ...over };
}

const moved = (recordId: string) =>
  ({ recordId }) as unknown as BulkSubmitReportDTO['submitted'][number];
const refused = (over: Partial<BulkSubmitIssue> = {}): BulkSubmitIssue => ({
  recordId: 'rec-1',
  code: 'not_submittable',
  message: 'nope',
  ...over,
});

describe('eligibleForSubmit', () => {
  it('offers the rows that can actually move', () => {
    const { recordIds, blockedReason } = eligibleForSubmit([
      imported({ recordId: 'a' }),
      imported({ recordId: 'b' }),
    ]);
    expect(recordIds).toEqual(['a', 'b']);
    expect(blockedReason).toBeNull();
  });

  it('holds back a category that needs an evidence file', () => {
    // The server would refuse every one of them, and the import already warned
    // on these rows — sending them to be told again teaches nothing.
    const { recordIds, needingEvidence } = eligibleForSubmit([
      imported({ recordId: 'a', category: 'Electricity' }),
      imported({ recordId: 'b', category: 'Business Travel' }),
    ]);
    expect(recordIds).toEqual(['b']);
    expect(needingEvidence).toBe(1);
  });

  it('explains an all-evidence import rather than offering a dead button', () => {
    // This is the SEEDED case, and it is the whole feature on demo data: the
    // factor library covers only Electricity, Natural Gas and Fuel, and all
    // three require evidence — so everything importable is un-submittable in
    // bulk. The copy has to name that, not present it as a failure.
    const { recordIds, blockedReason } = eligibleForSubmit([
      imported({ recordId: 'a', category: 'Electricity' }),
      imported({ recordId: 'b', category: 'Natural Gas' }),
    ]);
    expect(recordIds).toEqual([]);
    expect(blockedReason).toMatch(/evidence file/i);
    expect(blockedReason).toMatch(/cannot attach/i);
    expect(blockedReason).toContain('2');
  });

  it('says nothing at all when there was no import to speak of', () => {
    expect(eligibleForSubmit([]).blockedReason).toBeNull();
  });

  it('drops rows with no id — a dry run has none by contract', () => {
    expect(
      eligibleForSubmit([imported({ recordId: null })]).recordIds,
    ).toEqual([]);
  });

  it('never offers more ids than the endpoint accepts, and says how many it held back', () => {
    // From the FRONT, and counted: a tail slice survived every assertion that
    // checked only the length, and a silent overflow would show "Send 1,000
    // records for review" after a 1,010-row import.
    const rows = Array.from({ length: BULK_SUBMIT_MAX_IDS + 10 }, (_, i) =>
      imported({ recordId: `rec-${i}` }),
    );
    const { recordIds, overCap } = eligibleForSubmit(rows);
    expect(recordIds).toHaveLength(BULK_SUBMIT_MAX_IDS);
    expect(recordIds[0]).toBe('rec-0');
    expect(overCap).toBe(10);
  });

  it('holds nothing back when everything fits', () => {
    expect(eligibleForSubmit([imported({ recordId: 'a' })]).overCap).toBe(0);
  });

  it('pins the cap to a literal', () => {
    expect(BULK_SUBMIT_MAX_IDS).toBe(1000);
  });
});

describe('SUBMIT_ISSUE_LABEL', () => {
  it('names every code the server can emit', () => {
    expect(Object.keys(SUBMIT_ISSUE_LABEL).sort()).toEqual(
      [...BULK_SUBMIT_ISSUE_CODES].sort(),
    );
  });

  it('gives every entry a real, distinct label', () => {
    const values = Object.values(SUBMIT_ISSUE_LABEL);
    expect(values.every((v) => v.trim().length > 0)).toBe(true);
    expect(new Set(values).size).toBe(BULK_SUBMIT_ISSUE_CODES.length);
  });

  it('names each refusal for the thing that caused it', () => {
    // Non-empty and distinct is only half the precedent, and I shipped half:
    // ROTATING all seven values by one position is still non-empty and still
    // distinct, and it survived. A user whose records were refused for a
    // closed period would read "Someone else's record" and go looking for a
    // colleague who does not exist.
    expect(SUBMIT_ISSUE_LABEL.period_locked).toMatch(/period/i);
    expect(SUBMIT_ISSUE_LABEL.evidence_required).toMatch(/evidence/i);
    expect(SUBMIT_ISSUE_LABEL.variance_reason_required).toMatch(/variance/i);
    expect(SUBMIT_ISSUE_LABEL.not_author).toMatch(/someone else/i);
    expect(SUBMIT_ISSUE_LABEL.not_found).toMatch(/available/i);
    expect(SUBMIT_ISSUE_LABEL.not_submittable).toMatch(/moved on/i);
    expect(SUBMIT_ISSUE_LABEL.unexpected).toMatch(/could not/i);
  });
});

describe('submitConfirmation', () => {
  it('says the thing there is no undo for', () => {
    // There is no author-side unsubmit anywhere in the API — only a reviewer
    // can send a record back. That is the fact a confirm dialog exists to put
    // in front of someone about to move four hundred records.
    const text = submitConfirmation(['a', 'b']);
    expect(text).toContain('2 records');
    expect(text).toMatch(/only a reviewer/i);
    expect(text).toMatch(/un-submit/i);
  });

  it('uses the singular for one', () => {
    expect(submitConfirmation(['a'])).toContain('1 record ');
  });
});

describe('summariseSubmit', () => {
  it('reports a clean run in the reader’s terms', () => {
    const s = summariseSubmit(report({ requested: 2, submitted: [moved('a'), moved('b')] }));
    expect(s.tone).toBe('clean');
    expect(s.headline).toMatch(/review queue/i);
    expect(s.detail).toBeNull();
  });

  it('says how many did not move after a partial run', () => {
    const s = summariseSubmit(
      report({ requested: 3, submitted: [moved('a')], failed: [refused(), refused()] }),
    );
    expect(s.tone).toBe('partial');
    expect(s.headline).toBe('1 of 3 submitted.');
    expect(s.detail).toMatch(/2 records were not/i);
  });

  it('does not claim the refused records are still drafts', () => {
    // It used to. That was false for three of the six codes, and the fixture
    // pinning it defaulted to `not_submittable` — the exact code for which a
    // record's status is by definition NOT draft.
    const s = summariseSubmit(
      report({
        requested: 3,
        submitted: [moved('a')],
        failed: [refused({ code: 'not_submittable' }), refused({ code: 'not_found' })],
      }),
    );
    expect(s.detail).not.toMatch(/draft/i);
  });

  it('uses the singular for one straggler', () => {
    const s = summariseSubmit(
      report({ requested: 2, submitted: [moved('a')], failed: [refused()] }),
    );
    expect(s.detail).toMatch(/1 record was not/i);
  });

  it('says plainly when nothing moved', () => {
    const s = summariseSubmit(report({ requested: 1, failed: [refused()] }));
    expect(s.tone).toBe('refused');
    expect(s.headline).toMatch(/No records were submitted/);
    expect(s.detail).toMatch(/All 1 need attention/);
  });
});

describe('submitErrorMessage', () => {
  it('explains the throttle', () => {
    expect(submitErrorMessage(new ApiError('Too Many Requests', 429))).toMatch(
      /wait a minute/i,
    );
  });

  it('explains a role refusal', () => {
    expect(submitErrorMessage(new ApiError('Forbidden', 403))).toMatch(
      /cannot submit/i,
    );
  });

  it('keeps the server’s own sentence otherwise', () => {
    expect(submitErrorMessage(new ApiError('recordIds must contain record ids', 400))).toBe(
      'recordIds must contain record ids',
    );
  });

  it('survives something that is not an ApiError', () => {
    expect(submitErrorMessage(new Error('offline'))).toBe('offline');
    expect(submitErrorMessage(null)).toMatch(/failed/i);
  });
});

describe('failuresToShow', () => {
  it('shows everything when there is little to show', () => {
    const { shown, remainder } = failuresToShow([refused(), refused()]);
    expect(shown).toHaveLength(2);
    expect(remainder).toBe(0);
  });

  it('counts what it folds away', () => {
    // The list truncated at fifty with NO remainder, under a verdict reading
    // "900 records were not — see below". The screen contradicted itself and
    // 850 records vanished from the user's work list.
    const failed = Array.from({ length: 900 }, (_, i) =>
      refused({ recordId: `rec-${i}` }),
    );
    const { shown, remainder } = failuresToShow(failed);
    expect(shown).toHaveLength(MAX_FAILURES_SHOWN);
    expect(shown[0].recordId).toBe('rec-0');
    expect(remainder).toBe(850);
  });

  it('pins the cap to a literal', () => {
    expect(MAX_FAILURES_SHOWN).toBe(50);
  });
});

describe('submitConfirmation — the zero case', () => {
  it('does not claim a record when there are none', () => {
    // The dialog is always mounted, so this is evaluated on every render.
    expect(submitConfirmation([])).toContain('0 records');
  });
});

// ---------------------------------------------------------------------------
// Drafts that did not come from an import (PR 2c)
// ---------------------------------------------------------------------------

const ME = { id: 'user-me', role: 'data_entry' };

function draft(over: Partial<SubmittableRow> = {}): SubmittableRow {
  return {
    id: 'rec-1',
    status: 'draft',
    // A category that needs NO evidence, so each test below turns on the one
    // thing it is about. `Electricity` appears only where evidence is the point.
    category: 'Business Travel',
    evidenceCount: 0,
    createdBy: ME.id,
    reportingYear: 2026,
    reportingPeriod: 'quarterly',
    periodValue: 'Q1',
    ...over,
  };
}

const lock = (over: Partial<LockedPeriod> = {}): LockedPeriod => ({
  reportingYear: 2026,
  reportingPeriod: 'quarterly',
  periodValue: 'Q1',
  ...over,
});

describe('needsEvidenceBeforeSubmit', () => {
  it('is category AND file count, not category alone', () => {
    // The bug this function exists to prevent: a draft whose invoice is already
    // attached, refused forever because of what category it is in.
    expect(
      needsEvidenceBeforeSubmit({ category: 'Electricity', evidenceCount: 1 }),
    ).toBe(false);
    expect(
      needsEvidenceBeforeSubmit({ category: 'Electricity', evidenceCount: 0 }),
    ).toBe(true);
  });

  it('leaves a category that never needed a file alone', () => {
    expect(
      needsEvidenceBeforeSubmit({ category: 'Business Travel', evidenceCount: 0 }),
    ).toBe(false);
  });

  it('is the same rule the import surface applies', () => {
    // Not a tautology: `eligibleForSubmit` passes `evidenceCount: 0` because an
    // import cannot attach a file. If that literal is ever changed to read a
    // field off the imported row — which carries none — this goes red rather
    // than silently offering every evidence-required row.
    const { recordIds, needingEvidence } = eligibleForSubmit([
      imported({ recordId: 'a', category: 'Electricity' }),
      imported({ recordId: 'b', category: 'Business Travel' }),
    ]);
    expect(recordIds).toEqual(['b']);
    expect(needingEvidence).toBe(1);
  });
});

describe('isPeriodLockedFor', () => {
  it('matches on the whole tuple, not on the period value alone', () => {
    const row = draft();
    expect(isPeriodLockedFor(row, [lock()])).toBe(true);
    expect(isPeriodLockedFor(row, [lock({ reportingYear: 2025 })])).toBe(false);
    expect(isPeriodLockedFor(row, [lock({ reportingPeriod: 'monthly' })])).toBe(false);
    expect(isPeriodLockedFor(row, [lock({ periodValue: 'Q2' })])).toBe(false);
    expect(isPeriodLockedFor(row, [])).toBe(false);
  });
});

describe('submitBlockReason', () => {
  it('offers a checkbox when every gate passes', () => {
    expect(submitBlockReason(draft(), ME, [])).toBeNull();
  });

  it('refuses a REJECTED record, and says why rather than echoing the status', () => {
    // The trap: `isSubmittable` admits `rejected` and the list's own hover
    // affordance treats it as editable, so reaching for the wrong predicate
    // offers a checkbox the server answers with `not_submittable`. If this ever
    // returns null, the contract has been widened by accident.
    const reason = submitBlockReason(draft({ status: 'rejected' }), ME, []);
    expect(reason).toMatch(/open it on its own/i);
    expect(reason).not.toMatch(/Already rejected/);
  });

  it('echoes the status for a record that has already moved on', () => {
    expect(submitBlockReason(draft({ status: 'submitted' }), ME, [])).toBe(
      'Already submitted.',
    );
    expect(submitBlockReason(draft({ status: 'under_review' }), ME, [])).toBe(
      'Already under review.',
    );
  });

  it("refuses someone else's record, and lets a super_admin through", () => {
    const theirs = draft({ createdBy: 'user-them' });
    expect(submitBlockReason(theirs, ME, [])).toBe('Entered by someone else.');
    expect(submitBlockReason(theirs, { ...ME, role: 'super_admin' }, [])).toBeNull();
  });

  it('refuses a closed period, naming it', () => {
    expect(submitBlockReason(draft(), ME, [lock()])).toBe('Q1 2026 is locked.');
  });

  it('refuses an evidence-required record with no file, and allows one with a file', () => {
    const needs = draft({ category: 'Electricity' });
    expect(submitBlockReason(needs, ME, [])).toBe('Needs an evidence file.');
    expect(submitBlockReason({ ...needs, evidenceCount: 1 }, ME, [])).toBeNull();
  });

  it('checks status before authorship, the way the server does', () => {
    // Both wrong at once. The server answers `not_submittable` here, so that is
    // the sentence the user must see — otherwise the screen blames the wrong
    // thing and the user goes looking for a colleague who cannot help.
    const row = draft({ status: 'approved', createdBy: 'user-them' });
    expect(submitBlockReason(row, ME, [])).toBe('Already approved.');
  });

  it('offers nothing at all while the user is unknown', () => {
    // `api.me()` is in flight on first paint. Offering a checkbox and then
    // retracting it is worse than waiting.
    expect(submitBlockReason(draft(), null, [])).not.toBeNull();
  });

  it('never lets an anomaly flag decide anything', () => {
    // Deliberate: the stored verdict is from write time, `submit` recomputes it,
    // and a batch shifts its own baseline. A client gate here would hide
    // submittable records AND still let the refusal through.
    const row = { ...draft(), anomalyFlag: true } as unknown as SubmittableRow;
    expect(submitBlockReason(row, ME, [])).toBeNull();
  });
});

describe('selectableDrafts', () => {
  it('splits the list, and explains only the rows that looked selectable', () => {
    const { selectableIds, reasonById } = selectableDrafts(
      [
        draft({ id: 'ok' }),
        draft({ id: 'theirs', createdBy: 'user-them' }),
        draft({ id: 'rejected', status: 'rejected' }),
        draft({ id: 'approved', status: 'approved' }),
        draft({ id: 'needs-file', category: 'Electricity' }),
      ],
      ME,
      [],
    );

    expect(selectableIds).toEqual(['ok']);
    // The approved row is absent: its badge already says so, and a reason on
    // every row of a long list is noise. The two editable-looking ones are
    // present, because a missing checkbox there reads as a bug.
    expect(Object.keys(reasonById).sort()).toEqual(
      ['needs-file', 'rejected', 'theirs'].sort(),
    );
  });

  it('selects nothing while the user is unknown', () => {
    expect(selectableDrafts([draft()], null, [])).toEqual({
      selectableIds: [],
      reasonById: {},
    });
  });

  it('keeps the order it was given', () => {
    const { selectableIds } = selectableDrafts(
      [draft({ id: 'c' }), draft({ id: 'a' }), draft({ id: 'b' })],
      ME,
      [],
    );
    expect(selectableIds).toEqual(['c', 'a', 'b']);
  });
});

describe('toggleSelected', () => {
  it('ticks and unticks', () => {
    expect(toggleSelected([], 'a')).toEqual({ selected: ['a'], refusedByCap: false });
    expect(toggleSelected(['a', 'b'], 'a')).toEqual({
      selected: ['b'],
      refusedByCap: false,
    });
  });

  it('refuses to grow past the cap, and says so', () => {
    const full = Array.from({ length: BULK_SUBMIT_MAX_IDS }, (_, i) => `r${i}`);
    const { selected, refusedByCap } = toggleSelected(full, 'one-too-many');
    expect(refusedByCap).toBe(true);
    expect(selected).toHaveLength(BULK_SUBMIT_MAX_IDS);
    // Unticking still works at the cap — otherwise the only way out is a reload.
    expect(toggleSelected(full, 'r0').refusedByCap).toBe(false);
  });
});

describe('selectAllEligible', () => {
  it('takes the first page and reports the leftover', () => {
    const many = Array.from({ length: BULK_SUBMIT_MAX_IDS + 7 }, (_, i) => `r${i}`);
    const { selected, overCap } = selectAllEligible(many);
    expect(selected).toHaveLength(BULK_SUBMIT_MAX_IDS);
    expect(selected[0]).toBe('r0');
    expect(overCap).toBe(7);
  });

  it('reports no leftover when everything fits', () => {
    expect(selectAllEligible(['a', 'b'])).toEqual({
      selected: ['a', 'b'],
      overCap: 0,
    });
  });
});

describe('draftsSubmitLabel', () => {
  it('agrees with itself about the number', () => {
    expect(draftsSubmitLabel(1)).toBe('Send 1 record for review');
    expect(draftsSubmitLabel(3)).toBe('Send 3 records for review');
    expect(draftsSubmitLabel(1200)).toBe('Send 1,200 records for review');
  });
});
