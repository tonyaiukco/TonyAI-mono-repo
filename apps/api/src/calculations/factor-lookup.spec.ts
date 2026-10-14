import { describe, it, expect, vi } from 'vitest';
import type { EmissionFactor, FactorRelease, Prisma } from '@tonyai/db';
import { directCalorificBasisFor, factorActivityTypeFor, scope2MethodFor } from '@tonyai/shared-types';
import type { PrismaService } from '../prisma/prisma.service';
import { CaptureSnapshot, CaptureSnapshotError, FACTOR_CANDIDATE_CAP, lookupFactorPath, type FactorLookupKey } from './factor-lookup';

/**
 * The one factor lookup's two ways of reading the library (LP3-04 PR B, W2):
 * its own REPEATABLE READ batch — the engine's, unchanged, and pinned by the
 * engine's spec — or a caller's transaction, which must hold one snapshot.
 * The real-database proof (an erratum committed between two reads inside a
 * capture) is `inventory-boundary.int.spec.ts`.
 */

type FactorRow = EmissionFactor & { release: FactorRelease };

const KEY: FactorLookupKey = { category: 'Electricity', activityType: 'grid_electricity', geographyCode: 'TR', reportingYear: 2026 };

function release(status: string): FactorRelease {
  return {
    id: `release-${status}`, publisher: 'TonyAI test fixture', title: 'Fixture', edition: '1', ordinal: 1, status,
    sourceUrl: null, licence: null, publishedAt: null, gwpSet: null, reviewedBy: null, reviewedAt: null, notes: null,
    withdrawnAt: null, withdrawnBy: null, withdrawalReason: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), sealedAt: new Date('2026-01-01T00:00:00Z'),
  } as FactorRelease;
}

function factor(status: string): FactorRow {
  const now = new Date('2026-01-01T00:00:00Z');
  const r = release(status);
  return {
    id: `factor-${status}`, category: 'Electricity', activityType: factorActivityTypeFor('Electricity', null), gas: 'CO2e',
    gasCoverage: 'all_ghg', geographyCode: 'TR', reportingYear: 2026, dataYear: 2026, scope: 2,
    scope2Method: scope2MethodFor('Electricity'), calorificBasis: directCalorificBasisFor('Electricity', 'kWh'),
    factorValue: 0.44, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'location-based',
    source: 'fixture', version: '1', createdAt: now, updatedAt: now, releaseId: r.id, release: r,
  } as FactorRow;
}

/** A library behind the two candidate queries, with the status filter applied. */
function library(rows: FactorRow[]) {
  const byStatus = (args: { where: { release: { status: { in: string[] } } } }) =>
    rows.filter((f) => args.where.release.status.in.includes(f.release.status));
  return {
    emissionFactor: { findMany: vi.fn(async (args: Parameters<typeof byStatus>[0]) => byStatus(args)) },
    unitConversion: { findMany: vi.fn(async () => []) },
  };
}

/** An interactive transaction's client: no `$transaction`, and a level. */
function transaction(rows: FactorRow[], isolation: string) {
  return { ...library(rows), $queryRaw: vi.fn(async () => [{ isolation }]) };
}

/** The root client — must never be read when a snapshot is passed. */
function rootClient(rows: FactorRow[] = []) {
  return {
    ...library(rows),
    $transaction: vi.fn(async (reads: Promise<unknown>[]) => Promise.all(reads)),
  };
}

const asTx = (t: object) => t as unknown as Prisma.TransactionClient;
const asPrisma = (p: object) => p as unknown as PrismaService;
const REFUSE_PLACEHOLDERS = { allowPlaceholders: false };

describe('CaptureSnapshot.open', () => {
  it('opens on a REPEATABLE READ or SERIALIZABLE transaction', async () => {
    for (const level of ['repeatable read', 'serializable']) {
      await expect(CaptureSnapshot.open(asTx(transaction([], level)))).resolves.toBeInstanceOf(CaptureSnapshot);
    }
  });

  it('refuses READ COMMITTED and READ UNCOMMITTED: two statements there read two snapshots', async () => {
    for (const level of ['read committed', 'read uncommitted']) {
      await expect(CaptureSnapshot.open(asTx(transaction([], level)))).rejects.toThrow(CaptureSnapshotError);
    }
  });

  it('refuses the root client, whose statements are each their own transaction', async () => {
    const root = { ...rootClient(), $queryRaw: vi.fn(async () => [{ isolation: 'repeatable read' }]) };
    await expect(CaptureSnapshot.open(asTx(root))).rejects.toThrow(CaptureSnapshotError);
    expect(root.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a snapshot constructed outside open, or one tampered with (security-rls re-check P3-1)', async () => {
    const readCommitted = asTx(transaction([factor('authoritative')], 'read committed'));
    // The constructor is private to TypeScript alone: JavaScript reaches it.
    const constructed = Reflect.construct(CaptureSnapshot, [readCommitted]) as CaptureSnapshot;
    expect(CaptureSnapshot.isOpened(constructed)).toBe(false);
    await expect(lookupFactorPath(asPrisma(rootClient()), REFUSE_PLACEHOLDERS, KEY, 'kWh', constructed)).rejects.toThrow(CaptureSnapshotError);
    // A genuine one cannot be pointed at another client.
    const real = await CaptureSnapshot.open(asTx(transaction([factor('authoritative')], 'repeatable read')));
    expect(() => Object.defineProperty(real, 'tx', { value: readCommitted })).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(real, {})).toThrow(TypeError);
    expect(CaptureSnapshot.isOpened(real)).toBe(true);
  });

  it('refuses a level it cannot read', async () => {
    const tx = { ...library([]), $queryRaw: vi.fn(async () => []) };
    await expect(CaptureSnapshot.open(asTx(tx))).rejects.toThrow(CaptureSnapshotError);
  });
});

describe('lookupFactorPath', () => {
  it('reads in a batch of its own with no snapshot — the engine\'s path', async () => {
    const root = rootClient([factor('authoritative')]);
    const result = await lookupFactorPath(asPrisma(root), REFUSE_PLACEHOLDERS, KEY, 'kWh');
    expect(result.ok).toBe(true);
    expect(root.$transaction).toHaveBeenCalledWith([expect.anything(), expect.anything()], { isolationLevel: 'RepeatableRead' });
  });

  it('asks for exactly the candidates the engine always has — both queries pinned (qa-auditor P3-9)', async () => {
    const root = rootClient([factor('authoritative')]);
    await lookupFactorPath(asPrisma(root), REFUSE_PLACEHOLDERS, KEY, 'kWh');
    const release = { status: { in: ['authoritative'] }, sealedAt: { not: null } };
    expect(root.emissionFactor.findMany).toHaveBeenCalledWith({
      where: { ...KEY, release, gas: 'CO2e', scope2Method: scope2MethodFor('Electricity') },
      include: { release: true },
      orderBy: { id: 'asc' },
      take: FACTOR_CANDIDATE_CAP + 1,
    });
    expect(root.unitConversion.findMany).toHaveBeenCalledWith({
      where: { ...KEY, release, fromUnit: 'kWh' },
      include: { release: true },
      orderBy: { id: 'asc' },
      take: FACTOR_CANDIDATE_CAP + 1,
    });
  });

  it('runs no diagnostic pass where placeholders price', async () => {
    const root = rootClient([]);
    await lookupFactorPath(asPrisma(root), { allowPlaceholders: true }, KEY, 'kWh');
    expect(root.$transaction).toHaveBeenCalledTimes(1);
  });

  it('reads every pass in the caller\'s transaction and never the root client', async () => {
    const root = rootClient([factor('authoritative')]);
    const tx = transaction([factor('authoritative')], 'repeatable read');
    const snapshot = await CaptureSnapshot.open(asTx(tx));
    const result = await lookupFactorPath(asPrisma(root), REFUSE_PLACEHOLDERS, KEY, 'kWh', snapshot);
    expect(result.ok).toBe(true);
    expect(tx.emissionFactor.findMany).toHaveBeenCalledTimes(1);
    expect(tx.unitConversion.findMany).toHaveBeenCalledTimes(1);
    expect(root.$transaction).not.toHaveBeenCalled();
    expect(root.emissionFactor.findMany).not.toHaveBeenCalled();
  });

  it('runs the placeholder diagnostic in the same caller snapshot', async () => {
    const root = rootClient();
    const tx = transaction([factor('placeholder')], 'serializable');
    const snapshot = await CaptureSnapshot.open(asTx(tx));
    const result = await lookupFactorPath(asPrisma(root), REFUSE_PLACEHOLDERS, KEY, 'kWh', snapshot);
    expect(result).toEqual({ ok: false, code: 'placeholder_refused' });
    expect(tx.emissionFactor.findMany).toHaveBeenCalledTimes(2);
    expect(root.$transaction).not.toHaveBeenCalled();
    expect(root.emissionFactor.findMany).not.toHaveBeenCalled();
  });

  it('refuses a snapshot it did not open', async () => {
    const forged = { tx: asTx(transaction([], 'read committed')) } as unknown as CaptureSnapshot;
    await expect(lookupFactorPath(asPrisma(rootClient()), REFUSE_PLACEHOLDERS, KEY, 'kWh', forged)).rejects.toThrow(CaptureSnapshotError);
  });

  it('queries exactly the key\'s four columns — a wider caller object never becomes a filter', async () => {
    const root = rootClient([factor('authoritative')]);
    const wide = { ...KEY, unit: 'kWh', subsidiaryId: 'x' } as FactorLookupKey;
    await lookupFactorPath(asPrisma(root), REFUSE_PLACEHOLDERS, wide, 'kWh');
    const where = root.emissionFactor.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(Object.keys(where).sort()).toEqual(
      ['activityType', 'category', 'gas', 'geographyCode', 'release', 'reportingYear', 'scope2Method'],
    );
  });

  it('answers an unknown unit without reading the library', async () => {
    const root = rootClient();
    await expect(lookupFactorPath(asPrisma(root), REFUSE_PLACEHOLDERS, KEY, 'furlongs')).resolves.toEqual({ ok: false, code: 'unit_unknown' });
    expect(root.$transaction).not.toHaveBeenCalled();
  });
});
