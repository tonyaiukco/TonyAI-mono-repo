// The decorators need the metadata shim that `main.ts` normally loads.
import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_UNITS,
  ACTIVITY_UNIT_MAX_LENGTH,
  EXPLANATION_MAX_LENGTH,
  PERIOD_VALUE_MAX_LENGTH,
} from '@tonyai/shared-types';
import { CreateActivityRecordDto } from './create-activity-record.dto';
import { UpdateActivityRecordDto } from './update-activity-record.dto';

/**
 * Both write DTOs, asserted together — hence the topic name rather than one
 * file per class.
 *
 * `UpdateActivityRecordDto` does not extend the create one; the two are
 * hand-maintained twins, and this repo has already paid for that: a validator
 * added to one side only shipped a field the UI offered, the seed wrote and
 * the API rejected, with the suite green.
 *
 * These fields were unbounded `text` with no `@MaxLength` at all until WP8.
 * Over HTTP that was theoretical — a human types into a box. A bulk importer
 * reads cells out of a file it did not write, which is where the
 * multi-megabyte cell actually arrives, so the bound has to exist BEFORE the
 * endpoint that would meet one.
 */
type WriteDto = {
  periodValue?: string;
  activityUnit?: string;
  varianceReason?: string | null;
};

const DTOS: [string, ClassConstructor<WriteDto>][] = [
  ['CreateActivityRecordDto', CreateActivityRecordDto],
  ['UpdateActivityRecordDto', UpdateActivityRecordDto],
];

/**
 * A complete valid body PER CLASS, because the two do not accept the same one.
 * `subsidiaryId` is omitted from the update surface deliberately — a record
 * cannot be moved between subsidiaries — so sending it under the real pipe
 * options is a `whitelistValidation` error, not a pass. An earlier version of
 * this file shared one body and validated with DEFAULT options, which made it
 * assert a shape the HTTP layer refuses; worse, ADDING `subsidiaryId` back to
 * the update DTO would have made it greener.
 */
const VALID: Record<string, Record<string, unknown>> = {
  CreateActivityRecordDto: {
    subsidiaryId: '22222222-2222-2222-2222-222222220001',
    reportingYear: 2026,
    reportingPeriod: 'monthly',
    periodValue: 'January',
    category: 'Electricity',
    activityValue: 1200,
    activityUnit: 'kWh',
  },
  UpdateActivityRecordDto: {
    reportingYear: 2026,
    reportingPeriod: 'monthly',
    periodValue: 'January',
    category: 'Electricity',
    activityValue: 1200,
    activityUnit: 'kWh',
  },
};

/** The options `main.ts` actually installs on the global ValidationPipe. */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

function parse(Dto: ClassConstructor<WriteDto>, body: Record<string, unknown>) {
  const dto = plainToInstance(Dto, { ...VALID[Dto.name], ...body });
  return { dto, errors: validateSync(dto as object, PIPE_OPTIONS) };
}

/**
 * Validate EXACTLY the given body — no complete-body merge.
 *
 * `parse` above spreads `VALID` over every case, which is what makes the
 * boundary tests readable and also what hid `@IsOptional`: every body it has
 * ever built is complete, so removing `@IsOptional` from any field on either
 * class left the whole suite green (verified). A PATCH omitting that field
 * would then have started 400-ing with nothing to say so.
 */
function parseExactly(Dto: ClassConstructor<WriteDto>, body: Record<string, unknown>) {
  return validateSync(plainToInstance(Dto, body) as object, PIPE_OPTIONS);
}

function constraintsOn(
  Dto: ClassConstructor<WriteDto>,
  body: Record<string, unknown>,
  property: string,
) {
  const hit = parse(Dto, body).errors.find((e) => e.property === property);
  return Object.keys(hit?.constraints ?? {});
}

/**
 * The values, pinned as literals.
 *
 * Every other case here derives its boundary from the constant under test
 * (`'x'.repeat(CAP + 1)`), which is pinning a constant to itself: a mutant
 * raising `PERIOD_VALUE_MAX_LENGTH` to 32,000 left the entire 735-test suite
 * green. That is the defect `void-view.spec.ts` already records, and this is
 * the three lines that close it. Changing a number here should be a deliberate
 * edit to a test, not a silent widening.
 */
describe('the caps have the values they claim', () => {
  it('pins them', () => {
    expect(PERIOD_VALUE_MAX_LENGTH).toBe(32);
    expect(ACTIVITY_UNIT_MAX_LENGTH).toBe(32);
    expect(EXPLANATION_MAX_LENGTH).toBe(2000);
  });
});

describe.each(DTOS)('%s — bounded free text', (_name, Dto) => {
  it('accepts every canonical period token', () => {
    for (const value of ['January', 'September', 'Q1', 'Q4', 'Annual']) {
      expect(parse(Dto, { periodValue: value }).errors).toHaveLength(0);
    }
  });

  it('refuses a periodValue past the cap', () => {
    expect(
      parse(Dto, { periodValue: 'x'.repeat(PERIOD_VALUE_MAX_LENGTH) }).errors,
    ).toHaveLength(0);
    expect(
      constraintsOn(
        Dto,
        { periodValue: 'x'.repeat(PERIOD_VALUE_MAX_LENGTH + 1) },
        'periodValue',
      ),
    ).toContain('maxLength');
  });

  it('still refuses an empty periodValue', () => {
    // The cap bounds the other end; it must not have displaced `@MinLength(1)`.
    expect(constraintsOn(Dto, { periodValue: '' }, 'periodValue')).toContain(
      'minLength',
    );
  });

  it('accepts every unit the vocabulary offers, and its longest spelling', () => {
    // The cap must never refuse a unit the engine knows.
    for (const value of [
      ...ACTIVITY_UNITS.map((unit) => unit.value),
      'normal_cubic_metres',
      'standard cubic metres',
    ]) {
      expect(parse(Dto, { activityUnit: value }).errors).toHaveLength(0);
    }
  });

  it('refuses an activityUnit past the cap', () => {
    // This case used to say "even one the vocabulary knows" and reached the
    // cap by padding. It no longer can: `storableUnit` collapses every
    // whitespace run to one space before the cap is measured, and nothing the
    // engine knows is near 32 once normalised — `standard_cubic_metres` is 21.
    // So the cap now refuses only long text that is NOT a unit, which is the
    // honest claim for it. What the cap was reaching for — padding stored
    // verbatim and frozen into an immutable snapshot — the transform removes
    // at any length rather than only above 32.
    expect(
      constraintsOn(
        Dto,
        { activityUnit: 'x'.repeat(ACTIVITY_UNIT_MAX_LENGTH + 1) },
        'activityUnit',
      ),
    ).toEqual(expect.arrayContaining(['maxLength']));
  });

  it('never refuses a spelling the vocabulary accepts, however it is spaced', () => {
    // The other half, and the one that would catch a cap set too low.
    for (const value of [
      'standard_cubic_metres',
      'standard cubic metres',
      `kW${' '.repeat(ACTIVITY_UNIT_MAX_LENGTH * 4)}h`,
    ]) {
      expect(parse(Dto, { activityUnit: value }).errors).toHaveLength(0);
    }
  });

  it('normalises the unit’s whitespace, interior characters included', () => {
    // Built from code points, never typed: escape sequences typed into this
    // repo have arrived in files as the literal, invisible character.
    const char = (code: number) => String.fromCharCode(code);

    // Every one of these is `\s` to JavaScript and so invisible to
    // `canonicalUnit`, which trims AND collapses `\s+` to `_` before it looks
    // a unit up. A run does not have to vanish to be ignored — it maps onto
    // the `_` of a multi-word key — so `us`, a carriage return and `gallons`
    // was a valid TEN-character `us_gallons`, comfortably under the cap, whose
    // raw form was written to `activity_records.activity_unit`, frozen into
    // the immutable calculation snapshot as `inputUnit`, copied into
    // `audit_log` and printed into the PDF, Excel and CSV exports. The cap
    // could not see it and a trim could not reach it.
    for (const code of [0x0d, 0x0a, 0x09, 0x0b, 0x0c, 0x2028, 0x00a0, 0xfeff]) {
      const interior = parse(Dto, { activityUnit: `us${char(code)}gallons` });
      expect(interior.errors).toHaveLength(0);
      expect(interior.dto.activityUnit).toBe('us gallons');

      const surrounding = parse(Dto, { activityUnit: `${char(code)}kWh${char(code)}` });
      expect(surrounding.errors).toHaveLength(0);
      expect(surrounding.dto.activityUnit).toBe('kWh');
    }
  });

  it('leaves case and alias exactly as the user wrote them', () => {
    // The DTO must not lowercase or resolve the alias: the service prices the
    // spelling that was entered and the snapshot keeps it as `inputUnit`.
    // Resolving to the vocabulary's value happens once, at the write —
    // `storedUnit`, covered in `calculations/stored-unit.spec.ts`.
    for (const value of ['kWh', 'm³', 'Sm³', 'kW h', 'standard cubic metres']) {
      expect(parse(Dto, { activityUnit: value }).dto.activityUnit).toBe(value);
    }
  });

  it('still refuses an activityUnit that is only whitespace', () => {
    // The normalisation must not have turned a blank into something
    // `@MinLength(1)` stops seeing: it collapses to '', which fails both rules.
    expect(constraintsOn(Dto, { activityUnit: '   ' }, 'activityUnit')).toEqual(
      expect.arrayContaining(['minLength']),
    );
  });

  it('bounds varianceReason at the shared explanation length', () => {
    expect(
      parse(Dto, { varianceReason: 'x'.repeat(EXPLANATION_MAX_LENGTH) }).errors,
    ).toHaveLength(0);
    expect(
      constraintsOn(
        Dto,
        { varianceReason: 'x'.repeat(EXPLANATION_MAX_LENGTH + 1) },
        'varianceReason',
      ),
    ).toContain('maxLength');
  });

  it('collapses a blank varianceReason to null and trims a real one', () => {
    // An empty cell is the archetypal bulk-import value. Without the
    // transform the column holds three spellings of "no explanation", and the
    // submit gate's `.trim()` is then the only thing telling them apart.
    expect(parse(Dto, { varianceReason: '   ' }).dto.varianceReason).toBeNull();
    expect(parse(Dto, { varianceReason: '' }).dto.varianceReason).toBeNull();
    expect(parse(Dto, { varianceReason: '  Meter replaced  ' }).dto.varianceReason).toBe(
      'Meter replaced',
    );
  });

  it('leaves varianceReason optional — most records never carry one', () => {
    expect(parse(Dto, {}).errors).toHaveLength(0);
    expect(parse(Dto, { varianceReason: undefined }).errors).toHaveLength(0);
  });

  it('refuses a negative activityValue', () => {
    // `@Min(0)` is hand-copied across the twins with no constant to bind them,
    // and a bulk importer is exactly where the first negative cell arrives.
    expect(constraintsOn(Dto, { activityValue: -1 }, 'activityValue')).toContain(
      'min',
    );
    expect(parse(Dto, { activityValue: 0 }).errors).toHaveLength(0);
  });

  it('accepts a unit the engine understands, "kW h" included', () => {
    // The refusal a user actually hit was raised HERE, not in the engine:
    // `@IsActivityUnit` asks `isKnownUnit`, whose alias table could not reach
    // its own `kw h` entry, so an ordinary spelling of kWh was rejected at
    // validation with "is not a unit this system understands" — before any
    // calculation ran. Pinned on the DTO because this is the contract the
    // browser and the bulk importer both meet; the engine's own specs cannot
    // see whether the decorator is still wired to it.
    expect(parse(Dto, { activityUnit: 'kW h' }).errors).toHaveLength(0);
    expect(parse(Dto, { activityUnit: 'kWh' }).errors).toHaveLength(0);
    expect(
      constraintsOn(Dto, { activityUnit: 'furlongs' }, 'activityUnit'),
    ).toContain('isActivityUnit');
  });
});

describe('the two write DTOs agree, rule for rule', () => {
  /**
   * Honest about what this does and does not prove.
   *
   * For the two CAPS it proves little: both classes import the same constant,
   * so parity is structural — the `describe.each` cases above already fail if
   * either class swaps in a literal. It is kept because it is the cheap thing
   * that would notice such a swap as DIVERGENCE rather than as one class's bug.
   *
   * For `@Min(0)` it is the real test: that rule is duplicated by hand, with
   * no constant making the two agree, so deleting it from one class alone is a
   * mutation nothing else here catches.
   */
  it.each([
    ['periodValue', { periodValue: 'x'.repeat(PERIOD_VALUE_MAX_LENGTH + 1) }],
    ['activityUnit', { activityUnit: 'x'.repeat(ACTIVITY_UNIT_MAX_LENGTH + 1) }],
    ['varianceReason', { varianceReason: 'x'.repeat(EXPLANATION_MAX_LENGTH + 1) }],
    ['activityValue', { activityValue: -0.0001 }],
  ])('%s is refused by both classes', (field, body) => {
    for (const [, Dto] of DTOS) {
      expect(constraintsOn(Dto, body, field).length).toBeGreaterThan(0);
    }
  });
});

describe('what each class lets you leave out', () => {
  it('takes an empty PATCH — every field on the update DTO is optional', () => {
    // The update surface's contract: a PATCH changes what it names and nothing
    // else. `{}` is the degenerate case and it must validate, or `@IsOptional`
    // has gone missing from something.
    expect(parseExactly(UpdateActivityRecordDto, {})).toHaveLength(0);
  });

  it.each([
    ['locationId', '33333333-3333-3333-3333-333333330001'],
    ['reportingYear', 2026],
    ['reportingPeriod', 'monthly'],
    ['periodValue', 'January'],
    ['category', 'Electricity'],
    ['activityValue', 1200],
    ['activityUnit', 'kWh'],
    ['input', { invoiceNo: 'A-1' }],
    ['varianceReason', 'Meter replaced'],
  ])('takes a PATCH carrying only %s', (field, value) => {
    expect(parseExactly(UpdateActivityRecordDto, { [field]: value })).toHaveLength(0);
  });

  it.each(['locationId', 'input', 'varianceReason'])(
    'creates a record without %s',
    (field) => {
      // The create DTO's three genuinely optional fields. Its required ones are
      // asserted by every other case here, which all send them.
      const body = { ...VALID.CreateActivityRecordDto };
      delete body[field];
      expect(parseExactly(CreateActivityRecordDto, body)).toHaveLength(0);
    },
  );
});

describe('reporting-entity ids — one spelling, lowercased at the boundary', () => {
  const SUB = 'a2222222-2222-4222-8222-22222222000a';
  const LOC = 'b3333333-3333-4333-8333-33333333000b';

  it('lowercases an UPPERCASE subsidiaryId, which used to miss the access set as a 404', () => {
    const { dto, errors } = parse(CreateActivityRecordDto, { subsidiaryId: SUB.toUpperCase() });
    expect(errors).toHaveLength(0);
    expect((dto as CreateActivityRecordDto).subsidiaryId).toBe(SUB);
  });

  it.each([
    ['braced', `{${SUB}}`],
    ['urn', `urn:uuid:${SUB}`],
    ['unhyphenated', SUB.replace(/-/g, '')],
    ['free text', 'sub-1'],
  ])('refuses a %s subsidiaryId as a 400 — it used to reach Prisma as a P2023, a 500', (_label, subsidiaryId) => {
    expect(constraintsOn(CreateActivityRecordDto, { subsidiaryId }, 'subsidiaryId')).toEqual(
      expect.arrayContaining(['matches']),
    );
  });

  it.each(DTOS)('%s lowercases a locationId, refuses a misspelt one, and still takes none', (_name, Dto) => {
    const upper = parse(Dto, { locationId: LOC.toUpperCase() });
    expect(upper.errors).toHaveLength(0);
    expect((upper.dto as { locationId?: string | null }).locationId).toBe(LOC);

    expect(constraintsOn(Dto, { locationId: `{${LOC}}` }, 'locationId')).toEqual(
      expect.arrayContaining(['matches']),
    );
    // Null / absent means the whole company, and `@IsOptional` must still win.
    expect(parse(Dto, { locationId: null }).errors).toHaveLength(0);
    expect(parse(Dto, {}).errors).toHaveLength(0);
  });

  it('names the field in the sentence, and quotes nothing back', () => {
    const { errors } = parse(CreateActivityRecordDto, { subsidiaryId: '{nope}' });
    const message = Object.values(errors[0].constraints ?? {}).join(' ');
    expect(message).toContain('subsidiaryId is not an id');
    expect(message).not.toContain('nope');
  });
});

describe('import provenance is not a caller field', () => {
  it.each(DTOS)('%s refuses an importBatchId key in the body', (_name, Dto) => {
    // Set only by the importer, server-side (`create(user, dto, provenance)`).
    const { errors } = parse(Dto, { importBatchId: 'a1111111-1111-4111-8111-11111111111a' });
    expect(errors.map((e) => e.property)).toContain('importBatchId');
  });
});
