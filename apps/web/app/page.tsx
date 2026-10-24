'use client';

import { Suspense, useCallback, useState, useMemo, useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/dashboard/sidebar';
import { SignOutButton } from '@/components/dashboard/sign-out-button';
import { KPICards } from '@/components/dashboard/kpi-cards';
import { TrackingMatrix } from '@/components/dashboard/tracking-matrix';
import { AlertsPanel } from '@/components/dashboard/alerts-panel';
import { EmissionsCharts } from '@/components/dashboard/emissions-charts';
import { SubsidiaryDetail } from '@/components/dashboard/subsidiary-detail';
import { CoverageCard, CoverageUnavailable } from '@/components/reports/coverage-card';
import { withPreviewRetry } from '@/lib/report-preview';
import { selectsScope3Only } from '@/lib/report-coverage-view';
import { ReportingContextBar, ReportingContextInvalid } from '@/components/reporting-context/reporting-context-bar';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Building2,
  CheckCircle2,
  Clock,
  Globe,
  Search,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { useAuthStore } from '@/lib/store';
import { useReportingContext } from '@/lib/use-reporting-context';
import { useRecordWords, useStableErrorToast } from '@/lib/i18n/hooks';
import { formatNumber } from '@/lib/i18n/number';
import {
  buildKpiData,
  matrixToAlerts,
  matrixToSubsidiaries,
} from '@/lib/dashboard-view';
import { CATEGORY_SCOPE_MAP, mayAuthorRecords } from '@/lib/types';
import type {
  Category,
  DashboardKpi,
  ReportLiveCoverage,
  EmissionsSummary,
  TrackingMatrixRow,
  SubsidiaryDTO,
  TrackingMatrixDTO,
} from '@/lib/types';

const statusClass: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  pending: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  inactive: 'bg-red-500/15 text-red-600 border-red-500/30',
};

/** `useReportingContext` reads the URL (`useSearchParams`), which Next wants under a Suspense boundary. */
export default function CarbonDashboard() {
  return (
    <Suspense fallback={null}>
      <CarbonDashboardInner />
    </Suspense>
  );
}

function CarbonDashboardInner() {
  const tRoles = useTranslations('users');
  const router = useRouter();
  const { user, setUser } = useAuthStore();
  // LP3-02 N1: the one reporting selection, carried in the URL.
  const tContext = useTranslations('reportingContext');
  const tDashboard = useTranslations('dashboard');
  const tSubsidiaryStatus = useTranslations('subsidiaryStatus');
  const tCategory = useTranslations('categories');
  const tCommon = useTranslations('common');
  const words = useRecordWords();
  // Stable: `loadDashboard` is an effect's dependency, and a language switch
  // must not reload the dashboard.
  const showError = useStableErrorToast();
  const contextView = useReportingContext();
  const contextKey = contextView.status === 'ready' ? contextView.key : null;
  const context = useMemo(
    () => (contextView.status === 'ready' ? contextView.context : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contextKey],
  );

  // Live data (API: /me, /kpi, /subsidiaries, /emissions/summary, /emissions/tracking-matrix)
  const [kpi, setKpi] = useState<DashboardKpi | null>(null);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  // Whether `subsidiaries` was ever answered: a failed load is not "none of
  // them is yours", which the bar would say of a selected one.
  const [subsidiariesKnown, setSubsidiariesKnown] = useState(false);
  const [summary, setSummary] = useState<EmissionsSummary | null>(null);
  const [matrix, setMatrix] = useState<TrackingMatrixDTO | null>(null);
  const [coverage, setCoverage] = useState<ReportLiveCoverage | 'unavailable' | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Drill-down detail sheet (view model mapped from the live tracking matrix)
  // The matrix ROW, not the mock view model: the drawer needs `coverage`,
  // `trackingGranularity` and `locationCount`, all of which
  // `matrixToSubsidiaries` drops. Kept as the subsidiary and the selection it
  // was opened in, and the row read from the matrix on screen: a stored row
  // outlived its selection, so Back showed one year's figures beside another
  // year's invoice grid (Codex B9 P2-3).
  const [selected, setSelected] = useState<{ key: string | null; subsidiaryId: string } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  // A new selection — the bar, Back/Forward, a refused link — closes the drawer.
  if (selected !== null && selected.key !== contextKey) {
    setSelected(null);
    setDetailOpen(false);
  }
  const [refreshFailures, setRefreshFailures] = useState(0);
  const inFlight = useRef(false);

  /**
   * Load the dashboard's four sources together.
   *
   * `silent` skips the loading state so a background refresh does not blank the
   * page under the reader — a refresh they did not ask for should look like the
   * numbers changing, not like the page reloading.
   */
  // Sequence token: whichever request resolves LAST used to win, so a slow
  // response carrying an older view could land after a newer one and stay on
  // screen until the next focus. On a compliance dashboard a figure that is
  // wrong and never self-corrects is the failure that matters.
  const loadSeq = useRef(0);

  const loadDashboard = useCallback(async (silent = false) => {
    // One refresh at a time. A real alt-tab fires `focus` AND
    // `visibilitychange`, so without this a single tab return issued two full
    // reloads — eight requests — and rapid switching multiplied it.
    if (silent && loadSeq.current !== 0 && inFlight.current) return;
    const mine = ++loadSeq.current;
    inFlight.current = true;
    if (!silent) setLoading(true);
    try {
      const [kpiData, list, summaryData, matrixData, metaData] = await Promise.all([
        api.kpi(),
        api.listSubsidiaries(),
        // ONE context for both: they feed one set of KPI cards (`buildKpiData`),
        // so a total and a completeness bar of different years, subsidiaries or
        // filters would sit in one row with neither labelled. An invalid link
        // loads neither (LP3-02 N1).
        context ? api.reportingSummary(context) : Promise.resolve(null),
        // A year, not "everything": without one the endpoint folds every year
        // into a single cell, so a subsidiary complete for 2023 and empty for
        // 2024 read as complete.
        context ? api.reportingMatrix(context) : Promise.resolve(null),
        // The boundary's live coverage beside the entry progress (LP4-03 K9).
        // Its own snapshot read: a failure (a second preview of this user's
        // running, a selection too broad) leaves the card out, never the dashboard.
        // Retried once after a capacity refusal; a failure stands as "unavailable", never as no card.
        context
          ? withPreviewRetry(() => api.reportingMeta(context)).catch(() => 'unavailable' as const)
          : Promise.resolve(null),
      ]);
      // A response from a superseded request must not overwrite a newer one.
      if (mine !== loadSeq.current) return;
      setKpi(kpiData);
      setSubsidiaries(list);
      setSubsidiariesKnown(true);
      setSummary(summaryData?.data ?? null);
      setMatrix(matrixData?.data ?? null);
      setCoverage(metaData === 'unavailable' ? 'unavailable' : (metaData?.data.coverage ?? null));
      setRefreshFailures(0);
    } catch (e) {
      // An expired session is the MOST likely failure on the focus path — it is
      // the "came back after a while" path — so it cannot be swallowed: the
      // page would keep showing authenticated figures to someone who is signed
      // out, beside a green "Live data" badge.
      if (e instanceof ApiError && e.status === 401) {
        router.push('/login');
        return;
      }
      // A newer request owns the screen now; this failure says nothing about it.
      if (mine !== loadSeq.current) return;
      if (!silent) {
        // A load the user asked for — a new selection — that failed must not
        // leave the previous selection's figures under the new bar (`qa-auditor` P2-1).
        setSummary(null);
        setMatrix(null);
        setCoverage(null);
        showError(e);
      } else {
        // Swallowing one transient failure is right; swallowing them forever is
        // not. After a few, say the numbers are not live any more.
        setRefreshFailures((n) => n + 1);
      }
    } finally {
      // Only the latest request ends the loading state: an older one finishing
      // first would show its predecessor's figures under the newest selection.
      if (mine === loadSeq.current) {
        inFlight.current = false;
        if (!silent) setLoading(false);
      }
    }
  }, [router, context, showError]);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(showError);
  }, [setUser, showError]);

  // Again whenever the selection changes; the sequence token drops the older answer.
  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  /**
   * Refresh when the tab comes back into focus (round-1 DASH-1).
   *
   * These figures are computed from data changed on OTHER pages — add a location
   * on Subsidiaries and this page, if it is sitting open in another tab, keeps
   * yesterday's count with nothing to invalidate it. Navigating here already
   * remounts and refetches; this covers the case navigation does not.
   */
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === 'visible') void loadDashboard(true);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [loadDashboard]);

  const filteredSubsidiaries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return subsidiaries;
    return subsidiaries.filter((s) =>
      [s.legalName, s.tradingName, s.location, s.sector, s.geographyCode]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q)),
    );
  }, [subsidiaries, searchQuery]);

  // Live Emissions Overview view models, mapped from the aggregation endpoints.
  const matrixSubsidiaries = useMemo(
    () => (matrix ? matrixToSubsidiaries(matrix) : []),
    [matrix],
  );
  // Scope 1 + 2 is not covered by a Scope 3 selection: the cards and the chart say so, never 0.
  const scope3Only = !!context && selectsScope3Only(context, (c) => CATEGORY_SCOPE_MAP[c as Category]);
  // The card's locations are the selection's: with one subsidiary selected,
  // GET /kpi's total for every accessible subsidiary would sit beside
  // "1 company". Both count every location a subsidiary owns.
  const selectedLocations =
    context?.subsidiaryId !== undefined && matrix
      ? matrix.rows.reduce((n, row) => n + row.locationCount, 0)
      : (kpi?.totalLocations ?? null);
  const emissionsKpiData = useMemo(
    () =>
      summary && matrix
        ? buildKpiData(summary, matrix, selectedLocations)
        : null,
    [summary, matrix, selectedLocations],
  );
  // A scope or category narrows the overview to an extract of the year.
  const filterLabel = context
    ? [
        context.scope !== undefined ? tContext('scopeValue', { scope: context.scope }) : null,
        context.category !== undefined ? tCategory(context.category) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const liveAlerts = useMemo(
    () =>
      matrix
        ? matrixToAlerts(matrix, (category) =>
            tDashboard('alerts.anomaly', { category: words.category(category) }),
          )
        : [],
    [matrix, tDashboard, words],
  );

  const selectedRow = selected
    ? (matrix?.rows.find((row) => row.subsidiaryId === selected.subsidiaryId) ?? null)
    : null;
  const handleMatrixSubsidiaryClick = (row: TrackingMatrixRow) => {
    setSelected({ key: contextKey, subsidiaryId: row.subsidiaryId });
    setDetailOpen(true);
  };

  // A cell is a (subsidiary, category) pair, so clicking one goes where that
  // pair is acted on rather than opening the same subsidiary drawer as the row
  // name. Round-1 UAT (DASH-2): the cells advertise "click to view details" and
  // did nothing distinguishable.
  const handleMatrixCategoryClick = (row: TrackingMatrixRow, category: string) => {
    const params = new URLSearchParams({
      subsidiaryId: row.subsidiaryId,
      category,
      // The year the grid shows, which is the selected one.
      year: String(matrix?.reportingYear ?? context?.year),
    });
    router.push(`/data-entry?${params.toString()}`);
  };

  /**
   * An open invoice slot names the location, the month and the category, so the
   * deep link can carry all three. The matrix cell can only offer category +
   * year, which is why Data Entry answers it with "several records exist, pick
   * one" — from the grid there is nothing left to guess.
   */
  const handleSlotClick = ({
    subsidiaryId,
    category,
    locationId,
    month,
  }: {
    subsidiaryId: string;
    category: string;
    locationId: string;
    month: string;
  }) => {
    const params = new URLSearchParams({
      subsidiaryId,
      category,
      // The year the GRID was fetched for, not the module default. Equal today;
      // the first year picker would otherwise send the user to a different year
      // than the one they were looking at.
      year: String(matrix?.reportingYear ?? context?.year),
      locationId,
      period: 'monthly',
      periodValue: month,
    });
    router.push(`/data-entry?${params.toString()}`);
  };

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />

      <main className="ml-[280px] transition-all duration-300">
        {/* Live header */}
        <header className="sticky top-0 z-30 h-16 border-b border-[#D8D8DC] bg-[#EBEBF0]">
          <div className="flex h-16 items-center justify-between px-6">
            <div className="flex items-center gap-4">
              <h1 className="text-xl font-bold text-[#1D1D1F]" data-testid="dashboard-title">{tDashboard('title')}</h1>
              {user && (
                <span className="hidden text-sm font-medium text-[#6E6E73] md:inline">
                  {user.fullName} · {tRoles(`roles.${user.role}`)}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6E6E73]" />
                <Input
                  placeholder={tDashboard('searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-9 w-56 rounded-lg border-[#D8D8DC] bg-[#EBEBF0] pl-9 text-sm font-medium text-[#1D1D1F] placeholder:text-[#8E8E93] focus:ring-[#1B5E3B]/40"
                />
              </div>
              <SignOutButton onClick={handleLogout} size="sm" className="h-9 rounded-lg border-[#D8D8DC] bg-[#EBEBF0] font-semibold text-[#1D1D1F] hover:bg-[#E0E0E5]" />
            </div>
          </div>
        </header>

        <div className="space-y-6 p-6">
          {/* LIVE: KPI summary from /kpi */}
          <LiveKpiStrip kpi={kpi} loading={loading} />

          {/* LIVE: Subsidiary register from /subsidiaries */}
          <Card className="rounded-[18px] border-border bg-white shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between px-6 pb-4 pt-5">
              <CardTitle className="text-lg font-semibold text-foreground">
                {tDashboard('register.title')}
              </CardTitle>
              {/* The badge is a claim. Once background refreshes keep failing
                  it stops being true, and a green "Live data" beside stale
                  figures is worse than no badge at all. */}
              {refreshFailures >= 3 ? (
                <Badge
                  variant="outline"
                  className="gap-1.5 rounded-lg border-amber-500/30 bg-amber-500/10 text-amber-700"
                >
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  {tDashboard('stale')}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="gap-1.5 rounded-lg border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
                >
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  {tDashboard('live')}
                </Badge>
              )}
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <p className="py-12 text-center text-sm text-muted-foreground">{tCommon('loading')}</p>
              ) : subsidiaries.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {tDashboard('register.empty')}
                </p>
              ) : filteredSubsidiaries.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {tDashboard('register.noMatch', { query: searchQuery })}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="border-border bg-secondary hover:bg-transparent">
                      <TableHead className="pl-6">{tDashboard('register.columns.legalName')}</TableHead>
                      <TableHead>{tDashboard('register.columns.tradingName')}</TableHead>
                      <TableHead>{tDashboard('register.columns.location')}</TableHead>
                      <TableHead>{tDashboard('register.columns.geography')}</TableHead>
                      <TableHead>{tDashboard('register.columns.sector')}</TableHead>
                      <TableHead className="pr-6 text-right">{tDashboard('register.columns.status')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSubsidiaries.map((s) => (
                      <TableRow
                        key={s.id}
                        className="border-border transition-colors duration-150 hover:bg-secondary/50"
                      >
                        <TableCell className="pl-6 font-medium text-foreground">
                          {s.legalName}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {s.tradingName ?? '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {s.location ?? '—'}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className="rounded-lg border-border bg-secondary/50 text-muted-foreground"
                          >
                            {s.geographyCode}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {s.sector ?? '—'}
                        </TableCell>
                        <TableCell className="pr-6 text-right">
                          <Badge
                            variant="outline"
                            className={statusClass[s.reportingStatus]}
                          >
                            {tSubsidiaryStatus(s.reportingStatus)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* LIVE: Emissions Overview from /emissions/summary + /emissions/tracking-matrix */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#1D1D1F]">{tDashboard('overview.title')}</h2>
              {/* The badge is a claim. Once background refreshes keep failing
                  it stops being true, and a green "Live data" beside stale
                  figures is worse than no badge at all. */}
              {refreshFailures >= 3 ? (
                <Badge
                  variant="outline"
                  className="gap-1.5 rounded-lg border-amber-500/30 bg-amber-500/10 text-amber-700"
                >
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  {tDashboard('stale')}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="gap-1.5 rounded-lg border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
                >
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  {tDashboard('live')}
                </Badge>
              )}
            </div>
            <p className="-mt-2 text-sm text-muted-foreground">{tDashboard('overviewNote')}</p>
            {contextView.status === 'ready' ? (
              <ReportingContextBar
                context={contextView.context}
                subsidiaries={subsidiariesKnown ? subsidiaries : null}
                onSelect={contextView.select}
              />
            ) : null}

            {contextView.status === 'ready' && filterLabel && (
              <p className="text-sm text-blue-800" data-testid="filtered-view">
                {tContext('filteredView', { filters: filterLabel })}
              </p>
            )}

            {contextView.status === 'invalid' ? (
              <ReportingContextInvalid invalid={contextView.invalid} onReset={contextView.reset} />
            ) : loading ? (
              <p className="py-12 text-center text-sm text-muted-foreground">{tCommon('loading')}</p>
            ) : !emissionsKpiData || !matrix ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {tDashboard('overview.loadFailed')}
              </p>
            ) : (
              <div className="space-y-6">
                <KPICards
                  data={emissionsKpiData}
                  reportingYear={matrix?.reportingYear ?? null}
                  scope3Only={scope3Only}
                  byLocationCount={
                    matrix?.rows.filter(
                      (r) => r.trackingGranularity === 'location',
                    ).length ?? 0
                  }
                />

                {coverage === 'unavailable' ? (
                  <CoverageUnavailable />
                ) : coverage && matrix?.reportingYear != null ? (
                  <CoverageCard coverage={coverage} year={matrix.reportingYear} />
                ) : null}

                <TrackingMatrix
                  rows={matrix?.rows ?? []}
                  reportingYear={matrix?.reportingYear ?? null}
                  onSubsidiaryClick={handleMatrixSubsidiaryClick}
                  onCategoryClick={handleMatrixCategoryClick}
                />

                <div className="grid gap-6 lg:grid-cols-3">
                  <div className="lg:col-span-1">
                    <AlertsPanel alerts={liveAlerts} reportingYear={matrix?.reportingYear ?? null} />
                  </div>
                  <div className="lg:col-span-2">
                    <EmissionsCharts subsidiaries={matrixSubsidiaries} notCovered={scope3Only} />
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      {/* Drill-down detail sheet — reads the matrix row, and fetches the
          per-location invoice grid on open (round-1 DASH-3). */}
      <SubsidiaryDetail
        row={selectedRow}
        reportingYear={matrix?.reportingYear ?? null}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        canEnter={mayAuthorRecords(user)}
        onSlotClick={handleSlotClick}
      />
    </div>
  );
}

function LiveKpiStrip({ kpi, loading }: { kpi: DashboardKpi | null; loading: boolean }) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const cards = [
    {
      key: 'total',
      title: t('strip.totalSubsidiaries'),
      value: kpi?.totalSubsidiaries ?? 0,
      icon: <Building2 className="h-4 w-4 text-primary" />,
      hint: t('strip.accessible'),
    },
    {
      key: 'active',
      title: t('strip.active'),
      value: kpi?.activeSubsidiaries ?? 0,
      icon: <CheckCircle2 className="h-4 w-4 text-primary" />,
      hint: t('strip.activeHint'),
    },
    {
      key: 'pending',
      title: t('strip.pending'),
      value: kpi?.pendingSubsidiaries ?? 0,
      icon: <Clock className="h-4 w-4 text-primary" />,
      hint: t('strip.pendingHint'),
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.key} className="rounded-[18px] border-border bg-white shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {c.title}
            </CardTitle>
            {c.icon}
          </CardHeader>
          <CardContent>
            <div className="font-mono text-3xl font-bold tabular-nums text-foreground">
              {loading ? '—' : formatNumber(c.value, locale)}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{c.hint}</p>
          </CardContent>
        </Card>
      ))}

      {/* Geography breakdown */}
      <Card className="rounded-[18px] border-border bg-white shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t('strip.geographies')}
          </CardTitle>
          <Globe className="h-4 w-4 text-primary" />
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="font-mono text-3xl font-bold tabular-nums text-foreground">—</div>
          ) : kpi && kpi.geographyBreakdown.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {kpi.geographyBreakdown.map((g) => (
                <Badge
                  key={g.geographyCode}
                  variant="outline"
                  className="rounded-lg border-border bg-secondary/50 font-mono text-muted-foreground"
                >
                  {g.geographyCode}
                  <span className="ml-1 font-semibold text-foreground">{formatNumber(g.count, locale)}</span>
                </Badge>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">{t('strip.noData')}</div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">{t('strip.byRegion')}</p>
        </CardContent>
      </Card>
    </div>
  );
}

