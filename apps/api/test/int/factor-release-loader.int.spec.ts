import { randomUUID } from 'node:crypto';
import { INTERNAL_FACTOR_PUBLISHERS, type FactorReleaseImport } from '@tonyai/shared-types';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CalculationsService } from '../../src/calculations/calculations.service';
import { FactorReleaseLoader, LoaderRefusal } from '../../src/factor-releases/factor-release-loader';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { connect, connectLoader, connectOwner } from './db';
import { INT_FACTOR_POLICY } from './services';

/**
 * LP4-02 PR B1 — the factor loader against real PostgreSQL, through its own
 * login (`tonyai_factor_loader`): a release loads whole and sealed, a re-run
 * is a no-op, an erratum withdraws what it corrects in the same transaction,
 * and nothing else is the loader's. Labelled test fixtures only: no real
 * publisher is registered before the owner records its source and licence
 * (decision L6), and every value here says it is not an emission factor.
 */

const FIXTURE = INTERNAL_FACTOR_PUBLISHERS.fixture;
const OPERATOR = 'TonyAI test operator';

let loaderDb: PrismaService;
let owner: PrismaService;
let runtime: PrismaService;
const loaded: string[] = [];

beforeAll(() => {
  loaderDb = connectLoader();
  owner = connectOwner();
  runtime = connect();
});

afterEach(async () => {
  // Fixture releases are test data: deletable with their rows, withdrawn or not.
  for (const edition of loaded.splice(0)) {
    const release = await owner.factorRelease.findUnique({ where: { publisher_edition: { publisher: FIXTURE, edition } } });
    if (!release) continue;
    await owner.emissionFactor.deleteMany({ where: { releaseId: release.id } });
    await owner.unitConversion.deleteMany({ where: { releaseId: release.id } });
    await owner.factorRelease.delete({ where: { id: release.id } });
  }
});

afterAll(async () => {
  await Promise.all([loaderDb.$disconnect(), owner.$disconnect(), runtime.$disconnect()]);
});

async function nextOrdinal(): Promise<number> {
  const latest = await owner.factorRelease.findFirst({ where: { publisher: FIXTURE }, orderBy: { ordinal: 'desc' }, select: { ordinal: true } });
  return (latest?.ordinal ?? 0) + 1;
}

/** A labelled fixture release file: one Natural Gas factor for 2031 at `factorValue`. */
async function fixtureFile(factorValue = 0.2): Promise<FactorReleaseImport> {
  const edition = `int-loader-${randomUUID()}`;
  loaded.push(edition);
  return {
    release: {
      publisher: FIXTURE, title: 'Loader integration fixture — not a source', edition, ordinal: await nextOrdinal(), status: 'fixture',
      sourceUrl: null, licence: null, publishedAt: null, gwpSet: null, reviewedBy: null, reviewedAt: null,
      notes: 'Written by the loader integration spec and removed by it. Not a source.',
    },
    factors: [
      {
        category: 'Natural Gas', activityType: 'natural_gas', gas: 'CO2e', gasCoverage: 'all_ghg', geographyCode: 'UK',
        reportingYear: 2031, dataYear: 2031, scope: 1, factorValue, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh',
        calorificBasis: 'gross', scope2Method: 'not_applicable',
        methodology: 'Loader integration fixture — not a methodology', source: 'INT FIXTURE — not a real emission factor',
      },
    ],
    conversions: [
      {
        category: 'Natural Gas', activityType: 'natural_gas', geographyCode: 'UK', reportingYear: 2031, dataYear: 2031,
        fromUnit: 'cubic_metres', toUnit: 'kWh', multiplier: 10, calorificBasis: 'gross', referenceConditions: 'INT FIXTURE — no conditions',
        basis: 'INT FIXTURE — not a real conversion',
      },
    ],
  };
}

const eventsOf = (releaseId: string) =>
  owner.$queryRawUnsafe<{ event: string; db_role: string; actor: string | null; row_count: number | null }[]>(
    `SELECT event, db_role, actor, row_count FROM factor_release_events WHERE release_id = '${releaseId}' ORDER BY occurred_at`,
  );

async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('the factor loader (LP4-02 PR B1)', () => {
  it('plans on a dry run and writes nothing', async () => {
    const file = await fixtureFile();
    const report = await new FactorReleaseLoader(loaderDb, OPERATOR).load(file, { apply: false });
    expect(report).toMatchObject({ outcome: 'would_load', factors: 1, conversions: 1, supersedes: null });
    expect(await owner.factorRelease.count({ where: { publisher: FIXTURE, edition: file.release.edition } })).toBe(0);
  });

  it('loads a release whole and sealed, recorded as the loader with the stated operator — and a re-run is a no-op', async () => {
    const file = await fixtureFile();
    const loader = new FactorReleaseLoader(loaderDb, OPERATOR);
    expect(await loader.load(file, { apply: true })).toMatchObject({ outcome: 'loaded', release: { edition: file.release.edition } });
    const release = await owner.factorRelease.findUniqueOrThrow({
      where: { publisher_edition: { publisher: FIXTURE, edition: file.release.edition } },
      include: { factors: true, conversions: true },
    });
    expect(release.sealedAt).not.toBeNull();
    expect(release.factors).toHaveLength(1);
    expect(release.factors[0]).toMatchObject({ factorValue: 0.2, version: file.release.edition });
    expect(release.conversions).toHaveLength(1);
    const events = await eventsOf(release.id);
    expect(events.map((e) => [e.event, e.db_role, e.actor])).toEqual([
      ['loaded', 'tonyai_factor_loader', OPERATOR],
      ['rows_added', 'tonyai_factor_loader', OPERATOR],
      ['rows_added', 'tonyai_factor_loader', OPERATOR],
      ['sealed', 'tonyai_factor_loader', OPERATOR],
    ]);
    // Idempotent: nothing written, nothing recorded.
    expect(await loader.load(file, { apply: true })).toMatchObject({ outcome: 'already_loaded' });
    expect(await eventsOf(release.id)).toHaveLength(4);
  });

  it('refuses other content under a loaded edition — an erratum is a new edition', async () => {
    const file = await fixtureFile();
    const loader = new FactorReleaseLoader(loaderDb, OPERATOR);
    await loader.load(file, { apply: true });
    const changed = { ...file, factors: [{ ...file.factors[0], factorValue: 0.3 }] };
    const refusal = await failure(loader.load(changed, { apply: true }));
    expect(refusal).toBeInstanceOf(LoaderRefusal);
    expect((refusal as Error).message).toMatch(/already loaded with other content — an erratum is a new edition/);
  });

  it('loads an erratum and withdraws what it corrects in one transaction — pricing moves to it at once', async () => {
    const loader = new FactorReleaseLoader(loaderDb, OPERATOR);
    const engine = new CalculationsService(runtime, INT_FACTOR_POLICY);
    const input = { category: 'Natural Gas', geographyCode: 'UK', reportingYear: 2031, value: 100, unit: 'kWh' };
    const first = await fixtureFile(0.2);
    await loader.load(first, { apply: true });
    expect(await engine.compute(input)).toMatchObject({ kgCo2e: 20, version: first.release.edition });

    const erratum = await fixtureFile(0.25);
    const reason = 'Erratum: the 2031 natural gas factor corrected';
    // The dry run names what it would withdraw, and withdraws nothing.
    expect(await loader.load(erratum, { apply: false, supersedes: first.release.edition, reason })).toMatchObject({
      outcome: 'would_load',
      supersedes: { edition: first.release.edition, status: 'fixture', reason },
    });
    expect(await owner.factorRelease.count({ where: { edition: first.release.edition, status: 'withdrawn' } })).toBe(0);

    expect(await loader.load(erratum, { apply: true, supersedes: first.release.edition, reason })).toMatchObject({ outcome: 'loaded' });
    const old = await owner.factorRelease.findUniqueOrThrow({ where: { publisher_edition: { publisher: FIXTURE, edition: first.release.edition } } });
    expect(old).toMatchObject({ status: 'withdrawn', withdrawnBy: OPERATOR, withdrawalReason: reason });
    expect(await engine.compute(input)).toMatchObject({ kgCo2e: 25, version: erratum.release.edition });
    // Again: a no-op. And an erratum of a withdrawn edition is refused.
    expect(await loader.load(erratum, { apply: true, supersedes: first.release.edition, reason })).toMatchObject({ outcome: 'already_loaded' });
    const third = await fixtureFile(0.3);
    expect(await failure(loader.load(third, { apply: true, supersedes: first.release.edition, reason }))).toBeInstanceOf(LoaderRefusal);
  });

  it('loads an erratum and its withdrawal together or not at all — a refused withdrawal leaves the erratum unloaded', async () => {
    const loader = new FactorReleaseLoader(loaderDb, OPERATOR);
    const first = await fixtureFile(0.2);
    await loader.load(first, { apply: true });
    const erratum = await fixtureFile(0.25);
    // Longer than the release's text CHECK admits (the CLI refuses it first):
    // the database refuses the withdrawal inside the load's transaction.
    const refusal = await failure(loader.load(erratum, { apply: true, supersedes: first.release.edition, reason: 'x'.repeat(2001) }));
    expect(refusal).not.toBeNull();
    expect(await owner.factorRelease.count({ where: { publisher: FIXTURE, edition: erratum.release.edition } })).toBe(0);
    expect(await owner.factorRelease.findUniqueOrThrow({ where: { publisher_edition: { publisher: FIXTURE, edition: first.release.edition } } })).toMatchObject({
      status: 'fixture',
    });
  });

  it('withdraws a release with no replacement, once, as the loader', async () => {
    const loader = new FactorReleaseLoader(loaderDb, OPERATOR);
    const file = await fixtureFile();
    await loader.load(file, { apply: true });
    const target = { publisher: FIXTURE, edition: file.release.edition, reason: 'Found wrong at review' };
    expect(await loader.withdraw(target, false)).toMatchObject({ outcome: 'would_withdraw' });
    expect(await loader.withdraw(target, true)).toMatchObject({ outcome: 'withdrawn' });
    expect(await loader.withdraw(target, true)).toMatchObject({ outcome: 'already_withdrawn' });
    const release = await owner.factorRelease.findUniqueOrThrow({ where: { publisher_edition: { publisher: FIXTURE, edition: file.release.edition } } });
    expect((await eventsOf(release.id)).map((e) => [e.event, e.db_role, e.actor]).at(-1)).toEqual(['withdrawn', 'tonyai_factor_loader', OPERATOR]);
  });

  it('refuses any login but its own — the owner and the API alike — before reading the file into the database', async () => {
    for (const client of [owner, runtime]) {
      const file = await fixtureFile();
      const refusal = await failure(new FactorReleaseLoader(client, OPERATOR).load(file, { apply: true }));
      expect(refusal).toBeInstanceOf(LoaderRefusal);
      expect((refusal as Error).message).toMatch(/connect as tonyai_factor_loader/);
      expect(await owner.factorRelease.count({ where: { edition: file.release.edition } })).toBe(0);
    }
  });

  it('refuses a file the contract refuses, naming every issue, and writes nothing', async () => {
    const file = await fixtureFile();
    const bad = { ...file, release: { ...file.release, status: 'authoritative' }, factors: [{ ...file.factors[0], gas: 'CO2x' }] };
    const refusal = await failure(new FactorReleaseLoader(loaderDb, OPERATOR).load(bad, { apply: true }));
    expect(refusal).toBeInstanceOf(LoaderRefusal);
    expect((refusal as LoaderRefusal).issues.map((i) => i.path)).toEqual(expect.arrayContaining(['factors[0].gas']));
    expect(await owner.factorRelease.count({ where: { edition: file.release.edition } })).toBe(0);
  });
});
