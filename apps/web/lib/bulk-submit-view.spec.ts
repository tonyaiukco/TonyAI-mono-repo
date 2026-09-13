import { describe, it, expect } from 'vitest';
import { BULK_SUBMIT_ISSUE_CODES, BULK_SUBMIT_MAX_IDS } from '@/lib/types';
import type {
  BulkSubmitIssue,
  BulkSubmitReportDTO,
  BulkUploadAcceptedRow,
} from '@/lib/types';
import { ApiError } from '@/lib/api';
import {
  allEligibleSelected,
  authoredBy,
  capRefusedNotice,
  draftsSubmitLabel,
  liveSelection,
  eligibleForSubmit,
  failuresToShow,
  isPeriodLockedFor,
  MAX_FAILURES_SHOWN,
  needsEvidenceBeforeSubmit,
  othersWarning,
  selectableDrafts,
  selectAllEligible,
  selectAllNotices,
  selectedFromOthers,
  submitBlockReason,
  submitConfirmation,
  submitErrorMessage,
  SUBMIT_ISSUE_LABEL,
  summariseSubmit,
  toggleSelected,
} from '@/lib/bulk-submit-view';
import type {
  LockedPeriod,
  SubmittableRow,
  SubmittingUser,
} from '@/lib/bulk-submit-view';

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
    expect(blockedReason).toBe(
      'All 2 imported records need an evidence file before they can be submitted, and an import cannot attach one. Open each record below to add its invoice.',
    );
  });

  it('uses the singular for one imported record', () => {
    // It read "All 1 imported record needs an evidence file … Open each record
    // below to add its invoice." — pinned verbatim by the E2E suite.
    const { blockedReason } = eligibleForSubmit([
      imported({ recordId: 'a', category: 'Water' }),
    ]);
    expect(blockedReason).toBe(
      'The imported record needs an evidence file before it can be submitted, and an import cannot attach one. Open it below to add its invoice.',
    );
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
    expect(text).toMatch(/only a reviewer can send them back/i);
    expect(text).toMatch(/un-submit them yourself/i);
  });

  it('uses the singular for one — including the pronoun', () => {
    // "Send 1 record for review. Only a reviewer can send them back" read as
    // though more than one record were leaving.
    const text = submitConfirmation(['a']);
    expect(text).toContain('1 record ');
    expect(text).toContain('Only a reviewer can send it back');
    expect(text).toContain('un-submit it yourself');
    expect(text).not.toMatch(/\bthem\b/);
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
    const s = summariseSubmit(report({ requested: 2, failed: [refused(), refused()] }));
    expect(s.tone).toBe('refused');
    expect(s.headline).toMatch(/No records were submitted/);
    expect(s.detail).toBe('All 2 need attention first — see below.');
  });

  it('does not say "All 1" when the only record was refused', () => {
    // Measured: "No records were submitted. All 1 need attention first".
    const s = summariseSubmit(report({ requested: 1, failed: [refused()] }));
    expect(s.detail).toBe('It needs attention first — see below.');
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

const ME: SubmittingUser = { id: 'user-me', role: 'data_entry' };

function draft(over: Partial<SubmittableRow> = {}): SubmittableRow {
  return {
    id: 'rec-1',
    subsidiaryId: 'sub-1',
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
  subsidiaryId: 'sub-1',
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
    // The dimension a hand-written shape had dropped: a lock on ANOTHER
    // subsidiary's identical period must not block this one.
    expect(isPeriodLockedFor(row, [lock({ subsidiaryId: 'sub-2' })])).toBe(false);
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

  it("refuses someone else's record for every role but super_admin", () => {
    // Parameterised over the whole enum, because the exemption is a LIST
    // membership test and widening it by one role is a one-word edit. With
    // only `data_entry` and `super_admin` exercised, adding `consultant` to
    // the exemption was invisible.
    const theirs = draft({ createdBy: 'user-them' });
    expect(submitBlockReason(theirs, { ...ME, role: 'super_admin' }, [])).toBeNull();
    expect(submitBlockReason(theirs, ME, [])).toBe('Entered by someone else.');
    // The other two are refused earlier, by the role gate — which is itself the
    // point: no non-super_admin role reaches a colleague's record.
    for (const role of ['consultant', 'executive_viewer'] as const) {
      expect(submitBlockReason(theirs, { ...ME, role }, [])).not.toBeNull();
      expect(submitBlockReason(theirs, { ...ME, role }, [])).not.toBe(null);
    }
  });

  it('refuses a closed period, naming it', () => {
    expect(submitBlockReason(draft(), ME, [lock()])).toBe('Q1 2026 is locked.');
  });

  it('refuses an evidence-required record with no file, and allows one with a file', () => {
    const needs = draft({ category: 'Electricity' });
    expect(submitBlockReason(needs, ME, [])).toBe('Needs an evidence file.');
    expect(submitBlockReason({ ...needs, evidenceCount: 1 }, ME, [])).toBeNull();
  });

  it('keeps the server\'s ORDER when two gates fail at once', () => {
    // Each branch was tested alone, so every reordering of them survived: no
    // fixture failed two at the same time. The order is not cosmetic — it
    // decides which sentence the user reads, and therefore what they try next.
    const theirsAndLocked = draft({ createdBy: 'user-them' });
    expect(submitBlockReason(theirsAndLocked, ME, [lock()])).toBe(
      'Entered by someone else.',
    );
    const lockedAndNeedsFile = draft({ category: 'Electricity' });
    expect(submitBlockReason(lockedAndNeedsFile, ME, [lock()])).toBe(
      'Q1 2026 is locked.',
    );
    // And the role gate outranks all three.
    expect(
      submitBlockReason(theirsAndLocked, { ...ME, role: 'consultant' }, [lock()]),
    ).toBe('Your role cannot submit records.');
  });

  it('checks status before authorship, the way the server does', () => {
    // Both wrong at once. The server answers `not_submittable` here, so that is
    // the sentence the user must see — otherwise the screen blames the wrong
    // thing and the user goes looking for a colleague who cannot help.
    const row = draft({ status: 'approved', createdBy: 'user-them' });
    expect(submitBlockReason(row, ME, [])).toBe('Already approved.');
  });

  it('refuses a role that may not author records at all, before anything else', () => {
    // The server refuses the WHOLE request with a 403 — it is not a per-record
    // code — so a seat demoted out of the write roles would otherwise see live
    // checkboxes and one refusal for everything it ticked. First, as the server
    // checks it: a consultant looking at their own old draft gets THIS, not
    // "Entered by someone else."
    const mine = draft({ createdBy: 'user-me' });
    expect(submitBlockReason(mine, { ...ME, role: 'consultant' }, [])).toBe(
      'Your role cannot submit records.',
    );
    expect(submitBlockReason(mine, { ...ME, role: 'executive_viewer' }, [])).toBe(
      'Your role cannot submit records.',
    );
    expect(submitBlockReason(mine, ME, [])).toBeNull();
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
      ownSelectableIds: [],
      reasonById: {},
    });
  });

  it('carries the locks through — the composition, not just the branch', () => {
    // The mutation this exists for: `submitBlockReason(row, user, [])` inside
    // this function, or `locks={locks}` dropped from the JSX. Every other test
    // here passes an empty lock list, so both were invisible — and the result
    // is a checkbox on a draft in a closed period, which comes back
    // `period_locked` for the whole batch the user ticked around it.
    const rows = [draft({ id: 'open' }), draft({ id: 'closed', periodValue: 'Q4' })];
    const { selectableIds, reasonById } = selectableDrafts(rows, ME, [
      lock({ periodValue: 'Q4' }),
    ]);
    expect(selectableIds).toEqual(['open']);
    expect(reasonById.closed).toBe('Q4 2026 is locked.');
  });

  it('spells out each reason, not just which rows have one', () => {
    // Asserting `Object.keys(reasonById)` alone let every value be replaced by
    // the wrong sentence — or by the row id — with the test still green.
    const { reasonById } = selectableDrafts(
      [
        draft({ id: 'theirs', createdBy: 'user-them' }),
        draft({ id: 'rejected', status: 'rejected' }),
        draft({ id: 'needs-file', category: 'Electricity' }),
      ],
      ME,
      [],
    );
    expect(reasonById.theirs).toBe('Entered by someone else.');
    expect(reasonById['needs-file']).toBe('Needs an evidence file.');
    expect(reasonById.rejected).toMatch(/open it on its own/);
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

  it('accepts the last tick that fits', () => {
    // Only the refusing side was pinned, so `>= CAP - 1` and a hardcoded 999
    // both survived: the cap could silently lose a record with nothing red.
    const nearly = Array.from({ length: BULK_SUBMIT_MAX_IDS - 1 }, (_, i) => `r${i}`);
    const { selected, refusedByCap } = toggleSelected(nearly, 'last');
    expect(refusedByCap).toBe(false);
    expect(selected).toHaveLength(BULK_SUBMIT_MAX_IDS);
    expect(selected.at(-1)).toBe('last');
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

describe('what a super_admin may sweep', () => {
  const ADMIN: SubmittingUser = { id: 'user-admin', role: 'super_admin' };

  it('lets a super_admin tick a colleague\'s draft, but not sweep one', () => {
    // The endpoint's own DTO refused to take a FILTER because it would let one
    // user sweep another's work-in-progress into review in a single call. A
    // "Select all 240" over other people's rows is that filter wearing a
    // checkbox — so select-all takes only your own, while ticking one
    // deliberately stays allowed, because the server allows it and one row at
    // a time is a different act.
    const rows = [
      draft({ id: 'mine', createdBy: ADMIN.id }),
      draft({ id: 'theirs', createdBy: 'user-them' }),
    ];
    const { selectableIds, ownSelectableIds } = selectableDrafts(rows, ADMIN, []);
    expect(selectableIds).toEqual(['mine', 'theirs']);
    expect(ownSelectableIds).toEqual(['mine']);
  });

  it('is the same list for everyone else, because the author gate already ran', () => {
    const rows = [
      draft({ id: 'mine', createdBy: ME.id }),
      draft({ id: 'theirs', createdBy: 'user-them' }),
    ];
    const { selectableIds, ownSelectableIds } = selectableDrafts(rows, ME, []);
    expect(selectableIds).toEqual(['mine']);
    expect(ownSelectableIds).toEqual(['mine']);
  });

  it('counts what was ticked from someone else, and says so once', () => {
    const rows = [
      draft({ id: 'a', createdBy: ADMIN.id }),
      draft({ id: 'b', createdBy: 'user-them' }),
      draft({ id: 'c', createdBy: 'user-other' }),
    ];
    expect(selectedFromOthers(rows, ['a', 'b', 'c'], ADMIN)).toBe(2);
    expect(selectedFromOthers(rows, ['a'], ADMIN)).toBe(0);
    expect(selectedFromOthers(rows, ['a', 'b'], null)).toBe(0);

    expect(othersWarning(0)).toBeNull();
    expect(othersWarning(1)).toMatch(/1 of them was entered by someone else/);
    expect(othersWarning(1)).toMatch(/only a reviewer can send it back/);
    expect(othersWarning(2)).toMatch(/2 of them were entered by someone else/);
  });

  it('exempts a super_admin from the author gate, and nobody else', () => {
    const theirs = draft({ createdBy: 'user-them' });
    expect(authoredBy(theirs, ADMIN)).toBe(true);
    expect(authoredBy(draft({ createdBy: ME.id }), ME)).toBe(true);
    // Every other role, asserted on the exported predicate directly. Through
    // `submitBlockReason` the role gate refuses these two first, so widening
    // the exemption to one of them is unreachable there and survives every
    // test — but this function is exported, and the next caller may not have a
    // role gate in front of it.
    for (const role of ['data_entry', 'consultant', 'executive_viewer'] as const) {
      expect(authoredBy(theirs, { id: ME.id, role })).toBe(false);
    }
  });
});

describe('allEligibleSelected', () => {
  it('is true when everything takeable is taken', () => {
    expect(allEligibleSelected(3, 3)).toBe(true);
    expect(allEligibleSelected(2, 3)).toBe(false);
    expect(allEligibleSelected(0, 0)).toBe(false);
  });

  it('compares against the CAP, so the master control can still clear', () => {
    // It compared against the raw count, so above the cap it was permanently
    // unchecked — and an unchecked master sends `on = true`, which re-selects
    // the same thousand. The control could never be used to clear.
    expect(allEligibleSelected(BULK_SUBMIT_MAX_IDS, BULK_SUBMIT_MAX_IDS + 50)).toBe(true);
  });
});

describe('liveSelection', () => {
  it('drops ids that have stopped being selectable', () => {
    // The stale-id guard. Without it the next submit sends ids the server
    // refuses and the count on the button is a lie.
    expect(liveSelection(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c']);
    expect(liveSelection(['a'], [])).toEqual([]);
    expect(liveSelection([], ['a'])).toEqual([]);
  });
});

describe('the notices select-all owes the user', () => {
  it('says nothing when it took everything', () => {
    expect(selectAllNotices(5, 0, 0)).toEqual([]);
  });

  it('separates the two reasons, because the remedies differ', () => {
    const [others] = selectAllNotices(3, 2, 0);
    expect(others).toMatch(/Selected your own 3/);
    expect(others).toMatch(/2 records were entered by someone else/);
    expect(others).toMatch(/ticked one at a time/);

    const [over] = selectAllNotices(1000, 0, 7);
    expect(over).toMatch(/Selected the first 1,000/);
    expect(over).toMatch(/7 more can go in a second submission/);

    expect(selectAllNotices(1000, 4, 7)).toHaveLength(2);
  });

  it('agrees with itself about one record', () => {
    expect(selectAllNotices(3, 1, 0)[0]).toMatch(/1 record was entered by someone else/);
  });

  it('names the cap in the refusal, from the constant', () => {
    expect(capRefusedNotice()).toBe('1,000 records is the most one submission can carry.');
  });
});
