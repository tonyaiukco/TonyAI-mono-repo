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
