import { INTERNAL_FACTOR_PUBLISHERS, validateFactorReleaseImport, type FactorReleaseImport } from '@tonyai/shared-types';
import type { PrismaClient } from '@tonyai/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FactorReleaseLoader, LoaderRefusal } from './factor-release-loader';

vi.mock('@tonyai/shared-types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tonyai/shared-types')>();
  return { ...actual, validateFactorReleaseImport: vi.fn(actual.validateFactorReleaseImport) };
});

/** A labelled test fixture — not an emission factor, and every field says so. */
function fixtureRelease(): FactorReleaseImport {
  return {
    release: {
      publisher: INTERNAL_FACTOR_PUBLISHERS.fixture,
      title: 'Loader spec fixture — not a source',
      edition: 'spec-1',
      ordinal: 7,
      status: 'fixture',
      sourceUrl: null,
      licence: null,
      publishedAt: null,
      gwpSet: null,
      reviewedBy: null,
      reviewedAt: null,
      notes: 'Written by a spec. Not a source.',
    },
    factors: [
      {
        category: 'Natural Gas', activityType: 'natural_gas', gas: 'CO2e', gasCoverage: 'all_ghg', geographyCode: 'UK',
        reportingYear: 2031, dataYear: 2031, scope: 1, factorValue: 0.2, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh',
        calorificBasis: 'gross', scope2Method: 'not_applicable',
        methodology: 'Spec fixture — not a methodology', source: 'SPEC FIXTURE — not a real emission factor',
      },
    ],
    conversions: [],
  };
}

/** Just enough of the client for `load`: the identity check, the reads, one transaction. */
function fakeDb(existing: Record<string, unknown> | null = null) {
  const created = { release: [] as unknown[], factors: [] as unknown[], conversions: [] as unknown[], sealed: [] as unknown[] };
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    factorRelease: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => (created.release.push(args.data), { id: 'new-release', ...args.data })),
      update: vi.fn(async (args: unknown) => (created.sealed.push(args), { id: 'new-release' })),
    },
    emissionFactor: { createMany: vi.fn(async (args: { data: unknown[] }) => (created.factors.push(...args.data), { count: args.data.length })) },
    unitConversion: { createMany: vi.fn(async (args: { data: unknown[] }) => (created.conversions.push(...args.data), { count: args.data.length })) },
  };
  const db = {
    $queryRaw: vi.fn(async () => [{ session: 'tonyai_factor_loader', current: 'tonyai_factor_loader' }]),
    factorRelease: { findUnique: vi.fn(async () => existing) },
    emissionFactor: { findMany: vi.fn(async () => []) },
    unitConversion: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { db: db as unknown as PrismaClient, raw: db, tx, created };
}

describe('FactorReleaseLoader.load', () => {
  beforeEach(() => vi.mocked(validateFactorReleaseImport).mockClear());

  it("validates the file with the contract's defaults — never a stand-in publisher list (LP4-02 follow-ups (4))", async () => {
    const input = fixtureRelease();
    await new FactorReleaseLoader(fakeDb().db, 'TonyAI data team').load(input, { apply: false });
    expect(validateFactorReleaseImport).toHaveBeenCalledTimes(1);
    // Exactly one argument: no `options`, so no `testPublishers`.
    expect(vi.mocked(validateFactorReleaseImport).mock.calls[0]).toEqual([input]);
  });

  it('refuses a file with issues before touching the database, listing every issue', async () => {
    const { db, raw } = fakeDb();
    const input = fixtureRelease();
    const bad = { ...input, release: { ...input.release, publisher: 'DESNZ ', status: 'authoritative' } };
    const refusal = await new FactorReleaseLoader(db, 'TonyAI data team').load(bad, { apply: true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(LoaderRefusal);
    expect((refusal as LoaderRefusal).issues.length).toBeGreaterThan(0);
    expect((refusal as LoaderRefusal).issues.map((i) => i.path)).toContain('release.publisher');
    expect(raw.$queryRaw).not.toHaveBeenCalled();
    expect(raw.$transaction).not.toHaveBeenCalled();
  });

  it('writes nothing on a dry run, and says what it would load', async () => {
    const { db, raw } = fakeDb();
    const report = await new FactorReleaseLoader(db, 'TonyAI data team').load(fixtureRelease(), { apply: false });
    expect(report).toMatchObject({
      outcome: 'would_load',
      release: { publisher: INTERNAL_FACTOR_PUBLISHERS.fixture, edition: 'spec-1', ordinal: 7, status: 'fixture' },
      factors: 1,
      conversions: 0,
    });
    expect(raw.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['the owner logged in, acting as the loader', { session: 'postgres', current: 'tonyai_factor_loader' }],
    ['the loader logged in, acting as another role', { session: 'tonyai_factor_loader', current: 'postgres' }],
  ])('refuses %s — its login and its role must both be the loader', async (_label, who) => {
    const { db, raw } = fakeDb();
    raw.$queryRaw.mockResolvedValueOnce([who]);
    const refusal = await new FactorReleaseLoader(db, 'TonyAI data team').load(fixtureRelease(), { apply: true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(LoaderRefusal);
    expect((refusal as Error).message).toMatch(/connect as tonyai_factor_loader/);
    expect(raw.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to load an edition again once it is withdrawn — naming the withdrawal, not other content', async () => {
    const input = fixtureRelease();
    const withdrawn = {
      id: 'old', ...input.release, publishedAt: null, reviewedAt: null, status: 'withdrawn', sealedAt: new Date(),
      withdrawnAt: new Date(), withdrawnBy: 'TonyAI data team', withdrawalReason: 'Erratum', createdAt: new Date(),
    };
    const { db, raw } = fakeDb(withdrawn);
    const refusal = await new FactorReleaseLoader(db, 'TonyAI data team').load(input, { apply: true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(LoaderRefusal);
    expect((refusal as Error).message).toMatch(/is withdrawn \(Erratum\) — a withdrawn edition is never loaded again/);
    expect(raw.$transaction).not.toHaveBeenCalled();
  });

  it("maps the file's rows column by column — a stray key never reaches the database — and seals what it loads", async () => {
    const { db, tx, created } = fakeDb();
    const input = fixtureRelease();
    const stray = { ...input.factors[0], id: 'chosen-id', releaseId: 'another-release', version: 'another-edition', createdAt: '2000-01-01' };
    const withStray = { ...input, release: { ...input.release, sealedAt: '2000-01-01', id: 'chosen' }, factors: [stray] };
    const report = await new FactorReleaseLoader(db, 'TonyAI data team').load(withStray, { apply: true });
    expect(report.outcome).toBe('loaded');
    expect(created.release[0]).not.toHaveProperty('id');
    expect(created.release[0]).not.toHaveProperty('sealedAt');
    expect(created.factors[0]).toEqual({
      ...input.factors[0],
      releaseId: 'new-release',
      // A factor's version is its release's edition (the database refuses any other).
      version: 'spec-1',
    });
    // The seal, in the same transaction, after the rows.
    expect(tx.factorRelease.update).toHaveBeenCalledWith({ where: { id: 'new-release' }, data: { sealedAt: expect.any(Date) } });
    expect(tx.emissionFactor.createMany.mock.invocationCallOrder[0]).toBeLessThan(tx.factorRelease.update.mock.invocationCallOrder[0]);
    // The operator is the stated actor of every event the load writes.
    expect(tx.$executeRaw).toHaveBeenCalled();
  });
});
