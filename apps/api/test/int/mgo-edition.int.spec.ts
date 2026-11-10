import {
  isCalculated,
  type CalculationInput,
  type CalculationResultV3,
} from '@tonyai/shared-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { CalculationsService } from '../../src/calculations/calculations.service';
import { connect } from './db';
import { INT_FACTOR_POLICY } from './services';
import { loadTrReleases } from './tr-releases';

/**
 * UAT round 2, BUG-R2-11 (OpenSpec `uat2-mgo-factor-edition`, task 3.2): the
 * supplementary IPCC MGO edition loaded through the loader beside the TR
 * package, and marine gas oil priced through the engine.
 *
 * The expected figure is recomputed here from the IPCC 2006 values the edition
 * cites, not read from its builder: NCV 43.0 TJ/Gg (Vol. 2 Ch. 1 Table 1.2),
 * CO2 74 100 kg/TJ (Ch. 3 Table 3.5.2), CH4 7 and N2O 2 kg/TJ (Table 3.5.3),
 * weighted at AR6 (27, 273).
 */

const EDITION = 'TONYAI-EF-TR-MGO-2026.11-AR6';
const KGCO2E_PER_KG = (43.0 / 1e6) * (74100 + 7 * 27 + 2 * 273);

let engine: CalculationsService;

beforeAll(async () => {
  await loadTrReleases();
  engine = new CalculationsService(connect(), INT_FACTOR_POLICY);
}, 120_000);

const mgo = (over: Partial<CalculationInput>): CalculationInput =>
  ({
    category: 'Mobile Combustion', activityType: 'marine_gas_oil', geographyCode: 'TR', reportingYear: 2025,
    value: 0, unit: 'kg', ...over,
  }) as CalculationInput;

async function priced(input: CalculationInput): Promise<CalculationResultV3> {
  const result = await engine.compute(input);
  if (!isCalculated(result)) throw new Error('no figure');
  return result as CalculationResultV3;
}

const code = (input: CalculationInput) => engine.compute(input).then(() => null, (e: { code?: string }) => e.code ?? 'uncoded');

describe('marine gas oil on the supplementary IPCC edition (uat2-mgo-factor-edition)', () => {
  it('prices 12.5 t and 12,500 kg alike, at the IPCC values', async () => {
    const byTonnes = await priced(mgo({ value: 12.5, unit: 'tonnes' }));
    const byKg = await priced(mgo({ value: 12500, unit: 'kg' }));
    const expected = 12500 * KGCO2E_PER_KG;
    expect(byKg.kgCo2e).toBeCloseTo(expected, 6);
    expect(byTonnes.kgCo2e).toBeCloseTo(byKg.kgCo2e, 6);
    expect(byKg.scope).toBe(1);
  });

  it('snapshots the MGO edition, its source and method, and the tonnes-to-kg step', async () => {
    const result = await priced(mgo({ value: 12.5, unit: 'tonnes' }));
    expect(result.factorRelease).toMatchObject({ publisher: 'IPCC', edition: EDITION, ordinal: 2, status: 'authoritative' });
    expect(result.source).toMatch(/IPCC 2006 Vol\. 2 Ch\. 3 Table 3\.5\.2/);
    expect(result.source).not.toMatch(/Revision MD/);
    expect(result.methodology).toMatch(/43 TJ\/Gg/);
    expect(result.inputValue).toBe(12.5);
    expect(result.inputUnit).toBe('tonnes');
    expect(result.normalizedValue).toBe(12500);
    expect(result.normalizedUnit).toBe('kg');
    expect(result.conversionApplied).toBe(true);
    expect(result.conversionBasis).toMatch(/1 tonne = 1,000 kg/);
  });

  it('prices every covered year from the MGO edition', async () => {
    for (const reportingYear of [2024, 2025, 2026]) {
      const result = await priced(mgo({ value: 1000, reportingYear }));
      expect(result.kgCo2e).toBeCloseTo(1000 * KGCO2E_PER_KG, 6);
      expect(result.factorRelease.edition).toBe(EDITION);
    }
  });

  it('fails closed outside its coverage and off its mass basis', async () => {
    // A year the edition does not cover. 2027, not 2023: the e2e suite's
    // TR-2023 fixture release holds an MGO row of its own, and the
    // integration policy admits fixtures (INT_FACTOR_POLICY).
    expect(await code(mgo({ value: 100, reportingYear: 2027 }))).toBe('no_factor');
    // No density is held for MGO, so a volume has no factor.
    expect(await code(mgo({ value: 100, unit: 'litres' }))).toBe('no_factor');
    // A vehicle mode is priced per litre only, so a mass has no factor.
    expect(await code(mgo({ activityType: 'on_road_diesel', value: 100, unit: 'kg' }))).toBe('no_factor');
    expect(await code(mgo({ activityType: 'on_road_diesel', value: 1, unit: 'tonnes' }))).toBe('no_factor');
  });

  it('leaves the TR package pricing a vehicle mode from its own edition (golden value 7)', async () => {
    const diesel = await priced(mgo({ activityType: 'on_road_diesel', value: 3784.51, unit: 'litres' }));
    expect(Math.abs(diesel.kgCo2e - 10090.24) / 10090.24).toBeLessThan(0.005);
    expect(diesel.factorRelease).toMatchObject({ publisher: 'IPCC', ordinal: 1, edition: 'TONYAI-EF-TR-UK-2026.11-AR6-SEALED' });
  });
});
