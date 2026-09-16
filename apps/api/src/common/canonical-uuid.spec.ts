import { describe, it, expect } from 'vitest';
import { canonicalUuid } from './canonical-uuid';
import { UUID_SHAPE } from './parse-uuid-param.pipe';

/**
 * Hex LETTERS, not the seed's all-digit ids: a uuid of digits alone makes the
 * uppercase cases identical to the lowercase ones, and every case test passes
 * while testing nothing.
 */
const ID = '09ed17d3-aef5-4da2-89c1-3b001ac50e94';
const BARE = ID.replace(/-/g, '');

/**
 * The spellings Prisma resolves to ONE row, measured against the local stack
 * (Prisma 6.19 / Postgres 17) by reading a seeded row back through the API's
 * own client. The table in `canonical-uuid.ts` records the full measurement,
 * including where Postgres is more liberal than Prisma.
 */
const SAME_ROW: Record<string, string> = {
  hyphenated: ID,
  'hyphenated, upper': ID.toUpperCase(),
  'hyphenated, mixed': '09ED17d3-AEF5-4da2-89C1-3b001AC50E94',
  braced: `{${ID}}`,
  'braced, upper': `{${ID.toUpperCase()}}`,
  urn: `urn:uuid:${ID}`,
  'urn, upper hex': `urn:uuid:${ID.toUpperCase()}`,
  unhyphenated: BARE,
  'unhyphenated, upper': BARE.toUpperCase(),
};

/**
 * Every one of these is refused BY PRISMA — `P2023`, before Postgres sees it —
 * so folding any of them would invent an equivalence the database does not
 * have. The last three are the dangerous shape: 36 characters with four
 * hyphens, which a `split('-')` parser would happily accept and hand a
 * neighbouring id's key to.
 */
const NOT_THE_SAME_ROW: Record<string, string> = {
  'braced unhyphenated': `{${BARE}}`,
  'grouped in fours': BARE.replace(/(.{4})/g, '$1-').slice(0, -1),
  'URN:UUID: prefix': `URN:UUID:${ID}`,
  'mixed-case urn prefix': `Urn:Uuid:${ID}`,
  'urn unhyphenated': `urn:uuid:${BARE}`,
  'braced urn': `{urn:uuid:${ID}}`,
  'uuid: prefix': `uuid:${ID}`,
  'double braces': `{{${ID}}}`,
  'open brace only': `{${ID}`,
  'leading space': ` ${ID}`,
  'trailing space': `${ID} `,
  'one character short': ID.slice(0, -1),
  'one character long': `${ID}0`,
  'non-hex character': ID.replace(/[0-9a-f]/, 'g'),
  'underscore for hyphen': ID.replace('-', '_'),
  empty: '',
  'not a uuid at all': 'sub-1',
  // 36 characters, four hyphens, wrong positions.
  'hyphen one place late': `${BARE.slice(0, 9)}-${BARE.slice(9, 12)}-${BARE.slice(12, 16)}-${BARE.slice(16, 20)}-${BARE.slice(20)}`,
  'hyphen one place early': `${BARE.slice(0, 7)}-${BARE.slice(7, 12)}-${BARE.slice(12, 16)}-${BARE.slice(16, 20)}-${BARE.slice(20)}`,
  'thirty-six hex characters': `${BARE}0000`,
};

describe('canonicalUuid', () => {
  for (const [label, spelling] of Object.entries(SAME_ROW)) {
    it(`folds ${label} onto the stored spelling`, () => {
      expect(canonicalUuid(spelling)).toBe(ID);
    });
  }

  for (const [label, spelling] of Object.entries(NOT_THE_SAME_ROW)) {
    it(`refuses ${label}, which Prisma refuses too`, () => {
      expect(canonicalUuid(spelling)).toBeNull();
    });
  }

  it('leaves an already-canonical id byte for byte', () => {
    // Idempotence is what lets a caller run it over values that may already
    // have been through it — the access set is one.
    expect(canonicalUuid(ID)).toBe(ID);
    expect(canonicalUuid(canonicalUuid(ID) as string)).toBe(ID);
  });

  it('never folds two different ids onto one key', () => {
    // The property that matters more than completeness: missing a spelling
    // leaves a duplicate undetected, but merging two ids REFUSES a legitimate
    // row. Every distinct id must keep a distinct canonical form.
    const ids = Array.from(
      { length: 256 },
      (_, n) => `09ed17d3-aef5-4da2-89c1-3b001ac50${n.toString(16).padStart(3, '0')}`,
    );
    const canonical = new Set(ids.map((id) => canonicalUuid(id)));
    expect(canonical.size).toBe(ids.length);
  });

  it('returns a form the id pipe accepts', () => {
    // These two must not drift: this produces the one spelling that validates.
    for (const spelling of Object.values(SAME_ROW)) {
      expect(canonicalUuid(spelling)).toMatch(UUID_SHAPE);
    }
  });
});
