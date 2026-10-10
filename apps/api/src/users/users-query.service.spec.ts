import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeUsersCursor, encodeUsersCursor, toUserSummary } from './users-query.service';

describe('the users cursor (LP4-05 contract)', () => {
  it('round-trips the sort key and carries no address, name or tenant', () => {
    const key = { createdAt: new Date('2026-10-10T10:00:00.123Z'), id: randomUUID() };
    const raw = encodeUsersCursor(key);
    expect(decodeUsersCursor(raw)).toEqual(key);
    expect(Buffer.from(raw, 'base64url').toString()).toBe(JSON.stringify({ v: 1, k: 'users', t: key.createdAt.toISOString(), i: key.id }));
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['another endpoint’s cursor', Buffer.from(JSON.stringify({ v: 1, k: 'records', t: '2026-10-10T10:00:00.000Z', i: randomUUID() })).toString('base64url')],
    ['another version', Buffer.from(JSON.stringify({ v: 2, k: 'users', t: '2026-10-10T10:00:00.000Z', i: randomUUID() })).toString('base64url')],
    ['an id that is not one', Buffer.from(JSON.stringify({ v: 1, k: 'users', t: '2026-10-10T10:00:00.000Z', i: "1' OR 1=1" })).toString('base64url')],
    ['a time that is not canonical', Buffer.from(JSON.stringify({ v: 1, k: 'users', t: '2026-10-10', i: randomUUID() })).toString('base64url')],
    ['an over-long value', 'a'.repeat(2049)],
    ['an empty value', ''],
  ])('refuses %s as validation_failed', (_label, raw) => {
    expect(() => decodeUsersCursor(raw)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'validation_failed' }) }));
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
