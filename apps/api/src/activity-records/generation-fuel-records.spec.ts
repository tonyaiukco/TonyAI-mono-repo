import { describe, expect, it, vi } from 'vitest';
import { generationFuelRecords, type GenerationFuelSubject } from './generation-fuel-records';

const SUB_A = 'sub-a';
const SUB_B = 'sub-b';
const SITE = 'loc-site';

type Row = { subsidiaryId: string; locationId: string | null; reportingYear: number; category: string; activityType: string | null };

/** A stubbed client that answers `rows`, and records each `findMany` argument. */
function client(rows: Row[] = []) {
  const findMany = vi.fn(async (_args: unknown) => rows);
  return { findMany, client: { activityRecord: { findMany } } as never };
}

const electricity = (
  id: string,
  selfGenerationSource: string | null,
  over: Partial<GenerationFuelSubject> = {},
): GenerationFuelSubject => ({
  id,
  subsidiaryId: SUB_A,
  locationId: SITE,
  reportingYear: 2026,
  category: 'Electricity',
  parameters:
    selfGenerationSource === null
      ? null
      : { generationTopology: 'A', selfGenerationSource, selfGeneratedKwh: 1000 },
  ...over,
});

describe('generationFuelRecords (self-gen-form, design 6)', () => {
  it('runs no query when no record names a fuel source', async () => {
    const { findMany, client: c } = client();
    const states = await generationFuelRecords(c, [SUB_A], [
      electricity('plain', null),
      electricity('solar', 'solar'),
      electricity('wind', 'wind'),
      electricity('nulls', null, {
        parameters: { generationTopology: null, selfGenerationSource: null, selfGeneratedKwh: null },
      }),
      { ...electricity('gas', null), category: 'Natural Gas', parameters: { selfGenerationSource: 'natural_gas_chp' } },
    ]);
    expect(findMany).not.toHaveBeenCalled();
    expect(states.size).toBe(0);
  });

  it('asks once, with one condition per distinct site, year and kind', async () => {
    const { findMany, client: c } = client();
    await generationFuelRecords(c, [SUB_A, SUB_B], [
      electricity('q1', 'natural_gas_chp'),
      electricity('q2', 'natural_gas_chp'),
      electricity('gen', 'diesel_generator'),
      electricity('whole', 'natural_gas_chp', { locationId: null }),
      electricity('other-year', 'natural_gas_chp', { reportingYear: 2025 }),
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    const where = (findMany.mock.calls[0][0] as { where: { OR: unknown[] } }).where;
    expect(where.OR).toEqual([
      { subsidiaryId: SUB_A, locationId: SITE, reportingYear: 2026, category: 'Natural Gas' },
      { subsidiaryId: SUB_A, locationId: SITE, reportingYear: 2026, category: 'Fuel', activityType: 'diesel' },
      { subsidiaryId: SUB_A, locationId: null, reportingYear: 2026, category: 'Natural Gas' },
      { subsidiaryId: SUB_A, locationId: SITE, reportingYear: 2025, category: 'Natural Gas' },
    ]);
  });

  it('bounds the query by the accessible set, leaves voided records out and reads only key columns', async () => {
    const { findMany, client: c } = client();
    await generationFuelRecords(c, [SUB_A, SUB_B], [electricity('e', 'natural_gas_chp')]);
    const args = findMany.mock.calls[0][0] as { where: Record<string, unknown>; select: Record<string, true> };
    expect(args.where.subsidiaryId).toEqual({ in: [SUB_A, SUB_B] });
    expect(args.where.status).toEqual({ not: 'voided' });
    expect(Object.keys(args.select).sort()).toEqual(
      ['activityType', 'category', 'locationId', 'reportingYear', 'subsidiaryId'].sort(),
    );
  });

  it('asks nothing for a record outside the accessible set, and calls it missing', async () => {
    const { findMany, client: c } = client();
    const states = await generationFuelRecords(c, [SUB_B], [electricity('e', 'natural_gas_chp')]);
    expect(findMany).not.toHaveBeenCalled();
    expect(states.get('e')).toBe('missing');
  });

  it('reads present for a matching row and missing for the rest', async () => {
    const { client: c } = client([
      { subsidiaryId: SUB_A, locationId: SITE, reportingYear: 2026, category: 'Natural Gas', activityType: null },
    ]);
    const states = await generationFuelRecords(c, [SUB_A], [
      electricity('chp', 'natural_gas_chp'),
      electricity('chp-whole', 'natural_gas_chp', { locationId: null }),
      electricity('chp-2025', 'natural_gas_chp', { reportingYear: 2025 }),
      electricity('chp-other-sub', 'natural_gas_chp', { subsidiaryId: SUB_B }),
      electricity('gen', 'diesel_generator'),
      electricity('solar', 'solar'),
    ]);
    expect(Object.fromEntries(states)).toEqual({
      chp: 'present',
      'chp-whole': 'missing',
      'chp-2025': 'missing',
      'chp-other-sub': 'missing',
      gen: 'missing',
    });
  });

  it('matches a generator with a Fuel record for diesel only', async () => {
    const petrol = client([
      { subsidiaryId: SUB_A, locationId: SITE, reportingYear: 2026, category: 'Fuel', activityType: 'petrol' },
    ]);
    expect((await generationFuelRecords(petrol.client, [SUB_A], [electricity('g', 'diesel_generator')])).get('g')).toBe(
      'missing',
    );
    const diesel = client([
      { subsidiaryId: SUB_A, locationId: SITE, reportingYear: 2026, category: 'Fuel', activityType: 'diesel' },
    ]);
    expect((await generationFuelRecords(diesel.client, [SUB_A], [electricity('g', 'diesel_generator')])).get('g')).toBe(
      'present',
    );
  });

  it('matches a CHP unit with a Natural Gas record whatever type it stores', async () => {
    const { client: c } = client([
      { subsidiaryId: SUB_A, locationId: SITE, reportingYear: 2026, category: 'Natural Gas', activityType: 'natural_gas' },
    ]);
    expect((await generationFuelRecords(c, [SUB_A], [electricity('chp', 'natural_gas_chp')])).get('chp')).toBe('present');
  });

  it('keeps a whole-company fuel record apart from a site one', async () => {
    const { client: c } = client([
      { subsidiaryId: SUB_A, locationId: null, reportingYear: 2026, category: 'Natural Gas', activityType: null },
    ]);
    const states = await generationFuelRecords(c, [SUB_A], [
      electricity('site', 'natural_gas_chp'),
      electricity('whole', 'natural_gas_chp', { locationId: null }),
    ]);
    expect(states.get('site')).toBe('missing');
    expect(states.get('whole')).toBe('present');
  });
});
