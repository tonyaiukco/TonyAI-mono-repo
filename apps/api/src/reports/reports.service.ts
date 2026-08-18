import { ForbiddenException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ActivityRecordStatus, Prisma } from '@tonyai/db';
import type {
  EmissionsSummary,
  ReportExportType,
  ReportStatus,
  ReportTemplate,
} from '@tonyai/shared-types';
import { PENDING_REVIEW_STATUSES, REPORT_TEMPLATES } from '@tonyai/shared-types';
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

export interface ReportLedgerRow {
  subsidiaryName: string;
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
  status: string;
  evidenceCount: number;
  anomalyFlag: boolean;
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
  factors: ReportFactorRow[];
  evidenceSummary: ReportEvidenceRow[];
}

export interface ReportMeta {
  status: ReportStatus;
  organisationName: string;
  totalCount: number;
  committedCount: number;
  incompleteCount: number; // draft + rejected
  pendingCount: number; // submitted + under_review
  incompleteRatio: number;
}

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

    // Committed ledger (+ evidence file names when the appendix is requested).
    const records =
      ids.length === 0
        ? []
        : await this.prisma.activityRecord.findMany({
            where: {
              subsidiaryId: { in: ids },
              reportingYear: q.year,
              status: { in: COMMITTED_STATUSES },
            },
            // Evidence file names are always loaded: the ledger's evidence count
            // must be truthful whether or not the appendix is requested.
            include: { evidence: { select: { fileName: true } } },
            orderBy: [{ subsidiaryId: 'asc' }, { category: 'asc' }, { createdAt: 'asc' }],
          });

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

    const ledger: ReportLedgerRow[] = records.map((r) => {
      const calc = (r.calculation ?? {}) as Snapshot;
      const withEvidence = r as typeof r & { evidence?: { fileName: string }[] };
      return {
        subsidiaryName: nameById.get(r.subsidiaryId) ?? r.subsidiaryId,
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
        status: r.status,
        evidenceCount: withEvidence.evidence?.length ?? 0,
        anomalyFlag: r.anomalyFlag,
      };
    });

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
      await this.audit(user, q, 'pdf', data.summary.recordCount);
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
      'Subsidiary', 'Category', 'Reporting period', 'Period', 'Activity value',
      'Unit', 'tCO₂e', 'Status', 'Evidence files', 'Anomaly flag',
    ]);
    for (const r of data.records) {
      s2.addRow([
        r.subsidiaryName, r.category, r.reportingPeriod, r.periodValue,
        // A text cell, not an empty numeric one: a blank in a tCO₂e column
        // sums as zero the moment someone drags a SUM over it, which is the
        // same misstatement as writing 0 — only harder to notice.
        r.activityValue, r.activityUnit, r.tCo2e ?? NOT_CALCULATED, r.status, r.evidenceCount,
        r.anomalyFlag ? 'yes' : '',
      ]);
    }

    // Sheet 3 — Factors Used (immutable snapshots, audit traceability)
    const s3 = wb.addWorksheet('Factors Used');
    s3.addRow(['Category', 'Geography', 'Factor value', 'Factor unit', 'Methodology', 'Source', 'Version']);
    for (const f of data.factors) {
      s3.addRow([f.category, f.geographyCode, f.factorValue, f.factorUnit, f.methodology, f.source, f.version]);
    }

    const buffer = await wb.xlsx.writeBuffer();
    await this.audit(user, q, 'excel', data.summary.recordCount);
    return Buffer.from(buffer);
  }

  async generateCsv(user: RequestUser, q: ReportQueryDto): Promise<string> {
    this.assertCanGenerate(user);
    const data = await this.assemble(user, q);
    const header = [
      'subsidiary', 'category', 'reporting_period', 'period_value',
      'activity_value', 'activity_unit', 'tco2e', 'status', 'evidence_files',
      'anomaly_flag',
    ];
    const cell = (v: string | number | boolean): string => {
      let s = String(v);
      // Neutralize spreadsheet formula injection on user-influenced text.
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      header.join(','),
      ...data.records.map((r) =>
        [
          r.subsidiaryName, r.category, r.reportingPeriod, r.periodValue,
          // Same reasoning as the Excel sheet: an empty cell in a numeric
          // column is read as zero by whatever consumes the CSV next.
          r.activityValue, r.activityUnit, r.tCo2e ?? NOT_CALCULATED, r.status, r.evidenceCount,
          r.anomalyFlag,
        ]
          .map(cell)
          .join(','),
      ),
    ];
    await this.audit(user, q, 'csv', data.summary.recordCount);
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
      },
    });

  }
}
