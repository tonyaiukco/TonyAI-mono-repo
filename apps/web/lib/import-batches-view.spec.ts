import { createTranslator } from 'use-intl/core';
import en from '@/messages/en/errors.json';
import tr from '@/messages/tr/errors.json';
import { describe, expect, it } from 'vitest';
import { ApiError, SESSION_EXPIRED_MESSAGE } from '@/lib/api';
import {
  INTERRUPTED_AFTER_MS,
  awaitingEvidenceNote as awaitingEvidenceNoteIn,
  submitFailureDetail as submitFailureDetailIn,
  batchOutcome as batchOutcomeIn,
  batchState,
  batchSubmitLabel as batchSubmitLabelIn,
  importBatchesErrorMessage as importBatchesErrorMessageIn,
} from './import-batches-view';
import { copyFor, describeFor } from '@/lib/i18n/testing';

// English: the text the panel showed before LP4-04.
const ib = () => copyFor('imports');
// The `errors` translator recent-imports passes (no English default since LP4-04 slice 2).
const errorsT = (locale: 'en' | 'tr' = 'en') => copyFor('errors', locale).t as never;
const batchOutcome = (batch: Parameters<typeof batchOutcomeIn>[0], t: Parameters<typeof batchOutcomeIn>[1] = errorsT(), locale: 'en' | 'tr' = 'en') =>
  batchOutcomeIn(batch, t, locale);
const submitFailureDetail = (report: Parameters<typeof submitFailureDetailIn>[0], locale: 'en' | 'tr' = 'en') =>
  submitFailureDetailIn(report, errorsT(locale), errorsT(locale), locale);
const awaitingEvidenceNote = (b: Parameters<typeof awaitingEvidenceNoteIn>[0]) => awaitingEvidenceNoteIn(b, ib());
const batchSubmitLabel = (n: number) => batchSubmitLabelIn(n, ib());
const importBatchesErrorMessage = (e: unknown) => importBatchesErrorMessageIn(e, ib(), describeFor()).title;

const T0 = Date.parse('2026-09-19T10:00:00Z');

describe('batchState', () => {
  it('reports a finished batch as it was recorded', () => {
    expect(batchState({ status: 'completed', createdAt: new Date(T0).toISOString() }, T0)).toBe('completed');
    expect(batchState({ status: 'failed', createdAt: new Date(T0).toISOString() }, T0)).toBe('failed');
  });

  it('calls a batch still processing past the limit interrupted, not processing', () => {
    const started = new Date(T0).toISOString();
    expect(batchState({ status: 'processing', createdAt: started }, T0 + 60_000)).toBe('processing');
    expect(
      batchState({ status: 'processing', createdAt: started }, T0 + INTERRUPTED_AFTER_MS + 1),
    ).toBe('interrupted');
  });
});

describe('batchOutcome', () => {
  it('names what was imported and leaves out a zero refusal', () => {
    expect(batchOutcome({ acceptedCount: 2, rejectedCount: 1, totalRows: 3 })).toBe('2 imported · 1 refused');
    expect(batchOutcome({ acceptedCount: 1200, rejectedCount: 0, totalRows: 1200 })).toBe('1,200 imported');
  });

  it('says so when the outcome was never recorded, rather than claiming zero', () => {
    expect(batchOutcome({ acceptedCount: null, rejectedCount: null, totalRows: 3 })).toBe(
      'Rows with no recorded outcome: 3',
    );
  });
});

describe('batchSubmitLabel', () => {
  it('offers no button when nothing can be sent', () => {
    expect(batchSubmitLabel(0)).toBeNull();
  });
  it('counts drafts, singular and plural', () => {
    expect(batchSubmitLabel(1)).toBe('Send 1 draft for review');
    expect(batchSubmitLabel(12)).toBe('Send 12 drafts for review');
  });
});

describe('importBatchesErrorMessage', () => {
  it('names an expired session, and a batch that is gone', () => {
    expect(importBatchesErrorMessage(new ApiError('Unauthorized', 401))).toBe(SESSION_EXPIRED_MESSAGE);
    expect(importBatchesErrorMessage(new ApiError('Import not found', 404))).toMatch(/no longer available/);
  });
  it('words anything else as the error catalogue does, never error.message', () => {
    expect(importBatchesErrorMessage(new ApiError('Service unavailable', 503))).toBe(
      describeFor()(new ApiError('x', 503)).title,
    );
    expect(importBatchesErrorMessage(new ApiError('Service unavailable', 503))).not.toBe('Service unavailable');
  });
});

describe('awaitingEvidenceNote', () => {
  it('is silent when every draft can go', () => {
    expect(awaitingEvidenceNote({ draftCount: 2, submittableDraftCount: 2 })).toBeNull();
  });
  it('names how many wait for a file, and where to attach it', () => {
    expect(awaitingEvidenceNote({ draftCount: 3, submittableDraftCount: 1 })).toBe(
      '2 drafts need an evidence file first — under Previous submissions, attach each invoice to the drafts it evidences; one file can cover several.',
    );
    expect(awaitingEvidenceNote({ draftCount: 1, submittableDraftCount: 0 })).toMatch(/^1 draft needs/);
  });
});

describe('submitFailureDetail', () => {
  it('groups the reasons a record was not moved', () => {
    const report = {
      requested: 3,
      submitted: [],
      failed: [
        { recordId: 'a', code: 'evidence_required' as const, message: 'x' },
        { recordId: 'b', code: 'evidence_required' as const, message: 'x' },
        { recordId: 'c', code: 'period_locked' as const, message: 'x' },
      ],
    };
    const detail = submitFailureDetail(report) ?? '';
    expect(detail.split('\n')).toHaveLength(2);
    expect(detail).toMatch(/· 2/);
  });
  it('says nothing when everything moved', () => {
    expect(submitFailureDetail({ requested: 1, submitted: [], failed: [] })).toBeNull();
  });
});


it.each([['en', en], ['tr', tr]] as const)('%s preserves persisted unstarted and unknown outcomes', (locale, messages) => {
  const t = createTranslator({ locale, messages });
  expect(batchOutcome({ totalRows: 6, acceptedCount: 2, rejectedCount: 1 }, t, locale)).toBe([
    t('bulkOutcomes.imported', { count: 2 }), t('bulkOutcomes.refused', { count: 1 }), t('bulkOutcomes.notProcessed', { count: 3 }),
  ].join(' · '));
  expect(batchOutcome({ totalRows: 6, acceptedCount: 2, rejectedCount: null }, t, locale)).toBe(t('bulkOutcomes.unknown', { count: 6 }));
  // A count of 1,000 or more is grouped in the user's language, in every branch.
  const g = (n: string) => (locale === 'en' ? n : n.replace(',', '.'));
  expect(batchOutcome({ totalRows: 4600, acceptedCount: 1200, rejectedCount: 1300 }, t, locale)).toBe([
    t('bulkOutcomes.imported', { count: g('1,200') }), t('bulkOutcomes.refused', { count: g('1,300') }),
    t('bulkOutcomes.notProcessed', { count: g('2,100') }),
  ].join(' · '));
  expect(batchOutcome({ totalRows: 1200, acceptedCount: null, rejectedCount: null }, t, locale)).toBe(
    t('bulkOutcomes.unknown', { count: g('1,200') }),
  );
});


it.each([['en', en], ['tr', tr]] as const)('%s keeps accepted counts and safe retry guidance in the RecentImports toast', (locale, messages) => {
  const t = createTranslator({ locale, messages });
  const detail = submitFailureDetailIn({ requested: 2, completion: 'deadline_exceeded',
    submitted: [{ recordId: 'a' } as never], failed: [{ recordId: 'b', code: 'not_processed_deadline', message: 'Not started' }],
  }, t as never, t as never, locale);
  expect(detail).toBe(t('bulkDeadline.detail', { accepted: 1, refused: 0, unstarted: 1 }));
});


it.each([['en', en], ['tr', tr]] as const)('%s localises stale records in recent imports', (locale, messages) => {
  const t = createTranslator({ locale, messages });
  expect(submitFailureDetailIn({ requested: 1, submitted: [], failed: [
    { recordId: 'draft', code: 'calculation_stale', message: 'server English' },
  ] }, t as never, t as never, locale)).toBe(`${messages.bulkIssues.calculation_stale} · 1`);
});
