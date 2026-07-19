import { Injectable } from '@nestjs/common';
import { ActivityRecordStatus, Prisma, type ActivityRecord } from '@tonyai/db';
import {
  CATEGORIES,
  CATEGORY_SCOPE_MAP,
  isEvidenceRequired,
  type CalculationResult,
  type Category,
  type DataStatus,
  type EmissionsByCategory,
  type EmissionsBySubsidiary,
  type EmissionsSummary,
  type EmissionsTrendPoint,
  type TrackingMatrixCell,
  type TrackingMatrixDTO,
  type TrackingMatrixRow,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { EmissionsSummaryQueryDto } from './dto/emissions-summary-query.dto';
import { TrackingMatrixQueryDto } from './dto/tracking-matrix-query.dto';

/**
 * Only "committed" records feed the emissions inventory. Drafts are
 * work-in-progress and rejected records are invalid, so both are excluded —
 * this keeps analytics consistent with the authoritative dataset.
 */
export const COUNTED_STATUSES: ActivityRecordStatus[] = [
  ActivityRecordStatus.submitted,
  ActivityRecordStatus.under_review,
  ActivityRecordStatus.approved,
  ActivityRecordStatus.locked,
];

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

    for (const r of rows) {
      const calc = r.calculation as unknown as CalculationResult | null;
      const tCo2e =
        calc && Number.isFinite(calc.tCo2e) ? calc.tCo2e : 0;
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
      recordCount: rows.length,
      statusesIncluded: COUNTED_STATUSES,
    };
  }

  /**
   * Subsidiary × category completeness matrix (FR §2.2). Every accessible
   * subsidiary gets a row; every canonical category gets a cell — cells with
   * no records are "missing". The "required evidence" condition for
   * `complete` is deferred until the evidence backend ships.
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

    const [records, subs] = await Promise.all([
      // All statuses on purpose: drafts/rejected make a cell "incomplete".
      // Evidence count feeds the FR §2.2 rule (green needs evidence where required).
      this.prisma.activityRecord.findMany({
        where: {
          subsidiaryId: { in: user.accessibleSubsidiaryIds },
          reportingYear: query.year,
        },
        include: { _count: { select: { evidence: true } } },
      }),
      this.prisma.subsidiary.findMany({
        where: { id: { in: user.accessibleSubsidiaryIds } },
        select: {
          id: true,
          tradingName: true,
          legalName: true,
          sector: true,
          designatedPerson: true,
        },
        orderBy: { legalName: 'asc' },
      }),
    ]);

    // Group records by subsidiary + category.
    type RecordWithEvidence = ActivityRecord & { _count: { evidence: number } };
    const byCell = new Map<string, RecordWithEvidence[]>();
    for (const r of records) {
      const key = `${r.subsidiaryId} ${r.category}`;
      const bucket = byCell.get(key);
      if (bucket) bucket.push(r);
      else byCell.set(key, [r]);
    }

    const totals = { complete: 0, incomplete: 0, missing: 0 };
    const matrixRows: TrackingMatrixRow[] = subs.map((sub) => {
      let totalTCo2e = 0;
      let completeCount = 0;

      const cells: TrackingMatrixCell[] = CATEGORIES.map((category) => {
        const recs = byCell.get(`${sub.id} ${category}`) ?? [];

        let status: DataStatus;
        let tCo2e = 0;
        let lastUpdate: string | null = null;
        let anomaly = false;

        if (recs.length === 0) {
          status = 'missing';
        } else {
          let hasPending = false;
          let latest = 0;
          // Evidence gate: for an evidence-required category, any committed
          // record lacking a file leaves the cell short of "complete" (FR §2.2).
          const evidenceRequired = isEvidenceRequired(category);
          let evidenceMissing = false;
          for (const r of recs) {
            if (PENDING_STATUSES.has(r.status)) hasPending = true;
            if (r.anomalyFlag) anomaly = true;
            if (COUNTED_SET.has(r.status)) {
              const calc = r.calculation as unknown as CalculationResult | null;
              if (calc && Number.isFinite(calc.tCo2e)) tCo2e += calc.tCo2e;
              if (evidenceRequired && r._count.evidence === 0) {
                evidenceMissing = true;
              }
            }
            const t = r.updatedAt.getTime();
            if (t > latest) latest = t;
          }
          lastUpdate = new Date(latest).toISOString();
          status =
            hasPending || anomaly || evidenceMissing ? 'incomplete' : 'complete';
        }

        totals[status] += 1;
        if (status === 'complete') completeCount += 1;
        totalTCo2e += tCo2e;

        return {
          category: category as Category,
          scope: CATEGORY_SCOPE_MAP[category as Category],
          status,
          tCo2e,
          recordCount: recs.length,
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
        cells,
      };
    });

    return { reportingYear: query.year ?? null, rows: matrixRows, totals };
  }
}
