import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { MAX_LOCATIONS_PER_CREATE } from '@tonyai/shared-types';
import { CreateSubsidiaryDto } from './create-subsidiary.dto';
import { CreateSubsidiaryLocationDto } from '../../locations/dto/create-location.dto';
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

/**
 * Typed to the two fields these cases exercise rather than left to inference.
 * The two classes are no longer key-identical (update alone carries
 * `trackingGranularity`), so an inferred union stopped resolving
 * `plainToInstance`'s overload and every `dto.contactPhone` below became an
 * error on an array type. Naming the shape keeps the twin-DTO coverage — which
 * exists because removing `@Transform` from the update side alone once survived
 * the whole CI gate — instead of quietly dropping to one class.
 */
type ContactBearingDto = { contactEmail?: string | null; contactPhone?: string | null };
const DTOS: [string, ClassConstructor<ContactBearingDto>][] = [
  ['CreateSubsidiaryDto', CreateSubsidiaryDto],
  ['UpdateSubsidiaryDto', UpdateSubsidiaryDto],
];

const CASES: [string, Record<string, unknown>, boolean][] = [
  ['a plain address', { contactEmail: 'aylin.demir@example.com' }, true],
  ['a phone', { contactPhone: '+44 7700 900002' }, true],
  ['a phone over the length cap', { contactPhone: 'x'.repeat(41) }, false],
  ['a plus-addressed mailbox', { contactEmail: 'a.demir+esg@example.com' }, true],
  ['no email at all', {}, true],
  ['an explicit null (this is how a contact is CLEARED)', { contactEmail: null }, true],
  ['a bare word', { contactEmail: 'aylin' }, false],
  ['a missing domain', { contactEmail: 'aylin@' }, false],
  // Blank collapses to null via @Transform, which @IsOptional then skips —
  // so it is ACCEPTED, and means "clear this field". Before the transform an
  // empty phone was stored verbatim, leaving three spellings of "no phone".
  ['whitespace (this is a clear, not a value)', { contactEmail: '   ' }, true],
  // These two rows pin `@IsEmail`'s RFC behaviour, NOT `@MaxLength(320)`.
  // Measured: no input reaches the length rule while `IsEmail` is in front of
  // it — a 556-character address fails both — so `MaxLength` is unreachable
  // defence, kept only for the day someone relaxes the email check. Saying it
  // pinned the length cap would have been a comment asserting coverage that
  // does not exist.
  ['a local part at the RFC limit (64)', { contactEmail: `${'a'.repeat(64)}@example.com` }, true],
  ['a local part one over the limit', { contactEmail: `${'a'.repeat(65)}@example.com` }, false],
];

/**
 * The nested `locations[]` of a subsidiary create (round-1 SUB-3).
 *
 * Driven through the REAL pipe options, because the failure mode here is
 * silence: `whitelist: true` strips any nested object that has no `@Type`, so a
 * missing decorator does not error — the locations simply vanish, the
 * subsidiary is created without them, and nothing anywhere says so. Removing
 * `@ValidateNested`/`@Type` passed the entire unit suite until this existed.
 */
/**
 * `UpdateSubsidiaryDto` is hand-written, not `PartialType(CreateSubsidiaryDto)`
 * — `@nestjs/mapped-types` is deliberately not a dependency, and the update
 * class carries its own reasoning in its docblocks. The cost is that the two
 * can drift, and the shared `UpdateSubsidiaryInput` claims they do not.
 *
 * This costs nothing at runtime and fails `pnpm typecheck` the day someone adds
 * a field to one and forgets the other — at the layer where the mistake is
 * made. It does NOT catch validator drift, or the `| null` mismatch the update
 * DTO's own docblock confesses to; those are a separate cleanup.
 */
type Assert<T extends true> = T;
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
type _UpdateMirrorsCreate = Assert<
  SameKeys<UpdateSubsidiaryDto, Omit<CreateSubsidiaryDto, 'locations'>>
>;

describe('trackingGranularity validation', () => {
  it('rejects a value outside the enum on both DTOs', () => {
    // Deleting `@IsIn(TRACKING_GRANULARITIES)` was a surviving mutant: any
    // string reached Prisma, where the column is a Postgres enum.
    for (const [, Dto] of [
      ['create', CreateSubsidiaryDto],
      ['update', UpdateSubsidiaryDto],
    ] as const) {
      const errors = validateSync(
        plainToInstance(Dto, {
          legalName: 'New Co',
          geographyCode: 'UK',
          trackingGranularity: 'banana',
        }),
      );
      expect(errors).toHaveLength(1);
    }
  });

  it('accepts both declared values', () => {
    for (const value of ['subsidiary', 'location']) {
      expect(
        validateSync(plainToInstance(UpdateSubsidiaryDto, { trackingGranularity: value })),
      ).toHaveLength(0);
    }
  });
});

describe('CreateSubsidiaryDto — nested locations', () => {
  const parse = (locations: unknown) =>
    plainToInstance(
      CreateSubsidiaryDto,
      { legalName: 'New Co', geographyCode: 'UK', locations },
      { excludeExtraneousValues: false },
    );

  it('keeps the nested objects as validated instances, not bare objects', () => {
    const dto = parse([{ name: 'Istanbul HQ', geographyCode: 'TR' }]);
    expect(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
    expect(dto.locations).toHaveLength(1);
    // The `@Type` is what makes this an instance rather than a plain object —
    // and an instance is what the per-location rules run against.
    expect(dto.locations?.[0]).toBeInstanceOf(CreateSubsidiaryLocationDto);
  });

  it('rejects a location with no name', () => {
    const errors = validateSync(parse([{ name: '', geographyCode: 'TR' }]), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors).toHaveLength(1);
  });

  it('rejects a geography the contract does not know', () => {
    expect(
      validateSync(parse([{ name: 'HQ', geographyCode: 'XX' }]), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).toHaveLength(1);
  });

  it('rejects a nested subsidiaryId — a location cannot name its own parent here', () => {
    // Accepting one would let a caller attach a location to somebody else's
    // subsidiary through the create endpoint, which performs no accessible-set
    // check on the nested rows (the parent is being created, so there is none).
    expect(
      validateSync(parse([{ name: 'HQ', geographyCode: 'TR', subsidiaryId: 'sub-1' }]), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).toHaveLength(1);
  });

  it('caps the array at exactly MAX_LOCATIONS_PER_CREATE, from the shared constant', () => {
    // The bound had no CI gate: CI runs unit tests only, so replacing the
    // constant with a literal — or widening it — was visible to E2E alone.
    // Asserted against the exported value rather than a number, so the web form
    // and the API cannot drift apart.
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `Site ${i}`, geographyCode: 'TR' }));
    const opts = { whitelist: true, forbidNonWhitelisted: true } as const;

    expect(validateSync(parse(many(MAX_LOCATIONS_PER_CREATE)), opts)).toHaveLength(0);
    expect(validateSync(parse(many(MAX_LOCATIONS_PER_CREATE + 1)), opts)).toHaveLength(1);
  });

  it('accepts none at all — the FORM requires one, the contract does not', () => {
    const dto = plainToInstance(CreateSubsidiaryDto, { legalName: 'New Co', geographyCode: 'UK' });
    expect(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });

  it('collapses a blank address to null inside a nested location too', () => {
    const dto = parse([{ name: 'HQ', geographyCode: 'TR', address: '   ' }]);
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.locations?.[0].address).toBeNull();
  });
});

describe('subsidiary contact fields — validation', () => {
  it.each(CASES)('create: %s', (_label, body, valid) => {
    expect(createErrors(body)).toHaveLength(valid ? 0 : 1);
  });

  it.each(CASES)('update: %s', (_label, body, valid) => {
    expect(updateErrors(body)).toHaveLength(valid ? 0 : 1);
  });

  // Both DTOs, both fields. These are hand-maintained twins — `Update` does not
  // extend `Create` — and the first cut of this spec exercised the transform on
  // the create side only, so removing `@Transform` from `UpdateSubsidiaryDto`'s
  // phone alone survived the whole CI gate.
  it.each(DTOS)('%s collapses a blank contact to null instead of storing it', (_n, Dto) => {
    for (const blank of ['', '   ', '\t']) {
      const dto = plainToInstance(Dto, {
        legalName: 'New Co', geographyCode: 'UK', contactPhone: blank, contactEmail: blank,
      });
      expect(validateSync(dto)).toHaveLength(0);
      expect(dto.contactPhone).toBeNull();
      expect(dto.contactEmail).toBeNull();
    }
  });

  it.each(DTOS)('%s trims rather than refusing a pasted value with space', (_n, Dto) => {
    const dto = plainToInstance(Dto, {
      legalName: 'New Co', geographyCode: 'UK',
      contactEmail: '  aylin.demir@example.com  ', contactPhone: '  +44 7700 900002  ',
    });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.contactEmail).toBe('aylin.demir@example.com');
    expect(dto.contactPhone).toBe('+44 7700 900002');
  });

  it.each(DTOS)('%s rejects an unknown key rather than dropping it', (_n, Dto) => {
    const errors = validateSync(
      plainToInstance(Dto, { legalName: 'New Co', geographyCode: 'UK', contactMobile: '+90 555' }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors).toHaveLength(1);
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
