'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { withdrawalNotice } from '@/lib/report-view';
import { formatNumber } from '@/lib/i18n/number';
import { useErrorToast } from '@/lib/i18n/hooks';
import { withPreviewRetry } from '@/lib/report-preview';
import { scope3Lines, selectsScope3Only, STATUS_KEY } from '@/lib/report-coverage-view';
import { CoverageCard } from '@/components/reports/coverage-card';
import { IssuedReports } from '@/components/reports/issued-reports';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sidebar } from '@/components/dashboard/sidebar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertTriangle,
  Download,
  FileSpreadsheet,
  FileText,
  Info,
  Leaf,
  LogOut,
  Radio,
  Table2,
} from 'lucide-react';
import {
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
} from 'recharts';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { useAuthStore } from '@/lib/store';
import { useReportingContext } from '@/lib/use-reporting-context';
import { reportingContextKey } from '@/lib/reporting-context-url';
import { ReportingContextBar, ReportingContextInvalid, selectionAvailable } from '@/components/reporting-context/reporting-context-bar';
import { CATEGORY_SCOPE_MAP, REPORT_TEMPLATES } from '@/lib/types';
import type {
  Category,
  Locale,
  ReportInventorySummary,
  ReportExportType,
  ReportingContext,
  ReportMetaDTO,
  ReportStatus,
  ReportTemplate,
  SubsidiaryDTO,
} from '@/lib/types';


const SCOPE_COLORS = { scope1: '#34C759', scope2: '#007AFF', scope3: '#AF52DE' };

// Review status, labelled as such (LP4-03 K3): the words are the catalogue's (`STATUS_KEY`).
const STATUS_CLASS: Record<ReportStatus, string> = {
  approved: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  draft: 'bg-blue-500/15 text-blue-600 border-blue-500/30',
  contains_incomplete_data: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
};

type ReportsTab = 'live' | 'issued';

/** `useReportingContext` reads the URL (`useSearchParams`), which Next wants under a Suspense boundary. */
export default function ReportsPage() {
  return (
    <Suspense fallback={null}>
      <ReportsPageInner />
    </Suspense>
  );
}

function ReportsPageInner() {
  const router = useRouter();
  const { user, setUser } = useAuthStore();
  const tContext = useTranslations('reportingContext');
  const tCategory = useTranslations('categories');
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const showError = useErrorToast();
  const fmt = (value: number) => formatNumber(value, locale, { maximumFractionDigits: 1 });
  const tonnes = (value: number) => t('tonnes', { value: fmt(value) });

  // LP4-03 K8: the live preview and the issued reports, the tab in the URL
  // beside the reporting context (`reportingContextQuery` keeps a page's own keys).
  const searchParams = useSearchParams();
  const tab: ReportsTab = searchParams.get('tab') === 'issued' ? 'issued' : 'live';
  const selectTab = (next: string) => {
    const params = new URLSearchParams(window.location.search);
    if (next === 'issued') params.set('tab', 'issued');
    else params.delete('tab');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  };

  // LP3-02 N1: year, subsidiary, scope and category come from the URL — the
  // same selection the dashboard and emissions screens carry.
  const contextView = useReportingContext();
  const contextKey = contextView.status === 'ready' ? contextView.key : null;
  const context = useMemo(
    () => (contextView.status === 'ready' ? contextView.context : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contextKey],
  );

  // View-local export options (FR §5.3)
  const [template, setTemplate] = useState<ReportTemplate>('executive_summary');
  const [includeMethodology, setIncludeMethodology] = useState(true);
  const [includeEvidence, setIncludeEvidence] = useState(false);

  // Live data
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [subsidiariesLoaded, setSubsidiariesLoaded] = useState(false);
  // The report's own figures, read in the same snapshot as `meta` (LP4-03 K2):
  // Scope 1 + 2, as every export of this selection prints them (K4).
  const [summary, setSummary] = useState<ReportInventorySummary | null>(null);
  const [meta, setMeta] = useState<ReportMetaDTO | null>(null);
  // The context the preview on screen was computed for. Exports send exactly
  // this, so a file can never describe a selection the preview did not show.
  const [shown, setShown] = useState<ReportingContext | null>(null);
  const [loading, setLoading] = useState(true);
  // A failed preview says so (with a retry) instead of a skeleton that never ends.
  const [previewFailed, setPreviewFailed] = useState(false);
  const [downloading, setDownloading] = useState<ReportExportType | null>(null);
  const loadSeq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++loadSeq.current;
    // Nothing of the previous selection stays on screen while the new one loads:
    // the completeness card, the withdrawal notice and the draft warning read `meta`.
    setShown(null);
    setSummary(null);
    setMeta(null);
    setPreviewFailed(false);
    if (!context) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      // The preview holds one snapshot connection per user (LP4-03): a second
      // one while the first still runs answers 429 with Retry-After — try once more.
      const m = await withPreviewRetry(() => api.reportingMeta(context), () => mine === loadSeq.current);
      if (mine !== loadSeq.current) return;
      setSummary(m.data.summary);
      setMeta(m.data);
      setShown(context);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      setSummary(null);
      setMeta(null);
      setPreviewFailed(true);
      showError(e);
    } finally {
      if (mine === loadSeq.current) setLoading(false);
    }
  }, [context, showError]);

  useEffect(() => {
    api.me().then(setUser).catch(showError);
    api
      .listSubsidiaries()
      .then((list) => {
        setSubsidiaries(list);
        setSubsidiariesLoaded(true);
      })
      .catch(showError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleDownload(kind: ReportExportType) {
    // Only the selection the preview shows, and only once it is on screen.
    if (!shown || !context || reportingContextKey(shown) !== reportingContextKey(context)) return;
    setDownloading(kind);
    try {
      await api.downloadReportingReport(kind, {
        ...shown,
        template,
        includeMethodologyNotes: includeMethodology,
        includeEvidenceSummary: includeEvidence,
      });
      toast.success(t('generated', { kind: kind.toUpperCase() }));
    } catch (e) {
      showError(e);
    } finally {
      setDownloading(null);
    }
  }

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const canGenerate = !!user && user.role !== 'data_entry'; // permissions §"Generate and export reports"
  const exportReady = !!shown && !!context && !loading && reportingContextKey(shown) === reportingContextKey(context);
  const totals = summary?.totals ?? { scope1: 0, scope2: 0, scope3: 0, total: 0 };
  const templateName = REPORT_TEMPLATES.some((r) => r.id === template) ? t(`templates.${template}`) : template;
  // A Scope 3 selection (`scope=3`, or a Scope 3 category) has no Scope 1/2 figure: its tiles read "Not covered" (K4).
  const scope3Only = !!shown && selectsScope3Only(shown, (c) => CATEGORY_SCOPE_MAP[c as Category]);
  const scopeTile = (value: number) => (scope3Only ? t('tiles.notCovered') : tonnes(value));
  const shownSubsidiary = shown?.subsidiaryId
    ? (subsidiaries.find((s) => s.id === shown.subsidiaryId) ?? null)
    : null;
  const subsidiaryName = shown?.subsidiaryId
    ? shownSubsidiary
      ? (shownSubsidiary.tradingName ?? shownSubsidiary.legalName)
      : selectionAvailable(shown, subsidiariesLoaded ? subsidiaries : null) === false
        ? tContext('unavailableSubsidiary')
        : null
    : null;
  // A scope or category narrows the file to an extract (follow-up (10): its
  // status badge describes the filtered records alone).
  const filterLabel = shown
    ? [
        shown.scope !== undefined ? tContext('scopeValue', { scope: shown.scope }) : null,
        shown.category !== undefined ? tCategory(shown.category) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const badge = meta ? { label: t(STATUS_KEY[meta.status] as never), className: STATUS_CLASS[meta.status] } : null;
  const withdrawn = withdrawalNotice(meta);

  const pieData = useMemo(
    () =>
      [
        // Scope 1 and 2 only: a live report sums no Scope 3 record (K4).
        { name: t('tiles.scope1'), value: totals.scope1, color: SCOPE_COLORS.scope1 },
        { name: t('tiles.scope2'), value: totals.scope2, color: SCOPE_COLORS.scope2 },
      ].filter((d) => d.value > 0),
    [totals, t],
  );

  const topContributors = useMemo(
    () => (summary?.bySubsidiary ?? []).slice(0, 5).map((s) => ({ name: s.subsidiaryName, tCo2e: s.tCo2e })),
    [summary],
  );

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-[280px] transition-all duration-300">
        <div className="space-y-6 p-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
              <p className="mt-1 text-muted-foreground">
                {user ? t('subtitleUser', { name: user.fullName, role: user.role }) : t('subtitle')}
              </p>
            </div>
            <Button variant="outline" onClick={handleLogout} className="gap-2">
              <LogOut className="h-4 w-4" />
              {tCommon('signOut')}
            </Button>
          </div>

          {/* Provenance banner */}
          <div className="flex items-start gap-2 rounded-lg border border-[#FEF3C7] bg-[#FFFBEB] px-4 py-3 text-sm text-[#92400E]">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t.rich('provenance', { strong: (chunks) => <strong>{chunks}</strong> })}</span>
          </div>

          <Tabs value={tab} onValueChange={selectTab}>
            <TabsList>
              <TabsTrigger value="live">{t('tabs.live')}</TabsTrigger>
              <TabsTrigger value="issued">{t('tabs.issued')}</TabsTrigger>
            </TabsList>
            <TabsContent value="issued" className="mt-4">
              {context ? (
                <IssuedReports year={context.year} role={user?.role ?? null} language={user?.language ?? locale} />
              ) : contextView.status === 'invalid' ? (
                <ReportingContextInvalid invalid={contextView.invalid} onReset={contextView.reset} />
              ) : null}
            </TabsContent>
            <TabsContent value="live" className="mt-4 space-y-6">
          <div
            className="flex items-start gap-2 rounded-lg border-2 border-dashed border-amber-400 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900"
            data-testid="live-banner"
          >
            <Radio className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('liveBanner')}</span>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Left: config + preview */}
            <div className="space-y-6 lg:col-span-2">
              {/* Config bar (report_page.md §3) */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('configuration')}</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="sm:col-span-3">
                    <Field label={tContext('label')}>
                      {contextView.status === 'ready' ? (
                        <ReportingContextBar
                          context={contextView.context}
                          subsidiaries={subsidiariesLoaded ? subsidiaries : null}
                          onSelect={contextView.select}
                          disabled={downloading !== null}
                        />
                      ) : (
                        <ReportingContextInvalid invalid={contextView.invalid} onReset={contextView.reset} />
                      )}
                    </Field>
                  </div>
                  <Field label={t('template')}>
                    <Select value={template} onValueChange={(v) => setTemplate(v as ReportTemplate)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {REPORT_TEMPLATES.map((r) => (
                          <SelectItem key={r.id} value={r.id}>{t(`templates.${r.id}`)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={includeMethodology}
                      onCheckedChange={(c) => setIncludeMethodology(c === true)}
                    />
                    {t('methodologyNotes')}
                  </label>
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <Checkbox
                      checked={includeEvidence}
                      onCheckedChange={(c) => setIncludeEvidence(c === true)}
                    />
                    {t('evidenceSummary')}
                  </label>
                </CardContent>
              </Card>

              {/* Restatement disclosure — the same fact the exports carry, so a
                  user knows what the file will say before generating it. */}
              {withdrawn && (
                <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{withdrawn.count === 1 ? t('withdrawnOne') : t('withdrawnMany', { count: fmt(withdrawn.count) })}</span>
                </div>
              )}

              {filterLabel && (
                <div
                  className="flex items-start gap-2 rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800"
                  data-testid="filtered-extract"
                >
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{tContext('filteredExtract', { filters: filterLabel })}</span>
                </div>
              )}

              {/* Data warning (report_page.md §9) */}
              {meta && meta.incompleteRatio > 0.15 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t('draftWarning', { percent: fmt(meta.incompleteRatio * 100) })}</span>
                </div>
              )}

              {/* Preview canvas (report_page.md §4-§6) */}
              {contextView.status === 'invalid' ? null : previewFailed ? (
                <div
                  className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-12 text-center text-sm"
                  role="alert"
                  data-testid="preview-failed"
                >
                  <AlertTriangle className="h-8 w-8 text-[#B91C1C]" />
                  <p className="text-muted-foreground">{tContext('loadFailed')}</p>
                  <Button variant="outline" onClick={() => void refresh()}>{tContext('retry')}</Button>
                </div>
              ) : loading || !shown ? (
                <Skeleton className="h-[480px] w-full" />
              ) : (
                <Card className="border-2 border-primary/20">
                  <CardContent className="space-y-6 p-8">
                    {/* Branded header */}
                    <div className="flex items-start justify-between border-b-2 border-primary pb-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <Leaf className="h-5 w-5 text-primary" />
                          <h2 className="text-xl font-bold text-primary">{meta?.organisationName ?? "—"}</h2>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {t('templateYear', { template: templateName, year: shown.year })}
                          {subsidiaryName ? ` · ${subsidiaryName}` : ''}
                          {filterLabel ? ` · ${filterLabel}` : ''}
                        </p>
                      </div>
                      {badge && (
                        <div className="flex max-w-[45%] flex-col items-end gap-1 text-right">
                          <Badge variant="outline" className={badge.className}>{badge.label}</Badge>
                          <p className="text-[11px] leading-snug text-muted-foreground" data-testid="status-note">{t('statusNote')}</p>
                        </div>
                      )}
                    </div>

                    {meta && <CoverageCard coverage={meta.coverage} year={shown.year} />}

                    {/* Metric tiles */}
                    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                      <Tile label={t('tiles.scope1')} value={scopeTile(totals.scope1)} />
                      <Tile label={t('tiles.scope2')} value={scopeTile(totals.scope2)} />
                      <Tile label={t('tiles.total')} value={scopeTile(totals.total)} />
                      {/* Scope 3's committed records are the disclosure's count below, never a 0 here. */}
                      <Tile label={t('tiles.committed')} value={scope3Only ? t('tiles.notCovered') : fmt(summary?.recordCount ?? 0)} />
                    </div>

                    {meta && (
                      <div className="space-y-1 text-xs text-muted-foreground" data-testid="scope3-disclosure">
                        {scope3Lines(meta.scope3).map((line) => (
                          <p key={line.key}>
                            {t(
                              line.key as never,
                              Object.fromEntries(Object.entries(line.values ?? {}).map(([k, v]) => [k, typeof v === 'number' ? fmt(v) : v])) as never,
                            )}
                          </p>
                        ))}
                      </div>
                    )}

                    {/* Charts */}
                    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                      <div>
                        <h3 className="mb-2 text-sm font-semibold text-foreground">{t('scopeSplit')}</h3>
                        <div className="h-52">
                          <ResponsiveContainer width="100%" height="100%">
                            <RechartsPieChart>
                              <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75}>
                                {pieData.map((d) => (
                                  <Cell key={d.name} fill={d.color} />
                                ))}
                              </Pie>
                              <RechartsTooltip formatter={(v: number) => tonnes(v)} />
                            </RechartsPieChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                      <div>
                        <h3 className="mb-2 text-sm font-semibold text-foreground">{t('topContributors')}</h3>
                        <div className="h-52">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={topContributors} layout="vertical" margin={{ left: 24 }}>
                              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                              <XAxis type="number" hide />
                              <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                              <RechartsTooltip formatter={(v: number) => tonnes(v)} />
                              <Bar dataKey="tCo2e" fill="#059669" radius={[0, 4, 4, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>

                    {/* Category breakdown (report_page.md §6) */}
                    <div>
                      <h3 className="mb-2 text-sm font-semibold text-foreground">{t('byCategory')}</h3>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <th className="py-2">{t('columns.category')}</th>
                            <th className="py-2">{t('columns.scope')}</th>
                            <th className="py-2 text-right">{t('columns.tco2e')}</th>
                            <th className="py-2 text-right">{t('columns.percent')}</th>
                            <th className="py-2 text-right">{t('columns.records')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(summary?.byCategory ?? []).map((c) => (
                            <tr key={`${c.category}-${c.scope}`} className="border-b border-border/60">
                              <td className="py-2 font-medium">{tCategory(c.category)}</td>
                              <td className="py-2">{t('scopeValue', { scope: c.scope })}</td>
                              <td className="py-2 text-right tabular-nums">{fmt(c.tCo2e)}</td>
                              <td className="py-2 text-right tabular-nums">{fmt(c.percentOfTotal)}%</td>
                              <td className="py-2 text-right tabular-nums">{fmt(c.recordCount)}</td>
                            </tr>
                          ))}
                          {(summary?.byCategory ?? []).length === 0 && (
                            <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">{scope3Only ? t('scope3.noInventoryFigures') : t('noCommittedData')}</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    {includeMethodology && (
                      <p className="rounded-lg bg-secondary/50 p-3 text-xs text-muted-foreground">
                        {t.rich('methodology', { strong: (chunks) => <strong>{chunks}</strong> })}
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Right rail: downloads + completeness */}
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('generate')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {!canGenerate && (
                    <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                      {t('cannotGenerate')}
                    </p>
                  )}
                  {canGenerate && (<>
                  <Button
                    className="w-full justify-start gap-2"
                    onClick={() => handleDownload('pdf')}
                    disabled={downloading !== null || !exportReady}
                  >
                    <FileText className="h-4 w-4" />
                    {downloading === 'pdf' ? t('generatingPdf') : t('downloadPdf')}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-2"
                    onClick={() => handleDownload('excel')}
                    disabled={downloading !== null || !exportReady}
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    {downloading === 'excel' ? t('generatingExcel') : t('exportExcel')}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-2"
                    onClick={() => handleDownload('csv')}
                    disabled={downloading !== null || !exportReady}
                  >
                    <Table2 className="h-4 w-4" />
                    {downloading === 'csv' ? t('generatingCsv') : t('exportCsv')}
                  </Button>
                  </>)}
                  <p className="text-xs text-muted-foreground">{t('excelNote')}</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Download className="h-4 w-4 text-muted-foreground" />
                    {t('recordsHeading')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {meta ? (
                    <>
                      <Row label={t('rows.total')} value={fmt(meta.totalCount)} />
                      <Row label={t('rows.committed')} value={fmt(meta.committedCount)} />
                      <Row label={t('rows.pending')} value={fmt(meta.pendingCount)} />
                      <Row label={t('rows.incomplete')} value={fmt(meta.incompleteCount)} />
                      {meta.voidedCount > 0 && (
                        <Row label={t('rows.withdrawn')} value={fmt(meta.voidedCount)} />
                      )}
                    </>
                  ) : previewFailed ? null : (
                    <Skeleton className="h-20 w-full" />
                  )}
                  <p className="pt-1 text-xs text-muted-foreground">{t('sharingNote')}</p>
                </CardContent>
              </Card>
            </div>
          </div>
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-bold text-foreground">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}
