import { ForbiddenException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ActivityRecordStatus, Prisma } from '@tonyai/db';
import type {
  ReportExportType,
  ReportMetaDTO,
  ReportStatus,
} from '@tonyai/shared-types';
import {
  isAnomalyEvaluated,
  PENDING_REVIEW_STATUSES,
  REPORT_TEMPLATES,
} from '@tonyai/shared-types';
import puppeteer, { type Browser } from 'puppeteer';
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
  ReportData,
  ReportEvidenceRow,
  ReportFactorRow,
  ReportLedgerRow,
  ReportWithdrawnRow,
  ReportWithdrawnTotals,
} from './report-data';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { COUNTED_STATUSES, EmissionsService } from '../emissions/emissions.service';
import { ReportQueryDto } from './dto/report-query.dto';
import { buildReportHtml } from './report-html';

// Single source of truth for "committed": imported from the emissions service so
// a report's summary tables and its own ledger can never silently diverge.
const COMMITTED_STATUSES = COUNTED_STATUSES;

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
    s2.addRow(excelLedgerHeader());
    for (const r of data.records) s2.addRow(excelLedgerRow(r));

    // Sheet 3 — Withdrawn Records (the restatement disclosure), directly after
    // the ledger it was taken out of.
    // Always present, even when empty: a workbook whose sheet list depends on
    // the data cannot be read by anything automated, and an empty sheet with a
    // header states "nothing was withdrawn" where a missing one states nothing.
    const s3 = wb.addWorksheet('Withdrawn Records');
    s3.addRow(excelWithdrawnHeader());
    for (const r of data.withdrawn) s3.addRow(excelWithdrawnRow(r));
    if (data.withdrawn.length > 0) {
      s3.addRow(excelWithdrawnTotalRow(data.withdrawnTotals));
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
    const lines = [
      csvHeader(),
      ...data.records.map((r) => csvLedgerRow(r)),
      ...data.withdrawn.map((r) => csvWithdrawnRow(r)),
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
