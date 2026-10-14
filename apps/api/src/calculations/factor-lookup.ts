import { Prisma, type EmissionFactor, type FactorRelease, type UnitConversion } from '@tonyai/db';
import {
  CALCULATION_GAS,
  DIMENSION_BASE_UNIT,
  resolveFactorPath,
  scope2MethodFor,
  unitDimensionOf,
  type FactorPathResolution,
  type FactorStatus,
} from '@tonyai/shared-types';
import type { PrismaService } from '../prisma/prisma.service';
import { FactorLibraryConflictError } from './errors';
import type { FactorPolicy } from './factor-policy';

/**
 * The ONE factor lookup (LP3-04 PR B, W2; README "Inventory coverage and
 * report datasets"): which factor — and which sourced conversion — prices one
 * category, activity type, geography, year and unit. The engine prices with
 * it, and LP3-04's dataset producer will read the library through it inside
 * its capture transaction; nothing else selects candidates from the library
 * (`factor-lookup.single-source.spec.ts` fails on a second copy).
 */

/** Every status a calculation may ever resolve from — never `withdrawn`. */
export const LIVE_STATUSES: readonly FactorStatus[] = ['authoritative', 'placeholder', 'fixture'];

/**
 * A release is read once sealed (LP4-02): the loader seals it in the
 * transaction that loads it, and the database refuses a commit that leaves one
 * unsealed — so this excludes only what a restore or a disabled guard left
 * behind, a release whose contents nobody closed.
 */
export const SEALED = { sealedAt: { not: null } } as const;

/**
 * More candidate rows than one lookup can legitimately have. A lookup is one
 * category, activity type, geography and year; its candidates are that key's
 * factors across releases and units, and its conversions — paths are
 * factors × conversions, so an unbounded library would make one request
 * quadratic. Above the cap the library is defective and the lookup refused.
 */
export const FACTOR_CANDIDATE_CAP = 50;

type FactorRow = EmissionFactor & { release: FactorRelease };
type ConversionRow = UnitConversion & { release: FactorRelease };
type Ranked<T extends { release: FactorRelease }> = T & { release: FactorRelease & { status: FactorStatus } };

/**
 * A row with its release status typed as the contract's. The column is
 * CHECK-constrained to `FACTOR_STATUSES`, and `selectByRelease` ignores any
 * status it does not know in any case.
 */
function ranked<T extends { release: FactorRelease }>(row: T): Ranked<T> {
  return { ...row, release: { ...row.release, status: row.release.status as FactorStatus } };
}

/** What a lookup is keyed on — exactly these four; the unit is its own argument. */
export interface FactorLookupKey {
  category: string;
  activityType: string;
  geographyCode: string;
  reportingYear: number;
}

export type FactorLookupResult = FactorPathResolution<Ranked<FactorRow>, Ranked<ConversionRow>>;

/** A transaction handed to the lookup that cannot hold one snapshot. */
export class CaptureSnapshotError extends Error {}

/** Every snapshot `CaptureSnapshot.open` made — and nothing else. */
const OPENED = new WeakSet<object>();

/**
 * The database as one capture's transaction sees it — the factor library
 * through `lookupFactorPath`, the boundary through `readInventoryBoundary`.
 * Opened only from a transaction at REPEATABLE READ or SERIALIZABLE: every
 * statement in it reads the same snapshot, so a capture's boundary, records,
 * releases and factor candidates agree — at READ COMMITTED an erratum committed between two of its reads would
 * price the old factor with the new conversion (Codex's B9 review of LP4-02
 * PR B1, F2). Never a record writer's transaction: their triggers require READ
 * COMMITTED (TA003), so the engine itself is never handed one (LP4-02 (26)) —
 * it reads in a snapshot of its own.
 */
export class CaptureSnapshot {
  // An ES private field, not TypeScript's `private`, read through `txOf` only:
  // a shape-alike (`Object.create(prototype)`, a Proxy, a spread) has no
  // `#tx`; and a snapshot counts only if `open` made it — TypeScript's private
  // constructor is not JavaScript's, so `Reflect.construct` or a subclass
  // could otherwise skip the isolation check. Frozen, so a genuine one cannot
  // be re-pointed (security-rls P3-2 and its re-check).
  readonly #tx: Prisma.TransactionClient;

  private constructor(tx: Prisma.TransactionClient) {
    this.#tx = tx;
    Object.freeze(this);
  }

  /** Was this snapshot opened by `open` — not merely shaped or built like one? */
  static isOpened(value: unknown): value is CaptureSnapshot {
    return typeof value === 'object' && value !== null && OPENED.has(value);
  }

  /** The transaction an opened snapshot reads in. */
  static txOf(snapshot: CaptureSnapshot): Prisma.TransactionClient {
    if (!CaptureSnapshot.isOpened(snapshot)) {
      throw new CaptureSnapshotError('A capture reads in a snapshot opened by CaptureSnapshot.open only.');
    }
    return snapshot.#tx;
  }

  static async open(tx: Prisma.TransactionClient): Promise<CaptureSnapshot> {
    // The root client has `$transaction`; an interactive transaction's does
    // not. A root client's statements are each a transaction of their own.
    if ('$transaction' in tx) {
      throw new CaptureSnapshotError('The factor lookup reads in a caller snapshot only inside an interactive transaction.');
    }
    const [row] = await tx.$queryRaw<Array<{ isolation: string }>>`
      SELECT pg_catalog.current_setting('transaction_isolation') AS isolation`;
    if (row?.isolation !== 'repeatable read' && row?.isolation !== 'serializable') {
      throw new CaptureSnapshotError(
        `The factor lookup reads in a caller snapshot only at REPEATABLE READ or SERIALIZABLE, not ${row?.isolation ?? 'an unknown level'}.`,
      );
    }
    const snapshot = new CaptureSnapshot(tx);
    OPENED.add(snapshot);
    return snapshot;
  }
}

/**
 * The candidate factors and conversions of one lookup, matched EXACTLY on
 * category, activity type, geography and reporting year — a loose match
 * would apply another country's calorific value or another year's grid —
 * factors also on the CO2e row of the category's own Scope 2 method, and
 * conversions from the base unit of the record's family. Releases are
 * filtered by status here, in SQL, as well as by `resolveFactorPath`, and
 * to sealed ones.
 *
 * Both reads see ONE snapshot of the library: the caller's, or else a
 * REPEATABLE READ, read-only batch of their own — read apart, an erratum
 * committed between them (the new release loaded, the old withdrawn,
 * atomically) priced the old factor with the new conversion (measured: 400
 * kgCO2e where either library alone gives 200 or 600).
 */
async function candidates(
  prisma: PrismaService,
  snapshot: CaptureSnapshot | undefined,
  key: FactorLookupKey,
  baseUnit: string,
  statuses: readonly FactorStatus[],
): Promise<{ factors: FactorRow[]; conversions: ConversionRow[] }> {
  const db = snapshot ? CaptureSnapshot.txOf(snapshot) : prisma;
  const where = { ...key, release: { status: { in: [...statuses] }, ...SEALED } };
  const factorQuery = db.emissionFactor.findMany({
    where: { ...where, gas: CALCULATION_GAS, scope2Method: scope2MethodFor(key.category) },
    include: { release: true },
    orderBy: { id: 'asc' },
    take: FACTOR_CANDIDATE_CAP + 1,
  });
  const conversionQuery = db.unitConversion.findMany({
    where: { ...where, fromUnit: baseUnit },
    include: { release: true },
    orderBy: { id: 'asc' },
    take: FACTOR_CANDIDATE_CAP + 1,
  });
  const [factors, conversions] = snapshot
    ? [await factorQuery, await conversionQuery]
    : await prisma.$transaction([factorQuery, conversionQuery], {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
  if (factors.length > FACTOR_CANDIDATE_CAP || conversions.length > FACTOR_CANDIDATE_CAP) {
    throw new FactorLibraryConflictError(
      'ambiguous_factor',
      `The factor library holds more than ${FACTOR_CANDIDATE_CAP} candidate rows for category ` +
        `"${key.category}" (${key.activityType}, ${key.geographyCode}, ${key.reportingYear}) — a library defect, refused rather than searched.`,
    );
  }
  return { factors, conversions };
}

/**
 * Which factor — and which sourced conversion — prices this lookup, by
 * `resolveFactorPath`: the one rule the engine, the seed and the coverage
 * report share.
 *
 * Where placeholders are refused, the pricing query reads authoritative
 * releases only, so no non-authoritative row ever reaches the arithmetic
 * even if the resolver were wrong. A refusal is then re-derived over every
 * live release — never to price, only so the code names the real gap
 * (`placeholder_refused` — "load the source" — rather than `no_factor`). In a
 * caller's snapshot both passes read that snapshot; in the engine's own, each
 * pass is a snapshot of its own, as before.
 */
export async function lookupFactorPath(
  prisma: PrismaService,
  policy: FactorPolicy,
  lookup: FactorLookupKey,
  inputUnit: string,
  snapshot?: CaptureSnapshot,
): Promise<FactorLookupResult> {
  if (snapshot !== undefined && !CaptureSnapshot.isOpened(snapshot)) {
    throw new CaptureSnapshotError('The factor lookup reads in a snapshot opened by CaptureSnapshot.open only.');
  }
  // Exactly the key's four columns reach the query — a caller's wider object
  // (a coverage key carries its unit) never becomes a filter.
  const key: FactorLookupKey = {
    category: lookup.category,
    activityType: lookup.activityType,
    geographyCode: lookup.geographyCode,
    reportingYear: lookup.reportingYear,
  };
  const dimension = unitDimensionOf(inputUnit);
  if (dimension === undefined) return { ok: false, code: 'unit_unknown' };
  const baseUnit = DIMENSION_BASE_UNIT[dimension];
  const allowPlaceholders = policy.allowPlaceholders;
  const run = async (statuses: readonly FactorStatus[]) => {
    const { factors, conversions } = await candidates(prisma, snapshot, key, baseUnit, statuses);
    return resolveFactorPath({
      category: key.category,
      inputUnit,
      factors: factors.map(ranked),
      conversions: conversions.map(ranked),
      allowPlaceholders,
    });
  };
  const result = await run(allowPlaceholders ? LIVE_STATUSES : ['authoritative']);
  if (result.ok || allowPlaceholders) return result;
  // Diagnostic only. A library that is defective among its non-authoritative
  // rows (over the cap) must not turn this lookup's 404 into a 409.
  try {
    const why = await run(LIVE_STATUSES);
    return why.ok ? result : why;
  } catch (e) {
    if (e instanceof FactorLibraryConflictError) return result;
    throw e;
  }
}
