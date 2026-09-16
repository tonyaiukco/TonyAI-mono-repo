// The decorators need the metadata shim that `main.ts` normally loads.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { BULK_SUBMIT_MAX_IDS } from '@tonyai/shared-types';
import { BulkSubmitActivityRecordsDto } from './bulk-submit-activity-records.dto';

/** The options `main.ts` installs on the global ValidationPipe. */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true } as const;

function parse(body: unknown) {
  const dto = plainToInstance(BulkSubmitActivityRecordsDto, body);
  return validateSync(dto as object, PIPE_OPTIONS);
}

const ID = '11111111-1111-1111-1111-111111111111';
/** The seed's own ids: valid hex, but NOT RFC 4122 — `2` in the variant slot. */
const SEED_ID = '22222222-2222-2222-2222-222222220001';
/**
 * Hex LETTERS: both ids above are all digits, so `toUpperCase()` returns them
 * unchanged and a case test written with either proves nothing at all.
 */
const LETTERED_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

describe('BulkSubmitActivityRecordsDto', () => {
  it('accepts a list of record ids', () => {
    expect(parse({ recordIds: [ID, SEED_ID] })).toHaveLength(0);
  });

  it('accepts the seed’s non-RFC-4122 ids', () => {
    // `@IsUUID` would reject these — and they are the ids every demo, every
    // UAT walkthrough and every E2E spec uses. The pipe's own docblock records
    // the same trap.
    expect(parse({ recordIds: [SEED_ID] })).toHaveLength(0);
  });

  it('accepts an id spelled in any case, which the service then folds', () => {
    // The premise `BulkSubmitService` rests on, and nothing else in the repo
    // pinned it: dropping the `/i` flag from `UUID_SHAPE` left all 1,409 api
    // tests green while turning this request into a 400 and the service's
    // canonicalisation into dead code.
    expect(LETTERED_ID).not.toBe(LETTERED_ID.toUpperCase());
    expect(parse({ recordIds: [LETTERED_ID.toUpperCase()] })).toHaveLength(0);
    expect(
      parse({ recordIds: ['A0eeBC99-9c0B-4ef8-BB6d-6bb9BD380a11'] }),
    ).toHaveLength(0);
  });

  it.each([
    ['braced', `{${LETTERED_ID}}`],
    ['urn', `urn:uuid:${LETTERED_ID}`],
    ['unhyphenated', LETTERED_ID.replace(/-/g, '')],
  ])('refuses the %s spelling, though it names a real row', (_, spelling) => {
    // Deliberate, and the asymmetry with the IMPORT is the point: the import
    // reads cells a person typed into a spreadsheet, this route reads ids the
    // API handed to its own client. `canonicalUuid` resolves all three, so
    // this is the DTO choosing to stay narrow, not a limit of the fold.
    expect(parse({ recordIds: [spelling] })).toHaveLength(1);
  });

  it('refuses an id Prisma would choke on', () => {
    // A malformed id reaching a `uuid` column is P2023, which the exception
    // filter renders as a 500.
    expect(parse({ recordIds: ['not-a-uuid'] })).toHaveLength(1);
    expect(parse({ recordIds: [ID, 'nope'] })).toHaveLength(1);
    expect(parse({ recordIds: [`${ID}x`] })).toHaveLength(1);
  });

  it('refuses an empty list rather than reading it as "all"', () => {
    // The one interpretation of `[]` nobody wants.
    expect(parse({ recordIds: [] })).toHaveLength(1);
    expect(parse({})).toHaveLength(1);
  });

  it('refuses a list past the cap', () => {
    const atCap = Array.from({ length: BULK_SUBMIT_MAX_IDS }, () => ID);
    expect(parse({ recordIds: atCap })).toHaveLength(0);
    expect(parse({ recordIds: [...atCap, ID] })).toHaveLength(1);
  });

  it('pins the cap to a literal', () => {
    // Deriving the boundary from the constant under test proves only that the
    // import worked. Raising it also means setting an explicit body-parser
    // limit — a thousand ids is ~39 KB against Express's unconfigured 100 KB.
    expect(BULK_SUBMIT_MAX_IDS).toBe(1000);
  });

  it('refuses an unknown field beside the ids', () => {
    expect(parse({ recordIds: [ID], force: true })).toHaveLength(1);
  });

  it('refuses something that is not a list at all', () => {
    expect(parse({ recordIds: ID })).toHaveLength(1);
    expect(parse({ recordIds: null })).toHaveLength(1);
  });
});
