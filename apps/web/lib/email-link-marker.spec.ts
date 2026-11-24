import { describe, expect, it } from 'vitest';
import {
  clearEmailLinkMarker,
  EMAIL_LINK_MARKER_KEY,
  EMAIL_LINK_MARKER_TTL_MS,
  readEmailLinkMarker,
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

describe('the email-link marker (pre-g5-security-hardening)', () => {
  it('reads back what the email-link page wrote, for the same user, within the hour', () => {
    const storage = memory();
    writeEmailLinkMarker(storage, 'user-a', 'recovery', NOW);
    expect(readEmailLinkMarker(storage, 'user-a', NOW + EMAIL_LINK_MARKER_TTL_MS - 1)).toEqual({ userId: 'user-a', flow: 'recovery', at: NOW });
  });

  it('lasts exactly an hour, as an email link\'s one-time token does', () => {
    expect(EMAIL_LINK_MARKER_TTL_MS).toBe(3_600_000);
  });

  it('is nobody else\'s', () => {
    const storage = memory();
    writeEmailLinkMarker(storage, 'user-a', 'invite', NOW);
    expect(readEmailLinkMarker(storage, 'user-b', NOW)).toBeNull();
    expect(readEmailLinkMarker(storage, undefined, NOW)).toBeNull();
  });

  it('expires after an hour, and is not trusted from the future', () => {
    const storage = memory();
    writeEmailLinkMarker(storage, 'user-a', 'invite', NOW);
    expect(readEmailLinkMarker(storage, 'user-a', NOW + EMAIL_LINK_MARKER_TTL_MS)).toBeNull();
    expect(readEmailLinkMarker(storage, 'user-a', NOW - 1)).toBeNull();
  });

  it('reads anything that is not its own shape as no marker', () => {
    const storage = memory();
    for (const raw of ['{', 'null', '42', '"x"', '{"userId":"user-a"}', `{"userId":"user-a","flow":"admin","at":${NOW}}`,
      `{"userId":"user-a","flow":"invite","at":"${NOW}"}`, '{"userId":"user-a","flow":"invite","at":null}']) {
      storage.values.set(EMAIL_LINK_MARKER_KEY, raw);
      expect(readEmailLinkMarker(storage, 'user-a', NOW), raw).toBeNull();
    }
  });

  it('never throws when storage refuses or is missing', () => {
    expect(() => writeEmailLinkMarker(throwing, 'user-a', 'invite', NOW)).not.toThrow();
    expect(readEmailLinkMarker(throwing, 'user-a', NOW)).toBeNull();
    expect(() => clearEmailLinkMarker(throwing)).not.toThrow();
    expect(readEmailLinkMarker(null, 'user-a', NOW)).toBeNull();
  });

  it('is gone once cleared', () => {
    const storage = memory();
    writeEmailLinkMarker(storage, 'user-a', 'invite', NOW);
    clearEmailLinkMarker(storage);
    expect(readEmailLinkMarker(storage, 'user-a', NOW)).toBeNull();
  });
});
