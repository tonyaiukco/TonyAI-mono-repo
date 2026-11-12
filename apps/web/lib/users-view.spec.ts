import { describe, expect, it } from 'vitest';
import type { InvitationStateDTO, UserSummaryDTO } from '@/lib/types';
import {
  accessSummary,
  appendPage,
  canResend,
  invitationNote,
  replaceUser,
  selectAllSubsidiaries,
  selectionState,
  toggleSubsidiary,
} from './users-view';

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
  const names = new Map([
    ['den', 'Denizli Dağıtım'],
    ['cor', 'Çorum Dağıtım'],
    ['ank', 'Ankara Dağıtım'],
    ['izm', 'İzmir Dağıtım'],
    ['bur', 'Bursa Dağıtım'],
  ]);

  it('every role but data_entry reads the whole parent company, grants or not', () => {
    for (const role of ['consultant', 'executive_viewer', 'super_admin'] as const) {
      expect(accessSummary(member({ role, subsidiaryIds: ['den'] }), names, 'tr-TR')).toEqual({ key: 'wholeOrganisation' });
    }
  });

  it('a data_entry user with no grant has no access', () => {
    expect(accessSummary(member(), names, 'tr-TR')).toEqual({ key: 'noAccess' });
  });

  it('names the grants in Turkish name order, never only a count', () => {
    expect(accessSummary(member({ subsidiaryIds: ['den', 'cor'] }), names, 'tr-TR')).toEqual({
      key: 'named',
      names: ['Çorum Dağıtım', 'Denizli Dağıtım'],
      overflow: 0,
      all: ['Çorum Dağıtım', 'Denizli Dağıtım'],
    });
  });

  it('shows three names and counts the rest', () => {
    const summary = accessSummary(member({ subsidiaryIds: ['izm', 'den', 'cor', 'bur', 'ank'] }), names, 'tr-TR');
    expect(summary).toEqual({
      key: 'named',
      names: ['Ankara Dağıtım', 'Bursa Dağıtım', 'Çorum Dağıtım'],
      overflow: 2,
      all: ['Ankara Dağıtım', 'Bursa Dağıtım', 'Çorum Dağıtım', 'Denizli Dağıtım', 'İzmir Dağıtım'],
    });
  });

  it('counts a grant whose subsidiary is not loaded instead of showing its id', () => {
    const summary = accessSummary(member({ subsidiaryIds: ['den', 'unknown-id'] }), names, 'tr-TR');
    expect(summary).toEqual({ key: 'named', names: ['Denizli Dağıtım'], overflow: 1, all: ['Denizli Dağıtım'] });
    expect(JSON.stringify(summary)).not.toContain('unknown-id');
  });
});

describe('subsidiary picker', () => {
  const listed = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('ticks and unticks one subsidiary without repeating it', () => {
    expect(toggleSubsidiary(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleSubsidiary(['a', 'b'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleSubsidiary(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(toggleSubsidiary([], 'a', false)).toEqual([]);
  });

  it('selects every listed subsidiary, from none or from all', () => {
    expect(selectAllSubsidiaries([], listed)).toEqual(['a', 'b', 'c']);
    expect(selectAllSubsidiaries(['b'], listed)).toEqual(['a', 'b', 'c']);
    expect(selectionState(selectAllSubsidiaries([], listed), listed)).toEqual({ count: 3, total: 3, allSelected: true, noneSelected: false });
    expect(selectAllSubsidiaries([], [])).toEqual([]);
  });

  it('select all keeps a grant the list does not show', () => {
    expect(selectAllSubsidiaries(['added-later', 'a'], listed)).toEqual(['added-later', 'a', 'b', 'c']);
  });

  it('counts only listed subsidiaries and says when nothing is ticked', () => {
    expect(selectionState([], listed)).toEqual({ count: 0, total: 3, allSelected: false, noneSelected: true });
    expect(selectionState(['a', 'gone'], listed)).toEqual({ count: 1, total: 3, allSelected: false, noneSelected: false });
    expect(selectionState(['gone'], listed)).toEqual({ count: 0, total: 3, allSelected: false, noneSelected: true });
    expect(selectionState([], [])).toEqual({ count: 0, total: 0, allSelected: false, noneSelected: true });
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
