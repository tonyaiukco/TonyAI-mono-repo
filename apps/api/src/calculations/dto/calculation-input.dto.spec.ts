// The decorators need the metadata shim that `main.ts` normally loads.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_UNITS,
  ACTIVITY_UNIT_MAX_LENGTH,
  CATEGORIES,
  GEOGRAPHY_CODES,
  SELECTABLE_GEOGRAPHY_CODES,
} from '@tonyai/shared-types';
import { CalculationInputDto } from './calculation-input.dto';

/**
 * The preview endpoint's body.
 *
 * Unlike the record write DTOs this one is a leaf — `POST
 * /api/v1/calculations/preview` is its only binding site — so nothing else in
 * the suite would notice a validator going missing here. It is also the one
 * calculation path whose `category`, `geographyCode` and `unit` arrive from the
 * request body rather than from a database row, which is what these cases are
 * about: every value below reaches the factor lookup, and a miss is answered by
 * a sentence that repeats the value.
 */

/** A complete, valid body — the shape the Data Entry page actually sends. */
const VALID: Record<string, unknown> = {
  category: 'Electricity',
  geographyCode: 'UK',
  reportingYear: 2026,
  value: 1200,
  unit: 'kWh',
};

/**
 * The two `ValidatorOptions` from the global pipe in `main.ts`. Its third
 * option, `transform`, belongs to the pipe rather than to the validator and is
 * installed with no `transformOptions`, so implicit conversion is off and
 * `plainToInstance` here behaves as the pipe's own does — verified: a string
 * `reportingYear` errors under both.
 */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

function parse(body: Record<string, unknown>) {
  const dto = plainToInstance(CalculationInputDto, { ...VALID, ...body });
  return { dto, errors: validateSync(dto as object, PIPE_OPTIONS) };
}

function constraintsOn(body: Record<string, unknown>, property: string) {
  const hit = parse(body).errors.find((e) => e.property === property);
  return Object.keys(hit?.constraints ?? {});
}

/**
 * The value, pinned as a literal.
 *
 * Every boundary case below derives its edge from the constant under test
 * (`padEnd(CAP + 1)`), which is pinning a constant to itself: raising the cap
 * would leave them all green. Changing this number should be a deliberate edit
 * to a test.
 */
describe('the cap has the value it claims', () => {
  it('pins it', () => {
    expect(ACTIVITY_UNIT_MAX_LENGTH).toBe(32);
  });
});

describe('CalculationInputDto', () => {
  it('accepts the body the Data Entry page sends', () => {
    expect(parse({}).errors).toHaveLength(0);
  });

  it('requires every field, so none can arrive undefined', () => {
    // Not a spare case. `findFactor` passes these straight into Prisma's
    // `where`, and Prisma reads an `undefined` key as FILTER ABSENT — an
    // undefined category would match the newest factor of ANY category and
    // return a confident preview computed from the wrong one. Nothing today
    // makes a field optional; this is what would notice if something did.
    const errors = validateSync(
      plainToInstance(CalculationInputDto, {}) as object,
      PIPE_OPTIONS,
    );
    expect(errors.map((e) => e.property).sort()).toEqual([
      'category',
      'geographyCode',
      'reportingYear',
      'unit',
      'value',
    ]);
  });

  it('refuses an unknown field, as the real pipe does', () => {
    expect(constraintsOn({ subsidiaryId: 'x' }, 'subsidiaryId')).toContain(
      'whitelistValidation',
    );
  });
});

describe('CalculationInputDto — category vocabulary', () => {
  it('accepts every category the vocabulary offers', () => {
    // The same constant `CreateActivityRecordDto` binds, so preview and save
    // agree on the set by construction, not by coincidence.
    for (const category of CATEGORIES) {
      expect(parse({ category }).errors).toHaveLength(0);
    }
  });

  it('refuses a category outside the vocabulary', () => {
    expect(constraintsOn({ category: 'Electricty' }, 'category')).toContain(
      'isIn',
    );
  });

  it('refuses a category that is merely long, before it reaches the lookup', () => {
    // The point of the vocabulary check: an arbitrary body can no longer put
    // arbitrary text into the 404 that names the category it could not find.
    expect(constraintsOn({ category: 'x'.repeat(5000) }, 'category')).toContain(
      'isIn',
    );
  });
});

describe('CalculationInputDto — geography vocabulary', () => {
  it('accepts every geography code the API recognises', () => {
    for (const geographyCode of GEOGRAPHY_CODES) {
      expect(parse({ geographyCode }).errors).toHaveLength(0);
    }
  });

  it('accepts EU, which is valid but deliberately not selectable', () => {
    // The regression this file exists to prevent. SELECTABLE_GEOGRAPHY_CODES
    // hides EU from pickers while it stays valid at the API, in the factor
    // table and on every existing record; validating against that narrower
    // list instead would 400 every preview for an EU-geography entity — the
    // seeded Munich subsidiary among them — while looking correct.
    expect(SELECTABLE_GEOGRAPHY_CODES).not.toContain('EU');
    expect(GEOGRAPHY_CODES).toContain('EU');
    expect(parse({ geographyCode: 'EU' }).errors).toHaveLength(0);
  });

  it('refuses a geography outside the vocabulary', () => {
    expect(constraintsOn({ geographyCode: 'ZZ' }, 'geographyCode')).toContain(
      'isIn',
    );
  });

  it('refuses the ISO spelling of the United Kingdom', () => {
    // `GB` is the ISO-3166 code; this system's vocabulary says `UK`. Worth a
    // case because it is the plausible wrong value, not a hostile one.
    expect(constraintsOn({ geographyCode: 'GB' }, 'geographyCode')).toContain(
      'isIn',
    );
  });
});

describe('CalculationInputDto — unit', () => {
  it('accepts every unit the vocabulary offers, and its longest spelling', () => {
    // The cap must never refuse a unit the engine knows.
    for (const unit of [
      ...ACTIVITY_UNITS.map((u) => u.value),
      'normal_cubic_metres',
      'standard cubic metres',
    ]) {
      expect(parse({ unit }).errors).toHaveLength(0);
    }
  });

  it('refuses a unit past the cap, even one the vocabulary knows', () => {
    // Padding keeps the unit KNOWN (`canonicalUnit` trims and collapses
    // whitespace), so only the cap can refuse it — and only at 33. Without it
    // this DTO was the one path that could still send an unbounded unit into
    // the refusals that quote it back.
    const known = (length: number) => 'kWh'.padEnd(length);
    expect(parse({ unit: known(ACTIVITY_UNIT_MAX_LENGTH) }).errors).toHaveLength(
      0,
    );
    expect(
      constraintsOn({ unit: known(ACTIVITY_UNIT_MAX_LENGTH + 1) }, 'unit'),
    ).toEqual(['maxLength']);
  });

  it('refuses an unknown unit that fits the cap', () => {
    // The complement of the case above: at exactly the cap, the vocabulary is
    // what refuses, so neither check is standing in for the other.
    expect(
      constraintsOn({ unit: 'furlongs'.padEnd(ACTIVITY_UNIT_MAX_LENGTH) }, 'unit'),
    ).toEqual(['isActivityUnit']);
  });

  it('refuses an empty unit', () => {
    // The cap bounds the other end; it must not have displaced `@MinLength(1)`.
    expect(constraintsOn({ unit: '' }, 'unit')).toContain('minLength');
  });

  it('refuses a unit the engine does not know', () => {
    expect(constraintsOn({ unit: 'furlongs' }, 'unit')).toContain(
      'isActivityUnit',
    );
  });
});

describe('CalculationInputDto — the fields that were already bounded', () => {
  it('holds the reporting year inside the factor library era', () => {
    expect(parse({ reportingYear: 2000 }).errors).toHaveLength(0);
    expect(parse({ reportingYear: 2100 }).errors).toHaveLength(0);
    expect(constraintsOn({ reportingYear: 1999 }, 'reportingYear')).toContain(
      'min',
    );
    expect(constraintsOn({ reportingYear: 2101 }, 'reportingYear')).toContain(
      'max',
    );
  });

  it('refuses a negative activity value, and accepts a zero one', () => {
    expect(constraintsOn({ value: -1 }, 'value')).toContain('min');
    // Both halves, because zero is a real reading — a closed site, a month
    // with no fuel bought — and the save DTO takes it. Asserting only the
    // refusal let `@Min(0)` become `@Min(1)` unnoticed, which is precisely the
    // preview/save divergence this file exists to rule out.
    expect(parse({ value: 0 }).errors).toHaveLength(0);
  });

  it('refuses a fractional reporting year', () => {
    expect(constraintsOn({ reportingYear: 2024.5 }, 'reportingYear')).toContain(
      'isInt',
    );
  });
});
