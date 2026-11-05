import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isCalculated,
  type CalculationInput,
  type CalculationResultV3,
  type FactorReleaseImport,
} from '@tonyai/shared-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { CalculationsService } from '../../src/calculations/calculations.service';
import { FactorReleaseLoader } from '../../src/factor-releases/factor-release-loader';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { connect, connectLoader, connectOwner } from './db';
import { INT_FACTOR_POLICY } from './services';

/**
 * LP4-02 PR5, task 5.2: the two authoritative TR releases loaded through the
 * loader and priced through the engine, against the package's §5 golden values
 * (docs/md_docs/Revision MD.md), all within ±0.5%.
 *
 * Owner decision 2026-11-05 (option A): the real files load into the test
 * database. An authoritative release cannot be deleted, so a second run finds
 * them `already_loaded`, which is the loader's no-op. CI's database is fresh
 * each run; a local one keeps them, as hosted QA will once L10 closes.
 */

const DIR = resolve(__dirname, '../../../../packages/db/factor-releases/tr-2026-11');
const read = (name: string) => JSON.parse(readFileSync(resolve(DIR, `${name}.json`), 'utf8')) as FactorReleaseImport;
const OPERATOR = 'TonyAI Sustainability Team';

let engine: CalculationsService;
let owner: PrismaService;
/** Every committed record's figure, as it stood before this spec loaded anything. */
let committedBefore: Map<string, string>;

/** Committed records, keyed by id, with whether a placeholder priced them in TR. */
const committed = async (db: PrismaService) =>
  new Map(
    (await db.activityRecord.findMany({
      where: { status: { in: ['approved', 'locked'] } },
      select: { id: true, calculation: true },
    })).map((r) => [r.id, JSON.stringify(r.calculation)]),
  );
const placeholderTr = (calculation: string) => {
  const c = JSON.parse(calculation) as { geographyCode?: string; factorRelease?: { status?: string } };
  return c.geographyCode === 'TR' && c.factorRelease?.status === 'placeholder';
};

beforeAll(async () => {
  owner = connectOwner();
  committedBefore = await committed(owner);
  const loader = new FactorReleaseLoader(connectLoader(), OPERATOR);
  for (const name of ['ipcc', 'etkb']) {
    // The dry run first, as an operator would (the factor-release-import skill).
    const dry = await loader.load(read(name), { apply: false });
    expect(['would_load', 'already_loaded']).toContain(dry.outcome);
    const applied = await loader.load(read(name), { apply: true });
    expect(['loaded', 'already_loaded']).toContain(applied.outcome);
  }
  engine = new CalculationsService(connect(), INT_FACTOR_POLICY);
}, 120_000);

const tr = (over: Partial<CalculationInput>): CalculationInput =>
  ({ category: 'Electricity', geographyCode: 'TR', reportingYear: 2025, value: 0, unit: 'kWh', ...over }) as CalculationInput;

async function priced(input: CalculationInput): Promise<CalculationResultV3> {
  const result = await engine.compute(input);
  if (!isCalculated(result)) throw new Error('no figure');
  return result as CalculationResultV3;
}

const code = (input: CalculationInput) => engine.compute(input).then(() => null, (e: { code?: string }) => e.code ?? 'uncoded');

describe('the TR factor package against its golden values (LP4-02 PR5, task 5.2)', () => {
  it.each([
    ['Electricity 2025', tr({ value: 4180.56 }), 1814.36],
    ['Electricity 2024', tr({ value: 4180.56, reportingYear: 2024 }), 1847.81],
    ['Electricity 2026', tr({ value: 4180.56, reportingYear: 2026 }), 1814.36],
    ['Natural gas with billed GCV', tr({ category: 'Natural Gas', value: 73.953103, unit: 'standard_cubic_metres', parameters: { billedGcvKcalPerSm3: 9349.174 } }), 140.37],
    ['Natural gas, default NCV', tr({ category: 'Natural Gas', value: 100, unit: 'standard_cubic_metres' }), 193.83],
    // QA's UAT round 1 golden vector: the NCV typed by the user, not derived (0.1404 t).
    ['Natural gas, user-edited NCV', tr({ category: 'Natural Gas', value: 73.953, unit: 'standard_cubic_metres', parameters: { ncvKcalPerSm3: 8080 } }), 140.39],
    ['On-road petrol', tr({ category: 'Mobile Combustion', activityType: 'on_road_petrol', value: 15973.75, unit: 'litres' }), 36864.62],
    ['On-road diesel', tr({ category: 'Mobile Combustion', activityType: 'on_road_diesel', value: 3784.51, unit: 'litres' }), 10090.24],
    ['Leakage', tr({ category: 'Fugitive Gas', value: 84783.36, unit: 'standard_cubic_metres' }), 1632467.22],
    ['FM200', tr({
      category: 'Refrigerants', activityType: 'HFC-227ea', value: 40, unit: 'kg', reportingPeriod: 'annual',
      parameters: { equipment: [{ equipmentType: 'fire_suppression_system', capacityKg: 40, refillKg: 0, leakRateChoice: 'default' }] },
    }), 2880.0],
  ])('%s', async (_name, input, expected) => {
    const result = await priced(input);
    expect(Math.abs(result.kgCo2e - expected) / expected).toBeLessThan(0.005);
    // Priced from the package itself, authoritative on every link.
    expect(result.factorRelease).toMatchObject({ status: 'authoritative', edition: 'TONYAI-EF-TR-UK-2026.11-AR6-SEALED' });
    expect(['IPCC', 'ETKB']).toContain(result.factorRelease.publisher);
    if (result.conversion) expect(result.conversion.release.status).toBe('authoritative');
  });

  it('records each input of the gas chain and the FM200 rate with its origin', async () => {
    const billed = await priced(tr({
      category: 'Natural Gas', value: 73.953103, unit: 'standard_cubic_metres', parameters: { billedGcvKcalPerSm3: 9349.174 },
    }));
    const effective = billed.parameters.find((p) => p.name === 'ncvKcalPerSm3');
    expect(effective?.origin).toBe('derived');
    expect(Math.abs(effective!.value - 8078.67) / 8078.67).toBeLessThan(0.0005);
    expect(billed.parameterRows.map((r) => r.key).sort()).toEqual(['billed_gcv_max', 'billed_gcv_min', 'reference_gcv', 'reference_ncv']);

    const fm200 = await priced(tr({
      category: 'Refrigerants', activityType: 'HFC-227ea', value: 40, unit: 'kg', reportingPeriod: 'annual',
      parameters: { equipment: [{ equipmentType: 'fire_suppression_system', capacityKg: 40, refillKg: 0, leakRateChoice: 'default' }] },
    }));
    expect(fm200.refrigerantTerms).toEqual([expect.objectContaining({ leakRate: 0.02, leakRateChoice: 'default' })]);
  });

  it('refuses a billed GCV outside the ŞİD range the release carries (task 5.5)', async () => {
    const billed = (billedGcvKcalPerSm3: number) =>
      tr({ category: 'Natural Gas', value: 100, unit: 'standard_cubic_metres', parameters: { billedGcvKcalPerSm3 } });
    expect(await code(billed(8100))).toBeNull();
    expect(await code(billed(10427))).toBeNull();
    expect(await code(billed(8099.9))).toBe('billed_gcv_out_of_range');
    expect(await code(billed(10427.1))).toBe('billed_gcv_out_of_range');
  });

  it('fails closed for 2023 and for UK (owner decision 2026-11-05 (1))', async () => {
    expect(await code(tr({ value: 100, reportingYear: 2023 }))).toBe('no_factor');
    // on_road_petrol, which the e2e suite's TR 2023 fixture does not hold.
    expect(await code(tr({ category: 'Mobile Combustion', activityType: 'on_road_petrol', value: 100, unit: 'litres', reportingYear: 2023 }))).toBe('no_factor');
    expect(await code(tr({ value: 100, geographyCode: 'UK', reportingYear: 2024 }))).toBe('no_factor');
  });

  // On the first load, this is the TR records the seed's placeholders priced,
  // which the new releases now outrank; on a re-run the load is a no-op and
  // the check guards only that nothing recomputes a committed record.
  it('leaves every committed record byte-identical, the placeholder-priced TR ones included', async () => {
    const after = await committed(owner);
    // A record another spec deleted meanwhile is gone, not changed.
    const kept = [...committedBefore].filter(([id]) => after.has(id));
    expect(kept.filter(([, calculation]) => placeholderTr(calculation)).length).toBeGreaterThan(0);
    for (const [id, calculation] of kept) expect(after.get(id), id).toBe(calculation);
  });
});
