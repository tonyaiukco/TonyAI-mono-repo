import { Prisma, type FactorRelease, type PrismaClient } from '@tonyai/db';
import {
  validateFactorReleaseImport,
  type FactorImportIssue,
  type FactorImportRow,
  type FactorReleaseImport,
  type UnitConversionImportRow,
} from '@tonyai/shared-types';

/**
 * The factor library's loader (LP4-02, decisions L5 and P1–P8): it loads a
 * release whole — the release, its factors and conversions, its seal — in one
 * transaction, and withdraws one, as the database role `tonyai_factor_loader`
 * and nothing else. The database holds the rules (a sealed release takes no
 * row, a seal is the loader's or the owner's, a commit leaving a release
 * unsealed is refused); this checks the file against the contract first, so a
 * refusal names every issue and nothing is written while one stands.
 */
export const FACTOR_LOADER_ROLE = 'tonyai_factor_loader';

/** Rows per INSERT — far under PostgreSQL's 65,535 bind parameters. */
const INSERT_CHUNK = 1000;

export class LoaderRefusal extends Error {
  constructor(
    message: string,
    readonly issues: readonly FactorImportIssue[] = [],
  ) {
    super(message);
  }
}

export interface ReleaseSummary {
  publisher: string;
  edition: string;
  ordinal: number;
  status: string;
}

export interface LoadOptions {
  apply: boolean;
  /** The edition of the same publisher this release corrects: withdrawn in the load's transaction (P7). */
  supersedes?: string;
  reason?: string;
}

export interface LoadReport {
  command: 'load';
  outcome: 'would_load' | 'loaded' | 'already_loaded';
  operator: string;
  release: ReleaseSummary;
  factors: number;
  conversions: number;
  supersedes: (ReleaseSummary & { reason: string }) | null;
}

export interface WithdrawReport {
  command: 'withdraw';
  outcome: 'would_withdraw' | 'withdrawn' | 'already_withdrawn';
  operator: string;
  release: ReleaseSummary;
  reason: string;
}

type ReleaseData = Omit<Prisma.FactorReleaseCreateInput, 'factors' | 'conversions'>;
type FactorData = Omit<Prisma.EmissionFactorUncheckedCreateInput, 'releaseId' | 'version'>;
type ConversionData = Omit<Prisma.UnitConversionUncheckedCreateInput, 'releaseId'>;

/** A date the contract has checked is `YYYY-MM-DD`, as the `DATE` column holds it. */
const asDate = (value: string | null): Date | null => (value === null ? null : new Date(`${value}T00:00:00.000Z`));

/** Column by column from the checked file — a key the contract does not name never reaches the database. */
function releaseData(r: FactorReleaseImport['release']): ReleaseData {
  return {
    publisher: r.publisher,
    title: r.title,
    edition: r.edition,
    ordinal: r.ordinal,
    status: r.status,
    sourceUrl: r.sourceUrl,
    licence: r.licence,
    publishedAt: asDate(r.publishedAt),
    gwpSet: r.gwpSet,
    reviewedBy: r.reviewedBy,
    reviewedAt: asDate(r.reviewedAt),
    notes: r.notes,
  };
}

function factorData(f: FactorImportRow): FactorData {
  return {
    category: f.category,
    activityType: f.activityType,
    gas: f.gas,
    gasCoverage: f.gasCoverage,
    geographyCode: f.geographyCode,
    reportingYear: f.reportingYear,
    dataYear: f.dataYear,
    scope: f.scope,
    factorValue: f.factorValue,
    factorUnit: f.factorUnit,
    normalizedUnit: f.normalizedUnit,
    calorificBasis: f.calorificBasis,
    scope2Method: f.scope2Method,
    methodology: f.methodology,
    source: f.source,
  };
}

function conversionData(c: UnitConversionImportRow): ConversionData {
  return {
    category: c.category,
    activityType: c.activityType,
    geographyCode: c.geographyCode,
    reportingYear: c.reportingYear,
    dataYear: c.dataYear,
    fromUnit: c.fromUnit,
    toUnit: c.toUnit,
    multiplier: c.multiplier,
    calorificBasis: c.calorificBasis,
    referenceConditions: c.referenceConditions,
    basis: c.basis,
  };
}

const FACTOR_FIELDS = Object.keys(factorData({} as FactorImportRow)) as (keyof FactorData)[];
const CONVERSION_FIELDS = Object.keys(conversionData({} as UnitConversionImportRow)) as (keyof ConversionData)[];
const RELEASE_FIELDS = Object.keys(releaseData({} as FactorReleaseImport['release'])) as (keyof ReleaseData)[];

/** Rows as comparable text, in one order: what a release holds, whichever way it was read. */
function canonical(rows: readonly object[], fields: readonly string[]): string {
  return JSON.stringify(
    rows
      .map((row) => JSON.stringify(fields.map((f) => normalise((row as Record<string, unknown>)[f]))))
      .sort(),
  );
}

function normalise(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}

function summary(r: { publisher: string; edition: string; ordinal: number; status: string }): ReleaseSummary {
  return { publisher: r.publisher, edition: r.edition, ordinal: r.ordinal, status: r.status };
}

export class FactorReleaseLoader {
  constructor(
    private readonly db: PrismaClient,
    /** A firm or a role, never a person (P8): the events' actor and a withdrawal's `withdrawn_by`. */
    private readonly operator: string,
  ) {}

  /**
   * Load `input` (an untyped release file) whole and seal it; with
   * `supersedes`, withdraw that edition of the same publisher in the same
   * transaction — an erratum leaves neither two live releases nor none.
   * Idempotent: the same release already loaded is a no-op; a different one
   * under its edition is a refusal (an erratum is a new edition).
   */
  async load(input: unknown, options: LoadOptions): Promise<LoadReport> {
    // The contract's defaults, never a stand-in publisher list: a real release
    // is loaded only under a registered publisher (LP4-02 follow-ups (4)).
    const issues = validateFactorReleaseImport(input);
    if (issues.length > 0) {
      throw new LoaderRefusal(`the release file has ${issues.length} issue(s) — nothing was written`, issues);
    }
    if ((options.supersedes === undefined) !== (options.reason === undefined)) {
      throw new LoaderRefusal('an erratum names the edition it supersedes and why, together');
    }
    const file = input as FactorReleaseImport;
    const release = releaseData(file.release);
    const factors = file.factors.map(factorData);
    const conversions = file.conversions.map(conversionData);
    await this.assertLoader();

    const superseded = options.supersedes === undefined ? null : await this.find(release.publisher, options.supersedes);
    if (options.supersedes !== undefined && !superseded) {
      throw new LoaderRefusal(`${release.publisher} has no edition ${options.supersedes} to supersede`);
    }
    const report = (outcome: LoadReport['outcome']): LoadReport => ({
      command: 'load',
      outcome,
      operator: this.operator,
      release: summary(release),
      factors: factors.length,
      conversions: conversions.length,
      supersedes: superseded ? { ...summary(superseded), reason: options.reason! } : null,
    });

    const stored = await this.find(release.publisher, release.edition);
    if (stored) {
      await this.assertSameContent(stored, release, factors, conversions);
      if (superseded && superseded.status !== 'withdrawn') {
        throw new LoaderRefusal(
          `${release.publisher} ${release.edition} is loaded, but ${superseded.edition} it supersedes is not withdrawn — withdraw it with the withdraw command`,
        );
      }
      return report('already_loaded');
    }
    if (superseded?.status === 'withdrawn') {
      throw new LoaderRefusal(`${release.publisher} ${superseded.edition} is already withdrawn — load the new edition without --supersedes`);
    }
    if (!options.apply) return report('would_load');

    await this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_catalog.set_config('tonyai.actor', ${this.operator}, true)`;
        const { id } = await tx.factorRelease.create({ data: release, select: { id: true } });
        for (let i = 0; i < factors.length; i += INSERT_CHUNK) {
          const chunk = factors.slice(i, i + INSERT_CHUNK).map((f) => ({ ...f, releaseId: id, version: release.edition }));
          await tx.emissionFactor.createMany({ data: chunk });
        }
        for (let i = 0; i < conversions.length; i += INSERT_CHUNK) {
          const chunk = conversions.slice(i, i + INSERT_CHUNK).map((c) => ({ ...c, releaseId: id }));
          await tx.unitConversion.createMany({ data: chunk });
        }
        // The database's clock replaces the value given; after this the
        // release takes no row.
        await tx.factorRelease.update({ where: { id }, data: { sealedAt: new Date() } });
        if (superseded) {
          await tx.factorRelease.update({
            where: { id: superseded.id },
            data: { status: 'withdrawn', withdrawnBy: this.operator, withdrawalReason: options.reason!, withdrawnAt: new Date() },
          });
        }
      },
      // The library's triggers read concurrent loads and withdrawals: READ
      // COMMITTED, which they require. A large release takes a while.
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 300_000 },
    );
    return report('loaded');
  }

  /** Withdraw one release — a source found wrong with no replacement. Idempotent. */
  async withdraw(target: { publisher: string; edition: string; reason: string }, apply: boolean): Promise<WithdrawReport> {
    await this.assertLoader();
    const stored = await this.find(target.publisher, target.edition);
    if (!stored) throw new LoaderRefusal(`${target.publisher} has no edition ${target.edition}`);
    const report = (outcome: WithdrawReport['outcome']): WithdrawReport => ({
      command: 'withdraw',
      outcome,
      operator: this.operator,
      release: summary(stored),
      reason: target.reason,
    });
    if (stored.status === 'withdrawn') return report('already_withdrawn');
    if (!apply) return report('would_withdraw');
    await this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_catalog.set_config('tonyai.actor', ${this.operator}, true)`;
        await tx.factorRelease.update({
          where: { id: stored.id },
          data: { status: 'withdrawn', withdrawnBy: this.operator, withdrawalReason: target.reason, withdrawnAt: new Date() },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return report('withdrawn');
  }

  /**
   * The loader's own login, nothing else: the owner would load past the
   * loader's bounds, and the library's record names the database role.
   */
  private async assertLoader(): Promise<void> {
    const [who] = await this.db.$queryRaw<{ session: string; current: string }[]>`
      SELECT session_user::text AS "session", current_user::text AS "current"`;
    if (who?.session !== FACTOR_LOADER_ROLE || who.current !== FACTOR_LOADER_ROLE) {
      throw new LoaderRefusal(
        `connect as ${FACTOR_LOADER_ROLE} (FACTOR_LOADER_DATABASE_URL), not ${who?.session ?? 'an unknown role'}`,
      );
    }
  }

  private find(publisher: string, edition: string) {
    return this.db.factorRelease.findUnique({ where: { publisher_edition: { publisher, edition } } });
  }

  private async assertSameContent(
    stored: FactorRelease,
    release: ReleaseData,
    factors: FactorData[],
    conversions: ConversionData[],
  ): Promise<void> {
    const [storedFactors, storedConversions] = await Promise.all([
      this.db.emissionFactor.findMany({ where: { releaseId: stored.id } }),
      this.db.unitConversion.findMany({ where: { releaseId: stored.id } }),
    ]);
    const same =
      canonical([stored], RELEASE_FIELDS) === canonical([release], RELEASE_FIELDS) &&
      canonical(storedFactors, FACTOR_FIELDS) === canonical(factors, FACTOR_FIELDS) &&
      canonical(storedConversions, CONVERSION_FIELDS) === canonical(conversions, CONVERSION_FIELDS);
    if (!same) {
      throw new LoaderRefusal(
        `${release.publisher} ${release.edition} is already loaded with other content — an erratum is a new edition with the next ordinal (--supersedes=${release.edition})`,
      );
    }
  }
}
