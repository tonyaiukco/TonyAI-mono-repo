import { HttpException } from '@nestjs/common';
import type { ActivityRecord, ActivityRecordStatus, Prisma } from '@tonyai/db';
import {
  anomalyNotEvaluated,
  canonicalPeriodValue,
  CATEGORY_SCOPE_MAP,
  computeAnomalyVerdict,
  COUNTED_STATUSES,
  isCalculated,
  normalizeRecordParameters,
  PERIOD_VALUES,
  withFirstPeriodCeiling,
  type ActivityCalculationSnapshot,
  type AnomalyVerdict,
  type Category,
  type RecordParameters,
  type ReportingPeriod,
} from '@tonyai/shared-types';
import type { CalculationsService } from '../calculations/calculations.service';
import { storedUnit } from '../calculations/storable-unit';
import { ResourceNotFoundError } from '../common/api-error';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * K11's recompute (Decisions 2026-10-11, L4 and P6; LP4-02 B2): the snapshot
 * the engine gives NOW for a record's stored inputs, or the name of the
 * refusal it gave instead.
 */
export type Recomputed =
  | { ok: true; calculation: ActivityCalculationSnapshot }
  | { ok: false; refusal: string };

/**
 * The record's columns the engine reads — with the geography of its subsidiary
 * or site, which lives on those rows. Equal on the row as read and as locked,
 * they prove a recompute taken from the first still describes the second,
 * whoever wrote in between (decision C1-a, 2026-10-13): `updatedAt` is Prisma's
 * own stamp, which a direct writer neither sets nor is stopped from setting.
 */
const ENGINE_INPUT_COLUMNS = [
  'subsidiaryId',
  'locationId',
  'category',
  'activityType',
  'reportingYear',
  'reportingPeriod',
  'activityValue',
  'activityUnit',
] as const satisfies readonly (keyof ActivityRecord)[];

export function sameEngineInputs(read: ActivityRecord, locked: ActivityRecord): boolean {
  return (
    ENGINE_INPUT_COLUMNS.every((column) => (read[column] ?? null) === (locked[column] ?? null)) &&
    sameParameters(read.parameters, locked.parameters)
  );
}

/** Compared by value, a null field being an absent one: Prisma returns a new object per read. */
export function sameParameters(a: unknown, b: unknown): boolean {
  return canonicalParameters(normalizeRecordParameters(a)) === canonicalParameters(normalizeRecordParameters(b));
}

function canonicalParameters(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    field !== null && typeof field === 'object' && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => (a < b ? -1 : 1)))
      : field,
  );
}

/** A refusal's stable code for the log — never its sentence, which may quote input. */
function refusalName(error: HttpException): string {
  const body = error.getResponse();
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : error.constructor.name;
}

/** What the first-period typo ceiling judges, beside the series key. */
interface CeilingAmount {
  activityValue: number;
  activityUnit: string;
  parameters: unknown;
}

/** Inputs to the VAR §4 rolling-baseline check, minus the figure itself. */
interface AnomalyParams {
  subsidiaryId: string;
  locationId: string | null;
  category: string;
  /** Null for an untyped record — never undefined, which Prisma would drop
   *  from the `where` and so pool diesel with petrol (LP3-03). */
  activityType: string | null;
  reportingPeriod: string;
  reportingYear: number;
  periodValue: string;
  currentTCo2e: number;
  excludeId?: string;
}

// --- Anomaly detection (VAR §4) --------------------------------------------
// A value is anomalous when it deviates > ±50% from the rolling average of the
// previous 3 comparable periods for the same reporting entity, measured on
// calculated tCO₂e. Only committed rows feed the baseline (unreviewed drafts
// would add noise). Warning-based, never auto-rejection (VAR §8).
//
// ONE prior with a figure is enough (BUG-R2-07, decision 2026-11-11, which
// supersedes "three priors or the rule does not run" of 2026-08-27). One or two
// is a LIMITED-history verdict under the same threshold, none is NOT EVALUATED,
// and the record says which via `baselinePriorCount` — the count is what lets
// a screen tell a one-period comparison from a three-period average, which
// `anomalyFlag` alone never could.
//
// The window, the minimum and the threshold live in @tonyai/shared-types: a
// screen has to state the same rule now that "on 2 periods" is something it
// must be able to say.
// The SAME list the inventory counts — a sixth hand-written copy of it lived
// here, character-identical, in the file this rule is most likely to be edited
// from. A record that counts towards the totals is exactly a record that should
// inform the baseline, so the two can never legitimately differ.
const BASELINE_STATUSES: ActivityRecordStatus[] = [...COUNTED_STATUSES];

/** Position of a period within its year, so records can be ordered despite
 * `periodValue` being a plain string column. Only compared within the same
 * granularity (monthly 0–11, quarterly 1–4, annual single).
 *
 * Reads the shared vocabulary rather than a local lower-case copy of it — that
 * copy was one of six, and it is the reason nothing in this file could say what
 * the canonical spelling of a month WAS. */
export function periodOrdinal(reportingPeriod: string, periodValue: string): number {
  const canonical = canonicalPeriodValue(reportingPeriod, periodValue);
  if (canonical === null) return 0;
  const allowed: readonly string[] =
    PERIOD_VALUES[reportingPeriod as ReportingPeriod];
  // `canonical` came out of this very list, so the index is always found — no
  // `Math.max` floor, which would only have hidden a broken canonicaliser.
  //
  // Quarters stay 1-based and months 0-based, exactly as before. An ordinal is
  // only ever compared against another of the SAME granularity, so the bases do
  // not need to agree; what the +1 buys is keeping `Q1` distinct from
  // "unrecognised value" (0), which the regex it replaced also did.
  const i = allowed.indexOf(canonical);
  return reportingPeriod === 'quarterly' ? i + 1 : i;
}

/** Shared database-backed calculation for API records and operator repricing. */
export class ActivityRecordCalculation {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calculations: CalculationsService,
  ) {}

  /**
   * Produce the immutable calculation snapshot for a record by resolving the
   * subsidiary's geography and the category's scope, then calling the calc
   * engine. Returns both the snapshot and the derived scope.
   */
  async computeSnapshot(
    subsidiaryId: string,
    accessibleSubsidiaryIds: string[],
    category: Category,
    reportingYear: number,
    activityValue: number,
    activityUnit: string,
    locationId: string | null | undefined,
    /** The record's own activity type (null when it names none). */
    activityType: string | null,
    /** The record's period and per-record inputs, which the TR rules read (D11). */
    inputs: { reportingPeriod: string; parameters: RecordParameters | null },
    /** False when `activityUnit` came from the stored record, not this request. */
    unitChosenNow = true,
  ): Promise<{ calculation: ActivityCalculationSnapshot; scope: number }> {
    if (!accessibleSubsidiaryIds.includes(subsidiaryId)) {
      // Tenant isolation: cannot attach a record to an inaccessible subsidiary.
      throw new ResourceNotFoundError('subsidiary_not_found');
    }
    const subsidiary = await this.prisma.subsidiary.findUnique({
      where: { id: subsidiaryId },
    });
    if (!subsidiary) throw new ResourceNotFoundError('subsidiary_not_found');

    // Reporting entity (data_entry_page.md §5.2): when a location is targeted, it drives the
    // factor geography; otherwise the subsidiary does. A location must belong to
    // the same (accessible) subsidiary, else it is treated as not found.
    let geographyCode = subsidiary.geographyCode;
    if (locationId) {
      const location = await this.prisma.location.findUnique({
        where: { id: locationId },
      });
      if (!location || location.subsidiaryId !== subsidiaryId) {
        throw new ResourceNotFoundError('location_not_found');
      }
      geographyCode = location.geographyCode;
    }

    const scope = CATEGORY_SCOPE_MAP[category];
    const calculation = await this.calculations.compute(
      {
        category,
        activityType,
        geographyCode,
        reportingYear,
        value: activityValue,
        unit: activityUnit,
        ...inputs,
      },
      { enforceCategoryUnit: unitChosenNow },
    );
    return { calculation, scope };
  }

  /**
   * K11, first half: recompute a record's snapshot from its stored inputs with
   * the current library — the unit as stored, so the category map is not
   * re-applied (as an edit that leaves the unit, `update`). A refusal is kept,
   * not thrown: every 4xx the engine or the entity lookups raise here means the
   * stored figure can no longer be reproduced, which `assertFresh` answers as
   * `calculation_stale` (C5-A) once the record's own gates have run — never as
   * `not_found`, which would read as "not yours". A 5xx or a plain `Error` is
   * a defect and propagates.
   *
   * Called BEFORE `withLockedRecord`, never inside it: the engine reads the
   * library in one REPEATABLE READ snapshot (`factor-lookup.ts`), and a
   * transaction's isolation level is fixed by its first statement — the lock
   * protocol's transaction is READ COMMITTED and must stay so. Nor is the
   * engine ever handed a transaction client ("LP4-02 follow-ups" (26)); the
   * lookup accepts only a REPEATABLE READ or SERIALIZABLE one
   * (`CaptureSnapshot`), which no record writer holds.
   */
  async recompute(accessibleSubsidiaryIds: string[], record: ActivityRecord): Promise<Recomputed> {
    try {
      const { calculation } = await this.computeSnapshot(
        record.subsidiaryId,
        accessibleSubsidiaryIds,
        record.category as Category,
        record.reportingYear,
        record.activityValue,
        record.activityUnit,
        record.locationId,
        record.activityType ?? null,
        { reportingPeriod: record.reportingPeriod, parameters: (record.parameters ?? null) as RecordParameters | null },
        false,
      );
      return { ok: true, calculation };
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() < 500) {
        return { ok: false, refusal: refusalName(e) };
      }
      throw e;
    }
  }

  /**
   * Anomaly check for a record whose figure comes from a snapshot.
   *
   * VAR §4 defines the deviation on the **calculated tCO₂e**, so a record that
   * produced no figure has nothing to deviate from and is never anomalous.
   * Substituting 0 — which is what a plain `?? 0` does — reads as a 100% drop
   * against any real baseline and would demand a variance comment for a value
   * that was never computed. The API and operator command share this verdict.
   */
  async detectAnomalyFor(
    calculation: ActivityCalculationSnapshot,
    params: Omit<AnomalyParams, 'currentTCo2e'>,
    amount: CeilingAmount,
    client: Pick<Prisma.TransactionClient, 'activityRecord'> = this.prisma,
  ): Promise<AnomalyVerdict> {
    // Reports 0 priors because none were ever queried, not because none exist.
    // "Has no figure of its own" and "has no comparable periods" are different
    // facts; a reader separates them with isCalculated() on the snapshot, which
    // travels on the same DTO.
    if (!isCalculated(calculation)) return anomalyNotEvaluated();
    const history = await this.detectAnomaly({ ...params, currentTCo2e: calculation.tCo2e }, client);
    // A first period has no history to judge it by; its typo ceiling does
    // (BUG-R2-07 tier 3, Decisions 2026-11-12). Judged on the values the
    // record will STORE — the canonical unit, the merged parameters — so the
    // consistency tools, reading the row, reach the same verdict.
    return withFirstPeriodCeiling(history, {
      category: params.category,
      activityType: params.activityType,
      activityValue: amount.activityValue,
      activityUnit: storedUnit(amount.activityUnit),
      parameters: amount.parameters,
    });
  }

  /**
   * Anomaly check (VAR §4): anomalous when `currentTCo2e` deviates > ±50% from
   * the rolling average of the previous 3 committed periods for the same
   * reporting entity (subsidiary + location + category) at the same granularity.
   * No prior with a figure → the rule does not run. Warning-only.
   *
   * The key includes `locationId` and the granularity, which VAR §4.1 does not
   * name — a deliberate deviation, now written into the spec: comparing a site
   * meter against a whole-company roll-up flags a change of SCOPE as a change of
   * consumption, and it is what stops a re-attribution raising a false anomaly.
   */
  private async detectAnomaly(
    params: AnomalyParams,
    client: Pick<Prisma.TransactionClient, 'activityRecord'> = this.prisma,
  ): Promise<AnomalyVerdict> {
    // Prisma DROPS a `where` entry whose value is `undefined`, so an unset
    // subsidiary here would widen the pool to every tenant in the database and
    // persist a cross-tenant average onto the record. Unreachable today — all
    // three callers pass a value whose accessibility was established upstream —
    // but upstream is an ORDERING convention (`computeSnapshot` validates and
    // does not return what it validated), and a convention is not a mechanism.
    if (!params.subsidiaryId) {
      throw new Error('anomaly baseline requires a subsidiary scope');
    }
    // Bounded by the data model, not by a page (LP4-05 PR C): one live record
    // per entity, category, activity type and period (the reporting-entity
    // unique index), at most 12 periods a year and reporting years 2000–2100,
    // so at most 1,212 rows — read as the four columns the rule needs, never
    // the records' free-form input.
    const rows = await client.activityRecord.findMany({
      where: {
        subsidiaryId: params.subsidiaryId,
        locationId: params.locationId,
        category: params.category,
        activityType: params.activityType,
        reportingPeriod: params.reportingPeriod,
        status: { in: BASELINE_STATUSES },
        // A fuel batch's record is no manual record's history: a batch is
        // judged per invoice and fuel (inc28-fuel-bulk D12, `judgeFuelBatch`).
        fuelBatchId: null,
        ...(params.excludeId ? { id: { not: params.excludeId } } : {}),
      },
      select: { reportingYear: true, reportingPeriod: true, periodValue: true, calculation: true },
    });

    const currentKey =
      params.reportingYear * 100 +
      periodOrdinal(params.reportingPeriod, params.periodValue);
    // SELECTING the pool needs a database and therefore lives here; JUDGING it
    // is `computeAnomalyVerdict` in the contract package, so the API and
    // `pnpm anomaly:recompute` cannot disagree about the same record — not even
    // in the last ULP, which is exactly how far Postgres's `avg()` differs from
    // this fold.
    const orderedPriors = rows
      .map((r) => ({
        key: r.reportingYear * 100 + periodOrdinal(r.reportingPeriod, r.periodValue),
        calc: r.calculation as unknown as ActivityCalculationSnapshot | null,
      }))
      .filter((x) => x.key < currentKey) // strictly earlier periods only
      .sort((a, b) => b.key - a.key)
      // A prior with no figure stays in the list as `null` rather than being
      // filtered out here: it must still CONSUME one of the three slots, and
      // dropping it before the window is applied would let the rule reach
      // further back to refill it.
      .map((x) => (isCalculated(x.calc) ? x.calc.tCo2e : null));

    return computeAnomalyVerdict(params.currentTCo2e, orderedPriors);
  }
}
