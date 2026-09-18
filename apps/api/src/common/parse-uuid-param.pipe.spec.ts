import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import {
  canonicalUuid,
  lowercaseUuid,
  ParseUuidParamPipe,
  UUID_SHAPE,
} from './parse-uuid-param.pipe';

const pipe = new ParseUuidParamPipe();

/**
 * The seed uses fixed, human-readable ids so it can stay idempotent across
 * re-runs. They are the ids every user and every E2E spec touches first.
 */
const SEED_IDS = [
  '11111111-1111-1111-1111-111111111111', // organisation
  '22222222-2222-2222-2222-222222220001', // subsidiary
  '33333333-3333-3333-3333-333333330001', // location
];

describe('ParseUuidParamPipe', () => {
  it('accepts the ids Prisma generates', () => {
    const generated = 'acbec45e-cc89-4dc0-bc14-25f5acc525ef';
    expect(pipe.transform(generated)).toBe(generated);
  });

  it.each(SEED_IDS)('accepts the seeded id %s', (id) => {
    expect(pipe.transform(id)).toBe(id);
  });

  it('is why this is not ParseUUIDPipe: class-validator rejects every seeded id', () => {
    // The reason for the custom pipe, pinned so nobody "simplifies" it back to
    // Nest's built-in. `isUUID` enforces the RFC 4122 variant nibble (position
    // 17 ∈ 8/9/a/b) for EVERY version, "all" included, and the seed's ids have
    // `2` there. Swapping this pipe for ParseUUIDPipe would turn
    // `GET /subsidiaries/2222…0001` into a 400.
    for (const id of SEED_IDS) {
      expect(isUUID(id), `${id} unexpectedly satisfies class-validator`).toBe(false);
      expect(pipe.transform(id)).toBe(id);
    }
  });

  it.each([
    'not-a-uuid',
    '',
    '22222222-2222-2222-2222-22222222000', // 11 in the last group
    '22222222-2222-2222-2222-2222222200011', // 13
    '22222222222222222222222222222222', // unhyphenated
    'gggggggg-2222-2222-2222-222222220001', // non-hex
    ' 22222222-2222-2222-2222-222222220001', // padded
  ])('rejects %j with 400, never reaching Prisma', (bad) => {
    expect(() => pipe.transform(bad)).toThrow(BadRequestException);
  });

  it('rejects a non-string without throwing something other than 400', () => {
    expect(() => pipe.transform(undefined as unknown as string)).toThrow(
      BadRequestException,
    );
  });
});

describe('canonicalUuid — the one spelling a caller may use', () => {
  /** Hex LETTERS: an all-digit id makes a case test vacuous. */
  const ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  it('accepts the hyphenated shape in either case and returns it lowercase', () => {
    expect(canonicalUuid(ID)).toBe(ID);
    expect(canonicalUuid(ID.toUpperCase())).toBe(ID);
    // The seed's ids fail RFC 4122's variant check and must still pass.
    expect(canonicalUuid('22222222-2222-2222-2222-222222220001')).toBe(
      '22222222-2222-2222-2222-222222220001',
    );
  });

  it.each([
    ['braced', `{${ID}}`],
    ['urn', `urn:uuid:${ID}`],
    ['unhyphenated', ID.replace(/-/g, '')],
    ['mis-grouped', 'a0eebc999-c0b-4ef8-bb6d-6bb9bd380a11'],
    ['padded', ` ${ID} `],
    ['blank', ''],
    ['a non-hex character', ID.replace('a', 'g')],
  ])('refuses the %s spelling, though Postgres would resolve some of them', (_label, value) => {
    expect(canonicalUuid(value)).toBeNull();
  });

  it('refuses a non-string without throwing', () => {
    for (const value of [undefined, null, 42, {}, [ID]]) {
      expect(canonicalUuid(value)).toBeNull();
    }
  });

  it('is what the route pipe accepts — one shape, two callers', () => {
    expect(UUID_SHAPE.test(canonicalUuid(ID.toUpperCase()) as string)).toBe(true);
    expect(pipe.transform(ID.toUpperCase())).toBe(ID.toUpperCase());
  });

  it('as a transform, lowercases an id and leaves everything else for the validator', () => {
    expect(lowercaseUuid({ value: ID.toUpperCase() })).toBe(ID);
    expect(lowercaseUuid({ value: `{${ID}}` })).toBe(`{${ID}}`);
    expect(lowercaseUuid({ value: null })).toBeNull();
    expect(lowercaseUuid({ value: undefined })).toBeUndefined();
  });
});
