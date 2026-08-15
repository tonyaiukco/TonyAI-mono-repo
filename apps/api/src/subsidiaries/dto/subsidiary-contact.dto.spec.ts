import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateSubsidiaryDto } from './create-subsidiary.dto';
import { UpdateSubsidiaryDto } from './update-subsidiary.dto';

/**
 * The contact fields are the only columns on this entity a human is expected to
 * ACT on — someone reads the panel and sends an email — so a value that merely
 * looks like an address is worse than an empty one.
 *
 * These validators live in two hand-maintained DTOs (`UpdateSubsidiaryDto` does
 * not extend the create one), which is exactly how the denominator metric got
 * offered by the UI, written by the seed, and rejected on save with the whole
 * suite green. So both classes are asserted here, together.
 */
function createErrors(body: Record<string, unknown>) {
  return validateSync(
    plainToInstance(CreateSubsidiaryDto, {
      legalName: 'New Co',
      geographyCode: 'UK',
      ...body,
    }),
  );
}

function updateErrors(body: Record<string, unknown>) {
  return validateSync(plainToInstance(UpdateSubsidiaryDto, body));
}

const CASES: [string, Record<string, unknown>, boolean][] = [
  ['a plain address', { contactEmail: 'aylin.demir@example.com' }, true],
  ['a plus-addressed mailbox', { contactEmail: 'a.demir+esg@example.com' }, true],
  ['no email at all', {}, true],
  ['an explicit null (this is how a contact is CLEARED)', { contactEmail: null }, true],
  ['a bare word', { contactEmail: 'aylin' }, false],
  ['a missing domain', { contactEmail: 'aylin@' }, false],
  ['whitespace', { contactEmail: '   ' }, false],
  // RFC 5321 caps the local part at 64 and `@IsEmail` enforces that on its own
  // — measured, so `MaxLength(320)` is belt-and-braces rather than the binding
  // constraint. Pinned because a future switch to a laxer email check would
  // leave that column as the only thing between a paste accident and an
  // unbounded `text` write.
  ['a local part at the RFC limit (64)', { contactEmail: `${'a'.repeat(64)}@example.com` }, true],
  ['a local part one over the limit', { contactEmail: `${'a'.repeat(65)}@example.com` }, false],
];

describe('subsidiary contact fields — validation', () => {
  it.each(CASES)('create: %s', (_label, body, valid) => {
    expect(createErrors(body)).toHaveLength(valid ? 0 : 1);
  });

  it.each(CASES)('update: %s', (_label, body, valid) => {
    expect(updateErrors(body)).toHaveLength(valid ? 0 : 1);
  });

  it('keeps the phone a free string — no format is safe to assume', () => {
    // Turkish, UK and German numbers all appear in the seed alone, and
    // normalising would mangle extensions. Length is the only real bound.
    for (const contactPhone of ['+90 555 000 0001', '+44 7700 900002', '0212 000 00 00 / 123']) {
      expect(createErrors({ contactPhone })).toHaveLength(0);
    }
    expect(createErrors({ contactPhone: 'x'.repeat(41) })).toHaveLength(1);
  });

  it('rejects an unknown key outright, rather than dropping it silently', () => {
    // `ValidationPipe` runs with `whitelist + forbidNonWhitelisted`, so a web
    // client that ships a field before the API declares it gets a 400 it can
    // see — not a save that quietly loses data.
    const errors = validateSync(
      plainToInstance(CreateSubsidiaryDto, {
        legalName: 'New Co',
        geographyCode: 'UK',
        contactMobile: '+90 555 000 0001',
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors).toHaveLength(1);
  });
});
