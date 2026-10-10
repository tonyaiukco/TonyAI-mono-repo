import { describe, expect, it } from 'vitest';
import type { InvitationStateDTO, UserSummaryDTO } from '@/lib/types';
import { accessSummary, appendPage, canResend, invitationNote, replaceUser } from './users-view';

const invitation = (over: Partial<InvitationStateDTO> = {}): InvitationStateDTO => ({
  status: 'sent', language: 'en', attempts: 1, lastErrorStep: null, lastErrorCode: null,
  lastAttemptAt: '2026-10-10T10:00:00.000Z', sentAt: '2026-10-10T10:00:00.000Z', acceptedAt: null, ...over,
});
const member = (over: Partial<UserSummaryDTO> = {}): UserSummaryDTO => ({
  id: 'u1', email: 'a@b.test', fullName: 'A', role: 'data_entry', language: 'en', status: 'invited',
  subsidiaryIds: [], disabledAt: null, authSyncPending: false, invitation: invitation(), createdAt: '2026-10-10T09:00:00.000Z',
  ...over,
});

describe('invitationNote', () => {
  it('says when it was sent, that it is on its way, or that it failed', () => {
    expect(invitationNote(member())).toEqual({ key: 'invitationSent', values: { date: '2026-10-10T10:00:00.000Z' } });
    expect(invitationNote(member({ invitation: invitation({ status: 'pending', sentAt: null }) }))).toEqual({ key: 'invitationPending' });
    expect(
      invitationNote(member({ invitation: invitation({ status: 'pending', lastErrorStep: 'email', lastErrorCode: 'smtp_failed' }) })),
    ).toEqual({ key: 'deliveryFailed' });
  });

  it('says nothing once accepted, for a disabled account, or with no invitation', () => {
    expect(invitationNote(member({ status: 'active', invitation: invitation({ status: 'accepted', acceptedAt: 'x' }) }))).toBeNull();
    expect(invitationNote(member({ status: 'disabled', invitation: invitation({ status: 'revoked' }) }))).toBeNull();
    expect(invitationNote(member({ status: 'active', invitation: null }))).toBeNull();
  });
});

describe('canResend', () => {
  it('only an invitation not yet accepted, on an enabled account', () => {
    expect(canResend(member())).toBe(true);
    expect(canResend(member({ invitation: invitation({ status: 'pending' }) }))).toBe(true);
    expect(canResend(member({ status: 'active', invitation: invitation({ status: 'accepted' }) }))).toBe(false);
    expect(canResend(member({ status: 'disabled', invitation: invitation({ status: 'revoked' }) }))).toBe(false);
    expect(canResend(member({ status: 'active', invitation: null }))).toBe(false);
  });
});

describe('accessSummary', () => {
  it('grants are a data_entry user\'s alone', () => {
    expect(accessSummary(member({ role: 'consultant', subsidiaryIds: ['s'] }))).toEqual({ key: 'wholeOrganisation' });
    expect(accessSummary(member())).toEqual({ key: 'noAccess' });
    expect(accessSummary(member({ subsidiaryIds: ['s', 't'] }))).toEqual({ key: 'accessCount', values: { count: 2 } });
  });
});

describe('list updates', () => {
  it('replaces one member with the API answer and appends pages without repeating anyone', () => {
    const a = member({ id: 'a' });
    const b = member({ id: 'b' });
    expect(replaceUser([a, b], { ...b, fullName: 'B2' }).map((u) => u.fullName)).toEqual(['A', 'B2']);
    expect(appendPage([a], [a, b]).map((u) => u.id)).toEqual(['a', 'b']);
  });
});
