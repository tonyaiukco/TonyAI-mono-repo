import { describe, it, expect } from 'vitest';
import { BULK_SUBMIT_ISSUE_CODES, BULK_SUBMIT_MAX_IDS } from '@/lib/types';
import type {
  BulkSubmitIssue,
  BulkSubmitReportDTO,
  BulkUploadAcceptedRow,
} from '@/lib/types';
import { ApiError } from '@/lib/api';
import {
  eligibleForSubmit,
  failuresToShow,
  MAX_FAILURES_SHOWN,
  submitConfirmation,
  submitErrorMessage,
  SUBMIT_ISSUE_LABEL,
  summariseSubmit,
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
