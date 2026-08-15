import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ParseUuidParamPipe } from './parse-uuid-param.pipe';

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
