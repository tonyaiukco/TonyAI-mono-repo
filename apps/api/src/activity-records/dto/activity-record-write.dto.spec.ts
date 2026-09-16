// The decorators need the metadata shim that `main.ts` normally loads.
import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
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
type WriteDto = { periodValue?: string; varianceReason?: string | null };

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
    ['varianceReason', { varianceReason: 'x'.repeat(EXPLANATION_MAX_LENGTH + 1) }],
    ['activityValue', { activityValue: -0.0001 }],
  ])('%s is refused by both classes', (field, body) => {
    for (const [, Dto] of DTOS) {
      expect(constraintsOn(Dto, body, field).length).toBeGreaterThan(0);
    }
  });
});
