import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { canApproveRecord, canSubmitEntry, saveErrorMessage } from './record-lifecycle-view';

describe('record lifecycle controls', () => {
  const admin = { id: 'author', role: 'super_admin' as const };
  it('offers approval only to a different super_admin', () => {
    expect(canApproveRecord(admin, { createdBy: 'author' })).toBe(false);
    expect(canApproveRecord(admin, { createdBy: 'other' })).toBe(true);
    expect(canApproveRecord({ ...admin, role: 'consultant' }, { createdBy: 'other' })).toBe(false);
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
  it('adds duplicate advice only to an already-exists 409', () => {
    expect(saveErrorMessage(new ApiError('Record already exists.', 409))).toContain('Previous submissions');
    expect(saveErrorMessage(new ApiError('Record ALREADY EXISTS.', 409), true)).toContain('has not been moved');
    expect(saveErrorMessage(new ApiError('Record already exists.', 400))).toBe('Record already exists.');
  });
  it.each(['Record changed; reload.', 'Period locked.', 'Another conflict.'])('preserves %s', (message) => {
    expect(saveErrorMessage(new ApiError(message, 409))).toBe(message);
    expect(saveErrorMessage(new ApiError(message, 409), true)).toBe(message);
  });
  it('preserves other client errors and keeps server failures generic', () => {
    expect(saveErrorMessage(new ApiError('Only the author may submit.', 403))).toBe('Only the author may submit.');
    expect(saveErrorMessage(new ApiError('private failure', 500))).toContain('Could not save');
    expect(saveErrorMessage(new Error('Connection lost'))).toBe('Connection lost');
  });
});
