import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CalculationsService } from '../../src/calculations/calculations.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { connect } from './db';
import { INT_FACTOR_POLICY } from './services';
import { loadTrReleases } from './tr-releases';

/**
 * UAT round 2, S2 (OpenSpec `uat2-team-decisions-copy`, task 5.2): the sealed
 * release list on the real library, read as the runtime role. Its seal dates
 * must be the database's own `sealed_at`, and every sealed release — withdrawn
 * ones included — must be listed, and no unsealed one.
 */

let runtime: PrismaService;

beforeAll(async () => {
  await loadTrReleases();
  runtime = connect(1);
}, 120_000);

afterAll(async () => {
  await runtime?.$disconnect();
});

type SealRow = { id: string; status: string; sealedAt: Date };

describe('GET /factors/releases on the real library (uat2-team-decisions-copy)', () => {
  it('lists exactly the sealed releases, each with the seal timestamp the database holds', async () => {
    const rows = await runtime.$queryRawUnsafe<SealRow[]>(
      `SELECT id::text AS id, status, sealed_at AS "sealedAt" FROM factor_releases WHERE sealed_at IS NOT NULL`,
    );
    const listed = await new CalculationsService(runtime, INT_FACTOR_POLICY).listSealedReleases();

    expect(listed.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
    for (const row of rows) {
      const release = listed.find((r) => r.id === row.id);
      expect(release?.sealedAt, row.id).toBe(row.sealedAt.toISOString());
      expect(release?.status, row.id).toBe(row.status);
    }
  });

  it('includes the loaded TR package, and carries no reviewer, withdrawer or notes', async () => {
    const listed = await new CalculationsService(runtime, INT_FACTOR_POLICY).listSealedReleases();
    const tr = listed.filter((r) => r.publisher === 'ETKB' || r.publisher === 'IPCC');
    expect(tr.length).toBeGreaterThan(0);
    for (const release of listed) {
      for (const hidden of ['reviewedBy', 'reviewedAt', 'withdrawnBy', 'withdrawalReason', 'notes']) {
        expect(release).not.toHaveProperty(hidden);
      }
    }
  });
});
