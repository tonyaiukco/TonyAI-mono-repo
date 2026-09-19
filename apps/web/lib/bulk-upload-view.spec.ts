import { describe, it, expect } from 'vitest';
import {
  BULK_UPLOAD_ISSUE_CODES,
  BULK_UPLOAD_MAX_SIZE_BYTES,
  BULK_UPLOAD_COLUMNS,
} from '@/lib/types';
import type {
  BulkUploadAcceptedRow,
  BulkUploadReportDTO,
  BulkUploadRowIssue,
} from '@/lib/types';
import { ApiError, SESSION_EXPIRED_MESSAGE } from '@/lib/api';
import {
  applyConfirmation,
  applySuccessMessage,
  applyToast,
  COLUMN_LABEL,
  fileAcceptAttribute,
  groupIssues,
  ISSUE_CODE_LABEL,
  MAX_ISSUE_ROWS_PER_GROUP,
  preflightFile,
  sizeCapLabel,
  summarise,
  templateErrorMessage,
  tonnesLabel,
  totalTonnes,
  uploadErrorMessage,
} from '@/lib/bulk-upload-view';

/**
 * This module is the whole of what can be tested about bulk upload on the
 * client: `vitest.config.ts` collects only `lib/**`, so anything left in the
 * panel has no coverage in either direction. Every sentence a user reads, and
 * every decision about whether a file is even sent, therefore lives here.
 *
 * The cases marked "measured" were read off the REAL verdict — the server's
 * report for a fixture file, fed through this module — while the UAT round-2
 * catalog was being written. Each one is a sentence a tester would have filed.
 */
function accepted(over: Partial<BulkUploadAcceptedRow> = {}): BulkUploadAcceptedRow {
  return {
    row: 2,
    recordId: null,
    subsidiaryId: 'sub-1',
    locationId: null,
    reportingYear: 2024,
    reportingPeriod: 'monthly',
    periodValue: 'January',
    category: 'Electricity',
    tCo2e: 1.5,
    anomalous: false,
    ...over,
  };
}

function issue(over: Partial<BulkUploadRowIssue> = {}): BulkUploadRowIssue {
  return {
    row: 2,
    column: null,
    code: 'invalid',
    message: 'something is wrong',
    ...over,
  };
}

function report(over: Partial<BulkUploadReportDTO> = {}): BulkUploadReportDTO {
  return {
    dryRun: true,
    fileName: 'data.csv',
    sizeBytes: 1024,
    totalRows: 1,
    accepted: [accepted()],
    errors: [],
    warnings: [],
    ...over,
  };
}

describe('preflightFile', () => {
  it('lets a real spreadsheet through', () => {
    expect(preflightFile({ name: 'q1.csv', size: 2048 })).toBeNull();
    expect(preflightFile({ name: 'Q1 2024.XLSX', size: 2048 })).toBeNull();
  });

  it('refuses the wrong file type before a request is spent', () => {
    // The budget is five imports a minute per user, and a dry run plus an
    // apply already spends two. A refusal the client can see costs none.
    expect(preflightFile({ name: 'notes.txt', size: 10 })).toMatch(/\.csv or \.xlsx/);
    expect(preflightFile({ name: 'noextension', size: 10 })).not.toBeNull();
  });

  it('refuses a file over the size cap, naming the limit', () => {
    const message = preflightFile({
      name: 'huge.csv',
      size: BULK_UPLOAD_MAX_SIZE_BYTES + 1,
    });
    expect(message).toContain(sizeCapLabel());
    // The MEASURED size is deliberately absent: at 2.04 MB, one decimal place
    // produced "That file is 2.0 MB. The limit is 2 MB."
    expect(message).not.toMatch(/2\.0 MB/);
    expect(preflightFile({ name: 'ok.csv', size: BULK_UPLOAD_MAX_SIZE_BYTES })).toBeNull();
  });

  it('refuses an empty file', () => {
    expect(preflightFile({ name: 'empty.csv', size: 0 })).toMatch(/empty/i);
  });

  it('pins the caps to literals', () => {
    // Every case above derives its boundary from the constant it imports,
    // which proves only that the import worked.
    expect(BULK_UPLOAD_MAX_SIZE_BYTES).toBe(2 * 1024 * 1024);
    expect(sizeCapLabel()).toBe('2 MB');
    // Shrinking this to 1 left the whole suite green, and it lives in `lib/`
    // precisely so it can be held to account.
    expect(MAX_ISSUE_ROWS_PER_GROUP).toBe(50);
  });
});

describe('fileAcceptAttribute', () => {
  it('is derived from the server’s own list, not typed out', () => {
    // The evidence vault hardcodes its `accept`; when the server's list
    // changed, nothing failed. This one cannot drift.
    expect(fileAcceptAttribute()).toBe('.csv,.xlsx');
  });
});

describe('the label maps are exhaustive', () => {
  it('names every issue code the server can emit', () => {
    // `Record<BulkUploadIssueCode, string>` makes a new code a compile error
    // rather than a blank label in front of a user. This asserts the runtime
    // half: that the map has no gaps and no strays.
    expect(Object.keys(ISSUE_CODE_LABEL).sort()).toEqual(
      [...BULK_UPLOAD_ISSUE_CODES].sort(),
    );
  });

  it('names every column', () => {
    expect(Object.keys(COLUMN_LABEL).sort()).toEqual(
      [...BULK_UPLOAD_COLUMNS].sort(),
    );
  });

  it('gives every entry a real, distinct label', () => {
    // Keys alone are not the contract. Swapping `subsidiaryId` and
    // `locationId` passed all 156 tests — and `COLUMN_LABEL[issue.column]` is
    // the ONLY thing telling a user which cell to fix, so the panel would
    // have sent them to the Site column when the entity id was wrong.
    // Emptying a label passed too, rendering "· 17 rows" with no subject.
    for (const [map, size] of [
      [ISSUE_CODE_LABEL, BULK_UPLOAD_ISSUE_CODES.length],
      [COLUMN_LABEL, BULK_UPLOAD_COLUMNS.length],
    ] as const) {
      const values = Object.values(map);
      expect(values.every((v) => v.trim().length > 0)).toBe(true);
      expect(new Set(values).size).toBe(size);
    }
  });

  it('names the two entity columns apart from each other', () => {
    // The swap above, pinned by meaning rather than by distinctness alone.
    expect(COLUMN_LABEL.subsidiaryId).toMatch(/entity/i);
    expect(COLUMN_LABEL.locationId).toMatch(/site/i);
  });
});

describe('groupIssues', () => {
  it('gathers one problem at a time, commonest first', () => {
    const groups = groupIssues([
      issue({ row: 5, code: 'period_locked' }),
      issue({ row: 3, code: 'invalid' }),
      issue({ row: 2, code: 'invalid' }),
      issue({ row: 9, code: 'invalid' }),
    ]);

    expect(groups.map((g) => g.code)).toEqual(['invalid', 'period_locked']);
    expect(groups[0].count).toBe(3);
    // Row order inside a group, because the user works down their file.
    expect(groups[0].rows.map((r) => r.row)).toEqual([2, 3, 9]);
  });

  it('carries the human label beside the code', () => {
    expect(groupIssues([issue({ code: 'no_factor' })])[0].label).toBe(
      ISSUE_CODE_LABEL.no_factor,
    );
  });

  it('is stable when two problems are equally common', () => {
    const groups = groupIssues([
      issue({ code: 'period_locked' }),
      issue({ code: 'invalid' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].label.localeCompare(groups[1].label)).toBeLessThan(0);
  });

  it('says nothing about nothing', () => {
    expect(groupIssues([])).toEqual([]);
  });
});

describe('totalTonnes', () => {
  it('adds up the figures', () => {
    expect(totalTonnes([accepted({ tCo2e: 1.5 }), accepted({ tCo2e: 2.25 })])).toBe(3.75);
  });

  it('returns null rather than zero when nothing was calculated', () => {
    // Water is tracked by invoice and never calculated. A client folding with
    // `?? 0` turns "no figure exists" into a REPORTED zero entering the
    // inventory, which is the defect the nullable field exists to prevent.
    expect(totalTonnes([accepted({ tCo2e: null })])).toBeNull();
    expect(totalTonnes([])).toBeNull();
    expect(tonnesLabel([accepted({ tCo2e: null })])).toMatch(/No calculated figure/);
  });

  it('skips the nulls rather than counting them as zero', () => {
    expect(totalTonnes([accepted({ tCo2e: 4 }), accepted({ tCo2e: null })])).toBe(4);
  });
});

describe('summarise', () => {
  it('calls a clean dry run clean', () => {
    const s = summarise(report({ totalRows: 1 }));
    expect(s.tone).toBe('clean');
    expect(s.headline).toMatch(/would be imported/);
    expect(s.detail).toBeNull();
  });

  it('does not say "All 1 row" about a one-row file', () => {
    // Measured: "All 1 row would be imported." and, after the apply, "All 1 row
    // were imported." — and a one-row file is the first thing anyone tries.
    expect(summarise(report()).headline).toBe('1 row would be imported.');
    expect(summarise(report({ totalRows: 2, accepted: [accepted(), accepted({ row: 3 })] })).headline).toBe(
      'All 2 rows would be imported.',
    );
  });

  it('uses the past tense once rows have actually been written', () => {
    expect(summarise(report({ dryRun: false })).headline).toBe('1 row was imported.');
    expect(
      summarise(report({ dryRun: false, totalRows: 2, accepted: [accepted(), accepted({ row: 3 })] }))
        .headline,
    ).toBe('All 2 rows were imported.');
  });

  it('counts affected ROWS, not issues', () => {
    // One row can carry several issues, so `errors.length` is not "rows that
    // failed" — and telling a user 4 rows failed out of 3 costs trust in
    // every other number on the screen.
    const s = summarise(
      report({
        totalRows: 3,
        accepted: [accepted({ row: 2 })],
        errors: [
          issue({ row: 3, column: 'activityValue' }),
          issue({ row: 3, column: 'activityUnit' }),
          issue({ row: 4 }),
        ],
      }),
    );
    expect(s.tone).toBe('partial');
    expect(s.errorCount).toBe(3);
    expect(s.affectedRows).toBe(2);
    expect(s.detail).toMatch(/2 rows were not/);
  });

  it('uses the singular for one bad row', () => {
    const s = summarise(
      report({ totalRows: 2, accepted: [accepted()], errors: [issue({ row: 3 })] }),
    );
    expect(s.detail).toMatch(/1 row was not/);
  });

  it('agrees the verb with a single imported row after a partial apply', () => {
    const s = summarise(
      report({
        dryRun: false,
        totalRows: 3,
        accepted: [accepted()],
        errors: [issue({ row: 3 }), issue({ row: 4 })],
      }),
    );
    expect(s.headline).toBe('1 of 3 rows was imported.');
  });

  it('says plainly when nothing can be imported', () => {
    const s = summarise(
      report({ totalRows: 2, accepted: [], errors: [issue({ row: 2 }), issue({ row: 3 })] }),
    );
    expect(s.tone).toBe('refused');
    expect(s.headline).toMatch(/No rows/);
    expect(s.detail).toBe('All 2 rows in the file have a problem to fix.');
  });

  it('uses the singular when the only row has a problem', () => {
    // Measured: "All 1 row in the file have a problem to fix."
    const s = summarise(report({ accepted: [], errors: [issue()] }));
    expect(s.detail).toBe('The one row in the file has a problem to fix.');
  });
});

describe('the copy that warns about drafts', () => {
  it('says so before anything is written', () => {
    // `draft` is in neither the counted statuses nor the review queue's, so
    // an import moves no total — including the completeness panel on the same
    // screen. A user not told this reports it as a bug.
    const text = applyConfirmation(report({ accepted: [accepted(), accepted()] }));
    expect(text).toMatch(/drafts/i);
    expect(text).toMatch(/review queue/i);
    expect(text).toMatch(/cannot be undone/i);
    expect(text).toContain('2 rows');
  });

  it('does not promise "each" and "in bulk" about a single row', () => {
    const text = applyConfirmation(report());
    expect(text).toContain('Import 1 row');
    expect(text).toMatch(/arrives as a draft/);
    expect(text).toMatch(/review queue/i);
    expect(text).not.toMatch(/\b(each|they|drafts)\b/i);
  });

  it('names the tonnage it is about to write', () => {
    expect(applyConfirmation(report({ accepted: [accepted({ tCo2e: 1.5 })] }))).toContain(
      '1.500 tCO₂e',
    );
  });

  it('does not claim a figure when there is none', () => {
    expect(applyConfirmation(report({ accepted: [accepted({ tCo2e: null })] }))).toMatch(
      /No calculated figure/,
    );
  });

  it('says it again afterwards, in the right number', () => {
    const two = report({ dryRun: false, accepted: [accepted(), accepted({ row: 3 })] });
    expect(applySuccessMessage(two)).toBe(
      '2 records imported as drafts. Send them for review below to count them towards your inventory.',
    );
    // Measured: "1 record imported as drafts."
    expect(applySuccessMessage(report({ dryRun: false }))).toBe(
      '1 record imported as a draft. Send it for review below to count it towards your inventory.',
    );
  });
});

describe('applyToast', () => {
  it('reports success for what was written', () => {
    expect(applyToast(report({ dryRun: false }))).toEqual({
      kind: 'success',
      message: applySuccessMessage(report({ dryRun: false })),
    });
  });

  it('does not report success for an apply that wrote nothing', () => {
    // A 200 can carry zero accepted rows, and the success toast fired for it
    // anyway: "0 records imported as drafts".
    const outcome = applyToast(report({ dryRun: false, accepted: [], errors: [issue()] }));
    expect(outcome.kind).toBe('warning');
    expect(outcome.message).not.toMatch(/imported as/);
  });
});

describe('uploadErrorMessage', () => {
  it('says the session ended on a 401, never the raw "Unauthorized"', () => {
    // It fell through to `error.message` before, and the panel printed
    // "Unauthorized. Nothing was imported." Every other page names the cause.
    expect(uploadErrorMessage(new ApiError('Unauthorized', 401))).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('explains the throttle instead of repeating the status', () => {
    const text = uploadErrorMessage(new ApiError('Too Many Requests', 429));
    expect(text).toMatch(/wait a minute/i);
    // The budget is shared, which is the part a user cannot guess.
    expect(text).toMatch(/dry run/i);
  });

  it('supplies the size sentence for a 413, which may carry no body', () => {
    // Multer's limit fires before any of our code, and the proxy's 413 is
    // often not JSON at all — so this must not rely on `message`.
    expect(uploadErrorMessage(new ApiError('API 413', 413))).toContain('2 MB');
  });

  it('keeps the server’s own sentence for everything else', () => {
    // The 400s are written for the person reading them: "Unrecognised
    // column(s): activity_value. Expected: …" is more useful than anything
    // this module could invent.
    expect(
      uploadErrorMessage(
        new ApiError('Unrecognised column(s): activity_value.', 400),
      ),
    ).toBe('Unrecognised column(s): activity_value.');
  });

  it('survives something that is not an ApiError', () => {
    expect(uploadErrorMessage(new Error('offline'))).toBe('offline');
    expect(uploadErrorMessage('nonsense')).toMatch(/failed/i);
  });
});

describe('templateErrorMessage', () => {
  it('says the session ended on a 401, never the raw "Unauthorized"', () => {
    expect(templateErrorMessage(new ApiError('Unauthorized', 401))).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('does not blame an import budget the download never spent', () => {
    const text = templateErrorMessage(new ApiError('Too Many Requests', 429));
    expect(text).toMatch(/template/i);
    expect(text).toMatch(/wait a minute/i);
    expect(text).not.toMatch(/import|dry run/i);
  });

  it('keeps the server’s sentence otherwise, and survives a non-ApiError', () => {
    expect(templateErrorMessage(new ApiError('Reporting entities could not be read', 500))).toBe(
      'Reporting entities could not be read',
    );
    expect(templateErrorMessage(new Error('offline'))).toBe('offline');
    expect(templateErrorMessage('nonsense')).toMatch(/could not be downloaded/i);
  });
});

describe('the verdict carries what the report would otherwise hide', () => {
  it('says how many rows warn, even when none failed', () => {
    // The commonest real shape, and it had no test: every row of an
    // electricity file carries `evidence_required`. The clean verdict used to
    // say only "All 40 rows would be imported." with the warnings in a
    // COLLAPSED group — an unqualified success for a file where nothing can
    // subsequently be submitted.
    const s = summarise(
      report({
        totalRows: 3,
        accepted: [accepted(), accepted({ row: 3 }), accepted({ row: 4 })],
        warnings: [
          issue({ row: 2, code: 'evidence_required' }),
          issue({ row: 3, code: 'evidence_required' }),
          issue({ row: 4, code: 'evidence_required' }),
        ],
      }),
    );

    expect(s.tone).toBe('clean');
    expect(s.warningCount).toBe(3);
    expect(s.warnedRows).toBe(3);
    expect(s.detail).toMatch(/3 rows need attention/i);
    expect(s.detail).toMatch(/submitted/i);
  });

  it('counts warned ROWS, not warnings', () => {
    // Measured: an anomalous electricity row carries two warnings, and the
    // verdict told a user importing ONE row that "2 rows need attention".
    const s = summarise(
      report({
        warnings: [
          issue({ row: 2, code: 'evidence_required' }),
          issue({ row: 2, code: 'would_block_submit' }),
        ],
      }),
    );
    expect(s.warningCount).toBe(2);
    expect(s.warnedRows).toBe(1);
    expect(s.detail).toBe('1 row needs attention before it can be submitted — see below.');
  });

  it('uses the singular for one warned row', () => {
    const s = summarise(
      report({ warnings: [issue({ code: 'would_block_submit' })] }),
    );
    expect(s.detail).toMatch(/1 row needs attention/i);
  });

  it('says the rows are drafts on the surface that SURVIVES', () => {
    // It was in the confirm dialog (dismissed) and the success toast (fades).
    // The verdict block is the only thing still on screen when the user looks
    // at the completeness panel one column away and finds it unchanged.
    const one = summarise(report({ dryRun: false, totalRows: 1 }));
    expect(one.detail).toMatch(/is a draft/i);
    expect(one.detail).toMatch(/review queue/i);
    const two = summarise(
      report({ dryRun: false, totalRows: 2, accepted: [accepted(), accepted({ row: 3 })] }),
    );
    expect(two.detail).toMatch(/are drafts/i);
  });

  it('does not mention drafts before anything is written', () => {
    expect(summarise(report({ totalRows: 1 })).detail).toBeNull();
  });

  it('keeps the past tense when an apply imported nothing', () => {
    const s = summarise(
      report({ dryRun: false, totalRows: 1, accepted: [], errors: [issue()] }),
    );
    expect(s.headline).toMatch(/were imported/);
  });
});

describe('retry advice', () => {
  it('says to upload the file again after a DRY RUN', () => {
    const s = summarise(
      report({ totalRows: 2, accepted: [accepted()], errors: [issue({ row: 3 })] }),
    );
    expect(s.detail).toMatch(/upload the file again/i);
  });

  it('says to upload ONLY the failed rows after a real import', () => {
    // Re-sending the corrected whole file would return the rows that already
    // succeeded as `duplicate_existing` — the advice would manufacture the
    // next problem.
    const one = summarise(
      report({
        dryRun: false,
        totalRows: 2,
        accepted: [accepted()],
        errors: [issue({ row: 3 })],
      }),
    );
    expect(one.detail).toMatch(/only that row/i);
    expect(one.detail).not.toMatch(/upload the file again/i);
    const two = summarise(
      report({
        dryRun: false,
        totalRows: 3,
        accepted: [accepted()],
        errors: [issue({ row: 3 }), issue({ row: 4 })],
      }),
    );
    expect(two.detail).toMatch(/only those rows/i);
  });

  it('separates the advice from the sentence after it', () => {
    // Measured: concatenated without a space, the screen read "…upload it
    // again.5 rows need attention before they can be submitted".
    const s = summarise(
      report({
        totalRows: 2,
        accepted: [accepted()],
        errors: [issue({ row: 3 })],
        warnings: [issue({ row: 2, code: 'evidence_required' })],
      }),
    );
    expect(s.detail).toBe(
      '1 row was not. Fix it in your file and upload the file again. 1 row needs attention before it can be submitted — see below.',
    );
  });

  it('counts warned ROWS in the partial verdict too', () => {
    // The branch the measured "5 rows need attention" came from — and the
    // warned-rows test above only ever went through the clean one.
    const s = summarise(
      report({
        totalRows: 3,
        accepted: [accepted(), accepted({ row: 3 })],
        errors: [issue({ row: 4 })],
        warnings: [
          issue({ row: 2, code: 'evidence_required' }),
          issue({ row: 2, code: 'would_block_submit' }),
        ],
      }),
    );
    expect(s.detail).toBe(
      '1 row was not. Fix it in your file and upload the file again. 1 row needs attention before it can be submitted — see below.',
    );
  });

  it('counts failed ROWS in the advice, not errors', () => {
    // One row carrying two errors is still "it" and "that row".
    const s = summarise(
      report({
        dryRun: false,
        totalRows: 2,
        accepted: [accepted()],
        errors: [issue({ row: 3 }), issue({ row: 3, column: 'activityUnit' })],
      }),
    );
    expect(s.detail).toBe(
      '1 row was not. Fix it and upload a file containing only that row — re-sending the whole file would report the imported ones as duplicates. The imported row is a draft: it counts towards no total and does not appear in the review queue until it is submitted below.',
    );
  });

  it('joins the warning sentence and the draft sentence with a space', () => {
    expect(
      summarise(report({ dryRun: false, warnings: [issue({ row: 2, code: 'evidence_required' })] }))
        .detail,
    ).toBe(
      '1 row needs attention before it can be submitted — see below. The imported row is a draft: it counts towards no total and does not appear in the review queue until it is submitted below.',
    );
  });

  it('uses the plural pronoun for several warned rows', () => {
    expect(
      summarise(
        report({
          totalRows: 2,
          accepted: [accepted(), accepted({ row: 3 })],
          warnings: [
            issue({ row: 2, code: 'evidence_required' }),
            issue({ row: 3, code: 'evidence_required' }),
          ],
        }),
      ).detail,
    ).toBe('2 rows need attention before they can be submitted — see below.');
  });
});

describe('tonnesLabel', () => {
  it('states a whole-set figure plainly', () => {
    expect(tonnesLabel([accepted({ tCo2e: 1.5 }), accepted({ tCo2e: 1.5 })])).toBe(
      '3.000 tCO₂e',
    );
  });

  it('says how much of the set a partial figure covers', () => {
    // A Water + Electricity file yields one figure and one row count, and an
    // unqualified "4.000 tCO₂e" beside "40 rows" reads as the total for all
    // forty. Avoiding `?? 0` per row and then re-creating it in the aggregate
    // is the same defect one layer up — and this is a number someone pastes
    // into a report.
    const label = tonnesLabel([
      accepted({ tCo2e: 4 }),
      accepted({ tCo2e: null }),
      accepted({ tCo2e: null }),
    ]);
    expect(label).toContain('4.000 tCO₂e');
    expect(label).toMatch(/1 of 3 rows/);
    expect(label).toMatch(/2 have no calculated figure/);
  });

  it('agrees the verb when one row has no figure', () => {
    // Measured: "16.105 tCO₂e across 1 of 2 rows; 1 have no calculated figure".
    expect(tonnesLabel([accepted({ tCo2e: 4 }), accepted({ tCo2e: null })])).toBe(
      '4.000 tCO₂e across 1 of 2 rows; 1 has no calculated figure',
    );
  });
});

describe('uploadErrorMessage — the remaining branch', () => {
  it('explains a role refusal', () => {
    expect(uploadErrorMessage(new ApiError('Forbidden', 403))).toMatch(
      /cannot import/i,
    );
  });
});
