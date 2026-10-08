import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { createTranslator } from 'use-intl/core';
import { MESSAGES } from '@/messages';
import { describeApiError, type ErrorTranslator } from './i18n/errors';
import type { Locale } from './types';
import { canApproveRecord, canSubmitEntry, saveErrorDescription } from './record-lifecycle-view';

describe('record lifecycle controls', () => {
  const admin = { id: 'author', role: 'super_admin' as const };
  it.each([
    ['super_admin', true],
    ['data_entry', false],
    ['consultant', false],
    ['executive_viewer', false],
  ] as const)('offers approval only to a different super_admin: %s', (role, mayApproveOthers) => {
    const user = { ...admin, role };
    expect(canApproveRecord(user, { createdBy: 'author' })).toBe(false);
    expect(canApproveRecord(user, { createdBy: 'other' })).toBe(mayApproveOthers);
  });
  it('offers no approval without a loaded user or record', () => {
    expect(canApproveRecord(null, { createdBy: 'other' })).toBe(false);
    expect(canApproveRecord(admin, null)).toBe(false);
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

  it.each([
    ['record_changed', MESSAGES.tr.errors.codes.record_changed],
    ['snapshot_immutable', MESSAGES.tr.errors.codes.snapshot_immutable],
  ] as const)('words %s by the catalogue', (code, expected) => {
    expect(save(new ApiError('English sentence', 409, code), false, 'tr')).toEqual({ title: expected });
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
