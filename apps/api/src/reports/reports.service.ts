import { readRuntimeConfig } from '../common/runtime-config';
import { QueryTooBroadError } from '../common/api-error';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { ActivityRecordStatus, Prisma } from '@tonyai/db';
import type {
  ReportingContext,
  ActivityCalculationSnapshot,
  ReportInventorySummary,
  FactorStatus,
  Locale,
  ReportExportType,
  ReportLiveCoverage,
  ReportMetaDTO,
  ReportScope3Disclosure,
  ReportStatus,
} from '@tonyai/shared-types';
import {
  CATEGORY_SCOPE_MAP,
  DEFAULT_LOCALE,
  isLocale,
  FACTOR_STATUS_RANK,
  isAnomalyEvaluated,
  isAuthoritativeSnapshot,
  isCalculated,
  isProvenanceSnapshot,
  PENDING_REVIEW_STATUSES,
  REPORT_TEMPLATES,
} from '@tonyai/shared-types';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import {
  excelLedgerHeader,
  excelLedgerRow,
  excelWithdrawnHeader,
  excelWithdrawnRow,
  excelWithdrawnTotalRow,
  csvHeader,
  csvLedgerRow,
  csvWithdrawnRow,
} from './report-columns';
import type {
  FactorStandingCode,
  ReportData,
  ReportEvidenceRow,
  ReportFactorRow,
  ReportLedgerRow,
  ReportWithdrawnRow,
  ReportWithdrawnTotals,
} from './report-data';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { COUNTED_STATUSES, SUMMARY_RECORD_SELECT, summariseCounted, type SummaryRecord } from '../emissions/emissions.service';
import { CaptureSnapshot } from '../common/capture-snapshot';
import { readLiveCoverage } from './live-coverage';
import { ReportQueryDto } from './dto/report-query.dto';
import { reportingContext } from '../common/reporting-context-query.dto';
import { contextLabels } from './context-labels';
import { buildReportHtml, coverageSentences, selectsScope3Only, statusLabel } from './report-html';
import { reportVocabulary, type ReportVocabulary } from './report-vocabulary';
import { PdfRenderer } from '../common/pdf-renderer';

// Single source of truth for "committed": imported from the emissions service so
// a report's summary tables and its own ledger can never silently diverge.
const COMMITTED_STATUSES = COUNTED_STATUSES;
type SelectedReportQuery = ReportQueryDto & Pick<ReportingContext, 'scope' | 'category'>;
/** A live report's selection: the year and the optional filters. */
type LiveSelection = Pick<ReportingContext, 'year' | 'subsidiaryId' | 'scope' | 'category'>;

/** Read-only and one snapshot (K2); the 30 s a capture's snapshot is given. */
const LIVE_SNAPSHOT_TX = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 };

/** The Scope 1/2 records a selection counts: both, its one, or none for a Scope 3 selection (K4). */
function inventoryScopeFilter(scope: number | undefined): number | { in: number[] } | null {
  if (scope === undefined) return { in: [1, 2] };
  return scope === 3 ? null : scope;
}

/**
 * A live report's own summary (K4): the Scope 1/2 rows it lists, summed. A
 * Scope 3 row never reaches it (`inventoryScopeFilter`), so its Scope 3 is the
 * literal 0 the contract's type holds — refused, not silently zeroed, if a
 * read ever let one through.
 */
function inventorySummary(rows: readonly SummaryRecord[], nameById: ReadonlyMap<string, string>): ReportInventorySummary {
  if (rows.some((r) => r.scope !== 1 && r.scope !== 2)) throw new Error('A live report sums Scope 1/2 records only.');
  const summary = summariseCounted(rows, nameById);
  const point = (p: (typeof summary.trend.monthly)[number]) => ({ ...p, scope3: 0 as const });
  return {
    ...summary,
    totals: { ...summary.totals, scope3: 0 },
    trend: { monthly: summary.trend.monthly.map(point), quarterly: summary.trend.quarterly.map(point), yearly: summary.trend.yearly.map(point) },
  };
}

const NO_SCOPE3: ReportScope3Disclosure = { coverage: 'not_covered', recordCount: 0, calculatedTCo2e: 0, uncalculatedRecordCount: 0 };

// Re-exported so every existing importer keeps working; the definitions moved
// to `report-data.ts` to break the value-import cycle the descriptors create.
export type {
  ReportLedgerRow,
  ReportWithdrawnRow,
  ReportFactorRow,
  ReportEvidenceRow,
  ReportWithdrawnTotals,
  ReportData,
} from './report-data';

/**
 * What `GET /reports/meta` returns. This is the wire contract itself, not a
 * structural twin of it: the two were hand-written copies of one shape with
 * nothing tying them together, so a field added to either could sit unread on
 * the other — the exact drift `COUNTED_STATUSES` and the period vocabulary were
 * both consolidated to end.
 */
export type ReportMeta = ReportMetaDTO;

/** A record's link to an evidence file, as the ledger query loads it. */
type ReportEvidenceLink = {
  evidence: { id: string; fileName: string; _count: { links: number } };
};

type ReleaseWithdrawal = { at: Date | null; reason: string | null };

/** The releases a provenance snapshot rests on: its factor's, and its conversion's if any. */
function pathReleaseIds(snapshot: ActivityCalculationSnapshot): string[] {
  if (!isProvenanceSnapshot(snapshot)) return [];
  return [snapshot.factorRelease.id, ...(snapshot.conversion ? [snapshot.conversion.release.id] : [])];
}

/** Authoritative when calculated, and still: no link's release has been withdrawn since. */
function authoritativeNow(snapshot: ActivityCalculationSnapshot, withdrawals: Map<string, ReleaseWithdrawal>): boolean {
  return isAuthoritativeSnapshot(snapshot) && !pathReleaseIds(snapshot).some((id) => withdrawals.has(id));
}

/**
 * A factor path's standing in words, as of the report's generation:
 * authoritative only when every link is (`isAuthoritativeSnapshot`) and no
 * link's release has been withdrawn since; otherwise the withdrawn release —
 * named, since it may be the conversion's rather than the factor's that the
 * appendix's Release column shows — or the weakest link's status: a
 * placeholder conversion under an authoritative factor is not authoritative.
 */
function factorStanding(
  snapshot: ActivityCalculationSnapshot,
  withdrawals: Map<string, ReleaseWithdrawal>,
  v: ReportVocabulary,
): { code: FactorStandingCode; text: string } {
  if (!isProvenanceSnapshot(snapshot)) {
    return { code: 'pre_release', text: v.text('standingPreRelease') };
  }
  const links = [
    { link: 'factor', release: snapshot.factorRelease },
    ...(snapshot.conversion ? [{ link: 'conversion', release: snapshot.conversion.release }] : []),
  ];
  for (const { link, release } of links) {
    const withdrawn = withdrawals.get(release.id);
    if (!withdrawn) continue;
    // "Release withdrawn", never bare "Withdrawn": the ledger already uses
    // that word for a record taken out of the inventory.
    return {
      code: 'withdrawn',
      text: v.text('standingWithdrawn', {
        link,
        publisher: release.publisher,
        edition: release.edition,
        hasOn: withdrawn.at ? 'true' : 'false',
        on: withdrawn.at ? withdrawn.at.toISOString().slice(0, 10) : '',
        hasReason: withdrawn.reason ? 'true' : 'false',
        reason: withdrawn.reason ?? '',
      }),
    };
  }
  if (isAuthoritativeSnapshot(snapshot)) return { code: 'authoritative', text: v.text('standingAuthoritative') };
  const weakest = [snapshot.factorRelease.status, snapshot.conversion?.release.status]
    .filter((s): s is FactorStatus => s !== undefined)
    .sort((a, b) => FACTOR_STATUS_RANK[a] - FACTOR_STATUS_RANK[b])[0];
  return {
    code: weakest === 'fixture' ? 'fixture' : weakest === 'withdrawn' ? 'withdrawn' : 'placeholder',
    text: v.text('standingWeakest', {
      status: weakest ?? '',
      conversion: snapshot.factorRelease.status === weakest ? 'false' : 'true',
    }),
  };
}

@Injectable()
export class ReportsService {
  private readonly limits = readRuntimeConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditService,
    // The replica's one Chromium, shared with the issuances (LP3-04 PR D).
    private readonly pdf: PdfRenderer,
  ) {}

  /**
   * Generating/exporting reports is denied to `data_entry`
   * (permissions_and_roles.md §"Generate and export reports": all roles except
   * data_entry). Reads like /reports/meta stay tenant-scoped for everyone.
   */
  private assertCanGenerate(user: RequestUser): void {
    if (user.role === 'data_entry') {
      throw new ForbiddenException('data_entry may not generate or export reports');
    }
  }

  /** Tenant scope: requested subsidiary intersected with the accessible set. */
  private scopeIds(user: RequestUser, subsidiaryId?: string): string[] {
    if (subsidiaryId) {
      return user.accessibleSubsidiaryIds.includes(subsidiaryId)
        ? [subsidiaryId]
        : [];
    }
    return user.accessibleSubsidiaryIds;
  }

  /**
   * Every live read of one request in ONE REPEATABLE READ snapshot (LP4-03 K2):
   * the counts, the badge, the ledger, the totals, the evidence, the releases'
   * standing and the coverage are one moment's, so an approval, a withdrawal
   * or a new record committed while a report is built cannot make any two of
   * them disagree. Read-only; rendering happens after it closes.
   */
  private inSnapshot<T>(read: (snapshot: CaptureSnapshot) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => read(await CaptureSnapshot.openReadOnly(tx)), LIVE_SNAPSHOT_TX);
  }

  /** Review status and the report's own figures for a selection — the preview's one read. */
  async meta(
    user: RequestUser,
    year: number,
    subsidiaryId?: string,
    filters: Pick<ReportingContext, 'scope' | 'category'> = {},
  ): Promise<ReportMeta> {
    const ids = this.scopeIds(user, subsidiaryId);
    const selection: LiveSelection = { year, subsidiaryId: subsidiaryId || undefined, scope: filters.scope, category: filters.category };
    return this.inSnapshot(async (snapshot) => {
      const db = CaptureSnapshot.txOf(snapshot);
      const head = await this.readHead(snapshot, user, ids, selection);
      if (head.counts === null) return head.meta;
      const scopes = inventoryScopeFilter(selection.scope);
      const committed = scopes === null ? [] : await db.activityRecord.findMany({
        where: { ...this.recordWhere(ids, selection), scope: scopes, status: { in: COMMITTED_STATUSES } },
        select: SUMMARY_RECORD_SELECT,
        orderBy: { id: 'asc' },
        take: this.limits.REPORT_RECORD_LIMIT + 1,
      });
      if (committed.length > this.limits.REPORT_RECORD_LIMIT) throw new QueryTooBroadError();
      const nameById = await this.namesOf(db, ids);
      return this.metaOf(head, inventorySummary(committed, nameById), await this.readTail(snapshot, user, ids, selection));
    });
  }

  /** The organisation, the snapshot's clock and the selection's status counts — Scope 1/2 only (K4). */
  private async readHead(snapshot: CaptureSnapshot, user: RequestUser, ids: string[], selection: LiveSelection) {
    const db = CaptureSnapshot.txOf(snapshot);
    const readAt = await CaptureSnapshot.minute(snapshot);
    const org = user.organisationId
      ? await db.organisation.findUnique({
          where: { id: user.organisationId },
          select: { legalName: true, tradingName: true },
        })
      : null;
    const organisationName = org?.tradingName || org?.legalName || 'TonyAI';
    const empty: ReportMeta = {
      status: 'contains_incomplete_data',
      recordLimit: this.limits.REPORT_RECORD_LIMIT,
      organisationName,
      totalCount: 0,
      committedCount: 0,
      incompleteCount: 0,
      pendingCount: 0,
      incompleteRatio: 0,
      voidedCount: 0,
      summary: inventorySummary([], new Map()),
      scope3: NO_SCOPE3,
      // Nothing of the boundary is read for a selection the caller cannot see.
      coverage: { state: 'not_readable' },
    };
    if (ids.length === 0) return { meta: empty, counts: null, readAt };

    const scopes = inventoryScopeFilter(selection.scope);
    const grouped = scopes === null ? [] : await db.activityRecord.groupBy({
      by: ['status'],
      where: { ...this.recordWhere(ids, selection), scope: scopes },
      _count: { _all: true },
    });
    const count = (statuses: ActivityRecordStatus[]) =>
      grouped
        .filter((g) => statuses.includes(g.status))
        .reduce((sum, g) => sum + g._count._all, 0);

    // VOIDED records are excluded from the denominator, not just from
    // `committedCount`. `committed + incomplete` is meant to exhaust
    // `totalCount` — that identity is what makes `incompleteRatio` a ratio of
    // anything — and a withdrawn figure belongs to neither. Left in, it would
    // silently dilute the data-quality ratio with records the report's own
    // ledger does not contain, which is the "count quietly re-meant" trap WP17
    // hit with `recordCount`.
    const voidedCount = count([ActivityRecordStatus.voided]);
    const totalCount =
      grouped.reduce((s, g) => s + g._count._all, 0) - voidedCount;
    const committedCount = count(COMMITTED_STATUSES);
    const incompleteCount = count([
      ActivityRecordStatus.draft,
      ActivityRecordStatus.rejected,
    ]);
    // Derived, not restated: a status added to the shared pending list and
    // forgotten here would read "all approved" while undecided records still
    // sit in the reviewer's queue.
    const pendingCount = count([...PENDING_REVIEW_STATUSES]);
    const incompleteRatio = totalCount > 0 ? incompleteCount / totalCount : 0;

    // Review status only (K3): "approved" means every committed record of the
    // selection is approved and none is undecided — and that reviewed data
    // EXISTS (a zero-record year is never approved). It never says the
    // inventory is complete; `coverage` does, and only a final issuance certifies.
    const status: ReportStatus =
      committedCount === 0 || incompleteCount > 0
        ? 'contains_incomplete_data'
        : pendingCount > 0
          ? 'draft'
          : 'approved';
    return {
      meta: empty,
      readAt,
      counts: {
        status,
        organisationName,
        totalCount,
        committedCount,
        incompleteCount,
        pendingCount,
        incompleteRatio,
        // Reported, never deducted from anything above: the ratio keeps its
        // meaning and the reader still learns that figures left this year.
        voidedCount,
      },
    };
  }

  /** The Scope 3 disclosure and the boundary coverage, in the same snapshot. */
  private async readTail(snapshot: CaptureSnapshot, user: RequestUser, ids: string[], selection: LiveSelection) {
    const db = CaptureSnapshot.txOf(snapshot);
    const readsScope3 = (selection.scope === undefined || selection.scope === 3)
      && (selection.category === undefined || CATEGORY_SCOPE_MAP[selection.category] === 3);
    const scope3Rows = !readsScope3 ? [] : await db.activityRecord.findMany({
      where: { ...this.recordWhere(ids, selection), scope: 3, status: { in: COMMITTED_STATUSES } },
      select: { calculation: true },
      orderBy: { id: 'asc' },
      take: this.limits.REPORT_RECORD_LIMIT + 1,
    });
    if (scope3Rows.length > this.limits.REPORT_RECORD_LIMIT) throw new QueryTooBroadError();
    let calculatedTCo2e = 0;
    let uncalculatedRecordCount = 0;
    for (const r of scope3Rows) {
      const calc = r.calculation as unknown as ActivityCalculationSnapshot | null;
      if (isCalculated(calc)) calculatedTCo2e += calc.tCo2e;
      else uncalculatedRecordCount += 1;
    }
    const scope3: ReportScope3Disclosure = {
      coverage: 'not_covered', recordCount: scope3Rows.length, calculatedTCo2e, uncalculatedRecordCount,
    };
    // A requested subsidiary outside the caller's access never reaches here
    // (`ids` is empty and `readHead` answered); the boundary's own read rule
    // holds every subsidiary it declares to the caller's current access.
    const coverage: ReportLiveCoverage = !user.organisationId ? { state: 'no_boundary' } : await readLiveCoverage(
      snapshot,
      {
        organisationId: user.organisationId,
        accessibleSubsidiaryIds: user.accessibleSubsidiaryIds,
        reportSubsidiaryIds: ids,
        reportingYear: selection.year,
        selection: {
          ...(selection.subsidiaryId !== undefined ? { subsidiaryId: selection.subsidiaryId } : {}),
          ...(selection.scope !== undefined ? { scope: selection.scope } : {}),
          ...(selection.category !== undefined ? { category: selection.category } : {}),
        },
      },
      { records: this.limits.REPORT_RECORD_LIMIT, evidenceLinks: this.limits.REPORT_EVIDENCE_LINK_LIMIT },
    );
    return { scope3, coverage };
  }

  private metaOf(
    head: Awaited<ReturnType<ReportsService['readHead']>>,
    summary: ReportInventorySummary,
    tail: { scope3: ReportScope3Disclosure; coverage: ReportLiveCoverage },
  ): ReportMeta {
    return { ...head.meta, ...head.counts, summary, ...tail };
  }

  private recordWhere(ids: string[], selection: LiveSelection) {
    return { subsidiaryId: { in: ids }, reportingYear: selection.year, category: selection.category };
  }

  private async namesOf(db: Prisma.TransactionClient, ids: string[]): Promise<Map<string, string>> {
    const subs = ids.length === 0 ? [] : await db.subsidiary.findMany({
      where: { id: { in: ids } },
      select: { id: true, legalName: true, tradingName: true },
    });
    return new Map(subs.map((s) => [s.id, s.tradingName || s.legalName]));
  }

  /** Assemble everything a report needs — shared by PDF/Excel/CSV, in one snapshot. */
  assemble(user: RequestUser, q: SelectedReportQuery): Promise<ReportData> {
    return this.inSnapshot((snapshot) => this.assembleIn(snapshot, user, q));
  }

  private async assembleIn(snapshot: CaptureSnapshot, user: RequestUser, q: SelectedReportQuery): Promise<ReportData> {
    const db = CaptureSnapshot.txOf(snapshot);
    const ids = this.scopeIds(user, q.subsidiaryId);
    // Legacy routes accept an empty selector as all accessible subsidiaries.
    const context = reportingContext({ ...q, subsidiaryId: q.subsidiaryId || undefined });
    const selection: LiveSelection = { year: q.year, subsidiaryId: q.subsidiaryId || undefined, scope: q.scope, category: q.category };

    const head = await this.readHead(snapshot, user, ids, selection);
    // D16: the caller's language unless the request names one (K6).
    const language = q.language ?? (await this.languageOf(db, user.id));
    const v = reportVocabulary(language);
    const counts = head.counts;
    if (counts !== null && counts.committedCount + counts.voidedCount > this.limits.REPORT_RECORD_LIMIT) {
      throw new QueryTooBroadError();
    }
    const nameById = await this.namesOf(db, ids);
    // Scope 1 and 2 only (K4): Scope 3 is not covered, so its records are
    // disclosed (`readTail`) and never in the ledger, a total or a percentage.
    const scopes = inventoryScopeFilter(q.scope);

    // Evidence file names are always loaded: the ledger's evidence count must be
    // truthful whether or not the appendix is requested. The location join is
    // the one every other read path already uses (`ActivityRecordsService.toDTO`)
    // rather than a second way of resolving the same name.
    const include = {
      location: { select: { name: true } },
    } satisfies Prisma.ActivityRecordInclude;
    const orderBy: Prisma.ActivityRecordOrderByWithRelationInput[] = [
      { subsidiaryId: 'asc' },
      { category: 'asc' },
      { createdAt: 'asc' },
    ];
    const load = (statuses: ActivityRecordStatus[]) =>
      db.activityRecord.findMany({
        where: {
          subsidiaryId: { in: ids },
          reportingYear: q.year,
          scope: scopes ?? undefined,
          category: q.category,
          status: { in: statuses },
        },
        include,
        omit: { input: true },
        orderBy,
        take: this.limits.REPORT_RECORD_LIMIT + 1,
      });
    type LoadedRecord = Awaited<ReturnType<typeof load>>[number];
    // Two arrays, not one handed to both slots: aliasing them is harmless while
    // both are only mapped, and a trap the moment either is sorted in place.
    const noRecords: LoadedRecord[] = [];
    const noWithdrawals: LoadedRecord[] = [];

    // Two queries rather than one wide read partitioned in memory: "the ledger
    // holds committed records only" stays a property of the query, where it can
    // be asserted, instead of a property of a filter a later edit could get
    // wrong — and `voided` is by construction the set no figure here counts.
    const [records, voided] =
      ids.length === 0 || scopes === null
        ? [noRecords, noWithdrawals]
        : await Promise.all([
            load(COMMITTED_STATUSES),
            load([ActivityRecordStatus.voided]),
          ]);

    if (records.length + voided.length > this.limits.REPORT_RECORD_LIMIT) throw new QueryTooBroadError();
    const allRecords = [...records, ...voided];
    const links = allRecords.length ? await db.activityRecordEvidence.findMany({
      where: { activityRecordId: { in: allRecords.map((r) => r.id) }, subsidiaryId: { in: ids } },
      select: { activityRecordId: true, evidence: {
        select: { id: true, fileName: true, _count: { select: { links: true } } },
      } },
      orderBy: [{ linkedAt: 'asc' }, { evidenceId: 'asc' }],
      take: this.limits.REPORT_EVIDENCE_LINK_LIMIT + 1,
    }) : [];
    if (links.length > this.limits.REPORT_EVIDENCE_LINK_LIMIT) throw new QueryTooBroadError();
    const byRecord = new Map<string, ReportEvidenceLink[]>();
    for (const link of links) {
      const list = byRecord.get(link.activityRecordId) ?? [];
      list.push({ evidence: link.evidence });
      byRecord.set(link.activityRecordId, list);
    }
    let sourceBytes = 0;
    for (const record of allRecords) {
      Object.assign(record, { evidenceLinks: byRecord.get(record.id) ?? [] });
      sourceBytes += Buffer.byteLength(JSON.stringify(record));
      if (sourceBytes > this.limits.REPORT_MAX_BYTES) throw new QueryTooBroadError();
    }

    type Snapshot = {
      tCo2e?: number;
      normalizedValue?: number;
      normalizedUnit?: string;
      conversionFactor?: number;
      conversionBasis?: string;
      factorId?: string;
      factorValue?: number;
      factorUnit?: string;
      methodology?: string;
      source?: string;
      version?: string;
      geographyCode?: string;
    };

    // The releases these figures rest on, as they stand NOW: a snapshot
    // freezes its release's status when it was calculated, but a release can
    // be withdrawn later (an erratum), and a filed report must not call a
    // figure authoritative once its source has been withdrawn.
    const releaseIds = new Set<string>();
    for (const r of [...records, ...voided]) {
      const snapshot = r.calculation as unknown as ActivityCalculationSnapshot;
      if (isProvenanceSnapshot(snapshot)) {
        releaseIds.add(snapshot.factorRelease.id);
        if (snapshot.conversion) releaseIds.add(snapshot.conversion.release.id);
      }
    }
    const withdrawals = new Map<string, ReleaseWithdrawal>(
      releaseIds.size === 0
        ? []
        : (
            await db.factorRelease.findMany({
              where: { id: { in: [...releaseIds] }, status: 'withdrawn' },
              select: { id: true, withdrawnAt: true, withdrawalReason: true },
            })
          ).map((w) => [w.id, { at: w.withdrawnAt, reason: w.withdrawalReason }]),
    );

    // One mapper for both tables: a withdrawn figure is disclosed beside the
    // same identifying columns the ledger uses, so the reader can tell which of
    // two entries for one month was the one that left.
    const toRowBase = (r: LoadedRecord): Omit<ReportLedgerRow, 'status'> => {
      const calc = (r.calculation ?? {}) as Snapshot;
      const withRelations = r as typeof r & {
        evidenceLinks?: ReportEvidenceLink[];
        location?: { name: string } | null;
      };
      return {
        subsidiaryName: nameById.get(r.subsidiaryId) ?? r.subsidiaryId,
        locationId: r.locationId,
        locationName: withRelations.location?.name ?? null,
        category: r.category,
        activityType: r.activityType ?? null,
        factorStanding: isCalculated(r.calculation as unknown as ActivityCalculationSnapshot)
          ? factorStanding(r.calculation as unknown as ActivityCalculationSnapshot, withdrawals, v)
          : null,
        periodValue: r.periodValue,
        reportingPeriod: r.reportingPeriod,
        activityValue: r.activityValue,
        activityUnit: r.activityUnit,
        normalizedValue: calc.normalizedValue,
        normalizedUnit: calc.normalizedUnit,
        conversionFactor: calc.conversionFactor,
        // `?? 0` was the previous line and it is the exact misstatement this
        // type now prevents: a record with no factor has no figure, and a
        // report that prints 0 for it asserts a measurement nobody made.
        tCo2e: Number.isFinite(calc.tCo2e) ? (calc.tCo2e as number) : null,
        // Files backing THIS record. A file shared by several records counts
        // under each of them — per row that is the truth; the distinct total
        // is `evidenceFileTotal`, below.
        evidenceCount: withRelations.evidenceLinks?.length ?? 0,
        anomalyFlag: r.anomalyFlag,
        anomalyEvaluated: isAnomalyEvaluated(r),
        anomalyBaselinePriorCount: r.anomalyBaselinePriorCount,
      };
    };

    const ledger: ReportLedgerRow[] = records.map((r) => ({
      ...toRowBase(r),
      // Narrowed at the ONE place the committed query's result is mapped: the
      // query filters on `COMMITTED_STATUSES`, which excludes `voided`.
      status: r.status as Exclude<ActivityRecordStatus, 'voided'>,
    }));

    // The restatement disclosure. The reason is carried verbatim: it is written
    // once, at least 10 characters, and uncorrectable afterwards, so a report
    // that paraphrased it would be asserting something nobody wrote.
    const withdrawn: ReportWithdrawnRow[] = voided.map((r) => ({
      ...toRowBase(r),
      status: 'voided',
      voidReason: r.voidReason,
      // UTC, and every writer labels the column as such: an unlabelled wall
      // clock in an artifact a reader keeps in another timezone is ambiguous
      // about the one thing a restatement date is for.
      voidedAt: r.voidedAt
        ? r.voidedAt.toISOString().slice(0, 16).replace('T', ' ')
        : null,
      // Straight through, unresolved: `load()` reads with `include`, so the id
      // is already here, and resolving it would put a name in a filed file.
      voidedBy: r.voidedBy,
    }));
    const withdrawnTotals: ReportWithdrawnTotals = {
      count: withdrawn.length,
      tCo2e: withdrawn.reduce((sum, r) => sum + (r.tCo2e ?? 0), 0),
      uncalculatedCount: withdrawn.filter((r) => r.tCo2e === null).length,
    };

    // Deduplicate the immutable factor snapshots by PATH — factor and
    // conversion — for the audit appendix: one factor reached directly and
    // through a conversion is two lines, each with its own standing. A path's
    // standing is the whole path's (`isAuthoritativeSnapshot`: factor AND
    // conversion), never the factor's status alone — a figure is only as
    // authoritative as its weakest link (LP3-03, obligation 2).
    const factorByPath = new Map<string, ReportFactorRow>();
    let calculatedRecords = 0;
    let nonAuthoritativeRecords = 0;
    for (const r of records) {
      const snapshot = r.calculation as unknown as ActivityCalculationSnapshot;
      if (isCalculated(snapshot)) {
        calculatedRecords += 1;
        if (!authoritativeNow(snapshot, withdrawals)) nonAuthoritativeRecords += 1;
      }
      const calc = (r.calculation ?? {}) as Snapshot;
      const provenance = isProvenanceSnapshot(snapshot) ? snapshot : null;
      const pathKey = `${calc.factorId}|${provenance?.conversion?.id ?? ''}`;
      if (calc.factorId && !factorByPath.has(pathKey)) {
        factorByPath.set(pathKey, {
          category: r.category,
          activityType: provenance?.activityType ?? null,
          release: provenance
            ? `${provenance.factorRelease.publisher} ${provenance.factorRelease.edition}`
            : v.text('preReleaseLibrary'),
          standing: factorStanding(snapshot, withdrawals, v).text,
          geographyCode: calc.geographyCode ?? '',
          factorValue: Number(calc.factorValue ?? 0),
          factorUnit: calc.factorUnit ?? '',
          methodology: calc.methodology ?? '',
          source: calc.source ?? '',
          version: calc.version ?? '',
          ...(calc.conversionBasis
            ? { conversionBasis: calc.conversionBasis }
            : {}),
        });
      }
    }

    // One file can back several records (WP8 PR7), so the appendix says, per
    // file, how many OTHER records it backs — in all, and how many of them are
    // in this report, since a Dec–Feb invoice can back records of two years —
    // because the reader judging whether one invoice honestly covers them
    // needs to see it. The section counts distinct files once.
    const filesOf = (r: LoadedRecord) =>
      ((r as typeof r & { evidenceLinks?: ReportEvidenceLink[] }).evidenceLinks ?? []).map(
        (l) => l.evidence,
      );
    const recordsPerFile = new Map<string, number>();
    for (const r of records) {
      for (const f of filesOf(r)) {
        recordsPerFile.set(f.id, (recordsPerFile.get(f.id) ?? 0) + 1);
      }
    }
    const evidenceSummary: ReportEvidenceRow[] = q.includeEvidenceSummary
      ? records
          .map((r) => {
            const files = filesOf(r);
            return {
              subsidiaryName: nameById.get(r.subsidiaryId) ?? r.subsidiaryId,
              category: r.category,
              periodValue: r.periodValue,
              fileCount: files.length,
              fileNames: files.map((f) => f.fileName),
              alsoBacks: files.map((f) => f._count.links - 1),
              alsoBacksHere: files.map((f) => (recordsPerFile.get(f.id) ?? 1) - 1),
            };
          })
          .filter((e) => e.fileCount > 0)
      : [];

    // The totals, the tables and the badge from the ledger's own rows — never
    // a second read of the same selection (K2).
    const summary = inventorySummary(records, nameById);
    // Nothing more is read for a selection the caller cannot see (`readHead`).
    const meta = counts === null ? head.meta : this.metaOf(head, summary, await this.readTail(snapshot, user, ids, selection));

    return {
      context,
      template: q.template,
      templateName:
        REPORT_TEMPLATES.find((t) => t.id === q.template)?.name ?? q.template,
      language,
      organisationName: meta.organisationName,
      subsidiaryName: q.subsidiaryId ? (nameById.get(q.subsidiaryId) ?? null) : null,
      year: q.year,
      // The snapshot's own clock: every figure below is as of this moment.
      generatedAt: head.readAt,
      generatedBy: user.email,
      status: meta.status,
      incompleteRatio: meta.incompleteRatio,
      scope3: meta.scope3,
      coverage: meta.coverage,
      includeMethodologyNotes: q.includeMethodologyNotes ?? true,
      includeEvidenceSummary: q.includeEvidenceSummary ?? false,
      summary,
      records: ledger,
      withdrawn,
      withdrawnTotals,
      factors: [...factorByPath.values()],
      calculatedRecords,
      nonAuthoritativeRecords,
      evidenceSummary,
      evidenceFileTotal: recordsPerFile.size,
    };
  }

  async generatePdf(user: RequestUser, q: SelectedReportQuery): Promise<Buffer> {
    this.assertCanGenerate(user);
    const data = await this.assemble(user, q);
    const html = buildReportHtml(data);
    this.assertOutputSize(html);
    const { bytes } = await this.pdf.render(html);
    await this.audit(user, q, 'pdf', data);
    return bytes;
  }

  async generateExcel(user: RequestUser, q: SelectedReportQuery): Promise<Buffer> {
    this.assertCanGenerate(user);
    const data = await this.assemble(user, q);
    const v = reportVocabulary(data.language);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'TonyAI';
    const scope3Only = selectsScope3Only(data.context);
    const s3 = data.scope3;

    // Sheet 1 — Summary. Live, and its first row says so (K8); review status
    // in words, never the bare enum (K3); Scope 1 + 2 the only total (K4).
    const s1 = wb.addWorksheet(v.text('sheetSummary'));
    s1.addRows([
      [v.text('excelLive', { readAt: data.generatedAt })],
      [v.text('excelTitle'), data.templateName],
      [v.text('excelOrganisation'), data.organisationName],
      [v.text('excelReportingYear'), data.year],
      ...contextLabels(data.context, data.subsidiaryName, data.language),
      [v.text('excelStatus'), statusLabel(data.status, v)],
      [v.text('excelCoverage'), ...coverageSentences(data, v)],
      // Stated here and not only on the Withdrawn Records sheet: a reader who
      // opens Summary and nothing else must still learn that figures left, and
      // in tonnes — materiality is not measured in rows.
      [
        v.text('excelWithdrawn'),
        data.withdrawnTotals.count,
        v.text('excelWithdrawnTonnes', { tonnes: v.fullFigure(data.withdrawnTotals.tCo2e) }),
      ],
      [v.text('excelGenerated'), data.generatedAt, data.generatedBy],
      [],
      [v.text('excelScope1'), scope3Only ? v.text('notCovered') : data.summary.totals.scope1],
      [v.text('excelScope2'), scope3Only ? v.text('notCovered') : data.summary.totals.scope2],
      [v.text('excelTotal'), scope3Only ? v.text('notCovered') : data.summary.totals.total],
      // A word, never a number: a Scope 3 figure in this column would be summed
      // with the inventory's (K4). Its records are counted beside it.
      [v.text('excelScope3'), v.text('notCovered'), v.text('scope3NotCovered'),
        ...(s3.recordCount > 0 ? [v.text('scope3Recorded', { count: s3.recordCount, tonnes: v.fullFigure(s3.calculatedTCo2e) })] : [])],
      [],
      [v.label('Category'), v.label('Scope'), v.label('tCO₂e'), v.label('% of total'), v.label('Records')],
      ...data.summary.byCategory.map((c) => [
        v.category(c.category), c.scope, c.tCo2e, c.percentOfTotal, c.recordCount,
      ]),
      [],
      [v.label('Subsidiary'), v.label('tCO₂e'), v.label('% of total'), v.label('Records')],
      ...data.summary.bySubsidiary.map((r) => [
        r.subsidiaryName, r.tCo2e, r.percentOfTotal, r.recordCount,
      ]),
    ]);

    // Sheet 2 — Raw Activity Data (the committed ledger)
    const s2 = wb.addWorksheet(v.text('sheetLedger'));
    s2.addRow(excelLedgerHeader(v));
    for (const r of data.records) s2.addRow(excelLedgerRow(r, v));

    // Sheet 3 — Withdrawn Records (the restatement disclosure), directly after
    // the ledger it was taken out of.
    // Always present, even when empty: a workbook whose sheet list depends on
    // the data cannot be read by anything automated, and an empty sheet with a
    // header states "nothing was withdrawn" where a missing one states nothing.
    const sw = wb.addWorksheet(v.text('sheetWithdrawn'));
    sw.addRow(excelWithdrawnHeader(v));
    for (const r of data.withdrawn) sw.addRow(excelWithdrawnRow(r, v));
    if (data.withdrawn.length > 0) {
      sw.addRow(excelWithdrawnTotalRow(data.withdrawnTotals, v));
    }

    // Sheet 4 — Factors Used (immutable snapshots, audit traceability)
    const s4 = wb.addWorksheet(v.text('sheetFactors'));
    // The three LP3-03 columns are appended, never inserted (this file's rule
    // for every artifact a reader may parse by position).
    s4.addRow(['Category', 'Geography', 'Factor value', 'Factor unit', 'Methodology', 'Source', 'Version', 'Activity type', 'Release', 'Standing'].map((l) => v.label(l)));
    for (const f of data.factors) {
      s4.addRow([
        v.category(f.category), f.geographyCode, f.factorValue, f.factorUnit, f.methodology, f.source, f.version,
        f.activityType ? v.activityType({ category: f.category, activityType: f.activityType }) : '',
        f.release, f.standing,
      ]);
    }

    const buffer = await wb.xlsx.writeBuffer();
    this.assertOutputSize(buffer);
    await this.audit(user, q, 'excel', data);
    return Buffer.from(buffer);
  }

  async generateCsv(user: RequestUser, q: SelectedReportQuery): Promise<string> {
    this.assertCanGenerate(user);
    const data = await this.assemble(user, q);
    // `reporting_entity` is INSERTED at position 2, so column ORDER changed:
    // anything reading this export by position rather than by column name (a
    // formula pinned to column G) now reads its neighbour. Documented as a
    // one-time break in report_page.md and FR §5.4; from here on new columns
    // are appended, never inserted.
    //
    // The `voided_*` block is the suffix. Machine-readable identifiers use the
    // status word (`voided`, matching the `status` column that discriminates
    // the two row kinds); "withdrawn" is for the humans reading the PDF.
    const lines = [
      csvHeader(),
      ...data.records.map((r) => csvLedgerRow(r)),
      ...data.withdrawn.map((r) => csvWithdrawnRow(r)),
    ];

    // U+FEFF, and it belongs HERE rather than in `csvHeader()` or the
    // controller. The response already says `charset=utf-8`, but that header is
    // gone once the file is on disk, and Excel-on-Windows then decodes a
    // double-clicked .csv with the ANSI codepage — which mojibakes every
    // Turkish name in it. A BOM inside `csvHeader()` would land INSIDE the first
    // field, where `csvField` re-examines it; in the controller it would ship
    // with no unit coverage, since there is no controller spec.
    //
    // Not a security property: a multi-byte UTF-8 sequence misdecoded as any
    // single-byte codepage never yields a byte < 0x80, so it can neither
    // manufacture a formula lead nor break the RFC-4180 framing. Pure fidelity.
    const output = '\uFEFF' + lines.join('\n') + '\n';
    this.assertOutputSize(output);
    await this.audit(user, q, 'csv', data);
    return output;
  }

  /** D16: the caller's own language, else the product's default (as an issuance's). */
  private async languageOf(db: Prisma.TransactionClient, userId: string): Promise<Locale> {
    const profile = await db.profile.findUnique({ where: { id: userId }, select: { language: true } });
    return isLocale(profile?.language) ? profile.language : DEFAULT_LOCALE;
  }

  /** Generation log (report_page.md §10): one audit row per generated artifact.
   *
   *  All three formats log `summary.recordCount` — the CSV used to log
   *  `records.length` instead. The two were provably equal (same query, same
   *  instant) until WP17 briefly narrowed `recordCount`, at which point two
   *  exports of the same selection wrote different counts into an append-only
   *  compliance log. One expression, so they cannot diverge again. */
  private assertOutputSize(value: string | Uint8Array | ArrayBuffer): void {
    const bytes = typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
    if (bytes > this.limits.REPORT_MAX_BYTES) throw new QueryTooBroadError();
  }

  private async audit(
    user: RequestUser,
    q: SelectedReportQuery,
    exportType: ReportExportType,
    data: ReportData,
  ): Promise<void> {
    const recordCount = data.summary.recordCount;
    const voidedCount = data.withdrawnTotals.count;
    await this.auditLog.record(user, {
      action: 'generate',
      entity: 'report',
      // Reports have no persisted row to point at; the diff carries the scope.
      entityId: null,
      diff: {
        template: q.template,
        year: q.year,
        subsidiaryId: q.subsidiaryId || null,
        ...(q.scope !== undefined ? { scope: q.scope } : {}),
        ...(q.category !== undefined ? { category: q.category } : {}),
        exportType,
        // LP4-03: the snapshot every figure was read in, the badge it printed,
        // what the boundary said, and — for the PDF and the workbook — the
        // language (D16; the CSV has none: English machine headers).
        readAt: data.generatedAt,
        status: data.status,
        coverage: data.coverage.state === 'assessed'
          ? { state: 'assessed', boundaryId: data.coverage.boundary.id, version: data.coverage.boundary.version, reading: data.coverage.reading }
          : { state: data.coverage.state },
        ...(exportType === 'csv' ? {} : { language: data.language }),
        recordCount,
        // What the artifact disclosed, recorded with it. The record set moves
        // afterwards — a figure withdrawn next month is not in last month's
        // export — so this is not recoverable from the data later, and the log
        // is the only place a generated report's restatement count survives.
        //
        // Named for the STATUS, not for the reader-facing word: `audit_log` is
        // append-only, so a key written today cannot be renamed, and every
        // machine-readable identifier in this product already spells this
        // concept `void*` (`voidReason`, `transition.to: 'voided'`,
        // `ReportMetaDTO.voidedCount`). "Withdrawn" is the word humans read.
        voidedCount,
      },
    });

  }
}
