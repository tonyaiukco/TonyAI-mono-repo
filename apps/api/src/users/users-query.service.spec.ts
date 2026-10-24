import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cursorBinding, decodeCursor, encodeCursor } from '../common/keyset-cursor';
import { toUserSummary, USERS_SORT } from './users-query.service';

describe('the users cursor (LP4-05 contract, the shared keyset helper)', () => {
  const binding = cursorBinding(USERS_SORT, {});

  it('round-trips the sort key and carries no address, name or tenant', () => {
    const key = [new Date('2026-10-10T10:00:00.123Z'), randomUUID()] as const;
    const raw = encodeCursor(USERS_SORT, binding, key);
    expect(decodeCursor(USERS_SORT, binding, raw)).toEqual([...key]);
    expect(JSON.parse(Buffer.from(raw, 'base64url').toString())).toEqual({
      v: 2, k: 'users', b: binding, s: [key[0].toISOString(), key[1]],
    });
  });

  it('refuses a version-1 cursor of the list before PR C', () => {
    const v1 = Buffer.from(JSON.stringify({ v: 1, k: 'users', t: '2026-10-10T10:00:00.000Z', i: randomUUID() })).toString('base64url');
    expect(() => decodeCursor(USERS_SORT, binding, v1)).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'validation_failed' }) }),
    );
  });
});

describe('toUserSummary', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'u', email: 'a@b.test', fullName: 'A', role: 'data_entry' as const, language: 'tr', disabledAt: null,
    authSyncPendingSince: null, createdAt: new Date('2026-10-10T09:00:00.000Z'), subsidiaryAccess: [{ subsidiaryId: 's' }],
    invitation: null, ...over,
  });
  const invitation = (status: 'pending' | 'sent' | 'accepted' | 'revoked') => ({
    status, language: 'en', attempts: 1, lastErrorStep: null, lastErrorCode: null, lastAttemptAt: null, sentAt: null, acceptedAt: null,
  });

  it('is disabled first, then invited until accepted, else active', () => {
    expect(toUserSummary(row()).status).toBe('active');
    expect(toUserSummary(row({ invitation: invitation('sent') })).status).toBe('invited');
    expect(toUserSummary(row({ invitation: invitation('accepted') })).status).toBe('active');
    expect(toUserSummary(row({ invitation: invitation('sent'), disabledAt: new Date() })).status).toBe('disabled');
  });

  it('flags a pending Auth step and reads an unsupported stored language as the default', () => {
    const s = toUserSummary(row({ authSyncPendingSince: new Date(), language: 'de' }));
    expect(s).toMatchObject({ authSyncPending: true, language: 'en', subsidiaryIds: ['s'], createdAt: '2026-10-10T09:00:00.000Z' });
  });
});
