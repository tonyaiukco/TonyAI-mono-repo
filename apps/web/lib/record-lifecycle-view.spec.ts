import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { canApproveRecord, canSubmitEntry, saveErrorMessage } from './record-lifecycle-view';

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

describe('conflict advice', () => {
  // Fixture from the API's DUPLICATE_RECORD_MESSAGE error constant.
  const duplicateMessage = 'An activity record already exists for this reporting entity, period and category.';
  it('adds duplicate advice to the real API conflict message', () => {
    expect(saveErrorMessage(new ApiError(duplicateMessage, 409))).toBe(
      `${duplicateMessage} Open it from Previous submissions to continue it.`,
    );
    expect(saveErrorMessage(new ApiError(duplicateMessage, 409), true)).toBe(
      `${duplicateMessage} The record has not been moved, and stays where it is.`,
    );
  });
  it('adds duplicate advice only to an already-exists 409', () => {
    expect(saveErrorMessage(new ApiError('Record already exists.', 409))).toContain('Previous submissions');
    expect(saveErrorMessage(new ApiError('Record ALREADY EXISTS.', 409), true)).toContain('has not been moved');
    expect(saveErrorMessage(new ApiError('Record already exists.', 400))).toBe('Record already exists.');
  });
  it.each(['Record changed; reload.', 'Period locked.', 'Another conflict.', 'The record no longer exists.'])('preserves %s', (message) => {
    expect(saveErrorMessage(new ApiError(message, 409))).toBe(message);
    expect(saveErrorMessage(new ApiError(message, 409), true)).toBe(message);
  });
  it('preserves other client errors and keeps server failures generic', () => {
    expect(saveErrorMessage(new ApiError('Only the author may submit.', 403))).toBe('Only the author may submit.');
    expect(saveErrorMessage(new ApiError('private failure', 500))).toContain('Could not save');
    expect(saveErrorMessage(new Error('Connection lost'))).toBe('Connection lost');
  });
});
