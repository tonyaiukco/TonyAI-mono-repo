// The decorators need the metadata shim that `main.ts` normally loads.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { BulkUploadOptionsDto } from './bulk-upload-options.dto';

/**
 * One boolean, and it decides whether up to a thousand irreversible audited
 * writes happen. It had no spec, and three mutations proved what that meant:
 * replacing the transform with `Boolean(value)`, deleting `@IsBoolean()`, or
 * flipping the true branch to `return false` each passed all 819 tests. The
 * last one means a user who ticks "dry run" gets a real import.
 *
 * Driven through the options `main.ts` installs, not the defaults.
 */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true } as const;

function parse(body: unknown) {
  const dto = plainToInstance(BulkUploadOptionsDto, body);
  return { dto, errors: validateSync(dto as object, PIPE_OPTIONS) };
}

describe('BulkUploadOptionsDto', () => {
  it('reads the two spellings a form actually sends', () => {
    expect(parse({ dryRun: 'true' })).toMatchObject({
      dto: { dryRun: true },
      errors: [],
    });
    expect(parse({ dryRun: 'false' })).toMatchObject({
      dto: { dryRun: false },
      errors: [],
    });
  });

  it('reads real booleans, for a programmatic caller', () => {
    expect(parse({ dryRun: true }).dto.dryRun).toBe(true);
    expect(parse({ dryRun: false }).dto.dryRun).toBe(false);
  });

  it.each([
    ['1', 'truthy in JS, and not a spelling of true'],
    ['0', 'FALSY as a number but TRUTHY as a string — the classic'],
    ['yes', 'a person would write this'],
    ['on', 'what an HTML checkbox sends'],
    ['TRUE', 'case matters: guessing here is guessing about a write'],
    ['True', 'same'],
    [' true ', 'whitespace is not a spelling either'],
    ['maybe', 'a typo must fail loudly'],
  ])('refuses %s rather than guessing', (value) => {
    // Every one of these is truthy or falsy under `Boolean()`, which is why
    // the transform is an allow-list and not a cast.
    expect(parse({ dryRun: value }).errors).toHaveLength(1);
  });

  it('refuses a repeated field, which arrives as an array', () => {
    expect(parse({ dryRun: ['true', 'false'] }).errors).toHaveLength(1);
  });

  it('REQUIRES the flag — an omitted one is a 400, not a default', () => {
    // `@Transform` never fires for a key absent from the body, so there is no
    // default to fall back on, and that is the right contract: a caller who
    // did not say which one they meant should be told, not guessed at.
    expect(parse({}).errors).toHaveLength(1);
  });

  it('refuses an unknown field beside it', () => {
    expect(parse({ dryRun: 'true', force: 'true' }).errors).toHaveLength(1);
  });
});
