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
 * have.
 *
 * Most are caught on length or alphabet before either strip branch runs. The
 * two that carry the weight are `hyphen one place late` and `hyphen one place
 * early`: 36 characters with four hyphens, which a `split('-')` parser accepts
 * and hands a neighbouring id's key to. `grouped in fours` is the same shape a
 * length apart — and is the case where Postgres and Prisma disagree, so it must
 * be refused even though the database itself would read it.
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

  it('leaves trimming to the caller, which is why padding is refused here', () => {
    // These two facts read as a contradiction and are not. Prisma refuses a
    // padded value, so this function must too — but `canonicaliseEntityCells`
    // trims before calling, exactly as every reader of those cells already
    // did, so a padded id in a FILE is still folded. The refusal below is the
    // contract for direct callers, not the importer's behaviour.
    expect(canonicalUuid(` ${ID}`)).toBeNull();
    expect(canonicalUuid(` ${ID}`.trim())).toBe(ID);
  });

  it('leaves an already-canonical id byte for byte', () => {
    // Idempotence is what lets a caller run it over values that may already
    // have been through it — the access set is one.
    expect(canonicalUuid(ID)).toBe(ID);
    expect(canonicalUuid(canonicalUuid(ID) as string)).toBe(ID);
  });

  it('never folds two different ids onto one key', () => {
    // The property that matters more than completeness. Missing a spelling
    // only leaves a duplicate undetected; merging two ids is worse than a
    // refused row, because the caller REWRITES the cell with what this
    // returns — so a fold files the record against a site nobody named.
    //
    // Every one of the 32 hex positions is varied, in every accepted
    // spelling, which is what makes this catch a parser that mislays a
    // character. A first cut varied only the last two nibbles of an
    // already-canonical id: it passed under every loosening mutant, because
    // the function was the identity on all 256 of its inputs and it was
    // really asserting that 256 distinct strings are distinct.
    const nibble = (i: number) => (BARE[i] === '0' ? '1' : '0');
    const variants = Array.from({ length: 32 }, (_, i) =>
      `${BARE.slice(0, i)}${nibble(i)}${BARE.slice(i + 1)}`,
    ).concat(BARE);
    const canonical = new Set<string>();
    for (const bare of variants) {
      const hyphenated = [
        bare.slice(0, 8), bare.slice(8, 12), bare.slice(12, 16),
        bare.slice(16, 20), bare.slice(20),
      ].join('-');
      for (const spelling of [
        hyphenated,
        hyphenated.toUpperCase(),
        `{${hyphenated}}`,
        `urn:uuid:${hyphenated}`,
        bare,
      ]) {
        const folded = canonicalUuid(spelling);
        expect(folded).toBe(hyphenated);
        canonical.add(folded as string);
      }
    }
    // 33 ids, 5 spellings each: one canonical form per id, never fewer.
    expect(canonical.size).toBe(variants.length);
  });

  it('returns the lowercase form the id pipe accepts', () => {
    // `UUID_SHAPE` carries `/i`, so matching it alone would pass on an
    // UPPERCASE output — the exact thing this function exists to remove.
    for (const spelling of Object.values(SAME_ROW)) {
      const folded = canonicalUuid(spelling) as string;
      expect(folded).toMatch(UUID_SHAPE);
      expect(folded).toBe(folded.toLowerCase());
    }
  });
});
