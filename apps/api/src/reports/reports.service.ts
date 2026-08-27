import { ForbiddenException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ActivityRecordStatus, Prisma } from '@tonyai/db';
import type {
  EmissionsSummary,
  ReportExportType,
  ReportMetaDTO,
  ReportStatus,
  ReportTemplate,
} from '@tonyai/shared-types';
import {
  ANOMALY_BASELINE_PERIODS,
  entityLabel,
  isAnomalyEvaluated,
  PENDING_REVIEW_STATUSES,
  REPORT_TEMPLATES,
} from '@tonyai/shared-types';
import puppeteer, { type Browser } from 'puppeteer';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { COUNTED_STATUSES, EmissionsService } from '../emissions/emissions.service';
import { ReportQueryDto } from './dto/report-query.dto';
import { buildReportHtml } from './report-html';

// Single source of truth for "committed": imported from the emissions service so
// a report's summary tables and its own ledger can never silently diverge.
const COMMITTED_STATUSES = COUNTED_STATUSES;

/** One ledger row for the detail template / Excel raw-data sheet / CSV. */
/**
 * What every export writes where a tCO₂e figure would go when the record's
 * category has no emission factor. One constant so the PDF, the Excel sheet and
 * the CSV cannot say three different things about the same row.
 */
const NOT_CALCULATED = 'Not calculated';

/**
 * What the anomaly column says for a record the VAR §4 rule never ran on.
 *
 * A blank in that column has always meant "checked, nothing unusual". Since
 * 2026-08-27 the rule needs three priors, so a blank would also cover "never
 * checked" — and on the dev database that is 30 of 96 committed records, in the
 * artifact an auditor keeps. Same instinct as NOT_CALCULATED above: say the
 * absence rather than print something indistinguishable from a measurement.
 *
 * ONE renderer for every format (`anomalyCell`), because the Excel sheet and
 * the CSV each hold their own column literals and this is exactly the kind of
 * difference that survives review — WP20 shipped a CSV and an Excel from one
 * request that disagreed about withdrawn rows for precisely this reason.
 */
const NOT_EVALUATED = 'Not evaluated';

function anomalyCell(r: {
  anomalyFlag: boolean;
  anomalyEvaluated: boolean;
  anomalyBaselinePriorCount: number | null;
}): string {
  if (r.anomalyFlag) return 'yes';
  if (r.anomalyEvaluated) return '';
  const priors = r.anomalyBaselinePriorCount;
  // Each absence names itself: the reader of a filed report cannot ask which
  // one it was, and the three have different remedies — a factor, more months,
  // or nothing at all.
  if (priors === null) return `${NOT_EVALUATED} (no figure)`;
  if (priors >= ANOMALY_BASELINE_PERIODS) return `${NOT_EVALUATED} (baseline is zero)`;
  return `${NOT_EVALUATED} (${priors} of ${ANOMALY_BASELINE_PERIODS} priors)`;
}

/**
 * What the flat exports write in the tCO₂e column of a WITHDRAWN row.
 *
 * Text, never a number, and never blank: the withdrawn rows share one table
 * with the counted ledger in the CSV, so anything numeric there would be
 * summed straight back into a total the record was deliberately taken out of.
 * The figure that left is carried in its own `withdrawn_tco2e` column instead,
 * where a SUM over it answers a different question on purpose.
 */
const WITHDRAWN = 'Withdrawn';

export interface ReportLedgerRow {
  subsidiaryName: string;
  /** The location id, carried beside the name because `entityLabel` keys on the
   *  PAIR: the id is the fact, the name is a decoration the query may or may not
   *  have loaded. Free — it is on the record row already. */
  locationId: string | null;
  /** The site this figure is attributed to, or `null` for a whole-company row.
   *  Kept null-able rather than pre-labelled so the three writers all put the
   *  same phrase on it (`entityLabel`) instead of three near-synonyms. Without
   *  it a re-attribution from the company to a site changes nothing visible in
   *  any export, and the two halves of a double-counted month are
   *  indistinguishable in the ledger an auditor keeps. */
  locationName: string | null;
  category: string;
  periodValue: string;
  reportingPeriod: string;
  activityValue: number;
  activityUnit: string;
  /** What the activity value became after unit conversion, and by what factor.
   *  Without these the ledger prints "5,000 cubic_metres → 10.4 tCO₂e" beside a
   *  factor quoted per kWh, and the ×11.36 between them appears nowhere — the
   *  figure cannot be recomputed from the report, which is what ISO 14064-1
   *  §9.3.1 and GHG Protocol Ch.7 ask a report to make possible. */
  normalizedValue?: number;
  normalizedUnit?: string;
  conversionFactor?: number;
  /** `null` when the record's category has no emission factor and therefore
   *  produced no figure (WP17 — Water). Deliberately not `0`: an audit-ready
   *  ledger that prints a measured zero where nothing was measured cannot be
   *  told apart from a genuine zero afterwards, and the report is the artifact
   *  an auditor keeps. Every writer renders it as "Not calculated". */
  tCo2e: number | null;
  /** Narrowed so "the ledger holds no withdrawn figure" is a compile error
   *  rather than only a test: `ReportWithdrawnRow` extends this type, so a
   *  withdrawn row is otherwise assignable straight into `records` and into the
   *  ledger writers. Same allow-list instinct as `COUNTED_STATUSES`. */
  status: Exclude<ActivityRecordStatus, 'voided'>;
  evidenceCount: number;
  anomalyFlag: boolean;
  /** Whether the VAR §4 rule actually RAN on this record — `anomalyFlag: false`
   *  covers both "checked, clean" and "never checked", and only one of those is
   *  a statement a filed report may make. Derived once here through the shared
   *  `isAnomalyEvaluated` predicate so no writer re-derives it. */
  anomalyEvaluated: boolean;
  /** The window it was judged against: null (no figure of its own), 0–2 (short)
   *  or 3 (evaluated). Printed inside the anomaly column rather than as a new
   *  column — the ledger already carries ten hand-maintained column literals
   *  across three writers, and this adds no eleventh. */
  anomalyBaselinePriorCount: number | null;
}

/**
 * One figure withdrawn from this reporting year — a ledger row plus why it left.
 *
 * It extends `ReportLedgerRow` rather than restating it because a withdrawal
 * disclosure is only meaningful beside the same identifying columns the ledger
 * uses: the reader has to be able to tell which of two entries for one month
 * was removed, and before WP18's Reporting Entity row the two were
 * distinguishable only by activity value.
 */
export interface ReportWithdrawnRow extends Omit<ReportLedgerRow, 'status'> {
  status: 'voided';
  /** Why the figure was withdrawn — required at the API (min 10 chars) and
   *  uncorrectable afterwards, so it is quoted verbatim, never summarised. */
  voidReason: string | null;
  voidedAt: string | null;
}

/** One deduplicated factor snapshot (audit traceability core, FR §3.5/§5). */
export interface ReportFactorRow {
  category: string;
  geographyCode: string;
  factorValue: number;
  factorUnit: string;
  methodology: string;
  source: string;
  version: string;
  /** Set when records under this factor went through a unit conversion. The
   *  basis is disclosed here because for natural gas it is an ASSUMPTION, not a
   *  definition, and a factor appendix that hides it is not audit-traceable. */
  conversionBasis?: string;
}

export interface ReportEvidenceRow {
  subsidiaryName: string;
  category: string;
  periodValue: string;
  fileCount: number;
  fileNames: string[];
}

/**
 * How much left the inventory, alongside how many rows did.
 *
 * An assurer's first question about a restatement is its magnitude, and
 * materiality is measured in tonnes, not in rows. Computed once in `assemble`
 * so the banner, the Excel line and the table footer cannot state three
 * different numbers — the `recordCount` lesson, applied before it happens.
 */
export interface ReportWithdrawnTotals {
  count: number;
  /** Sum over the withdrawn rows that HAD a figure. */
  tCo2e: number;
  /** Withdrawn rows whose category has no emission factor, so nothing was
   *  removed from the totals by withdrawing them (WP17 — Water). Disclosed
   *  rather than folded in, because "269.9 tCO2e withdrawn" beside 6 rows must
   *  not imply all six carried tonnage. */
  uncalculatedCount: number;
}

/** Everything a report renders — assembled once, shared by PDF/Excel/CSV. */
export interface ReportData {
  template: ReportTemplate;
  templateName: string;
  organisationName: string;
  subsidiaryName: string | null;
  year: number;
  generatedAt: string;
  generatedBy: string;
  status: ReportStatus;
  incompleteRatio: number;
  includeMethodologyNotes: boolean;
  includeEvidenceSummary: boolean;
  summary: EmissionsSummary;
  records: ReportLedgerRow[];
  /** Records withdrawn from this year — disclosed by every format, counted by
   *  none of them. Empty is the normal case and every writer says nothing then.
   *
   *  This is the artifact's disclosure set BY CONSTRUCTION: every writer counts
   *  `withdrawn.length`, never `meta.voidedCount`. The two are computed by
   *  different queries with identical predicates and agree today; if this list
   *  ever gains a cap or a filter, a banner reading the meta would under-report
   *  the very table printed beneath it. `meta.voidedCount` is the SCREEN's
   *  number (it has no list to count). */
  withdrawn: ReportWithdrawnRow[];
  withdrawnTotals: ReportWithdrawnTotals;
  factors: ReportFactorRow[];
  evidenceSummary: ReportEvidenceRow[];
}

/**
 * What `GET /reports/meta` returns. This is the wire contract itself, not a
 * structural twin of it: the two were hand-written copies of one shape with
 * nothing tying them together, so a field added to either could sit unread on
 * the other — the exact drift `COUNTED_STATUSES` and the period vocabulary were
 * both consolidated to end.
 */
export type ReportMeta = ReportMetaDTO;

@Injectable()
export class ReportsService implements OnModuleDestroy {
  // Memoized launch promise: two concurrent first requests must share ONE
  // Chromium instance (a naive null-check race would leak the loser).
  private browserPromise: Promise<Browser> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emissions: EmissionsService,
    private readonly auditLog: AuditService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    const browser = await this.browserPromise?.catch(() => null);
    await browser?.close();
    this.browserPromise = null;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browserPromise) {
      const existing = await this.browserPromise.catch(() => null);
      if (existing?.connected) return existing;
    }
    this.browserPromise = puppeteer.launch({
      headless: true,
      // In containers we use the distro Chromium (PUPPETEER_EXECUTABLE_PATH);
      // locally the var is unset and Puppeteer falls back to its bundled Chrome.
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    return this.browserPromise;
  }

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

  /** Completeness/status for a year — drives the preview badge + PDF banner. */
  async meta(
    user: RequestUser,
    year: number,
    subsidiaryId?: string,
  ): Promise<ReportMeta> {
    const ids = this.scopeIds(user, subsidiaryId);
    const org = user.organisationId
      ? await this.prisma.organisation.findUnique({
          where: { id: user.organisationId },
          select: { legalName: true, tradingName: true },
        })
      : null;
    const organisationName = org?.tradingName || org?.legalName || 'TonyAI';
    const empty: ReportMeta = {
      status: 'contains_incomplete_data',
      organisationName,
      totalCount: 0,
      committedCount: 0,
      incompleteCount: 0,
      pendingCount: 0,
      incompleteRatio: 0,
      voidedCount: 0,
    };
    if (ids.length === 0) return empty;

    const grouped = await this.prisma.activityRecord.groupBy({
      by: ['status'],
      where: { subsidiaryId: { in: ids }, reportingYear: year },
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
    // Derived, not restated: this count is what stamps a generated report
    // `approved`, so a status added to the shared pending list and forgotten
    // here would mean an audit-ready PDF marked approved while undecided
    // records still sit in the reviewer's queue.
    const pendingCount = count([...PENDING_REVIEW_STATUSES]);
    const incompleteRatio = totalCount > 0 ? incompleteCount / totalCount : 0;

    // "Approved" must mean reviewed data EXISTS — a zero-record year is never
    // approved (compliance honesty; matches the out-of-scope empty case).
    const status: ReportStatus =
      committedCount === 0 || incompleteCount > 0
        ? 'contains_incomplete_data'
        : pendingCount > 0
          ? 'draft'
          : 'approved';

    return {
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
    };
  }

  /** Assemble everything a report needs — shared by PDF/Excel/CSV. */
  async assemble(user: RequestUser, q: ReportQueryDto): Promise<ReportData> {
    const ids = this.scopeIds(user, q.subsidiaryId);

    const [summary, meta, subs] = await Promise.all([
      this.emissions.summary(user, { subsidiaryId: q.subsidiaryId, year: q.year }),
      this.meta(user, q.year, q.subsidiaryId), // also resolves the org name
      this.prisma.subsidiary.findMany({
        where: { id: { in: user.accessibleSubsidiaryIds } },
        select: { id: true, legalName: true, tradingName: true },
      }),
    ]);

    const nameById = new Map(subs.map((s) => [s.id, s.tradingName || s.legalName]));

    // Evidence file names are always loaded: the ledger's evidence count must be
    // truthful whether or not the appendix is requested. The location join is
    // the one every other read path already uses (`ActivityRecordsService.toDTO`)
    // rather than a second way of resolving the same name.
    const include = {
      evidence: { select: { fileName: true } },
      location: { select: { name: true } },
    } satisfies Prisma.ActivityRecordInclude;
    const orderBy: Prisma.ActivityRecordOrderByWithRelationInput[] = [
      { subsidiaryId: 'asc' },
      { category: 'asc' },
      { createdAt: 'asc' },
    ];
    const load = (statuses: ActivityRecordStatus[]) =>
      this.prisma.activityRecord.findMany({
        where: {
          subsidiaryId: { in: ids },
          reportingYear: q.year,
          status: { in: statuses },
        },
        include,
        orderBy,
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
      ids.length === 0
        ? [noRecords, noWithdrawals]
        : await Promise.all([
            load(COMMITTED_STATUSES),
            load([ActivityRecordStatus.voided]),
          ]);

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

    // One mapper for both tables: a withdrawn figure is disclosed beside the
    // same identifying columns the ledger uses, so the reader can tell which of
    // two entries for one month was the one that left.
    const toRowBase = (r: LoadedRecord): Omit<ReportLedgerRow, 'status'> => {
      const calc = (r.calculation ?? {}) as Snapshot;
      const withRelations = r as typeof r & {
        evidence?: { fileName: string }[];
        location?: { name: string } | null;
      };
      return {
        subsidiaryName: nameById.get(r.subsidiaryId) ?? r.subsidiaryId,
        locationId: r.locationId,
        locationName: withRelations.location?.name ?? null,
        category: r.category,
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
        evidenceCount: withRelations.evidence?.length ?? 0,
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
    }));
    const withdrawnTotals: ReportWithdrawnTotals = {
      count: withdrawn.length,
      tCo2e: withdrawn.reduce((sum, r) => sum + (r.tCo2e ?? 0), 0),
      uncalculatedCount: withdrawn.filter((r) => r.tCo2e === null).length,
    };

    // Deduplicate the immutable factor snapshots by factorId (audit appendix).
    const factorById = new Map<string, ReportFactorRow>();
    for (const r of records) {
      const calc = (r.calculation ?? {}) as Snapshot;
      if (calc.factorId && !factorById.has(calc.factorId)) {
        factorById.set(calc.factorId, {
          category: r.category,
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

    const evidenceSummary: ReportEvidenceRow[] = q.includeEvidenceSummary
      ? records
          .map((r) => {
            const withEvidence = r as typeof r & { evidence?: { fileName: string }[] };
            return {
              subsidiaryName: nameById.get(r.subsidiaryId) ?? r.subsidiaryId,
              category: r.category,
              periodValue: r.periodValue,
              fileCount: withEvidence.evidence?.length ?? 0,
              fileNames: (withEvidence.evidence ?? []).map((e) => e.fileName),
            };
          })
          .filter((e) => e.fileCount > 0)
      : [];

    return {
      template: q.template,
      templateName:
        REPORT_TEMPLATES.find((t) => t.id === q.template)?.name ?? q.template,
      organisationName: meta.organisationName,
      subsidiaryName: q.subsidiaryId ? (nameById.get(q.subsidiaryId) ?? null) : null,
      year: q.year,
      generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      generatedBy: user.email,
      status: meta.status,
      incompleteRatio: meta.incompleteRatio,
      includeMethodologyNotes: q.includeMethodologyNotes ?? true,
      includeEvidenceSummary: q.includeEvidenceSummary ?? false,
      summary,
      records: ledger,
      withdrawn,
      withdrawnTotals,
      factors: [...factorById.values()],
      evidenceSummary,
    };
  }

  async generatePdf(user: RequestUser, q: ReportQueryDto): Promise<Buffer> {
    this.assertCanGenerate(user);
    const data = await this.assemble(user, q);
    const html = buildReportHtml(data);

    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
      });
      await this.audit(user, q, 'pdf', data.summary.recordCount, data.withdrawnTotals.count);
      return Buffer.from(pdf);
    } finally {
      await page.close();
    }
  }

  async generateExcel(user: RequestUser, q: ReportQueryDto): Promise<Buffer> {
    this.assertCanGenerate(user);
    const data = await this.assemble(user, q);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'TonyAI';

    // Sheet 1 — Summary
    const s1 = wb.addWorksheet('Summary');
    s1.addRows([
      ['TonyAI emissions report', data.templateName],
      ['Organisation', data.organisationName],
      ['Reporting year', data.year],
      ['Scope filter', data.subsidiaryName ?? 'All accessible subsidiaries'],
      ['Status', data.status],
      // Stated here and not only on the Withdrawn Records sheet: a reader who
      // opens Summary and nothing else must still learn that figures left, and
      // in tonnes — materiality is not measured in rows.
      [
        'Withdrawn records (excluded from every figure below)',
        data.withdrawnTotals.count,
        `${data.withdrawnTotals.tCo2e} tCO₂e removed`,
      ],
      ['Generated', data.generatedAt, data.generatedBy],
      [],
      ['Scope 1 (tCO₂e)', data.summary.totals.scope1],
      ['Scope 2 (tCO₂e)', data.summary.totals.scope2],
      ['Total (tCO₂e)', data.summary.totals.total],
      [],
      ['Category', 'Scope', 'tCO₂e', '% of total', 'Records'],
      ...data.summary.byCategory.map((c) => [
        c.category, c.scope, c.tCo2e, c.percentOfTotal, c.recordCount,
      ]),
      [],
      ['Subsidiary', 'tCO₂e', '% of total', 'Records'],
      ...data.summary.bySubsidiary.map((r) => [
        r.subsidiaryName, r.tCo2e, r.percentOfTotal, r.recordCount,
      ]),
    ]);

    // Sheet 2 — Raw Activity Data (the committed ledger)
    const s2 = wb.addWorksheet('Raw Activity Data');
    s2.addRow([
      'Subsidiary', 'Reporting entity', 'Category', 'Reporting period', 'Period',
      'Activity value', 'Unit', 'tCO₂e', 'Status', 'Evidence files', 'Anomaly flag',
    ]);
    for (const r of data.records) {
      s2.addRow([
        r.subsidiaryName, entityLabel(r), r.category, r.reportingPeriod, r.periodValue,
        // A text cell, not an empty numeric one: a blank in a tCO₂e column
        // sums as zero the moment someone drags a SUM over it, which is the
        // same misstatement as writing 0 — only harder to notice.
        r.activityValue, r.activityUnit, r.tCo2e ?? NOT_CALCULATED, r.status, r.evidenceCount,
        anomalyCell(r),
      ]);
    }

    // Sheet 3 — Withdrawn Records (the restatement disclosure), directly after
    // the ledger it was taken out of.
    // Always present, even when empty: a workbook whose sheet list depends on
    // the data cannot be read by anything automated, and an empty sheet with a
    // header states "nothing was withdrawn" where a missing one states nothing.
    const s3 = wb.addWorksheet('Withdrawn Records');
    s3.addRow([
      'Subsidiary', 'Reporting entity', 'Category', 'Reporting period', 'Period',
      'Activity value', 'Unit', 'tCO₂e removed', 'Withdrawn (UTC)', 'Reason',
    ]);
    for (const r of data.withdrawn) {
      s3.addRow([
        r.subsidiaryName, entityLabel(r), r.category, r.reportingPeriod,
        r.periodValue, r.activityValue, r.activityUnit, r.tCo2e ?? NOT_CALCULATED,
        r.voidedAt ?? '', r.voidReason ?? '',
      ]);
    }
    if (data.withdrawn.length > 0) {
      s3.addRow([
        'Total withdrawn', '', '', '', '', '', '',
        data.withdrawnTotals.tCo2e, '',
        data.withdrawnTotals.uncalculatedCount > 0
          ? `${data.withdrawnTotals.uncalculatedCount} of these carry no emissions figure`
          : '',
      ]);
    }

    // Sheet 4 — Factors Used (immutable snapshots, audit traceability)
    const s4 = wb.addWorksheet('Factors Used');
    s4.addRow(['Category', 'Geography', 'Factor value', 'Factor unit', 'Methodology', 'Source', 'Version']);
    for (const f of data.factors) {
      s4.addRow([f.category, f.geographyCode, f.factorValue, f.factorUnit, f.methodology, f.source, f.version]);
    }

    const buffer = await wb.xlsx.writeBuffer();
    await this.audit(user, q, 'excel', data.summary.recordCount, data.withdrawnTotals.count);
    return Buffer.from(buffer);
  }

  async generateCsv(user: RequestUser, q: ReportQueryDto): Promise<string> {
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
    const header = [
      'subsidiary', 'reporting_entity', 'category', 'reporting_period',
      'period_value', 'activity_value', 'activity_unit', 'tco2e', 'status',
      'evidence_files', 'anomaly_flag', 'voided_activity_value', 'voided_tco2e',
      'voided_at_utc', 'void_reason',
    ];
    const cell = (v: string | number | boolean): string => {
      let s = String(v);
      // Neutralize spreadsheet formula injection on user-influenced text.
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      // A BARE `\r` has to be quoted too, not just `\n`: most parsers end a
      // record on it, so a withdrawal reason containing one would split into a
      // second row — a fabricated ledger line, in the artifact a reader trusts,
      // behind no database row and no audit entry. A browser sends `\r\n`, so
      // reaching this needs a deliberate API call; it is still a forgery.
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      header.join(','),
      ...data.records.map((r) =>
        [
          r.subsidiaryName, entityLabel(r), r.category, r.reportingPeriod,
          r.periodValue,
          // Same reasoning as the Excel sheet: an empty cell in a numeric
          // column is read as zero by whatever consumes the CSV next.
          r.activityValue, r.activityUnit, r.tCo2e ?? NOT_CALCULATED, r.status, r.evidenceCount,
          anomalyCell(r),
          // The `voided_*` columns are empty for a counted row, and empty is
          // the right word here: this row was never withdrawn.
          '', '', '', '',
        ]
          .map(cell)
          .join(','),
      ),
      // Withdrawn records share the table rather than getting a second file:
      // one header row keeps the export parseable. EVERY column a reader could
      // aggregate therefore carries the marker on these rows — not just tCO₂e.
      // The first cut protected the tCO₂e column alone and left the real
      // `activity_value` in place, which overstated total electricity by
      // 394 MWh and total fuel by 36,000 litres on the seeded year: energy
      // consumption is a reported figure in its own right (GRI 302-1, CSRD
      // E1-5), and the Excel from the same request gave a different answer.
      // What was withdrawn is reported in the `voided_*` block, where summing
      // answers a different question on purpose.
      ...data.withdrawn.map((r) =>
        [
          r.subsidiaryName, entityLabel(r), r.category, r.reportingPeriod,
          r.periodValue, WITHDRAWN, r.activityUnit, WITHDRAWN, r.status,
          WITHDRAWN, WITHDRAWN,
          r.activityValue, r.tCo2e ?? NOT_CALCULATED, r.voidedAt ?? '',
          r.voidReason ?? '',
        ]
          .map(cell)
          .join(','),
      ),
    ];
    await this.audit(user, q, 'csv', data.summary.recordCount, data.withdrawnTotals.count);
    return lines.join('\n') + '\n';
  }

  /** Generation log (report_page.md §10): one audit row per generated artifact.
   *
   *  All three formats log `summary.recordCount` — the CSV used to log
   *  `records.length` instead. The two were provably equal (same query, same
   *  instant) until WP17 briefly narrowed `recordCount`, at which point two
   *  exports of the same selection wrote different counts into an append-only
   *  compliance log. One expression, so they cannot diverge again. */
  private async audit(
    user: RequestUser,
    q: ReportQueryDto,
    exportType: ReportExportType,
    recordCount: number,
    voidedCount: number,
  ): Promise<void> {
    await this.auditLog.record(user, {
      action: 'generate',
      entity: 'report',
      // Reports have no persisted row to point at; the diff carries the scope.
      entityId: null,
      diff: {
        template: q.template,
        year: q.year,
        subsidiaryId: q.subsidiaryId ?? null,
        exportType,
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
