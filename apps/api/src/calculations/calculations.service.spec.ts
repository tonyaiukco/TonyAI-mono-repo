import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { EmissionFactor } from '@tonyai/db';
import {
  isCalculated,
  type ActivityCalculationSnapshot,
  type CalculationResult,
  type UncalculatedSnapshot,
} from '@tonyai/shared-types';
import { CalculationsService } from './calculations.service';
import { CALLER_TEXT_QUOTE_MAX_LENGTH } from '../common/caller-text';
import { PrismaService } from '../prisma/prisma.service';
import {
  blockedUnitReason,
  canonicalUnit,
  isKnownUnit,
  normalize,
  UNIT_ALIAS_SPELLINGS,
} from './normalization';

/**
 * Assert the snapshot carries a real figure, and narrow to it.
 *
 * Deliberately an assertion rather than a cast: `as CalculationResult` would
 * compile against the uncalculated shape too, so a regression that silently
 * stopped calculating Electricity would keep every one of these specs green
 * while every `expect(...).toBeCloseTo` compared `undefined` to a number.
 */
function expectCalculated(
  snapshot: ActivityCalculationSnapshot,
): CalculationResult {
  expect(isCalculated(snapshot)).toBe(true);
  return snapshot as CalculationResult;
}

// Local Prisma mock: only the emissionFactor surface the service touches. No DB.
function createFactorPrismaMock() {
  return {
    emissionFactor: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  };
}
type FactorPrismaMock = ReturnType<typeof createFactorPrismaMock>;

let seq = 0;
function makeFactor(overrides: Partial<EmissionFactor> = {}): EmissionFactor {
  seq += 1;
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: `factor-${seq}`,
    category: 'Electricity',
    geographyCode: 'TR',
    reportingYear: 2024,
    scope: 2,
    factorValue: 0.44,
    factorUnit: 'kgCO2e/kWh',
    normalizedUnit: 'kWh',
    methodology: 'location-based',
    source: 'calculation_logic.md §3',
    version: '2024.1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as EmissionFactor;
}

describe('normalize (calculation_logic.md §2)', () => {
  it('passes through the electricity base unit (kWh) with no conversion', () => {
    expect(normalize(1000, 'kWh')).toEqual({
      normalizedValue: 1000,
      normalizedUnit: 'kWh',
      conversionApplied: false,
    });
  });

  it('converts electricity MWh -> kWh (×1000)', () => {
    const r = normalize(5, 'mwh');
    expect(r.normalizedValue).toBe(5000);
    expect(r.normalizedUnit).toBe('kWh');
    expect(r.conversionApplied).toBe(true);
  });

  it('converts natural gas cubic_metres -> kWh (×11.36)', () => {
    const r = normalize(100, 'cubic_metres');
    expect(r.normalizedValue).toBeCloseTo(1136, 6);
    expect(r.normalizedUnit).toBe('kWh');
    expect(r.conversionApplied).toBe(true);
  });

  it('accepts the m³ alias for cubic_metres', () => {
    expect(normalize(100, 'm³').normalizedValue).toBeCloseTo(1136, 6);
  });

  it('accepts kWh written with a space — "kW h"', () => {
    // Regression: the alias was declared `'kw h'`, but the lookup only ever asks
    // for the whitespace-collapsed form (`kw_h`). The entry was unreachable, so
    // a user typing `kW h` had an ordinary spelling of kWh refused outright as
    // a unit the system does not understand.
    expect(isKnownUnit('kW h')).toBe(true);
    expect(normalize(1000, 'kW h')).toEqual({
      normalizedValue: 1000,
      normalizedUnit: 'kWh',
      conversionApplied: false,
    });
  });

  it('resolves spacing and casing variants of kWh onto one canonical unit', () => {
    for (const spelling of ['kW h', 'KW  H', ' kWh ', 'kwh']) {
      expect(canonicalUnit(spelling)).toBe('kwh');
    }
  });

  it('accepts every alias spelling the table declares', () => {
    // The table is written in human spellings while the lookup is keyed by the
    // canonical form, so a spelling can survive declaration and still never
    // match — failing only when a real user types it. Assert the whole table
    // rather than the single entry that happened to be caught, which also
    // catches an alias pointing at a rule key that does not exist.
    const unreachable = Object.keys(UNIT_ALIAS_SPELLINGS).filter(
      (spelling) => !isKnownUnit(spelling),
    );
    expect(unreachable).toEqual([]);
  });

  it('resolves every alias spelling to the rule key it declares', () => {
    // Deriving the keys trades one silent failure for another: two spellings
    // that clean to the SAME key now overwrite each other, last declaration
    // wins, and TypeScript cannot see it (literal duplicate keys are an error;
    // `'uk gallon'` shadowing `uk_gallon` is not). Both stay *known*, so the
    // reachability check above passes. Only comparing each spelling against
    // the rule key it declared catches the shadowed one — and the damage is a
    // wrong figure, not a refusal: `'uk gallon': 'us_gallons'` silently prices
    // UK gallons 20% light.
    //
    // Scope, precisely: this catches a spelling SHADOWED by another, and the
    // check above catches a spelling that resolves nowhere. Neither can catch
    // a lone MIS-declared alias (`'sm³': 'cubic_metres'`), because both read
    // the same declaration they are checking — that needs the independent
    // oracle in the blocked-unit case below.
    const misresolved = Object.entries(UNIT_ALIAS_SPELLINGS).filter(
      ([spelling, ruleKey]) => canonicalUnit(spelling) !== ruleKey,
    );
    expect(misresolved).toEqual([]);
  });

  it('resolves each alias spelled with spaces, as a user would type it', () => {
    // The whole bug was a spelling written with a space never reaching the
    // lookup, yet nearly every declared key is already underscored — so the
    // checks above would still pass if `cleanUnitToken` DELETED whitespace
    // instead of collapsing it to `_`, and `standard cubic metres` would break
    // with the suite green. Retyping each key the human way exercises the
    // cleaning step itself rather than the table.
    const broken = Object.entries(UNIT_ALIAS_SPELLINGS).filter(
      ([spelling, ruleKey]) =>
        canonicalUnit(spelling.replace(/_/g, ' ')) !== ruleKey,
    );
    expect(broken).toEqual([]);
  });

  // An INDEPENDENT oracle: this list is written out by hand, not derived from
  // UNIT_ALIAS_SPELLINGS, which is the entire point. The table-driven checks
  // above compare the table against itself, so re-pointing a single blocked
  // spelling (`'sm³': 'cubic_metres'`) satisfies both while handing Sm³ the
  // ×11.36 natural-gas multiplier — 1000 Sm³ booked as 11,360 kWh. Sm³ and Nm³
  // are refused BY NAME because this repo holds no sourced calorific value for
  // them (see normalization.ts), and a fabricated figure in an emissions
  // inventory is the failure this product cannot have. Every spelling that
  // reaches a blocked unit is pinned, not just the one someone remembered.
  it.each([
    'Sm3',
    'sm3',
    'sm³',
    'SM³',
    'scm',
    'standard_cubic_metre',
    'standard_cubic_metres',
    'standard cubic metres',
    'Nm3',
    'nm3',
    'nm³',
    'normal_cubic_metre',
    'normal_cubic_metres',
    'normal cubic metres',
  ])('refuses %s rather than converting it', (spelling) => {
    expect(isKnownUnit(spelling)).toBe(true);
    expect(blockedUnitReason(spelling)).not.toBeNull();
    expect(() => normalize(1000, spelling)).toThrow(/sourced calorific value/i);
  });

  it('converts liquid fuel uk_gallons -> litres (×4.546)', () => {
    const r = normalize(10, 'uk_gallons');
    expect(r.normalizedValue).toBeCloseTo(45.46, 6);
    expect(r.normalizedUnit).toBe('litres');
    expect(r.conversionApplied).toBe(true);
  });

  it('throws for an unsupported unit', () => {
    expect(() => normalize(1, 'bananas')).toThrow(/Unsupported unit/);
  });

  it('knows Sm³ but refuses to convert it', () => {
    // Recognised, so the DTO accepts it and the refusal can explain itself —
    // "unsupported unit" would send the user looking for a spelling mistake.
    expect(isKnownUnit('Sm3')).toBe(true);
    expect(() => normalize(1, 'Sm3')).toThrow(/sourced calorific value/i);
    expect(() => normalize(1, 'Nm³')).toThrow(/sourced calorific value/i);
  });
});

describe('CalculationsService.compute', () => {
  let prisma: FactorPrismaMock;
  let service: CalculationsService;

  beforeEach(() => {
    prisma = createFactorPrismaMock();
    service = new CalculationsService(prisma as unknown as PrismaService);
  });

  it('known input -> known output: 45000 kWh electricity TR 2024 = 19.8 tCO2e', async () => {
    prisma.emissionFactor.findFirst.mockResolvedValue(
      makeFactor({ geographyCode: 'TR', factorValue: 0.44, reportingYear: 2024 }),
    );

    const result = expectCalculated(await service.compute({
      category: 'Electricity',
      geographyCode: 'TR',
      reportingYear: 2024,
      value: 45000,
      unit: 'kWh',
    }));

    expect(result.kgCo2e).toBeCloseTo(19800, 6);
    expect(result.tCo2e).toBeCloseTo(19.8, 6);
    expect(result.normalizedValue).toBe(45000);
    expect(result.conversionApplied).toBe(false);
  });

  it('doc worked example: 5 MWh electricity TR = 2.20 tCO2e (normalizes MWh->kWh)', async () => {
    prisma.emissionFactor.findFirst.mockResolvedValue(
      makeFactor({ geographyCode: 'TR', factorValue: 0.44 }),
    );

    const result = expectCalculated(await service.compute({
      category: 'Electricity',
      geographyCode: 'TR',
      reportingYear: 2024,
      value: 5,
      unit: 'mwh',
    }));

    expect(result.normalizedValue).toBe(5000);
    expect(result.kgCo2e).toBeCloseTo(2200, 6);
    expect(result.tCo2e).toBeCloseTo(2.2, 6);
    expect(result.conversionApplied).toBe(true);
  });

  it('returns the factor snapshot for traceability', async () => {
    const factor = makeFactor({
      id: 'factor-snap',
      factorValue: 0.44,
      factorUnit: 'kgCO2e/kWh',
      methodology: 'location-based',
      source: 'DEFRA demo',
      version: '2024.1',
    });
    prisma.emissionFactor.findFirst.mockResolvedValue(factor);

    const result = expectCalculated(await service.compute({
      category: 'Electricity',
      geographyCode: 'TR',
      reportingYear: 2024,
      value: 100,
      unit: 'kWh',
    }));

    expect(result.factorId).toBe('factor-snap');
    expect(result.factorValue).toBe(0.44);
    expect(result.factorUnit).toBe('kgCO2e/kWh');
    expect(result.methodology).toBe('location-based');
    expect(result.version).toBe('2024.1');
    expect(result.geographyCode).toBe('TR');
    expect(result.scope).toBe(2);
  });

  it('factor versioning: resolves the requested year (2023 factor differs from 2024)', async () => {
    // Query for 2023 must return the 2023 factor, ordered by version desc.
    prisma.emissionFactor.findFirst.mockResolvedValue(
      makeFactor({ reportingYear: 2023, factorValue: 0.2123, geographyCode: 'UK', version: '2023.1' }),
    );

    const result = expectCalculated(await service.compute({
      category: 'Electricity',
      geographyCode: 'UK',
      reportingYear: 2023,
      value: 1000,
      unit: 'kWh',
    }));

    // Confirms the year filter is passed to the DB and the returned factor is used.
    expect(prisma.emissionFactor.findFirst).toHaveBeenCalledWith({
      where: { category: 'Electricity', geographyCode: 'UK', reportingYear: 2023 },
      orderBy: { version: 'desc' },
    });
    expect(result.factorValue).toBe(0.2123);
    expect(result.version).toBe('2023.1');
    expect(result.kgCo2e).toBeCloseTo(212.3, 6);
  });

  it('natural gas m³ -> kWh then applies the Scope 1 factor', async () => {
    prisma.emissionFactor.findFirst.mockResolvedValue(
      makeFactor({
        category: 'Natural Gas',
        scope: 1,
        factorValue: 0.1829,
        geographyCode: 'UK',
      }),
    );

    const result = expectCalculated(await service.compute({
      category: 'Natural Gas',
      geographyCode: 'UK',
      reportingYear: 2024,
      value: 100,
      unit: 'cubic_metres',
    }));

    // 100 m³ × 11.36 = 1136 kWh ; × 0.1829 = 207.7744 kgCO2e
    expect(result.normalizedValue).toBeCloseTo(1136, 6);
    expect(result.kgCo2e).toBeCloseTo(207.7744, 4);
    expect(result.scope).toBe(1);
  });

  it('refuses Sm³ by name, saying what is missing', async () => {
    // Sm³ and m³ are different physical quantities and this repo holds no
    // sourced calorific value for the first. Registering it with the m³
    // multiplier would produce a number nobody could defend, so it is
    // recognised and refused — and the message must say why, or a tester reads
    // it as "unsupported unit" and simply reaches for m³ instead.
    await expect(
      service.compute({
        category: 'Natural Gas',
        geographyCode: 'UK',
        reportingYear: 2026,
        value: 100,
        unit: 'Sm3',
      }),
    ).rejects.toThrow(/sourced calorific value/i);
    expect(prisma.emissionFactor.findFirst).not.toHaveBeenCalled();
  });

  it('records WHICH conversion was applied, not just that one was', async () => {
    // `conversionApplied` is a boolean; an auditor asking what multiplier was
    // used had to divide normalizedValue by the input to find out.
    prisma.emissionFactor.findFirst.mockResolvedValue(
      makeFactor({
        category: 'Natural Gas',
        normalizedUnit: 'kWh',
        factorValue: 0.1829,
        scope: 1,
      }),
    );

    const result = expectCalculated(await service.compute({
      category: 'Natural Gas',
      geographyCode: 'UK',
      reportingYear: 2026,
      value: 100,
      unit: 'cubic_metres',
    }));

    expect(result.conversionApplied).toBe(true);
    expect(result.conversionFactor).toBe(11.36);
    expect(result.conversionBasis).toMatch(/NOT a sourced factor/i);
  });

  it('leaves the conversion fields off when nothing was converted', async () => {
    prisma.emissionFactor.findFirst.mockResolvedValue(
      makeFactor({ normalizedUnit: 'kWh' }),
    );

    const result = expectCalculated(await service.compute({
      category: 'Electricity',
      geographyCode: 'UK',
      reportingYear: 2026,
      value: 10,
      unit: 'kWh',
    }));

    expect(result.conversionApplied).toBe(false);
    expect(result.conversionFactor).toBeUndefined();
    expect(result.conversionBasis).toBeUndefined();
  });

  it('rejects a unit that is wrong for the category but right for the family', async () => {
    // The pre-existing guard only compares unit FAMILIES, so `therms` on
    // Electricity normalised to kWh, matched the factor and produced a
    // plausible number with no error at all.
    await expect(
      service.compute({
        category: 'Electricity',
        geographyCode: 'UK',
        reportingYear: 2026,
        value: 100,
        unit: 'therms',
      }),
    ).rejects.toThrow(/not valid for "Electricity"/);
    expect(prisma.emissionFactor.findFirst).not.toHaveBeenCalled();
  });

  it('throws NotFound when no factor exists for the key', async () => {
    prisma.emissionFactor.findFirst.mockResolvedValue(null);

    await expect(
      service.compute({
        category: 'Electricity',
        geographyCode: 'ZZ',
        reportingYear: 2024,
        value: 1,
        unit: 'kWh',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * The refusal names the two values it could not find, and `compute` is a
   * public method. `CalculationInputDto` now bounds the preview endpoint to the
   * two vocabularies, but it is not the only caller: `ActivityRecordsService`
   * passes a geography read from a subsidiary or location row, and
   * `geographyOptions` in @tonyai/shared-types explicitly anticipates "a code
   * that reached the database by some other route". The DTO bounds the door;
   * these two bound the sentence.
   */
  it('quotes the category and geography it could not find, rather than echoing them', async () => {
    prisma.emissionFactor.findFirst.mockResolvedValue(null);

    const message = await service
      .compute({
        category: 'E'.repeat(200),
        geographyCode: 'Z'.repeat(200),
        reportingYear: 2024,
        value: 1,
        unit: 'kWh',
      })
      .then(
        () => 'it resolved, which would itself be the bug',
        (error: Error) => error.message,
      );

    expect(message).toContain(
      `category "${'E'.repeat(CALLER_TEXT_QUOTE_MAX_LENGTH)}…"`,
    );
    expect(message).toContain(
      `geography "${'Z'.repeat(CALLER_TEXT_QUOTE_MAX_LENGTH)}…"`,
    );
    // 400 characters in, well under 200 out: the sentence can no longer be
    // multiplied by the length of what it is asked to name.
    expect(message.length).toBeLessThan(200);
  });

  it('names the characters that disguise a value in that sentence', async () => {
    prisma.emissionFactor.findFirst.mockResolvedValue(null);

    // Built from code points rather than written literally: a literal would be
    // a real invisible character sitting in this file. U+202E is the
    // right-to-left override, U+200B the zero-width space. Neither survives
    // into the sentence, and neither vanishes from it either — a refusal that
    // cannot show a character says which one it was.
    const override = String.fromCharCode(0x202e);
    const zeroWidth = String.fromCharCode(0x200b);

    const message = await service
      .compute({
        category: `Electricity${override}`,
        geographyCode: `U${zeroWidth}K`,
        reportingYear: 2024,
        value: 1,
        unit: 'kWh',
      })
      .then(
        () => 'it resolved, which would itself be the bug',
        (error: Error) => error.message,
      );

    expect(message).toContain('category "Electricity<U+202E>"');
    expect(message).toContain('geography "U<U+200B>K"');
    expect(message).not.toContain(override);
    expect(message).not.toContain(zeroWidth);
  });

  describe('a category with no factor at all (WP17 — Water)', () => {
    it('records the entry instead of refusing, and says why in the snapshot', async () => {
      prisma.emissionFactor.findFirst.mockResolvedValue(null);

      const result = await service.compute({
        category: 'Water',
        geographyCode: 'TR',
        reportingYear: 2026,
        value: 100,
        unit: 'cubic_metres',
      });

      expect(isCalculated(result)).toBe(false);
      const uncalculated = result as UncalculatedSnapshot;
      expect(uncalculated.reasonCode).toBe('no_emission_factor');
      expect(uncalculated.reason).toMatch(/no emission factor/i);
      // Scope still comes from the canonical map, so the record files itself
      // under Scope 3 rather than defaulting to 0.
      expect(uncalculated.scope).toBe(3);
      expect(uncalculated.inputValue).toBe(100);
      expect(uncalculated.inputUnit).toBe('cubic_metres');
    });

    it('does NOT normalise — 100 m³ of water must not become 1,136 kWh', async () => {
      prisma.emissionFactor.findFirst.mockResolvedValue(null);

      const result = (await service.compute({
        category: 'Water',
        geographyCode: 'TR',
        reportingYear: 2026,
        value: 100,
        unit: 'cubic_metres',
      })) as UncalculatedSnapshot & { normalizedValue?: number };

      // The guard that matters: normalize() is category-blind and converts any
      // cubic_metres at the NATURAL GAS calorific value (×11.36). Running it
      // here would freeze a nonsense figure into an immutable record.
      expect(result.normalizedValue).toBeUndefined();
      expect('normalizedUnit' in result).toBe(false);
      expect(normalize(100, 'cubic_metres').normalizedValue).toBeCloseTo(1136, 6);
    });

    it('carries no figure and no factor, so nothing can read it as zero', async () => {
      prisma.emissionFactor.findFirst.mockResolvedValue(null);

      const result = (await service.compute({
        category: 'Water',
        geographyCode: 'UK',
        reportingYear: 2026,
        value: 42,
        unit: 'cubic_metres',
      })) as UncalculatedSnapshot & { tCo2e?: number; factorId?: string };

      expect(result.tCo2e).toBeUndefined();
      expect(result.factorId).toBeUndefined();
      // Every consumer sums with a finite check, so an absent figure drops out
      // of totals rather than deflating them.
      expect(Number.isFinite(result.tCo2e)).toBe(false);
    });

    it('the exception stops firing the moment a factor resolves', async () => {
      // Deliberately a kWh-based factor: this proves only that the allow-list
      // is a permission and not an assertion — the `!factor` branch is checked
      // first, so a resolvable factor takes the normal path. It says nothing
      // about whether that path is CORRECT for water; see the next spec.
      prisma.emissionFactor.findFirst.mockResolvedValue(
        makeFactor({
          category: 'Water',
          scope: 3,
          factorValue: 0.149,
          normalizedUnit: 'kWh',
          geographyCode: 'UK',
        }),
      );

      const result = await service.compute({
        category: 'Water',
        geographyCode: 'UK',
        reportingYear: 2026,
        value: 100,
        unit: 'cubic_metres',
      });

      expect(isCalculated(result)).toBe(true);
    });

    it('a CORRECTLY-seeded water factor cannot be applied yet — normalize() is category-blind', async () => {
      // The safe seeding: a water factor is quoted per cubic metre, not per kWh.
      prisma.emissionFactor.findFirst.mockResolvedValue(
        makeFactor({
          category: 'Water',
          scope: 3,
          factorValue: 0.149,
          factorUnit: 'kgCO2e/m3',
          normalizedUnit: 'cubic_metres',
          geographyCode: 'UK',
        }),
      );

      // This is the honest state of affairs and the reason it must be a test
      // rather than a comment: `normalize()` converts ANY cubic_metres at the
      // natural-gas calorific value, so the input arrives as 1,136 "kWh" and
      // the unit guard refuses it. Seeding a water factor is therefore NOT
      // sufficient to make water calculable — `normalize(value, unit, category)`
      // has to land first (recorded in the roadmap's open questions).
      await expect(
        service.compute({
          category: 'Water',
          geographyCode: 'UK',
          reportingYear: 2026,
          value: 100,
          unit: 'cubic_metres',
        }),
      ).rejects.toThrow(/normalises to "kWh" but the factor .* expects "cubic_metres"/);

      // And the failure is loud, not a silently fabricated number.
      expect(normalize(100, 'cubic_metres').normalizedValue).toBeCloseTo(1136, 6);
    });

    it('a missing ELECTRICITY factor still refuses — the exception is one named category', async () => {
      prisma.emissionFactor.findFirst.mockResolvedValue(null);

      // Electricity is invoice-tracked too, so a rule keyed on "invoice-tracked
      // and unresolved" would have silently accepted this with no figure. The
      // core of the inventory must fail loudly instead.
      await expect(
        service.compute({
          category: 'Electricity',
          geographyCode: 'ZZ',
          reportingYear: 2026,
          value: 1000,
          unit: 'kWh',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('throws BadRequest for an unsupported unit before any DB lookup', async () => {
    await expect(
      service.compute({
        category: 'Electricity',
        geographyCode: 'TR',
        reportingYear: 2024,
        value: 1,
        unit: 'bananas',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.emissionFactor.findFirst).not.toHaveBeenCalled();
  });

  it('throws BadRequest when the normalized unit mismatches the factor unit', async () => {
    // Factor expects litres, but input normalises to kWh.
    prisma.emissionFactor.findFirst.mockResolvedValue(
      makeFactor({ category: 'Fuel', normalizedUnit: 'litres', factorValue: 2.6841, scope: 1 }),
    );

    await expect(
      service.compute({
        category: 'Fuel',
        geographyCode: 'UK',
        reportingYear: 2024,
        value: 100,
        unit: 'kWh',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('a refusal quotes the unit, never the whole of it', () => {
    // Built from code points, never typed: escape sequences typed into this
    // repo have arrived in files as the literal, invisible character.
    const char = (code: number) => String.fromCharCode(code);

    it('an unknown unit', async () => {
      await expect(
        service.compute({
          category: 'Electricity',
          geographyCode: 'TR',
          reportingYear: 2024,
          value: 1,
          unit: `bananas${char(0x202e)}${'x'.repeat(100)}`,
        }),
      ).rejects.toThrow(
        `Unsupported unit "bananas<U+202E>${'x'.repeat(32)}…"`,
      );

      // The caller's OWN spelling, not the canonicalised key: quoting
      // `canonicalUnit(input.unit)` would tell a user about a token they never
      // typed, and nothing else here has a capital letter or a space in it.
      await expect(
        service.compute({
          category: 'Electricity',
          geographyCode: 'TR',
          reportingYear: 2024,
          value: 1,
          unit: 'Banana Units',
        }),
      ).rejects.toThrow('Unsupported unit "Banana Units"');
    });

    it('a known unit padded out, which reaches the category refusal', async () => {
      // `canonicalUnit` collapses whitespace, so this is `cubic_metres` to the
      // vocabulary check, and a bulk import repeats the sentence it gets.
      await expect(
        service.compute({
          category: 'Electricity',
          geographyCode: 'UK',
          reportingYear: 2026,
          value: 1,
          unit: `cubic${' '.repeat(30_000)}metres`,
        }),
      ).rejects.toThrow(
        `Unit "cubic${' '.repeat(35)}…" is not valid for "Electricity". Accepted: kWh, MWh.`,
      );
    });

    it('a known unit carrying characters that disguise it, in the factor refusal', async () => {
      prisma.emissionFactor.findFirst.mockResolvedValue(
        makeFactor({
          category: 'Water',
          scope: 3,
          factorValue: 0.149,
          factorUnit: 'kgCO2e/m3',
          normalizedUnit: 'cubic_metres',
          geographyCode: 'UK',
        }),
      );

      // U+FEFF and a tab are whitespace to `canonicalUnit`: still cubic metres.
      await expect(
        service.compute({
          category: 'Water',
          geographyCode: 'UK',
          reportingYear: 2026,
          value: 100,
          unit: `cubic${char(0xfeff)}${char(0x09)}metres`,
        }),
      ).rejects.toThrow(
        'Unit "cubic<U+FEFF U+0009>metres" normalises to "kWh" but the factor for "Water" expects "cubic_metres"',
      );
    });

    it('a known unit padded out, in the factor refusal', async () => {
      // The other half of the same sentence: cleaning it is not cutting it,
      // and this one is reachable at any length through the preview DTO, which
      // has no cap.
      prisma.emissionFactor.findFirst.mockResolvedValue(
        makeFactor({
          category: 'Water',
          scope: 3,
          factorValue: 0.149,
          factorUnit: 'kgCO2e/m3',
          normalizedUnit: 'cubic_metres',
          geographyCode: 'UK',
        }),
      );

      await expect(
        service.compute({
          category: 'Water',
          geographyCode: 'UK',
          reportingYear: 2026,
          value: 100,
          unit: `cubic${' '.repeat(30_000)}metres`,
        }),
      ).rejects.toThrow(
        `Unit "cubic${' '.repeat(35)}…" normalises to "kWh" but the factor for "Water" expects "cubic_metres"`,
      );
    });
  });
});

describe('CalculationsService.listFactors', () => {
  let prisma: FactorPrismaMock;
  let service: CalculationsService;

  beforeEach(() => {
    prisma = createFactorPrismaMock();
    service = new CalculationsService(prisma as unknown as PrismaService);
  });

  it('passes optional filters through to Prisma and maps to DTOs', async () => {
    prisma.emissionFactor.findMany.mockResolvedValue([makeFactor({ id: 'f1' })]);

    const result = await service.listFactors({ category: 'Electricity', geographyCode: 'TR', year: 2024 });

    expect(prisma.emissionFactor.findMany).toHaveBeenCalledWith({
      where: { category: 'Electricity', geographyCode: 'TR', reportingYear: 2024 },
      orderBy: [
        { category: 'asc' },
        { geographyCode: 'asc' },
        { reportingYear: 'desc' },
        { version: 'desc' },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('f1');
    expect(typeof result[0].createdAt).toBe('string');
  });

  it('omits undefined filters (lists all)', async () => {
    prisma.emissionFactor.findMany.mockResolvedValue([]);

    await service.listFactors({});

    expect(prisma.emissionFactor.findMany).toHaveBeenCalledWith({
      where: { category: undefined, geographyCode: undefined, reportingYear: undefined },
      orderBy: expect.any(Array),
    });
  });
});
