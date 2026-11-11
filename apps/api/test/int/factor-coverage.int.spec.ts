import type { FactorCoverageEntry, LiveFactorStatus } from '@tonyai/shared-types';
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

/** Every sealed, live CO2e row's pair, release and status — read with SQL, not through the service. */
async function liveRows(db: PrismaService): Promise<LiveRow[]> {
  return db.$queryRawUnsafe<LiveRow[]>(
    `SELECT DISTINCT ef.geography_code AS "geographyCode", ef.reporting_year AS "reportingYear", ef.release_id::text AS "releaseId", r.status
       FROM emission_factors ef JOIN factor_releases r ON r.id = ef.release_id
      WHERE r.sealed_at IS NOT NULL AND r.status <> 'withdrawn' AND ef.gas = 'CO2e'`,
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
