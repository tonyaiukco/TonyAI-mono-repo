import { CATEGORIES, CATEGORY_SCOPE_MAP, type FactorCoverageEntry, type LiveFactorStatus } from '@tonyai/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CalculationsService } from '../../src/calculations/calculations.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { connect, connectOwner, withRollback } from './db';
import { INT_FACTOR_POLICY } from './services';
import { loadTrReleases } from './tr-releases';

/**
 * UAT round 2, BUG-R2-09 (OpenSpec `uat2-ui-quick-fixes`, task 1.4): the
 * coverage report on the real library — the TR package loaded through the
 * loader, whatever placeholder rows the local seed left beside it — under each
 * placeholder policy, and with every release withdrawn inside a transaction
 * that is always rolled back.
 */

let runtime: PrismaService;
let owner: PrismaService;

beforeAll(async () => {
  await loadTrReleases();
  runtime = connect(1);
  owner = connectOwner(1);
}, 120_000);

afterAll(async () => {
  await runtime?.$disconnect();
  await owner?.$disconnect();
});

type LiveRow = { geographyCode: string; reportingYear: number; releaseId: string; status: LiveFactorStatus };

/** The categories priced under Scope 2 — location-based only in the pilot (D08); every other one `not_applicable`. */
const SCOPE2_CATEGORIES = CATEGORIES.filter((c) => CATEGORY_SCOPE_MAP[c] === 2);
const OTHER_CATEGORIES = CATEGORIES.filter((c) => CATEGORY_SCOPE_MAP[c] !== 2);

/**
 * Every sealed, live CO2e row's pair, release and status that a lookup could
 * read — in its category's own Scope 2 method, never a market-based row
 * (review of PR #305) — read with SQL, not through the service.
 */
async function liveRows(db: PrismaService): Promise<LiveRow[]> {
  return db.$queryRawUnsafe<LiveRow[]>(
    `SELECT DISTINCT ef.geography_code AS "geographyCode", ef.reporting_year AS "reportingYear", ef.release_id::text AS "releaseId", r.status
       FROM emission_factors ef JOIN factor_releases r ON r.id = ef.release_id
      WHERE r.sealed_at IS NOT NULL AND r.status <> 'withdrawn' AND ef.gas = 'CO2e'
        AND ((ef.category = ANY($1::text[]) AND ef.scope2_method = 'location')
          OR (ef.category = ANY($2::text[]) AND ef.scope2_method = 'not_applicable'))`,
    SCOPE2_CATEGORIES,
    OTHER_CATEGORIES,
  );
}

const samePair = (a: { geographyCode: string; reportingYear: number }, b: { geographyCode: string; reportingYear: number }) =>
  a.geographyCode === b.geographyCode && a.reportingYear === b.reportingYear;

/** The report the rows imply under a policy: the spec's rule, written independently of the service. */
function oracle(rows: LiveRow[], allowPlaceholders: boolean): FactorCoverageEntry[] {
  const order: LiveFactorStatus[] = ['authoritative', 'placeholder', 'fixture'];
  const priced = rows.filter((r) => allowPlaceholders || r.status === 'authoritative');
  const pairs = [...new Map(priced.map((r) => [`${r.geographyCode}:${r.reportingYear}`, r])).values()];
  return pairs
    .map((p) => ({
      geographyCode: p.geographyCode,
      reportingYear: p.reportingYear,
      statuses: order.filter((status) => priced.some((r) => samePair(r, p) && r.status === status)),
    }))
    .sort((a, b) => a.geographyCode.localeCompare(b.geographyCode, 'en') || a.reportingYear - b.reportingYear);
}

describe('GET /factors/coverage on the real library (uat2-ui-quick-fixes)', () => {
  it('lists TR 2024–2026 as authoritative under either policy', async () => {
    for (const allowPlaceholders of [true, false]) {
      const { entries } = await new CalculationsService(runtime, { allowPlaceholders }).coverage();
      for (const year of [2024, 2025, 2026]) {
        const tr = entries.find((e) => e.geographyCode === 'TR' && e.reportingYear === year);
        expect(tr?.statuses[0], `TR ${year}, allowPlaceholders=${allowPlaceholders}`).toBe('authoritative');
      }
    }
  });

  it('equals, under each policy, what the library holds — an oracle read straight from SQL', async () => {
    const rows = await liveRows(runtime);
    for (const allowPlaceholders of [true, false]) {
      const { entries } = await new CalculationsService(runtime, { allowPlaceholders }).coverage();
      expect(entries, `allowPlaceholders=${allowPlaceholders}`).toEqual(oracle(rows, allowPlaceholders));
    }
  });

  it('drops a pair once every release behind it is withdrawn, and keeps every pair another release still covers', async () => {
    const rows = await liveRows(runtime);
    const [target] = oracle(rows, true);
    const withdrawn = [...new Set(rows.filter((r) => samePair(r, target)).map((r) => r.releaseId))];
    const expected = oracle(rows.filter((r) => !withdrawn.includes(r.releaseId)), true);

    const entries = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE factor_releases SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = 'TonyAI test', withdrawal_reason = 'coverage int test' WHERE id = ANY($1::uuid[])`,
        withdrawn,
      );
      return (await new CalculationsService(tx as unknown as PrismaService, INT_FACTOR_POLICY).coverage()).entries;
    });
    expect(entries.some((e) => samePair(e, target))).toBe(false);
    expect(entries).toEqual(expected);
  });

  it('never lists a pair only a market-based factor holds, and still lists the location-based one beside it', async () => {
    // Review of PR #305: the pilot prices Scope 2 location-based only (D08), so
    // a market-based row — legal to load — prices nothing. A fixture release of
    // our own, on years nothing else holds, loaded and sealed inside a
    // transaction that is always rolled back.
    const MARKET_ONLY = 2041;
    const BOTH = 2042;
    const entries = await withRollback(owner, async (tx) => {
      const [{ next }] = await tx.$queryRawUnsafe<{ next: number }[]>(
        `SELECT COALESCE(max(ordinal), 0) + 1 AS next FROM factor_releases WHERE publisher = 'TonyAI test fixture'`,
      );
      const release = await tx.factorRelease.create({
        data: { publisher: 'TonyAI test fixture', title: 'Coverage int test', edition: `int-${Date.now()}`, ordinal: Number(next), status: 'fixture' },
      });
      const electricity = (reportingYear: number, scope2Method: string) => ({
        releaseId: release.id, version: release.edition, category: 'Electricity', activityType: 'grid_electricity',
        gas: 'CO2e', gasCoverage: 'all_ghg', geographyCode: 'TR', reportingYear, dataYear: reportingYear, scope: 2,
        scope2Method, calorificBasis: 'not_applicable', factorValue: 0.4, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh',
        methodology: 'int test', source: 'int test',
      });
      await tx.emissionFactor.createMany({
        data: [electricity(MARKET_ONLY, 'market'), electricity(BOTH, 'market'), electricity(BOTH, 'location')],
      });
      await tx.factorRelease.update({ where: { id: release.id }, data: { sealedAt: new Date() } });
      return (await new CalculationsService(tx as unknown as PrismaService, { allowPlaceholders: true }).coverage()).entries;
    });
    expect(entries.find((e) => e.geographyCode === 'TR' && e.reportingYear === MARKET_ONLY)).toBeUndefined();
    expect(entries.find((e) => e.geographyCode === 'TR' && e.reportingYear === BOTH)).toEqual({
      geographyCode: 'TR',
      reportingYear: BOTH,
      statuses: ['fixture'],
    });
  });

  it('never lists a withdrawn release: with all of them withdrawn the report is empty', async () => {
    const entries = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE factor_releases SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = 'TonyAI test', withdrawal_reason = 'coverage int test' WHERE status <> 'withdrawn'`,
      );
      return (await new CalculationsService(tx as unknown as PrismaService, INT_FACTOR_POLICY).coverage()).entries;
    });
    expect(entries).toEqual([]);

    // Rolled back: the library is as it was.
    const after = await new CalculationsService(runtime, INT_FACTOR_POLICY).coverage();
    expect(after.entries.length).toBeGreaterThan(0);
  });
});
