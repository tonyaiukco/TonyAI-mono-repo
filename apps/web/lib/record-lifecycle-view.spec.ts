import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { createTranslator } from 'use-intl/core';
import { MESSAGES } from '@/messages';
import { describeApiError, type ErrorTranslator } from './i18n/errors';
import type { Locale } from './types';
import {
  canApproveRecord,
  canSubmitEntry,
  isOwnRecordForApprover,
  isRevised,
  saveErrorDescription,
  shouldStartReviewOnOpen,
} from './record-lifecycle-view';

describe('record lifecycle controls', () => {
  const admin = { id: 'author', role: 'super_admin' as const };
  it.each([
    ['super_admin', true],
    ['consultant', true],
    ['data_entry', false],
    ['executive_viewer', false],
  ] as const)('offers approval to a consultant or super_admin, never on their own record: %s', (role, mayApproveOthers) => {
    const user = { ...admin, role };
    expect(canApproveRecord(user, { createdBy: 'author' })).toBe(false);
    expect(canApproveRecord(user, { createdBy: 'other' })).toBe(mayApproveOthers);
  });
  it('offers no approval without a loaded user or record', () => {
    expect(canApproveRecord(null, { createdBy: 'other' })).toBe(false);
    expect(canApproveRecord(admin, null)).toBe(false);
  });
  it.each([
    ['super_admin', true],
    ['consultant', true],
    ['data_entry', false],
    ['executive_viewer', false],
  ] as const)('explains the withheld Approve only to an approver on their own record: %s', (role, explained) => {
    const user = { ...admin, role };
    expect(isOwnRecordForApprover(user, { createdBy: 'author' })).toBe(explained);
    expect(isOwnRecordForApprover(user, { createdBy: 'other' })).toBe(false);
    expect(isOwnRecordForApprover(null, { createdBy: 'author' })).toBe(false);
  });
  it.each(['super_admin', 'data_entry'] as const)('allows only own or new submissions for %s', (role) => {
    const user = { ...admin, role };
    expect(canSubmitEntry(user, null, null)).toBe(true);
    expect(canSubmitEntry(user, 'draft', 'author')).toBe(true);
    expect(canSubmitEntry(user, 'rejected', 'other')).toBe(false);
    expect(canSubmitEntry(user, 'draft', null)).toBe(false);
  });
  it('offers no submit control before user loading or to read/review roles', () => {
    expect(canSubmitEntry(null, null, null)).toBe(false);
    for (const role of ['consultant', 'executive_viewer'] as const) {
      expect(canSubmitEntry({ ...admin, role }, null, null)).toBe(false);
    }
  });
});

describe('save errors on Data Entry (LP3-01: by code, in the user\'s language)', () => {
  const tr = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale] }) as unknown as ErrorTranslator;
  const tDataEntry = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'dataEntry' });
  const save = (error: unknown, moving: boolean, locale: Locale) =>
    saveErrorDescription(error, moving, (e) => describeApiError(e, tr(locale), locale), tDataEntry(locale));
  // Fixture from the API's DUPLICATE_RECORD_MESSAGE error constant.
  const duplicateMessage = 'An activity record already exists for this reporting entity, period and category.';
  const duplicate = new ApiError(duplicateMessage, 409, 'record_duplicate');

  it('adds the duplicate advice to a duplicate, in both languages', () => {
    expect(save(duplicate, false, 'en')).toEqual({
      title: `${duplicateMessage} Open it from Previous submissions to continue it.`,
    });
    expect(save(duplicate, true, 'en')).toEqual({
      title: `${duplicateMessage} The record has not been moved, and stays where it is.`,
    });
    expect(save(duplicate, false, 'tr').title).toBe(
      `${MESSAGES.tr.errors.codes.record_duplicate} ${MESSAGES.tr.dataEntry.duplicateAdvice}`,
    );
  });

  it('decides by the code, never the sentence — another 409 saying "already exists" gets no advice', () => {
    const other = new ApiError('A denominator for this subsidiary, year and metric already exists.', 409);
    expect(save(other, false, 'en')).toEqual({ title: 'A denominator for this subsidiary, year and metric already exists.' });
    expect(save(new ApiError(duplicateMessage, 400), false, 'en').title).not.toContain('Previous submissions');
  });

  it('words snapshot_immutable by the catalogue', () => {
    expect(save(new ApiError('English sentence', 409, 'snapshot_immutable'), false, 'tr')).toEqual({
      title: MESSAGES.tr.errors.codes.snapshot_immutable,
    });
  });

  it('says a record changed since the form opened it was not saved, never that it changed during the request (self-gen-form)', () => {
    for (const locale of ['en', 'tr'] as const) {
      for (const moving of [false, true]) {
        expect(save(new ApiError('English sentence', 409, 'record_changed'), moving, locale)).toEqual({
          title: MESSAGES[locale].dataEntry.recordChanged,
        });
      }
    }
    const en = save(new ApiError('x', 409, 'record_changed'), false, 'en').title;
    expect(en).toContain('after this form opened it');
    expect(en).toContain('were not saved');
    expect(en).not.toContain('in progress');
    expect(en).not.toBe(MESSAGES.en.errors.codes.record_changed);
  });

  it('a locked period names the period and year in the user\'s language', () => {
    const locked = new ApiError('Reporting period Q1 2025 is locked', 409, 'period_locked', { period: 'Q1', year: 2025 });
    expect(save(locked, false, 'tr').title).toMatch(/^1\. çeyrek 2025 raporlama dönemi kilitli/);
    expect(save(locked, false, 'en').title).toMatch(/^Reporting period Q1 2025 is locked/);
  });

  it('keeps an uncoded refusal as the server worded it in English (K5)', () => {
    expect(save(new ApiError('Only the author may submit.', 403), false, 'en')).toEqual({ title: 'Only the author may submit.' });
    expect(save(new ApiError('Only the author may submit.', 403), false, 'tr')).toEqual({
      title: MESSAGES.tr.errors.codes.forbidden,
      description: 'Only the author may submit.',
    });
  });

  it('keeps server failures generic, and never shows a thrown error\'s own text', () => {
    expect(save(new ApiError('private failure', 500, 'internal_error'), false, 'en').title).toContain('Could not save');
    expect(save(new ApiError('private failure', 500), false, 'tr')).toEqual({ title: MESSAGES.tr.dataEntry.saveFailedServer });
    expect(save(new Error('Connection lost'), false, 'en')).toEqual({ title: MESSAGES.en.errors.unexpected });
    expect(save(new TypeError('Failed to fetch'), false, 'tr')).toEqual({ title: MESSAGES.tr.errors.network });
  });
});

describe('opening a record in the review queue (WP5)', () => {
  const consultant = { id: 'reviewer', role: 'consultant' as const };
  const admin = { id: 'author', role: 'super_admin' as const };
  const submitted = { createdBy: 'author', status: 'submitted' };

  it("starts the review when an approver opens another user's submitted record", () => {
    expect(shouldStartReviewOnOpen(consultant, submitted)).toBe(true);
    expect(shouldStartReviewOnOpen({ id: 'other-admin', role: 'super_admin' }, submitted)).toBe(true);
  });
  it('never starts it for the author, who may not approve it', () => {
    expect(shouldStartReviewOnOpen(admin, submitted)).toBe(false);
    expect(shouldStartReviewOnOpen({ id: 'author', role: 'consultant' }, submitted)).toBe(false);
  });
  it('changes nothing on a record already under review, or no longer pending', () => {
    for (const status of ['under_review', 'draft', 'rejected', 'approved']) {
      expect(shouldStartReviewOnOpen(consultant, { createdBy: 'author', status })).toBe(false);
    }
  });
  it('never starts it for a role that may not approve, or without a user or record', () => {
    expect(shouldStartReviewOnOpen({ id: 'x', role: 'executive_viewer' }, submitted)).toBe(false);
    expect(shouldStartReviewOnOpen({ id: 'x', role: 'data_entry' }, submitted)).toBe(false);
    expect(shouldStartReviewOnOpen(null, submitted)).toBe(false);
    expect(shouldStartReviewOnOpen(consultant, null)).toBe(false);
  });
  it('marks a record revised from its second submission', () => {
    expect(isRevised({ submissionCount: 0 })).toBe(false);
    expect(isRevised({ submissionCount: 1 })).toBe(false);
    expect(isRevised({ submissionCount: 2 })).toBe(true);
    expect(isRevised({ submissionCount: 5 })).toBe(true);
    expect(isRevised(null)).toBe(false);
  });
});
