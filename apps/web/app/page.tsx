'use client';

import { useCallback, useState, useMemo, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/dashboard/sidebar';
import { KPICards } from '@/components/dashboard/kpi-cards';
import { TrackingMatrix } from '@/components/dashboard/tracking-matrix';
import { AlertsPanel } from '@/components/dashboard/alerts-panel';
import { EmissionsCharts } from '@/components/dashboard/emissions-charts';
import { SubsidiaryDetail } from '@/components/dashboard/subsidiary-detail';
import { Button } from '@/components/ui/button';
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
  LogOut,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { useAuthStore } from '@/lib/store';
import {
  buildKpiData,
  matrixToAlerts,
  matrixToSubsidiaries,
} from '@/lib/dashboard-view';
import { DEFAULT_REPORTING_YEAR, mayAuthorRecords } from '@/lib/types';
import type {
  DashboardKpi,
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

export default function CarbonDashboard() {
  const router = useRouter();
  const { user, setUser } = useAuthStore();

  // Live data (API: /me, /kpi, /subsidiaries, /emissions/summary, /emissions/tracking-matrix)
  const [kpi, setKpi] = useState<DashboardKpi | null>(null);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [summary, setSummary] = useState<EmissionsSummary | null>(null);
  const [matrix, setMatrix] = useState<TrackingMatrixDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Drill-down detail sheet (view model mapped from the live tracking matrix)
  // The matrix ROW, not the mock view model: the drawer needs `coverage`,
  // `trackingGranularity` and `locationCount`, all of which
  // `matrixToSubsidiaries` drops.
  const [selectedRow, setSelectedRow] = useState<TrackingMatrixRow | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
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
      const [kpiData, list, summaryData, matrixData] = await Promise.all([
        api.kpi(),
        api.listSubsidiaries(),
        // Same year as the matrix below. These two feed ONE set of KPI cards
        // (`buildKpiData`), so an unscoped total sitting beside a 2024-only
        // completeness bar would put two different time ranges in one row with
        // neither of them labelled.
        api.emissionsSummary({ year: DEFAULT_REPORTING_YEAR }),
        // A year, not "everything": without one the endpoint folds every year
        // into a single cell, so a subsidiary complete for 2023 and empty for
        // 2024 read as complete. A completeness view that spans years states
        // nothing about either.
        api.trackingMatrix({ year: DEFAULT_REPORTING_YEAR }),
      ]);
      // A response from a superseded request must not overwrite a newer one.
      if (mine !== loadSeq.current) return;
      setKpi(kpiData);
      setSubsidiaries(list);
      setSummary(summaryData);
      setMatrix(matrixData);
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
      if (!silent) {
        toast.error((e as Error).message);
      } else {
        // Swallowing one transient failure is right; swallowing them forever is
        // not. After a few, say the numbers are not live any more.
        setRefreshFailures((n) => n + 1);
      }
    } finally {
      inFlight.current = false;
      if (!silent) setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch((e) => toast.error((e as Error).message));
    void loadDashboard();
  }, [loadDashboard, setUser]);

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
  const emissionsKpiData = useMemo(
    () =>
      summary && matrix
        ? buildKpiData(summary, matrix, kpi?.totalLocations ?? null)
        : null,
    [summary, matrix, kpi],
  );
  const liveAlerts = useMemo(() => (matrix ? matrixToAlerts(matrix) : []), [matrix]);

  const handleMatrixSubsidiaryClick = (row: TrackingMatrixRow) => {
    setSelectedRow(row);
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
      year: String(DEFAULT_REPORTING_YEAR),
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
      year: String(matrix?.reportingYear ?? DEFAULT_REPORTING_YEAR),
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
              <h1 className="text-xl font-bold text-[#1D1D1F]">Carbon Dashboard</h1>
              {user && (
                <span className="hidden text-sm font-medium text-[#6E6E73] md:inline">
                  {user.fullName} · {user.role}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6E6E73]" />
                <Input
                  placeholder="Search subsidiaries..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-9 w-56 rounded-lg border-[#D8D8DC] bg-[#EBEBF0] pl-9 text-sm font-medium text-[#1D1D1F] placeholder:text-[#8E8E93] focus:ring-[#1B5E3B]/40"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleLogout}
                className="h-9 gap-2 rounded-lg border-[#D8D8DC] bg-[#EBEBF0] font-semibold text-[#1D1D1F] hover:bg-[#E0E0E5]"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </Button>
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
                Subsidiary Register
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
                  Not refreshing — reload to retry
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="gap-1.5 rounded-lg border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
                >
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  Live data
                </Badge>
              )}
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
              ) : subsidiaries.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  No subsidiaries accessible to your account.
                </p>
              ) : filteredSubsidiaries.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  No subsidiaries match “{searchQuery}”.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="border-border bg-secondary hover:bg-transparent">
                      <TableHead className="pl-6">Legal name</TableHead>
                      <TableHead>Trading name</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Geography</TableHead>
                      <TableHead>Sector</TableHead>
                      <TableHead className="pr-6 text-right">Status</TableHead>
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
                            {s.reportingStatus}
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
              <h2 className="text-lg font-bold text-[#1D1D1F]">Emissions Overview</h2>
              {/* The badge is a claim. Once background refreshes keep failing
                  it stops being true, and a green "Live data" beside stale
                  figures is worse than no badge at all. */}
              {refreshFailures >= 3 ? (
                <Badge
                  variant="outline"
                  className="gap-1.5 rounded-lg border-amber-500/30 bg-amber-500/10 text-amber-700"
                >
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  Not refreshing — reload to retry
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="gap-1.5 rounded-lg border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
                >
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  Live data
                </Badge>
              )}
            </div>
            <p className="-mt-2 text-sm text-muted-foreground">
              Committed Scope 1 &amp; 2 activity records. Year-over-year trends
              arrive once prior-year data exists.
            </p>

            {loading ? (
              <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
            ) : !emissionsKpiData || !matrix ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Emissions data could not be loaded.
              </p>
            ) : (
              <div className="space-y-6">
                <KPICards
                  data={emissionsKpiData}
                  reportingYear={matrix?.reportingYear ?? null}
                  byLocationCount={
                    matrix?.rows.filter(
                      (r) => r.trackingGranularity === 'location',
                    ).length ?? 0
                  }
                />

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
                    <EmissionsCharts subsidiaries={matrixSubsidiaries} />
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
  const cards = [
    {
      title: 'Total Subsidiaries',
      value: kpi?.totalSubsidiaries ?? 0,
      icon: <Building2 className="h-4 w-4 text-primary" />,
      hint: 'Accessible to you',
    },
    {
      title: 'Active',
      value: kpi?.activeSubsidiaries ?? 0,
      icon: <CheckCircle2 className="h-4 w-4 text-primary" />,
      hint: 'Reporting active',
    },
    {
      title: 'Pending',
      value: kpi?.pendingSubsidiaries ?? 0,
      icon: <Clock className="h-4 w-4 text-primary" />,
      hint: 'Awaiting onboarding',
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.title} className="rounded-[18px] border-border bg-white shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {c.title}
            </CardTitle>
            {c.icon}
          </CardHeader>
          <CardContent>
            <div className="font-mono text-3xl font-bold tabular-nums text-foreground">
              {loading ? '—' : c.value}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{c.hint}</p>
          </CardContent>
        </Card>
      ))}

      {/* Geography breakdown */}
      <Card className="rounded-[18px] border-border bg-white shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Geographies
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
                  <span className="ml-1 font-semibold text-foreground">{g.count}</span>
                </Badge>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No data</div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Subsidiaries by region</p>
        </CardContent>
      </Card>
    </div>
  );
}

