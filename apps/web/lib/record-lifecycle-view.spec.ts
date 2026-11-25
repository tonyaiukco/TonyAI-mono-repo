import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { createTranslator } from 'use-intl/core';
import { MESSAGES } from '@/messages';
import { describeApiError, type ErrorTranslator } from './i18n/errors';
import { RECORD_APPROVERS, USER_ROLES, type Locale, type RecordApprover, type UserRole } from './types';
import {
  awaitedApprover,
  canApproveRecord,
  canSubmitEntry,
  isNewerRecord,
  keepNewerRows,
  isOwnRecordForApprover,
  isRevised,
  isSelfApproval,
  mayUseReviewQueue,
  saveErrorDescription,
  shouldStartReviewOnOpen,
} from './record-lifecycle-view';

/**
 * Who is offered a decision (inc26-roles-approval-chain, design Decision 7):
 * every role against every `approver` value, as the author and as anyone else.
 * `me` is the user on screen; the record's author is `me` or `other`.
 */
describe('record lifecycle controls — the approver decides (inc26-roles-approval-chain)', () => {
  const me = (role: UserRole) => ({ id: 'me', role });
  const record = (createdBy: 'me' | 'other', approver: RecordApprover | null) => ({ createdBy, approver });

  // [role, approver, decides someone else's record, decides own record]
  const MATRIX: readonly (readonly [UserRole, RecordApprover, boolean, boolean])[] = [
    // A masterkey decides a super_admin's record and the fallback, never
    // another masterkey's (approver `author`), and their own as a self-approval.
    ['masterkey', 'masterkey', true, false],
    ['masterkey', 'super_admin', false, false],
    ['masterkey', 'author', false, true],
    // A super_admin decides a standard user's record, never their own.
    ['super_admin', 'super_admin', true, false],
    ['super_admin', 'masterkey', false, false],
    ['super_admin', 'author', false, false],
    // The other two roles decide nothing.
    ['standard_user', 'super_admin', false, false],
    ['standard_user', 'masterkey', false, false],
    ['standard_user', 'author', false, false],
    ['auditor', 'super_admin', false, false],
    ['auditor', 'masterkey', false, false],
    ['auditor', 'author', false, false],
  ];

  it.each(MATRIX)('%s, approver %s: decides another\'s record %s, their own %s', (role, approver, others, own) => {
    expect(canApproveRecord(me(role), record('other', approver))).toBe(others);
    expect(canApproveRecord(me(role), record('me', approver))).toBe(own);
  });

  it('offers no decision on a record that states no approver (not pending), or without a user or record', () => {
    for (const role of USER_ROLES) {
      expect(canApproveRecord(me(role), record('other', null))).toBe(false);
      expect(canApproveRecord(me(role), { createdBy: 'other' })).toBe(false);
    }
    expect(canApproveRecord(null, record('other', 'masterkey'))).toBe(false);
    expect(canApproveRecord(me('masterkey'), null)).toBe(false);
  });

  it('opens the queue to a masterkey and a super_admin only', () => {
    expect(USER_ROLES.filter((role) => mayUseReviewQueue(me(role)))).toEqual(['masterkey', 'super_admin']);
    expect(mayUseReviewQueue(null)).toBe(false);
  });

  it('explains the withheld Approve to a super_admin on their own record, which a masterkey decides', () => {
    expect(isOwnRecordForApprover(me('super_admin'), record('me', 'masterkey'))).toBe(true);
    // Not on someone else's record, and not without a loaded user.
    expect(isOwnRecordForApprover(me('super_admin'), record('other', 'masterkey'))).toBe(false);
    expect(isOwnRecordForApprover(null, record('me', 'masterkey'))).toBe(false);
  });

  it('never explains a withheld Approve to a masterkey on their own record — it is theirs to decide', () => {
    expect(isOwnRecordForApprover(me('masterkey'), record('me', 'author'))).toBe(false);
  });

  it.each(['standard_user', 'auditor'] as const)('never explains it to a %s, who decides nothing', (role) => {
    for (const approver of RECORD_APPROVERS) expect(isOwnRecordForApprover(me(role), record('me', approver))).toBe(false);
  });

  it('notes a self-approval beside Approve for a masterkey\'s own record only', () => {
    expect(isSelfApproval(me('masterkey'), record('me', 'author'))).toBe(true);
    // Another masterkey's record is not theirs to approve at all.
    expect(isSelfApproval(me('masterkey'), record('other', 'author'))).toBe(false);
    // An ordinary approval is no self-approval.
    expect(isSelfApproval(me('masterkey'), record('other', 'masterkey'))).toBe(false);
    expect(isSelfApproval(me('super_admin'), record('other', 'super_admin'))).toBe(false);
    expect(isSelfApproval(null, record('me', 'author'))).toBe(false);
  });

  it('names who a record awaits when it is not the user\'s decision, and nothing when it is', () => {
    // The masterkey's "show every pending record" view (spec scenario "Showing the others").
    expect(awaitedApprover(me('masterkey'), record('other', 'super_admin'))).toBe('super_admin');
    expect(awaitedApprover(me('masterkey'), record('other', 'author'))).toBe('author');
    expect(awaitedApprover(me('masterkey'), record('other', 'masterkey'))).toBeNull();
    expect(awaitedApprover(me('masterkey'), record('me', 'author'))).toBeNull();
    // A super_admin's own record and a colleague's.
    expect(awaitedApprover(me('super_admin'), record('me', 'masterkey'))).toBe('masterkey');
    expect(awaitedApprover(me('super_admin'), record('other', 'masterkey'))).toBe('masterkey');
    expect(awaitedApprover(me('super_admin'), record('other', 'super_admin'))).toBeNull();
    // Nothing for a record that states no approver.
    expect(awaitedApprover(me('masterkey'), record('other', null))).toBeNull();
    expect(awaitedApprover(me('masterkey'), null)).toBeNull();
  });

  it.each(['masterkey', 'super_admin', 'standard_user'] as const)('allows only own or new submissions for %s', (role) => {
    const user = { id: 'author', role };
    expect(canSubmitEntry(user, null, null)).toBe(true);
    expect(canSubmitEntry(user, 'draft', 'author')).toBe(true);
    expect(canSubmitEntry(user, 'rejected', 'other')).toBe(false);
    expect(canSubmitEntry(user, 'draft', null)).toBe(false);
  });
  it('offers no submit control before user loading or to an auditor', () => {
    expect(canSubmitEntry(null, null, null)).toBe(false);
    expect(canSubmitEntry({ id: 'author', role: 'auditor' }, null, null)).toBe(false);
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

describe('opening a record in the review queue (WP5; inc26-roles-approval-chain)', () => {
  const superAdmin = { id: 'reviewer', role: 'super_admin' as const };
  const masterkey = { id: 'mk', role: 'masterkey' as const };
  const submitted = (createdBy: string, approver: RecordApprover | null) => ({ createdBy, approver, status: 'submitted' });

  it("starts the review when a super_admin opens a standard user's submitted record (approver super_admin)", () => {
    expect(shouldStartReviewOnOpen(superAdmin, submitted('author', 'super_admin'))).toBe(true);
  });
  it("starts it when a masterkey opens a super_admin's record, or the fallback (approver masterkey)", () => {
    expect(shouldStartReviewOnOpen(masterkey, submitted('author', 'masterkey'))).toBe(true);
  });
  it('starts it when a masterkey opens their own submitted record (approver author)', () => {
    expect(shouldStartReviewOnOpen(masterkey, submitted('mk', 'author'))).toBe(true);
  });
  it('never starts it for a non-approver: the masterkey on a super_admin\'s decision, the super_admin on a masterkey\'s', () => {
    expect(shouldStartReviewOnOpen(masterkey, submitted('author', 'super_admin'))).toBe(false);
    expect(shouldStartReviewOnOpen(superAdmin, submitted('author', 'masterkey'))).toBe(false);
    expect(shouldStartReviewOnOpen(superAdmin, submitted('author', 'author'))).toBe(false);
    // Another masterkey's own record waits for its author.
    expect(shouldStartReviewOnOpen(masterkey, submitted('other-mk', 'author'))).toBe(false);
  });
  it('never starts it for a super_admin author, whose record a masterkey decides', () => {
    expect(shouldStartReviewOnOpen(superAdmin, submitted('reviewer', 'masterkey'))).toBe(false);
  });
  it('changes nothing on a record already under review, or no longer pending', () => {
    for (const status of ['under_review', 'draft', 'rejected', 'approved']) {
      expect(shouldStartReviewOnOpen(superAdmin, { createdBy: 'author', approver: 'super_admin', status })).toBe(false);
    }
  });
  it('never starts it for a role that decides nothing, on a record stating no approver, or without a user or record', () => {
    for (const approver of RECORD_APPROVERS) {
      expect(shouldStartReviewOnOpen({ id: 'x', role: 'auditor' }, submitted('author', approver))).toBe(false);
      expect(shouldStartReviewOnOpen({ id: 'x', role: 'standard_user' }, submitted('author', approver))).toBe(false);
    }
    expect(shouldStartReviewOnOpen(superAdmin, submitted('author', null))).toBe(false);
    expect(shouldStartReviewOnOpen(null, submitted('author', 'super_admin'))).toBe(false);
    expect(shouldStartReviewOnOpen(superAdmin, null)).toBe(false);
  });
  it('marks a record revised from its second submission', () => {
    expect(isRevised({ submissionCount: 0 })).toBe(false);
    expect(isRevised({ submissionCount: 1 })).toBe(false);
    expect(isRevised({ submissionCount: 2 })).toBe(true);
    expect(isRevised({ submissionCount: 5 })).toBe(true);
    expect(isRevised(null)).toBe(false);
  });
});

describe('a late answer never replaces a newer read (owner review)', () => {
  const v = (updatedAt: string, submissionCount: number) => ({ updatedAt, submissionCount });
  it('keeps a row read after the answer, or holding a later submission', () => {
    expect(isNewerRecord(v('2026-11-25T10:00:02.000Z', 2), v('2026-11-25T10:00:01.000Z', 1))).toBe(true);
    expect(isNewerRecord(v('2026-11-25T10:00:00.000Z', 2), v('2026-11-25T10:00:01.000Z', 1))).toBe(true);
  });
  it('lets the answer replace the row it answered for', () => {
    expect(isNewerRecord(v('2026-11-25T10:00:00.000Z', 1), v('2026-11-25T10:00:01.000Z', 1))).toBe(false);
    expect(isNewerRecord(v('2026-11-25T10:00:01.000Z', 1), v('2026-11-25T10:00:01.000Z', 1))).toBe(false);
  });
});

describe('a queue page read before a step never turns its row back (owner review)', () => {
  const row = (id: string, status: string, updatedAt: string, submissionCount = 1) => ({ id, status, updatedAt, submissionCount });
  it('keeps the row the screen holds in a later version, and takes the page for the rest', () => {
    const shown = [row('b', 'under_review', '2026-11-25T10:00:05.000Z'), row('z', 'submitted', '2026-11-25T09:00:00.000Z')];
    const page = [row('b', 'submitted', '2026-11-25T10:00:01.000Z'), row('c', 'submitted', '2026-11-25T10:00:02.000Z')];
    expect(keepNewerRows(shown, page)).toEqual([shown[0], page[1]]);
  });
  it('takes the page where it is the later version', () => {
    const shown = [row('b', 'submitted', '2026-11-25T10:00:01.000Z')];
    const page = [row('b', 'under_review', '2026-11-25T10:00:05.000Z')];
    expect(keepNewerRows(shown, page)).toEqual(page);
  });
});
