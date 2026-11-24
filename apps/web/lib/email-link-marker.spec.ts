import { describe, expect, it } from 'vitest';
import {
  clearEmailLinkMarker,
  EMAIL_LINK_MARKER_KEY,
  EMAIL_LINK_MARKER_TTL_MS,
  readEmailLinkMarker,
  sessionIdOf,
  writeEmailLinkMarker,
} from './email-link-marker';

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
    removeItem: (k: string) => void values.delete(k),
  };
}
const throwing = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
  removeItem: () => { throw new Error('denied'); },
};

const NOW = 1_800_000_000_000;
const SESSION = 'session-1';

/** An unsigned token with these claims: only the payload is read. */
const tokenWith = (claims: Record<string, unknown>) =>
  `x.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.y`;

describe('the email-link marker (pre-g5-security-hardening)', () => {
  it('reads back what the email-link page wrote, for the same user and session, within the hour', () => {
    const storage = memory();
    writeEmailLinkMarker(storage, 'user-a', SESSION, 'recovery', NOW);
    expect(readEmailLinkMarker(storage, 'user-a', SESSION, NOW + EMAIL_LINK_MARKER_TTL_MS - 1))
      .toEqual({ userId: 'user-a', sessionId: SESSION, flow: 'recovery', at: NOW });
  });

  it('lasts exactly an hour, as an email link\'s one-time token does', () => {
    expect(EMAIL_LINK_MARKER_TTL_MS).toBe(3_600_000);
  });

  it('is nobody else\'s, and no other session\'s of the same person (Codex review)', () => {
    const storage = memory();
    writeEmailLinkMarker(storage, 'user-a', SESSION, 'invite', NOW);
    expect(readEmailLinkMarker(storage, 'user-b', SESSION, NOW)).toBeNull();
    expect(readEmailLinkMarker(storage, undefined, SESSION, NOW)).toBeNull();
    // Signed out and in again with a password, in the same tab: a new session.
    expect(readEmailLinkMarker(storage, 'user-a', 'session-2', NOW)).toBeNull();
    expect(readEmailLinkMarker(storage, 'user-a', null, NOW)).toBeNull();
  });

  it('writes nothing without a session id to bind to', () => {
    const storage = memory();
    writeEmailLinkMarker(storage, 'user-a', null, 'invite', NOW);
    expect(storage.values.size).toBe(0);
  });

  it('expires after an hour, and is not trusted from the future', () => {
    const storage = memory();
    writeEmailLinkMarker(storage, 'user-a', SESSION, 'invite', NOW);
    expect(readEmailLinkMarker(storage, 'user-a', SESSION, NOW + EMAIL_LINK_MARKER_TTL_MS)).toBeNull();
    expect(readEmailLinkMarker(storage, 'user-a', SESSION, NOW - 1)).toBeNull();
  });

  it('reads anything that is not its own shape as no marker', () => {
    const storage = memory();
    for (const raw of ['{', 'null', '42', '"x"', '{"userId":"user-a"}',
      `{"userId":"user-a","sessionId":"${SESSION}","flow":"admin","at":${NOW}}`,
      `{"userId":"user-a","sessionId":"${SESSION}","flow":"invite","at":"${NOW}"}`,
      `{"userId":"user-a","sessionId":"${SESSION}","flow":"invite","at":null}`,
      `{"userId":"user-a","flow":"invite","at":${NOW}}`]) {
      storage.values.set(EMAIL_LINK_MARKER_KEY, raw);
      expect(readEmailLinkMarker(storage, 'user-a', SESSION, NOW), raw).toBeNull();
    }
  });

  it('never throws when storage refuses or is missing', () => {
    expect(() => writeEmailLinkMarker(throwing, 'user-a', SESSION, 'invite', NOW)).not.toThrow();
    expect(readEmailLinkMarker(throwing, 'user-a', SESSION, NOW)).toBeNull();
    expect(() => clearEmailLinkMarker(throwing)).not.toThrow();
    expect(readEmailLinkMarker(null, 'user-a', SESSION, NOW)).toBeNull();
  });

  it('is gone once cleared', () => {
    const storage = memory();
    writeEmailLinkMarker(storage, 'user-a', SESSION, 'invite', NOW);
    clearEmailLinkMarker(storage);
    expect(readEmailLinkMarker(storage, 'user-a', SESSION, NOW)).toBeNull();
  });
});

describe('sessionIdOf', () => {
  it('reads the session_id claim of an access token, base64url included', () => {
    expect(sessionIdOf(tokenWith({ sub: 'user-a', session_id: 'f7c1-??>' }))).toBe('f7c1-??>');
  });

  it('is null for no token, a token without the claim, or one that does not decode', () => {
    for (const token of [undefined, '', 'only-one-part', tokenWith({ sub: 'user-a' }), tokenWith({ session_id: 5 }), 'x.%%%.y']) {
      expect(sessionIdOf(token), String(token)).toBeNull();
    }
  });
});
