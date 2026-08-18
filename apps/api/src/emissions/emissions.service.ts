import { Injectable, NotFoundException } from '@nestjs/common';
import { ActivityRecordStatus, Prisma, type ActivityRecord } from '@tonyai/db';
import {
  CATEGORIES,
  CATEGORY_SCOPE_MAP,
  COUNTED_STATUSES as SHARED_COUNTED_STATUSES,
  isCalculated,
  INVOICE_TRACKED_CATEGORIES,
  isEvidenceRequired,
  isInvoiceTracked,
  type ActivityCalculationSnapshot,
  type CalculationResult,
  type Category,
  type DataStatus,
  type EmissionsByCategory,
  type EmissionsBySubsidiary,
  type EmissionsSummary,
  type EmissionsTrendPoint,
  type TrackingMatrixCell,
  type TrackingMatrixDTO,
  type CategoryCompleteness,
  type SubsidiaryCompletenessDTO,
  type TrackingMatrixRow,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { EmissionsSummaryQueryDto } from './dto/emissions-summary-query.dto';
import { TrackingMatrixQueryDto } from './dto/tracking-matrix-query.dto';
import { CompletenessQueryDto } from './dto/completeness-query.dto';

/**
 * Only "committed" records feed the emissions inventory. Drafts are
 * work-in-progress, rejected records are invalid, and VOIDED records have been
 * withdrawn under FR §4.3 — all three are excluded, which keeps analytics
 * consistent with the authoritative dataset.
 *
 * Re-exported, not restated. The list itself now lives in `@tonyai/shared-types`
 * beside the status enum, because `targets.service.ts` kept a second copy and
 * nothing tied the two together.
 */
export const COUNTED_STATUSES: ActivityRecordStatus[] = [
  ...SHARED_COUNTED_STATUSES,
] as ActivityRecordStatus[];

/** Statuses that make a tracking-matrix cell "incomplete" (FR §2.2 yellow):
 * the record exists but is not (yet) valid committed data. */
const PENDING_STATUSES = new Set<ActivityRecordStatus>([
  ActivityRecordStatus.draft,
  ActivityRecordStatus.rejected,
]);
const COUNTED_SET = new Set<ActivityRecordStatus>(COUNTED_STATUSES);

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const MONTH_LABEL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * The WP17 invoice rule, as a pure function over records already loaded.
 *
 * Extracted rather than inlined because PR 3's drill-down needs a DIFFERENT
 * PROJECTION of this same computation — the OPEN `(location, month)` slots, to
 * render "January: missing at Ankara Power Plant". The matrix reduces the slot
 * set to a count and throws the set away; a drill-down that re-derived the rule
 * from scratch is exactly the drift the shared endpoint was meant to prevent.
 * One implementation, two readings of it.
 *
 * Every clause is load-bearing and each was a surviving mutant before it had a
 * test: an invoice covers one MONTH, a subsidiary-level entry covers no site, a
 * DRAFT is not an invoice anyone has accepted, and without the file there is
 * nothing to have covered the slot with.
 */
export interface InvoiceCoverage {
  required: number;
  /** The closed slots themselves, keyed `locationId\u0000month`. PR 3 renders
   *  the complement of this set; the matrix only needs its size. */
  covered: Set<string>;
  unattributedRecords: number;
  nonMonthlyRecords: number;
  missingEvidenceRecords: number;
  outOfScopeRecords: number;
  /**
   * The subset of `covered` whose closing record nobody has reviewed yet — see
   * `CellCoverage.awaitingReviewSlots` for why this is reported rather than
   * deducted. A SUBSET, always: every key here is also in `covered`.
   *
   * Where more than one record closes a slot, an approved one wins — an accepted
   * invoice covers the month whatever else was filed against it.
   */
  awaitingReview: Set<string>;
}

/**
 * The statuses that mean a human has actually accepted the invoice.
 *
 * Deliberately narrower than `COUNTED_STATUSES`: that set decides what the
 * emissions inventory counts (submitted data must not vanish from the totals
 * while it queues for review), this one decides what the *collection status* is
 * allowed to call finished. Round-1 DE-2 is precisely the gap between the two —
 * submitting is not finishing.
 */
const REVIEWED_STATUSES = new Set<ActivityRecordStatus>([
  ActivityRecordStatus.approved,
  ActivityRecordStatus.locked,
]);

/** The projection of an activity record that the invoice rule actually reads. */
export interface CoverageRecord {
  locationId: string | null;
  reportingPeriod: string;
  periodValue: string;
  evidenceCount: number;
  status: ActivityRecordStatus;
}

export function computeInvoiceCoverage(
  records: readonly CoverageRecord[],
  /**
   * The locations the denominator is built from — the SET, not just its size.
   *
   * The count alone was not enough and the gap was reachable: the denominator
   * drops a location created after the reported year ended, while the numerator
   * keyed on the record's own `locationId` and happily counted its invoices. A
   * subsidiary whose only 2025 invoice sits at a site created in 2026 reported
   * `covered 1, required 0` — a green "Complete" cell reading `1/0`, and the
   * drill-down beneath it rendering no rows at all. Restricting the numerator to
   * the same set is what makes `covered <= required` true rather than hoped for.
   */
  locationIds: readonly string[],
): InvoiceCoverage {
  const inScope = new Set(locationIds);
  const covered = new Set<string>();
  /** Slots closed by an ACCEPTED invoice. Subtracted from `covered` at the end
   *  rather than tracked as "awaiting" directly, so that a month closed twice —
   *  once submitted, once approved — resolves to accepted, not to both. */
  const reviewed = new Set<string>();
  let unattributedRecords = 0;
  let nonMonthlyRecords = 0;
  let missingEvidenceRecords = 0;
  let outOfScopeRecords = 0;

  for (const r of records) {
    // Self-contained rather than trusting the caller to pre-filter. Both call
    // sites already pass committed records only, so this changes nothing today
    // — but the signature now TAKES a status, and a reader will reasonably
    // assume the status rule lives in here. A third caller handing over raw
    // rows would otherwise let a draft close a slot AND be counted as awaiting
    // review, which is the one thing this function exists to prevent.
    if (!COUNTED_SET.has(r.status)) continue;
    if (!r.locationId) {
      unattributedRecords += 1;
    } else if (!inScope.has(r.locationId)) {
      // Attributed, but to a site outside this year's denominator. Counted
      // rather than dropped: it is the only signal that an invoice exists for a
      // site the grid cannot show a row for.
      outOfScopeRecords += 1;
    } else if (r.reportingPeriod !== 'monthly') {
      nonMonthlyRecords += 1;
    } else if (r.evidenceCount === 0) {
      missingEvidenceRecords += 1;
    } else {
      const month = r.periodValue.trim().toLowerCase();
      // Only a real month closes a slot. Without this the denominator would rest
      // on a rule enforced in ANOTHER module (`isValidPeriodValue`), and 24
      // records at one location could report 24-of-24 while the second location
      // held nothing.
      if (MONTH_INDEX[month] !== undefined) {
        const slot = `${r.locationId}\u0000${month}`;
        covered.add(slot);
        if (REVIEWED_STATUSES.has(r.status)) reviewed.add(slot);
      } else nonMonthlyRecords += 1;
    }
  }

  // The complement, not a second tally: derived from the two sets, so it can
  // never count a slot the closure rule above did not actually close.
  const awaitingReview = new Set<string>();
  for (const slot of covered) {
    if (!reviewed.has(slot)) awaitingReview.add(slot);
  }

  return {
    required: locationIds.length * MONTH_LABEL.length,
    covered,
    unattributedRecords,
    nonMonthlyRecords,
    missingEvidenceRecords,
    outOfScopeRecords,
    awaitingReview,
  };
}

/**
 * FR §2.2's verdict for one subsidiary × category cell.
 *
 * Extracted for the same reason `computeInvoiceCoverage` was: two endpoints now
 * answer with it. The matrix puts it on the cell; `completeness()` returns it so
 * the Data Entry panel can *show* the verdict rather than reconstruct one.
 *
 * Reconstruction was the actual danger, and it is subtle — the completeness
 * response carries the invoice counters but not `hasPending`, `anomaly` or
 * `evidenceMissing`, so a client deriving "complete" from `covered >= required`
 * badges green over a cell the dashboard is showing amber. That is round-1
 * DE-2's own shape (a green that overstates), one level up, and no amount of
 * care in the client can fix it: the inputs are not on the wire.
 */
export function deriveCellStatus(input: {
  hasRecords: boolean;
  /** Any `draft`/`rejected` record in the cell. */
  hasPending: boolean;
  anomaly: boolean;
  /** An evidence-required category holding a committed record with no file. */
  evidenceMissing: boolean;
  /** The invoice rule's result, or `null` for the yes/no categories. */
  coverage: InvoiceCoverage | null;
}): DataStatus {
  // `missing` means "no record exists for this cell" — the contract's own
  // definition. A cell holding twelve approved, evidence-backed records whose
  // slots simply are not closed is INCOMPLETE, not missing: the seed produced
  // exactly that and the dashboard rendered a red "Missing" cell showing
  // 198 tCO2e.
  if (!input.hasRecords) return 'missing';

  // The three caps both branches share. Full invoice coverage does not answer
  // "there is an unfinished record here" or "one of these has no document", and
  // FR §2.2's yellow means exactly that there is something left to look at.
  const somethingLeftToLookAt =
    input.hasPending || input.anomaly || input.evidenceMissing;

  if (!input.coverage) {
    return somethingLeftToLookAt ? 'incomplete' : 'complete';
  }

  // `required > 0` is load-bearing, not defensive. A location-measured
  // subsidiary whose sites all postdate the reported year has a denominator of
  // zero, and `0 >= 0` reported `complete` — a green tick over a year in which
  // nothing was tracked, next to records that closed nothing.
  const allSlotsClosed =
    input.coverage.required > 0 &&
    input.coverage.covered.size >= input.coverage.required;
  if (!allSlotsClosed) return 'incomplete';

  // The fourth cap is round-1 DE-2 itself: "On submit for review, the
  // data-collection status turns green immediately." It did, and the
  // denominator work of PRs 2–3 did not touch it — `COUNTED_STATUSES` counts a
  // `submitted` record as committed (rightly: the inventory must not lose data
  // queued for review), while `PENDING_STATUSES` only catches `draft`/
  // `rejected`. So twelve invoices sent for review and seen by nobody closed
  // twelve slots and turned the cell green.
  //
  // Confined to the invoice-tracked branch on purpose. The yes/no branch above
  // has the same property, and changing it would re-mean all eight remaining
  // categories on every subsidiary — a separate decision, recorded as an open
  // question rather than smuggled in here.
  if (somethingLeftToLookAt || input.coverage.awaitingReview.size > 0) {
    return 'incomplete';
  }
  return 'complete';
}

/** Mutable accumulator behind an EmissionsTrendPoint, carrying a sort key. */
interface TrendBucket {
  point: EmissionsTrendPoint;
  sortKey: number;
}

@Injectable()
export class EmissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Add a record's tCO₂e into the right scope field of a scope-split target. */
  private addScope(
    target: { scope1: number; scope2: number; scope3: number; total: number },
    scope: number,
    tCo2e: number,
  ): void {
    if (scope === 1) target.scope1 += tCo2e;
    else if (scope === 2) target.scope2 += tCo2e;
    else if (scope === 3) target.scope3 += tCo2e;
    target.total += tCo2e;
  }

  /** Resolve the calendar quarter (1–4) a record belongs to, or null if it
   * cannot be attributed to one (e.g. an annual record). */
  private quarterOf(record: ActivityRecord): number | null {
    if (record.reportingPeriod === 'quarterly') {
      const m = /^q([1-4])$/i.exec(record.periodValue.trim());
      return m ? Number(m[1]) : null;
    }
    if (record.reportingPeriod === 'monthly') {
      const idx = MONTH_INDEX[record.periodValue.trim().toLowerCase()];
      return idx === undefined ? null : Math.floor(idx / 3) + 1;
    }
    return null;
  }

  private emptySummary(): EmissionsSummary {
    return {
      totals: { scope1: 0, scope2: 0, scope3: 0, total: 0 },
      byCategory: [],
      bySubsidiary: [],
      trend: { monthly: [], quarterly: [], yearly: [] },
      recordCount: 0,
      calculatedRecordCount: 0,
      uncalculatedRecordCount: 0,
      statusesIncluded: COUNTED_STATUSES,
    };
  }

  async summary(
    user: RequestUser,
    query: EmissionsSummaryQueryDto,
  ): Promise<EmissionsSummary> {
    // Tenant scope: intersect any requested subsidiaryId with the accessible set.
    let subsidiaryFilter: Prisma.StringFilter | string;
    if (query.subsidiaryId) {
      if (!user.accessibleSubsidiaryIds.includes(query.subsidiaryId)) {
        return this.emptySummary(); // requested a subsidiary the caller cannot see
      }
      subsidiaryFilter = query.subsidiaryId;
    } else {
      if (user.accessibleSubsidiaryIds.length === 0) return this.emptySummary();
      subsidiaryFilter = { in: user.accessibleSubsidiaryIds };
    }

    const [rows, subs] = await Promise.all([
      this.prisma.activityRecord.findMany({
        where: {
          subsidiaryId: subsidiaryFilter,
          reportingYear: query.year,
          scope: query.scope,
          category: query.category,
          status: { in: COUNTED_STATUSES },
        },
      }),
      this.prisma.subsidiary.findMany({
        where: { id: { in: user.accessibleSubsidiaryIds } },
        select: { id: true, tradingName: true, legalName: true },
      }),
    ]);

    const nameById = new Map(
      subs.map((s) => [s.id, s.tradingName || s.legalName]),
    );

    const totals = { scope1: 0, scope2: 0, scope3: 0, total: 0 };
    const byCategory = new Map<
      string,
      { scope: number; tCo2e: number; recordCount: number }
    >();
    const bySubsidiary = new Map<
      string,
      { tCo2e: number; recordCount: number }
    >();
    const monthly = new Map<string, TrendBucket>();
    const quarterly = new Map<string, TrendBucket>();
    const yearly = new Map<string, TrendBucket>();

    const bump = (
      map: Map<string, TrendBucket>,
      label: string,
      sortKey: number,
      scope: number,
      tCo2e: number,
    ): void => {
      let bucket = map.get(label);
      if (!bucket) {
        bucket = {
          point: { period: label, scope1: 0, scope2: 0, scope3: 0, total: 0 },
          sortKey,
        };
        map.set(label, bucket);
      }
      this.addScope(bucket.point, scope, tCo2e);
    };

    let uncalculatedRecordCount = 0;

    for (const r of rows) {
      const calc = r.calculation as unknown as ActivityCalculationSnapshot | null;
      // A record with no factor produced no figure, so it is not part of the
      // inventory and must not enter the aggregation at all — not even as a
      // zero. Counting it would put a "Water — 0 tCO₂e, 1 record" row in the
      // category breakdown, which reads as "we measured water and it was zero"
      // rather than "water is not calculable yet". It is surfaced instead as
      // `uncalculatedRecordCount`, so the entries are declared, not hidden.
      if (!isCalculated(calc)) {
        uncalculatedRecordCount += 1;
        continue;
      }
      const tCo2e = calc.tCo2e;
      const scope = r.scope;

      this.addScope(totals, scope, tCo2e);

      const cat = byCategory.get(r.category) ?? {
        scope,
        tCo2e: 0,
        recordCount: 0,
      };
      cat.tCo2e += tCo2e;
      cat.recordCount += 1;
      byCategory.set(r.category, cat);

      const sub = bySubsidiary.get(r.subsidiaryId) ?? {
        tCo2e: 0,
        recordCount: 0,
      };
      sub.tCo2e += tCo2e;
      sub.recordCount += 1;
      bySubsidiary.set(r.subsidiaryId, sub);

      // Yearly — every counted record can be attributed to a year.
      bump(yearly, String(r.reportingYear), r.reportingYear, scope, tCo2e);

      // Quarterly — monthly/quarterly records only.
      const q = this.quarterOf(r);
      if (q !== null) {
        bump(
          quarterly,
          `${r.reportingYear}-Q${q}`,
          r.reportingYear * 10 + q,
          scope,
          tCo2e,
        );
      }

      // Monthly — monthly records only.
      if (r.reportingPeriod === 'monthly') {
        const idx = MONTH_INDEX[r.periodValue.trim().toLowerCase()];
        if (idx !== undefined) {
          bump(
            monthly,
            `${MONTH_LABEL[idx]} ${r.reportingYear}`,
            r.reportingYear * 100 + idx,
            scope,
            tCo2e,
          );
        }
      }
    }

    const grandTotal = totals.total;
    const pct = (v: number) => (grandTotal > 0 ? (v / grandTotal) * 100 : 0);

    const categoryList: EmissionsByCategory[] = Array.from(byCategory.entries())
      .map(([category, v]) => ({
        category: category as Category,
        scope: v.scope,
        tCo2e: v.tCo2e,
        recordCount: v.recordCount,
        percentOfTotal: pct(v.tCo2e),
      }))
      .sort((a, b) => b.tCo2e - a.tCo2e);

    const subsidiaryList: EmissionsBySubsidiary[] = Array.from(
      bySubsidiary.entries(),
    )
      .map(([subsidiaryId, v]) => ({
        subsidiaryId,
        subsidiaryName: nameById.get(subsidiaryId) ?? subsidiaryId,
        tCo2e: v.tCo2e,
        recordCount: v.recordCount,
        percentOfTotal: pct(v.tCo2e),
      }))
      .sort((a, b) => b.tCo2e - a.tCo2e);

    const toSortedPoints = (map: Map<string, TrendBucket>) =>
      Array.from(map.values())
        .sort((a, b) => a.sortKey - b.sortKey)
        .map((b) => b.point);

    return {
      totals,
      byCategory: categoryList,
      bySubsidiary: subsidiaryList,
      trend: {
        monthly: toSortedPoints(monthly),
        quarterly: toSortedPoints(quarterly),
        yearly: toSortedPoints(yearly),
      },
      // `recordCount` keeps its original meaning — every committed record in
      // scope — because it is what the report's "Committed records" tile shows
      // and what the generation audit row logs. Narrowing it silently to "the
      // ones that produced a figure" made that tile disagree with the ledger
      // printed directly beneath it, and made the PDF and CSV exports of the
      // same selection write two different counts into the append-only log.
      // The split is expressed by the two fields below, which always sum to it.
      recordCount: rows.length,
      calculatedRecordCount: rows.length - uncalculatedRecordCount,
      uncalculatedRecordCount,
      statusesIncluded: COUNTED_STATUSES,
    };
  }

  /**
   * Subsidiary × category completeness matrix (FR §2.2). Every accessible
   * subsidiary gets a row; every canonical category gets a cell — cells with
   * no records are "missing", in both readings of `complete` below.
   *
   * Two rules live here, chosen per cell:
   *   - the yes/no rule: committed records, evidence attached where the
   *     category requires it, nothing pending and nothing flagged;
   *   - the WP17 invoice rule, for the three invoice-tracked categories on a
   *     `location`-measured subsidiary IN A GIVEN YEAR: `locations × 12`
   *     monthly invoices, then the same three caps applied on top.
   */
  async trackingMatrix(
    user: RequestUser,
    query: TrackingMatrixQueryDto,
  ): Promise<TrackingMatrixDTO> {
    const empty: TrackingMatrixDTO = {
      reportingYear: query.year ?? null,
      rows: [],
      totals: { complete: 0, incomplete: 0, missing: 0 },
    };
    if (user.accessibleSubsidiaryIds.length === 0) return empty;

    // A requested subsidiary outside the accessible set returns the empty
    // matrix, never a 403 — the same "never leak existence" rule the rest of the
    // tenant surface follows.
    let subsidiaryFilter: Prisma.StringFilter | string;
    if (query.subsidiaryId) {
      if (!user.accessibleSubsidiaryIds.includes(query.subsidiaryId)) {
        return empty;
      }
      subsidiaryFilter = query.subsidiaryId;
    } else {
      subsidiaryFilter = { in: user.accessibleSubsidiaryIds };
    }

    // End of the requested reporting year, in UTC. Used to keep the location
    // multiplier contemporaneous with the period being measured.
    const yearEnd =
      query.year === undefined
        ? null
        : new Date(Date.UTC(query.year + 1, 0, 1) - 1);

    const [records, subs] = await Promise.all([
      // All statuses on purpose: drafts/rejected make a cell "incomplete".
      // Evidence count feeds the FR §2.2 rule (green needs evidence where required).
      this.prisma.activityRecord.findMany({
        where: {
          subsidiaryId: subsidiaryFilter,
          reportingYear: query.year,
        },
        include: { _count: { select: { evidence: true } } },
      }),
      this.prisma.subsidiary.findMany({
        where: { id: subsidiaryFilter },
        select: {
          id: true,
          tradingName: true,
          legalName: true,
          sector: true,
          designatedPerson: true,
          trackingGranularity: true,
          // The denominator's multiplier. Counted rather than fetched: the rule
          // needs how many locations exist, not which ones.
          //
          // Scoped to the reporting year when one is given. The multiplier is
          // otherwise CURRENT state applied to a PAST period, and it moves with
          // no decision by anyone: open a third site in 2027 and the 2024
          // matrix silently starts demanding 36 invoices instead of 24 — twelve
          // slots that could never have been filled — turning a closed year red
          // on its own. `createdAt` is when the site was entered into the
          // system rather than when it opened, so this is a floor, not a
          // reconstruction; it is strictly better than counting sites that did
          // not exist yet.
          // The IDS, not a count: the numerator has to be restricted to the
          // same set the denominator is built from (see computeInvoiceCoverage).
          locations: {
            select: { id: true },
            ...(yearEnd ? { where: { createdAt: { lte: yearEnd } } } : {}),
          },
        },
        orderBy: { legalName: 'asc' },
      }),
    ]);

    // Group records by subsidiary + category.
    type RecordWithEvidence = ActivityRecord & { _count: { evidence: number } };
    const byCell = new Map<string, RecordWithEvidence[]>();
    for (const r of records) {
      const key = `${r.subsidiaryId}\u0000${r.category}`;
      const bucket = byCell.get(key);
      if (bucket) bucket.push(r);
      else byCell.set(key, [r]);
    }

    const totals = { complete: 0, incomplete: 0, missing: 0 };
    const matrixRows: TrackingMatrixRow[] = subs.map((sub) => {
      let totalTCo2e = 0;
      let completeCount = 0;
      const locationIds = sub.locations.map((l) => l.id);
      const locationCount = locationIds.length;
      const byLocation = sub.trackingGranularity === 'location';

      let uncalculatedRowCount = 0;

      const cells: TrackingMatrixCell[] = CATEGORIES.map((category) => {
        const recs = byCell.get(`${sub.id}\u0000${category}`) ?? [];

        let coverage: InvoiceCoverage | null = null;
        let status: DataStatus;
        // `null` until something actually contributes a figure — see the note
        // on TrackingMatrixCell.tCo2e. A cell whose only records are
        // factor-less must not report a measured zero.
        let tCo2e: number | null = null;
        let uncalculatedRecordCount = 0;
        let voidedRecordCount = 0;
        let lastUpdate: string | null = null;
        let anomaly = false;

        // The invoice rule (WP17 / round-1 DASH-3) applies to three categories,
        // on a location-measured subsidiary, FOR ONE REPORTING YEAR.
        //
        // The year is not optional decoration: `required` is twelve months'
        // worth, so without a year filter every year's records fold into one
        // cell and a subsidiary with a complete 2024 and an empty 2025 reports
        // 24-of-24. An unscoped query therefore falls back to the yes/no rule
        // rather than answering a question the numbers cannot support.
        const invoiceTracked =
          byLocation && isInvoiceTracked(category) && query.year !== undefined;

        // Computed even for an empty cell: "0 of 24" is the whole point of the
        // rule for a category nobody has started, and it is what tells a user
        // the size of the job rather than just that it is unfinished.
        if (invoiceTracked) coverage = computeInvoiceCoverage([], locationIds);

        // A VOIDED record is invisible to the verdict, exactly as it is
        // invisible to the totals. Counting it as "this cell has a record"
        // reported `complete` for a category whose only figure had been
        // WITHDRAWN — a green cell over data somebody deliberately removed from
        // the inventory, which is the loudest possible version of the overstated
        // green this product keeps having to fix. The rows are still reported in
        // `voidedRecordCount`, so the cell can say what happened rather than
        // pretending nothing is there.
        const live = recs.filter((r) => r.status !== ActivityRecordStatus.voided);
        voidedRecordCount = recs.length - live.length;

        if (live.length === 0) {
          status = 'missing';
        } else {
          let hasPending = false;
          let latest = 0;
          // Evidence gate: for an evidence-required category, any committed
          // record lacking a file leaves the cell short of "complete" (FR §2.2).
          const evidenceRequired = isEvidenceRequired(category);
          let evidenceMissing = false;
          const committed: CoverageRecord[] = [];
          for (const r of live) {
            if (PENDING_STATUSES.has(r.status)) hasPending = true;
            if (r.anomalyFlag) anomaly = true;
            if (COUNTED_SET.has(r.status)) {
              const calc = r.calculation as unknown as ActivityCalculationSnapshot | null;
              if (isCalculated(calc)) tCo2e = (tCo2e ?? 0) + calc.tCo2e;
              else uncalculatedRecordCount += 1;
              if (evidenceRequired && r._count.evidence === 0) {
                evidenceMissing = true;
              }
              committed.push({
                locationId: r.locationId,
                reportingPeriod: r.reportingPeriod,
                periodValue: r.periodValue,
                evidenceCount: r._count.evidence,
                status: r.status,
              });
            }
            const t = r.updatedAt.getTime();
            if (t > latest) latest = t;
          }
          lastUpdate = new Date(latest).toISOString();

          if (invoiceTracked) coverage = computeInvoiceCoverage(committed, locationIds);
          status = deriveCellStatus({
            hasRecords: true,
            hasPending,
            anomaly,
            evidenceMissing,
            coverage,
          });
        }

        totals[status] += 1;
        if (status === 'complete') completeCount += 1;
        if (tCo2e !== null) totalTCo2e += tCo2e;
        uncalculatedRowCount += uncalculatedRecordCount;

        return {
          category: category as Category,
          scope: CATEGORY_SCOPE_MAP[category as Category],
          status,
          tCo2e,
          recordCount: recs.length,
          uncalculatedRecordCount,
          voidedRecordCount,
          ...(coverage
            ? {
                coverage: {
                  required: coverage.required,
                  covered: coverage.covered.size,
                  unattributedRecords: coverage.unattributedRecords,
                  nonMonthlyRecords: coverage.nonMonthlyRecords,
                  missingEvidenceRecords: coverage.missingEvidenceRecords,
                  outOfScopeRecords: coverage.outOfScopeRecords,
                  awaitingReviewSlots: coverage.awaitingReview.size,
                },
              }
            : {}),
          lastUpdate,
          anomaly,
        };
      });

      return {
        subsidiaryId: sub.id,
        subsidiaryName: sub.tradingName || sub.legalName,
        sector: sub.sector,
        designatedPerson: sub.designatedPerson,
        totalTCo2e,
        completeCount,
        categoryCount: CATEGORIES.length,
        trackingGranularity: sub.trackingGranularity,
        locationCount,
        uncalculatedRecordCount: uncalculatedRowCount,
        cells,
      };
    });

    return { reportingYear: query.year ?? null, rows: matrixRows, totals };
  }

  /**
   * Which `(location, month)` invoice slots are open for one subsidiary and
   * year — the drill-down behind a matrix cell (round-1 DASH-3).
   *
   * Reads the SAME `computeInvoiceCoverage()` the matrix reduces to a count,
   * and enumerates the COMPLEMENT of the set it returns. That is why the rule
   * was extracted in PR 2: a drill-down that re-derived "what closes a slot"
   * would be a second implementation of a compliance denominator, free to
   * disagree with the cell the user just clicked.
   *
   * A `subsidiary`-granularity subsidiary returns `categories: []` — not an
   * error and not zeroes. The rule does not apply to it, and the granularity
   * is returned alongside so a caller can say so.
   */
  async completeness(
    user: RequestUser,
    query: CompletenessQueryDto,
  ): Promise<SubsidiaryCompletenessDTO> {
    // Same "never leak existence" rule as every other tenant-scoped read: an
    // id outside the accessible set is not found, never forbidden.
    if (!user.accessibleSubsidiaryIds.includes(query.subsidiaryId)) {
      throw new NotFoundException('Subsidiary not found');
    }

    // Contemporaneous with the reported year, exactly as the matrix multiplier
    // is — otherwise the grid would show rows for sites that did not exist.
    const yearEnd = new Date(Date.UTC(query.year + 1, 0, 1) - 1);

    const [subsidiary, locations, records] = await Promise.all([
      this.prisma.subsidiary.findUnique({
        where: { id: query.subsidiaryId },
        select: { trackingGranularity: true },
      }),
      this.prisma.location.findMany({
        where: {
          subsidiaryId: query.subsidiaryId,
          createdAt: { lte: yearEnd },
        },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.activityRecord.findMany({
        where: {
          subsidiaryId: query.subsidiaryId,
          reportingYear: query.year,
          category: { in: INVOICE_TRACKED_CATEGORIES },
          // Deliberately UNFILTERED by status, where this once asked SQL for
          // `COUNTED_STATUSES` only. The response now carries FR §2.2's verdict,
          // and two of the three caps behind it — a draft sitting in the cell,
          // an anomaly flag — are invisible to a query that has already dropped
          // those rows. The committed subset is taken in JS below, exactly as
          // `trackingMatrix` does it, so both reach the verdict from the same
          // records rather than from two different queries.
        },
        include: { _count: { select: { evidence: true } } },
      }),
    ]);

    if (!subsidiary) throw new NotFoundException('Subsidiary not found');

    const empty: SubsidiaryCompletenessDTO = {
      subsidiaryId: query.subsidiaryId,
      reportingYear: query.year,
      trackingGranularity: subsidiary.trackingGranularity,
      locationCount: locations.length,
      categories: [],
    };
    if (subsidiary.trackingGranularity !== 'location') return empty;

    const byCategory = new Map<string, typeof records>();
    for (const r of records) {
      const bucket = byCategory.get(r.category);
      if (bucket) bucket.push(r);
      else byCategory.set(r.category, [r]);
    }

    const categories: CategoryCompleteness[] = INVOICE_TRACKED_CATEGORIES.map(
      (category) => {
        const recs = byCategory.get(category) ?? [];

        // The same three signals `trackingMatrix` reads, from the same rows.
        const evidenceRequired = isEvidenceRequired(category);
        let hasPending = false;
        let anomaly = false;
        let evidenceMissing = false;
        const committed: CoverageRecord[] = [];
        // The SAME `live` filter the matrix applies. Without it this panel
        // reads a voided record's stale anomaly flag and counts the row as
        // presence, so a category whose only records were withdrawn shows
        // `incomplete` here while the dashboard cell shows `missing` — two
        // surfaces disagreeing about one cell, which is exactly what this
        // method's own comment promises cannot happen.
        const live = recs.filter((r) => r.status !== ActivityRecordStatus.voided);
        for (const r of live) {
          if (PENDING_STATUSES.has(r.status)) hasPending = true;
          if (r.anomalyFlag) anomaly = true;
          if (!COUNTED_SET.has(r.status)) continue;
          if (evidenceRequired && r._count.evidence === 0) evidenceMissing = true;
          committed.push({
            locationId: r.locationId,
            reportingPeriod: r.reportingPeriod,
            periodValue: r.periodValue,
            evidenceCount: r._count.evidence,
            status: r.status,
          });
        }

        const coverage = computeInvoiceCoverage(
          committed,
          locations.map((l) => l.id),
        );

        return {
          category,
          // FR §2.2's verdict, from the shared derivation rather than from the
          // caller's arithmetic over the counters below.
          status: deriveCellStatus({
            hasRecords: live.length > 0,
            hasPending,
            anomaly,
            evidenceMissing,
            coverage,
          }),
          required: coverage.required,
          covered: coverage.covered.size,
          unattributedRecords: coverage.unattributedRecords,
          nonMonthlyRecords: coverage.nonMonthlyRecords,
          missingEvidenceRecords: coverage.missingEvidenceRecords,
          outOfScopeRecords: coverage.outOfScopeRecords,
          awaitingReviewSlots: coverage.awaitingReview.size,
          // Which months already hold a WHOLE-COMPANY entry. Without this the
          // grid invites the user to key a site invoice for a month that is
          // already recorded at company level, and both rows then feed the
          // total — the same month counted twice, with nothing anywhere saying
          // so. The rule cannot count them, but the screen must not pretend
          // they do not exist.
          // COMMITTED records only, not `recs`. The query above is now
          // unfiltered by status, and a DRAFT whole-company entry feeds no
          // total — so warning that it would double-count a month would be
          // warning about something that has not happened and may never.
          companyLevelMonths: [
            ...new Set(
              committed
                .filter((r) => !r.locationId && r.reportingPeriod === 'monthly')
                .map((r) => r.periodValue.trim().toLowerCase()),
            ),
          ],
          locations: locations.map((loc) => ({
            locationId: loc.id,
            locationName: loc.name,
            // The complement, month by month. Keyed identically to the set the
            // rule builds, so "covered here" and "covered in the cell" cannot
            // drift apart.
            months: MONTH_LABEL.map((month) => {
              const slot = `${loc.id}\u0000${month.toLowerCase()}`;
              return {
                month,
                covered: coverage.covered.has(slot),
                // Read from the SUBSET, so `awaitingReview` can never be true
                // where `covered` is false. The screen renders three states off
                // this pair and a fourth would be unreachable nonsense.
                awaitingReview: coverage.awaitingReview.has(slot),
              };
            }),
          })),
        };
      },
    );

    return { ...empty, categories };
  }
}
