import {
  isCalculated,
  REPORT_DATASET_SCHEMA_VERSION,
  type CalculationInput,
  type CalculationResultV3,
  type ReportDatasetRecord,
} from '@tonyai/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CalculationsService } from '../../src/calculations/calculations.service';
import { compareSnapshots } from '../../src/calculations/snapshot-staleness';
import { FactorReleaseLoader } from '../../src/factor-releases/factor-release-loader';
import { deriveIssuance } from '../../src/report-issuances/issuance-gate';
import { cell, complete, policy, source, SUB } from '../boundary-fixtures';
import { allLocks, datasetOf, frozenBoundary, fullYear, lock, record, release, standing } from '../issuance-fixtures';
import { connect, connectLoader } from './db';
import { INT_FACTOR_POLICY } from './services';
import { loadTrReleases, readTrRelease } from './tr-releases';

/**
 * UAT round 4, BUG-12 (OpenSpec `uat4-fire-suppression-entry`, task 4.3): the
 * supplementary fire suppression edition loaded through the loader beside the
 * TR package and the MGO edition, and fire suppression priced through the
 * engine. The expected figures are written out from the TR package's §4.6
 * (GWPs 1, 3,600, 25,200; rates 4%, 2%, 0.01%), not read from the builder.
 */

const EDITION = 'TONYAI-EF-TR-FIRE-2026.11-AR6';
const TR_EDITION = 'TONYAI-EF-TR-UK-2026.11-AR6-SEALED';
const MGO_EDITION = 'TONYAI-EF-TR-MGO-2026.11-AR6';

let engine: CalculationsService;
const db = connect();

beforeAll(async () => {
  await loadTrReleases();
  engine = new CalculationsService(db, INT_FACTOR_POLICY);
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

const line = (equipmentType: string, capacityKg: number, refillKg = 0) =>
  ({ equipmentType, capacityKg, refillKg, leakRateChoice: 'default' });
const fire = (activityType: string, ...lines: ReturnType<typeof line>[]): CalculationInput =>
  ({
    category: 'Fire Suppression', activityType, geographyCode: 'TR', reportingYear: 2025, reportingPeriod: 'annual',
    value: lines.reduce((sum, l) => sum + l.capacityKg, 0), unit: 'kg', parameters: { equipment: lines },
  }) as CalculationInput;

async function priced(input: CalculationInput): Promise<CalculationResultV3> {
  const result = await engine.compute(input);
  if (!isCalculated(result)) throw new Error('no figure');
  return result as CalculationResultV3;
}

const code = (input: CalculationInput) => engine.compute(input).then(() => null, (e: { code?: string }) => e.code ?? 'uncoded');

describe('the fire suppression edition beside the TR package (uat4-fire-suppression-entry)', () => {
  it('dry-runs and loads with no overlap and nothing superseded, leaving the three IPCC releases live', async () => {
    const client = connectLoader();
    try {
      const loader = new FactorReleaseLoader(client, 'TonyAI Sustainability Team');
      const dry = await loader.load(readTrRelease('ipcc-fire'), { apply: false });
      expect(['would_load', 'already_loaded']).toContain(dry.outcome);
      expect(dry.supersedes).toBeNull();
      const applied = await loader.load(readTrRelease('ipcc-fire'), { apply: true });
      expect(applied.outcome).toBe('already_loaded');
      expect(applied).toMatchObject({ factors: 12, conversions: 0, parameters: 3, supersedes: null });
    } finally {
      await client.$disconnect();
    }
    const ipcc = await db.factorRelease.findMany({
      where: { publisher: 'IPCC', edition: { in: [TR_EDITION, MGO_EDITION, EDITION] } },
      select: { edition: true, ordinal: true, status: true, withdrawnAt: true },
      orderBy: { ordinal: 'asc' },
    });
    expect(ipcc).toEqual([
      { edition: TR_EDITION, ordinal: 1, status: 'authoritative', withdrawnAt: null },
      { edition: MGO_EDITION, ordinal: 2, status: 'authoritative', withdrawnAt: null },
      { edition: EDITION, ordinal: 3, status: 'authoritative', withdrawnAt: null },
    ]);
  });

  // With the fire edition already loaded (beforeAll): a TR-priced figure is
  // still priced by ordinal 1 and recomputes identically. That the load
  // withdrew nothing is the release listing above (QA review).
  it('keeps a draft priced by the TR package fresh with the fire edition loaded', async () => {
    const refrigerant = {
      category: 'Refrigerants', activityType: 'R-410A', geographyCode: 'TR', reportingYear: 2025, reportingPeriod: 'annual',
      value: 10, unit: 'kg', parameters: { equipment: [{ ...line('split_air_conditioner', 10), leakRateChoice: 'default' }] },
    } as CalculationInput;
    const before = await priced(refrigerant);
    expect(before.factorRelease).toMatchObject({ edition: TR_EDITION, ordinal: 1 });
    const after = await priced(refrigerant);
    expect(compareSnapshots(before, after)).toMatchObject({ stale: false, classes: [] });
  });

  it('prices the five vectors from the loaded edition', async () => {
    const fm200 = await priced(fire('HFC-227ea', line('fire_suppression_system', 40)));
    expect(fm200.kgCo2e).toBeCloseTo(2880, 6);
    expect(fm200.refrigerantTerms).toEqual([expect.objectContaining({ leakRate: 0.02, leakRateChoice: 'default' })]);
    expect(fm200.factorRelease).toMatchObject({ publisher: 'IPCC', edition: EDITION, ordinal: 3, status: 'authoritative' });

    const refilled = await priced(fire('HFC-227ea', line('fire_suppression_system', 50, 35)));
    expect(refilled.kgCo2e).toBeCloseTo(126000, 4);
    expect(refilled.refrigerantTerms).toEqual([expect.objectContaining({ pricedBy: 'refill' })]);

    const co2 = await priced(fire('CO2', line('fire_extinguisher', 6)));
    expect(co2.kgCo2e).toBeCloseTo(0.24, 9);
    expect(co2.refrigerantTerms).toEqual([expect.objectContaining({ equipmentType: 'fire_extinguisher', leakRate: 0.04 })]);
    expect(co2.parameterRows).toEqual([expect.objectContaining({ equipmentType: 'fire_extinguisher', value: 0.04, isDefault: true })]);

    const sf6 = await priced(fire('SF6', line('transformer_breaker', 10)));
    expect(sf6.kgCo2e).toBeCloseTo(25.2, 6);

    const dry = await priced(fire('dry_powder_or_foam', line('fire_extinguisher', 12)));
    expect(dry.kgCo2e).toBe(0);
    expect(dry.tCo2e).toBe(0);
    expect(dry.factorValue).toBe(0);
    expect(dry.factorRelease.edition).toBe(EDITION);
    expect(dry.source).toMatch(/UAT round 4, BUG-12/);
    expect(dry.source).not.toMatch(/Revision MD/);
  });

  it('prices every covered year, and fails closed in 2027', async () => {
    for (const reportingYear of [2024, 2025, 2026]) {
      const result = await priced({ ...fire('CO2', line('fire_extinguisher', 6)), reportingYear } as CalculationInput);
      expect(result.factorRelease.edition).toBe(EDITION);
    }
    expect(await code({ ...fire('CO2', line('fire_extinguisher', 6)), reportingYear: 2027 } as CalculationInput)).toBe('no_factor');
    expect(await code({ ...fire('dry_powder_or_foam', line('fire_extinguisher', 6)), reportingYear: 2027 } as CalculationInput)).toBe('no_factor');
  });

  it('leaves a Refrigerants record of HFC-227ea priced by the TR package (golden value 9)', async () => {
    const result = await priced({
      category: 'Refrigerants', activityType: 'HFC-227ea', geographyCode: 'TR', reportingYear: 2025, reportingPeriod: 'annual',
      value: 40, unit: 'kg', parameters: { equipment: [line('fire_suppression_system', 40)] },
    } as CalculationInput);
    expect(result.kgCo2e).toBeCloseTo(2880, 6);
    expect(result.factorRelease).toMatchObject({ edition: TR_EDITION, ordinal: 1 });
  });

  it('counts a final whose Fire Suppression records are all dry powder: not partial', async () => {
    const dry = await priced(fire('dry_powder_or_foam', line('fire_extinguisher', 12)));
    const rows = complete();
    const boundary = frozenBoundary({
      ...rows,
      cells: rows.cells.map((c) => (c.subsidiaryId === SUB && c.category === 'Fire Suppression'
        ? cell(null, 'Fire Suppression') : c)),
      policies: rows.policies.map((p) => (p.subsidiaryId === SUB && p.category === 'Fire Suppression'
        ? policy('Fire Suppression', 'company', 'annual') : p)),
      sources: [...rows.sources, source({ id: 'fire-dry', category: 'Fire Suppression', activityType: 'dry_powder_or_foam', reportingPeriod: 'annual' })],
    });
    const records: ReportDatasetRecord[] = [
      ...fullYear(),
      record('fire-dry-powder', {
        category: 'Fire Suppression', activityType: 'dry_powder_or_foam', scope: 1, reportingYear: 2026,
        reportingPeriod: 'annual', periodValue: 'Annual', locationId: null, locationName: null,
        activityValue: 12, activityUnit: 'kg', calculation: dry as unknown as ReportDatasetRecord['calculation'],
      }),
    ];
    const dataset = datasetOf({
      boundary,
      records,
      locks: [...allLocks(), lock('Annual', 'annual')],
      releases: [standing(release('rel-a')), standing(dry.factorRelease as unknown as ReturnType<typeof release>)],
    });
    expect(dataset.schemaVersion).toBe(REPORT_DATASET_SCHEMA_VERSION);
    expect(deriveIssuance(dataset)).toEqual({ status: 'final', gaps: [] });
  });
});
