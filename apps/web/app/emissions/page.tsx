'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/dashboard/sidebar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Download,
  Search,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Layers,
  BarChart3,
  History,
  PieChart,
  Target,
  LogOut,
  RefreshCw,
  Info,
  Lock,
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
  Legend,
  AreaChart,
  Area,
  Treemap,
} from 'recharts';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { useAuthStore } from '@/lib/store';
import { CATEGORIES } from '@/lib/types';
import type {
  ActivityRecordDTO,
  ActivityRecordStatus,
  DataViewMode,
  EmissionsSummary,
  IntensityResponseDTO,
  SubsidiaryDTO,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { TargetsPanel } from '@/components/emissions/targets-panel';
import { IntensityPanel } from '@/components/emissions/intensity-panel';

// Scope colours (aligned with the rest of the design system).
const SCOPE_COLORS = {
  scope1: '#34C759',
  scope2: '#007AFF',
  scope3: '#AF52DE',
};

const STATUS_COLORS: Record<ActivityRecordStatus, string> = {
  draft: 'bg-[#F5F5F7] text-[#6E6E73] font-semibold',
  submitted: 'bg-[#E8F0FE] text-[#0066CC] font-semibold',
  under_review: 'bg-[#FEF3C7] text-[#92400E] font-semibold',
  approved: 'bg-[#D1F2EB] text-[#1D7A5F] font-semibold',
  rejected: 'bg-[#FEE2E2] text-[#B91C1C] font-semibold',
  locked: 'bg-[#F3E8FF] text-[#7C3AED] font-semibold',
};

// Palette for category slices / contributor bars.
const CATEGORY_COLORS = [
  '#007AFF',
  '#34C759',
  '#AF52DE',
  '#FF9500',
  '#5AC8FA',
  '#FF2D55',
  '#FFCC00',
  '#5856D6',
  '#30B0C7',
  '#A2845E',
  '#8E8E93',
];

type ScopeFilter = 'all' | 'scope1' | 'scope2' | 'scope3';
type TrendPeriod = 'monthly' | 'quarterly' | 'yearly';

function formatNumber(value: number, decimals = 0): string {
  const fixed = value.toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${formatted}.${decPart}` : formatted;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Human-friendly message for an API failure, distinguishing auth/permission. */
function errMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'Your session has expired — please sign in again.';
    if (e.status === 403) return 'You do not have access to this data.';
    if (e.status >= 500) return 'The analytics service is unavailable right now.';
    return e.message;
  }
  return (e as Error).message ?? 'Something went wrong.';
}

function scopeColorFor(scope: number): string {
  return scope === 1 ? SCOPE_COLORS.scope1 : scope === 2 ? SCOPE_COLORS.scope2 : SCOPE_COLORS.scope3;
}

export default function EmissionsAnalysisPage() {
  const router = useRouter();
  const { user, setUser } = useAuthStore();

  const [activeTab, setActiveTab] = useState('summary');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<ActivityRecordDTO | null>(null);
  const [contributorBasis, setContributorBasis] = useState<'subsidiary' | 'category'>('subsidiary');
  const [trendPeriod, setTrendPeriod] = useState<TrendPeriod>('monthly');
  const [historyCategory, setHistoryCategory] = useState<string>('all');
  const [dataViewMode, setDataViewMode] = useState<DataViewMode>('absolute');
  const [intensity, setIntensity] = useState<IntensityResponseDTO | null>(null);

  // Live data
  const [summary, setSummary] = useState<EmissionsSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [records, setRecords] = useState<ActivityRecordDTO[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of subsidiaries) m.set(s.id, s.tradingName || s.legalName);
    return m;
  }, [subsidiaries]);

  const scopeNum = useMemo<1 | 2 | 3 | undefined>(() => {
    if (scopeFilter === 'all') return undefined;
    return Number(scopeFilter.replace('scope', '')) as 1 | 2 | 3;
  }, [scopeFilter]);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const s = await api.emissionsSummary({
        scope: scopeNum,
        category: categoryFilter === 'all' ? undefined : (categoryFilter as never),
      });
      setSummary(s);
      setSummaryError(null);
    } catch (e) {
      setSummaryError(errMessage(e));
      toast.error(errMessage(e));
    } finally {
      setSummaryLoading(false);
    }
  }, [scopeNum, categoryFilter]);

  // Identity + one-off datasets (subsidiaries for names, records for the ledger).
  useEffect(() => {
    api.me().then(setUser).catch((e) => toast.error(errMessage(e)));

    (async () => {
      try {
        const [subs, recs] = await Promise.all([
          api.listSubsidiaries(),
          api.listActivityRecords(),
        ]);
        setSubsidiaries(subs);
        setRecords(recs);
      } catch (e) {
        toast.error(errMessage(e));
      } finally {
        setRecordsLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Aggregated summary — refetched whenever the scope/category filter changes.
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const isSuperAdmin = user?.role === 'super_admin';
  // The most recent year with data drives the intensity denominators in view.
  const dataYear = useMemo(
    () => records.reduce((max, r) => Math.max(max, r.reportingYear), 2024),
    [records],
  );
  const intensityAvailable = (intensity?.metrics.length ?? 0) > 0;
  // super_admin can always open the panel (to configure the first denominator);
  // viewers only when configured metrics exist ("only valid configured metrics").
  const intensityEnabled = intensityAvailable || isSuperAdmin;

  // Intensity availability + values (drives the Absolute/Intensity toggle).
  useEffect(() => {
    api.intensity({ year: dataYear }).then(setIntensity).catch(() => {});
  }, [dataYear]);

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const totals = summary?.totals ?? { scope1: 0, scope2: 0, scope3: 0, total: 0 };
  const byCategory = summary?.byCategory ?? [];
  const bySubsidiary = summary?.bySubsidiary ?? [];

  // Donut: scope split when unfiltered, else the selected scope's categories.
  const pieData = useMemo(() => {
    if (scopeFilter === 'all') {
      return [
        { name: 'Scope 1', value: totals.scope1, color: SCOPE_COLORS.scope1 },
        { name: 'Scope 2', value: totals.scope2, color: SCOPE_COLORS.scope2 },
        { name: 'Scope 3', value: totals.scope3, color: SCOPE_COLORS.scope3 },
      ].filter((d) => d.value > 0);
    }
    return byCategory.map((c, i) => ({
      name: c.category,
      value: c.tCo2e,
      color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    }));
  }, [scopeFilter, totals, byCategory]);

  const chartTitle = useMemo(() => {
    switch (scopeFilter) {
      case 'scope1': return 'Scope 1 Category Distribution';
      case 'scope2': return 'Scope 2 Category Distribution';
      case 'scope3': return 'Scope 3 Category Distribution';
      default: return 'Emissions by Scope';
    }
  }, [scopeFilter]);

  const topContributors = useMemo(() => {
    const source =
      contributorBasis === 'subsidiary'
        ? bySubsidiary.map((s) => ({ name: s.subsidiaryName, value: s.tCo2e }))
        : byCategory.map((c) => ({ name: c.category, value: c.tCo2e }));
    return source.slice(0, 5);
  }, [contributorBasis, bySubsidiary, byCategory]);

  const treemapData = useMemo(
    () =>
      byCategory
        .filter((c) => c.tCo2e > 0)
        .map((c) => ({ name: c.category, size: c.tCo2e, scope: c.scope, color: scopeColorFor(c.scope) })),
    [byCategory],
  );

  const currentTrendData = useMemo(() => {
    if (!summary) return [];
    if (trendPeriod === 'quarterly') return summary.trend.quarterly;
    if (trendPeriod === 'yearly') return summary.trend.yearly;
    return summary.trend.monthly;
  }, [summary, trendPeriod]);

  // Change from the first to the last point of the selected trend series.
  const trendChange = useMemo(() => {
    if (currentTrendData.length < 2) return 0;
    const first = currentTrendData[0].total;
    const last = currentTrendData[currentTrendData.length - 1].total;
    if (first === 0) return 0;
    return ((last - first) / first) * 100;
  }, [currentTrendData]);

  // History ledger — client-side filtered by scope/category/search.
  const filteredRecords = useMemo(() => {
    return records.filter((record) => {
      if (scopeNum !== undefined && record.scope !== scopeNum) return false;
      if (categoryFilter !== 'all' && record.category !== categoryFilter) return false;
      if (historyCategory !== 'all' && record.category !== historyCategory) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const subName = (nameById.get(record.subsidiaryId) ?? '').toLowerCase();
        return (
          subName.includes(q) ||
          record.category.toLowerCase().includes(q) ||
          record.periodValue.toLowerCase().includes(q) ||
          (record.varianceReason?.toLowerCase().includes(q) ?? false)
        );
      }
      return true;
    });
  }, [records, scopeNum, categoryFilter, historyCategory, searchQuery, nameById]);

  const unitLabel = 'tCO₂e';

  // --- Loading / error gates for the analytics body -------------------------

  if (summaryError && !summary) {
    return (
      <div className="flex min-h-screen bg-background">
        <Sidebar />
        <main className="flex-1 ml-[280px]">
          <div className="flex h-screen flex-col items-center justify-center gap-4 p-6 text-center">
            <AlertTriangle className="h-10 w-10 text-[#B91C1C]" />
            <div>
              <h2 className="text-lg font-semibold text-foreground">Couldn&apos;t load analytics</h2>
              <p className="mt-1 text-sm text-muted-foreground">{summaryError}</p>
            </div>
            <Button onClick={() => void loadSummary()} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <main className="flex-1 ml-[280px] transition-all duration-300">
        <div className="p-6 space-y-6">
          {/* Page Header */}
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Emissions Analytics</h1>
              <p className="text-sm text-muted-foreground">
                Analyse emissions across scopes, categories and time periods
                {user ? ` · ${user.fullName} (${user.role})` : ''}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Scope Toggle */}
              <Select value={scopeFilter} onValueChange={(v) => setScopeFilter(v as ScopeFilter)}>
                <SelectTrigger className="w-[140px] bg-card border-border">
                  <SelectValue placeholder="All Scopes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Scopes</SelectItem>
                  <SelectItem value="scope1">Scope 1</SelectItem>
                  <SelectItem value="scope2">Scope 2</SelectItem>
                  <SelectItem value="scope3">Scope 3</SelectItem>
                </SelectContent>
              </Select>

              {/* Category Filter */}
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-[180px] bg-card border-border">
                  <SelectValue placeholder="All Categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Absolute / Intensity view toggle (WP5) */}
              <div className="flex items-center rounded-lg border border-border bg-card p-1">
                <button
                  onClick={() => setDataViewMode('absolute')}
                  className={cn(
                    'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                    dataViewMode === 'absolute'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  Absolute
                </button>
                {intensityEnabled ? (
                  <button
                    onClick={() => setDataViewMode('intensity')}
                    className={cn(
                      'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                      dataViewMode === 'intensity'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    Intensity
                  </button>
                ) : (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex cursor-not-allowed items-center gap-1 px-3 py-1.5 text-sm font-medium text-muted-foreground/60">
                          <Lock className="h-3 w-3" />
                          Intensity
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>Configure an intensity denominator to enable this</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>

              <Button
                variant="outline"
                onClick={() => router.push('/reports')}
                className="gap-2"
              >
                <Download className="h-4 w-4" />
                Export
              </Button>
              <Button variant="outline" onClick={handleLogout} className="gap-2">
                <LogOut className="h-4 w-4" />
                Sign out
              </Button>
            </div>
          </div>

          {/* Provenance banner — these are prototype demo factors, not authoritative. */}
          <div className="flex items-start gap-2 rounded-lg border border-[#FEF3C7] bg-[#FFFBEB] px-4 py-3 text-sm text-[#92400E]">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Figures are computed from committed activity records using{' '}
              <strong>prototype demo emission factors</strong> — not authoritative DEFRA/AIB values.
              Scope 3 is out of scope for Phase 1.
            </span>
          </div>

          {/* Absolute view = the tabbed analytics; Intensity view = the panel (WP5) */}
          {dataViewMode === 'intensity' ? (
            <IntensityPanel
              canManage={isSuperAdmin}
              subsidiaries={subsidiaries}
              nameById={nameById}
              year={dataYear}
            />
          ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
            <TabsList className="bg-card border border-border">
              <TabsTrigger value="summary" className="gap-2">
                <PieChart className="h-4 w-4" />
                Summary
              </TabsTrigger>
              <TabsTrigger value="breakdown" className="gap-2">
                <Layers className="h-4 w-4" />
                Breakdown
              </TabsTrigger>
              <TabsTrigger value="history" className="gap-2">
                <History className="h-4 w-4" />
                History
              </TabsTrigger>
              <TabsTrigger value="targets" className="gap-2">
                <Target className="h-4 w-4" />
                Targets
              </TabsTrigger>
              <TabsTrigger value="trends" className="gap-2">
                <BarChart3 className="h-4 w-4" />
                Trends
              </TabsTrigger>
            </TabsList>

            {/* Summary Tab */}
            <TabsContent value="summary" className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {([
                  { label: 'Total Scope 1', value: totals.scope1, hint: 'Direct emissions' },
                  { label: 'Total Scope 2', value: totals.scope2, hint: 'Purchased energy' },
                  { label: 'Total Scope 3', value: totals.scope3, hint: 'Value chain (Phase 2)' },
                ]).map((card) => (
                  <Card key={card.label} className="border-border bg-card">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">{card.label}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {summaryLoading ? (
                        <Skeleton className="h-8 w-24" />
                      ) : (
                        <div className="flex items-baseline gap-2">
                          <span className="text-2xl font-bold text-foreground">{formatNumber(card.value)}</span>
                          <span className="text-sm text-muted-foreground">{unitLabel}</span>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">{card.hint}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {summaryLoading ? (
                <Skeleton className="h-[360px] w-full" />
              ) : totals.total === 0 ? (
                <EmptyState message="No committed emissions for the selected filters. Approve activity records in Data Entry to populate analytics." />
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Donut */}
                  <Card className="border-border bg-card">
                    <CardHeader>
                      <CardTitle className="text-base">{chartTitle}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="h-[300px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <RechartsPieChart>
                            <Pie
                              data={pieData}
                              cx="50%"
                              cy="50%"
                              innerRadius={60}
                              outerRadius={100}
                              paddingAngle={2}
                              dataKey="value"
                              labelLine={false}
                            >
                              {pieData.map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={entry.color} />
                              ))}
                            </Pie>
                            <RechartsTooltip
                              content={({ active, payload }) => {
                                if (active && payload && payload.length) {
                                  const total = pieData.reduce((sum, d) => sum + d.value, 0);
                                  const percent = ((payload[0].value as number) / total * 100).toFixed(1);
                                  return (
                                    <div className="bg-popover border border-border rounded-lg p-3 shadow-lg">
                                      <p className="font-medium text-foreground">{payload[0].name}</p>
                                      <p className="text-sm text-muted-foreground">
                                        {formatNumber(payload[0].value as number)} tCO₂e
                                      </p>
                                      <p className="text-sm text-muted-foreground">{percent}% share</p>
                                    </div>
                                  );
                                }
                                return null;
                              }}
                            />
                          </RechartsPieChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="flex flex-wrap justify-center gap-4 mt-4">
                        {pieData.map((entry) => (
                          <div key={entry.name} className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
                            <span className="text-sm text-muted-foreground">{entry.name}</span>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>

                  {/* Top Contributors */}
                  <Card className="border-border bg-card">
                    <CardHeader className="flex flex-row items-center justify-between">
                      <div>
                        <CardTitle className="text-base">Top 5 Contributors</CardTitle>
                        <p className="text-xs text-muted-foreground mt-1">
                          By {contributorBasis === 'subsidiary' ? 'Company' : 'Category'}
                        </p>
                      </div>
                      <Select
                        value={contributorBasis}
                        onValueChange={(v) => setContributorBasis(v as 'subsidiary' | 'category')}
                      >
                        <SelectTrigger className="w-[140px] h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="subsidiary">By Company</SelectItem>
                          <SelectItem value="category">By Category</SelectItem>
                        </SelectContent>
                      </Select>
                    </CardHeader>
                    <CardContent>
                      <div className="h-[300px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={topContributors} layout="vertical" margin={{ left: 20, right: 20 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal vertical={false} />
                            <XAxis
                              type="number"
                              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                              tickFormatter={(value) => formatNumber(value)}
                            />
                            <YAxis
                              type="category"
                              dataKey="name"
                              tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fontWeight: 500 }}
                              width={140}
                            />
                            <RechartsTooltip
                              content={({ active, payload }) => {
                                if (active && payload && payload.length) {
                                  return (
                                    <div className="bg-popover border border-border rounded-lg p-3 shadow-lg">
                                      <p className="font-medium text-foreground">{payload[0].payload.name}</p>
                                      <p className="text-sm text-muted-foreground">
                                        {formatNumber(payload[0].value as number)} tCO₂e
                                      </p>
                                    </div>
                                  );
                                }
                                return null;
                              }}
                            />
                            <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                              {topContributors.map((_, index) => (
                                <Cell key={`cell-${index}`} fill={CATEGORY_COLORS[index % CATEGORY_COLORS.length]} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
            </TabsContent>

            {/* Breakdown Tab */}
            <TabsContent value="breakdown" className="space-y-6">
              {summaryLoading ? (
                <Skeleton className="h-[300px] w-full" />
              ) : byCategory.length === 0 ? (
                <EmptyState message="No category data for the selected filters." />
              ) : (
                <>
                  <Card className="border-border bg-card">
                    <CardHeader>
                      <CardTitle className="text-base">Category Scale Visualisation</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="h-[300px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <Treemap
                            data={treemapData}
                            dataKey="size"
                            nameKey="name"
                            stroke="hsl(var(--border))"
                            content={(({ x, y, width, height, name, color }: any) => (
                              <g>
                                <rect
                                  x={x}
                                  y={y}
                                  width={width}
                                  height={height}
                                  fill={color as string}
                                  stroke="hsl(var(--background))"
                                  strokeWidth={2}
                                  rx={4}
                                />
                                {width > 60 && height > 30 && (
                                  <text
                                    x={x + width / 2}
                                    y={y + height / 2}
                                    textAnchor="middle"
                                    dominantBaseline="middle"
                                    fill="white"
                                    fontSize={12}
                                    fontWeight={500}
                                  >
                                    {name}
                                  </text>
                                )}
                              </g>
                            )) as any}
                          />
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-border bg-card">
                    <CardHeader>
                      <CardTitle className="text-base">Category Performance</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Category</TableHead>
                            <TableHead>Scope</TableHead>
                            <TableHead className="text-right">Emissions</TableHead>
                            <TableHead className="text-right">% of Total</TableHead>
                            <TableHead className="text-right">Records</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {byCategory.map((category) => (
                            <TableRow
                              key={category.category}
                              className="cursor-pointer hover:bg-muted/50"
                              onClick={() => {
                                setHistoryCategory(category.category);
                                setActiveTab('history');
                              }}
                            >
                              <TableCell className="font-medium">{category.category}</TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    'text-xs',
                                    category.scope === 1 && 'border-[#8ED1C2]/60 text-[#2F6B45]',
                                    category.scope === 2 && 'border-[#8FB7E8]/60 text-[#24597A]',
                                    category.scope === 3 && 'border-[#C7B5E8]/60 text-[#6B5B95]',
                                  )}
                                >
                                  Scope {category.scope}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right font-medium">
                                {formatNumber(category.tCo2e)} tCO₂e
                              </TableCell>
                              <TableCell className="text-right">{category.percentOfTotal.toFixed(1)}%</TableCell>
                              <TableCell className="text-right text-muted-foreground">{category.recordCount}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <p className="text-xs text-muted-foreground mt-4">
                        Click a row to view its records in the History tab.
                      </p>
                    </CardContent>
                  </Card>
                </>
              )}
            </TabsContent>

            {/* History Tab */}
            <TabsContent value="history" className="space-y-6">
              <div className="flex items-center gap-4">
                <div className="relative flex-1 max-w-md">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by subsidiary, category, period, or note..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 bg-card border-border"
                  />
                </div>
                <Select value={historyCategory} onValueChange={setHistoryCategory}>
                  <SelectTrigger className="w-[180px] bg-card border-border">
                    <SelectValue placeholder="All Categories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Card className="border-border bg-card">
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Created</TableHead>
                        <TableHead>Subsidiary</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Period</TableHead>
                        <TableHead className="text-right">Activity</TableHead>
                        <TableHead>Unit</TableHead>
                        <TableHead className="text-right">tCO₂e</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recordsLoading ? (
                        [...Array(4)].map((_, i) => (
                          <TableRow key={i}>
                            <TableCell colSpan={8}>
                              <Skeleton className="h-6 w-full" />
                            </TableCell>
                          </TableRow>
                        ))
                      ) : filteredRecords.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                            No activity records found. Start by adding data in the Data Entry tab.
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredRecords.map((record) => (
                          <TableRow
                            key={record.id}
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => setSelectedRecord(record)}
                          >
                            <TableCell className="text-sm">{formatDate(record.createdAt)}</TableCell>
                            <TableCell className="font-medium">
                              {nameById.get(record.subsidiaryId) ?? record.subsidiaryId}
                            </TableCell>
                            <TableCell>{record.category}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {record.periodValue} {record.reportingYear}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {formatNumber(record.activityValue)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{record.activityUnit}</TableCell>
                            <TableCell className="text-right font-medium">
                              {formatNumber(record.calculation.tCo2e, 2)}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Badge className={cn('text-xs', STATUS_COLORS[record.status])}>
                                  {record.status.replace('_', ' ')}
                                </Badge>
                                {record.anomalyFlag && (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger>
                                        <AlertTriangle className="h-4 w-4 text-[#8A641C]" />
                                      </TooltipTrigger>
                                      <TooltipContent>Anomaly flagged</TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Targets Tab — live reduction targets + progress (WP5) */}
            <TabsContent value="targets" className="space-y-6">
              <TargetsPanel canManage={isSuperAdmin} subsidiaries={subsidiaries} nameById={nameById} />
            </TabsContent>

            {/* Trends Tab */}
            <TabsContent value="trends" className="space-y-6">
              <div className="flex items-center gap-4">
                <div className="flex items-center rounded-lg border border-border bg-card p-1">
                  {(['monthly', 'quarterly', 'yearly'] as const).map((period) => (
                    <button
                      key={period}
                      onClick={() => setTrendPeriod(period)}
                      className={cn(
                        'px-4 py-1.5 text-sm font-medium rounded-md transition-colors capitalize',
                        trendPeriod === period
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {period}
                    </button>
                  ))}
                </div>
              </div>

              {summaryLoading ? (
                <Skeleton className="h-[400px] w-full" />
              ) : currentTrendData.length === 0 ? (
                <EmptyState message={`No ${trendPeriod} data for the selected filters.`} />
              ) : (
                <>
                  <Card className="border-border bg-card">
                    <CardHeader>
                      <CardTitle className="text-base">Emissions Trend by Scope</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="h-[400px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={currentTrendData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                            <XAxis dataKey="period" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                            <YAxis
                              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                              tickFormatter={(value) => formatNumber(value)}
                            />
                            <RechartsTooltip
                              content={({ active, payload, label }) => {
                                if (active && payload && payload.length) {
                                  return (
                                    <div className="bg-popover border border-border rounded-lg p-3 shadow-lg">
                                      <p className="font-medium text-foreground mb-2">{label}</p>
                                      {payload.map((entry, index) => (
                                        <p key={index} className="text-sm" style={{ color: entry.color }}>
                                          {entry.name}: {formatNumber(entry.value as number)} tCO₂e
                                        </p>
                                      ))}
                                    </div>
                                  );
                                }
                                return null;
                              }}
                            />
                            <Legend />
                            <Area
                              type="monotone"
                              dataKey="scope2"
                              name="Scope 2"
                              stackId="1"
                              stroke={SCOPE_COLORS.scope2}
                              fill={SCOPE_COLORS.scope2}
                              fillOpacity={0.6}
                            />
                            <Area
                              type="monotone"
                              dataKey="scope1"
                              name="Scope 1"
                              stackId="1"
                              stroke={SCOPE_COLORS.scope1}
                              fill={SCOPE_COLORS.scope1}
                              fillOpacity={0.6}
                            />
                            <Area
                              type="monotone"
                              dataKey="scope3"
                              name="Scope 3"
                              stackId="1"
                              stroke={SCOPE_COLORS.scope3}
                              fill={SCOPE_COLORS.scope3}
                              fillOpacity={0.6}
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-border bg-card">
                    <CardContent className="py-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-muted-foreground">
                            Change across the {trendPeriod} series (first → last)
                          </p>
                          <div className="flex items-center gap-2 mt-1">
                            {trendChange < 0 ? (
                              <TrendingDown className="h-5 w-5 text-[#2F6B45]" />
                            ) : trendChange > 0 ? (
                              <TrendingUp className="h-5 w-5 text-[#8A3D3B]" />
                            ) : (
                              <Minus className="h-5 w-5 text-muted-foreground" />
                            )}
                            <span
                              className={cn(
                                'text-2xl font-bold',
                                trendChange < 0 && 'text-[#2F6B45]',
                                trendChange > 0 && 'text-[#8A3D3B]',
                                trendChange === 0 && 'text-muted-foreground',
                              )}
                            >
                              {trendChange > 0 ? '+' : ''}
                              {trendChange.toFixed(1)}%
                            </span>
                          </div>
                        </div>
                        <p className="max-w-xs text-right text-sm text-muted-foreground">
                          {trendChange < 0
                            ? 'Emissions decreased over the period'
                            : trendChange > 0
                              ? 'Emissions increased over the period'
                              : 'No change over the period'}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}
            </TabsContent>
          </Tabs>
          )}
        </div>
      </main>

      {/* Audit Detail Drawer */}
      <Sheet open={!!selectedRecord} onOpenChange={() => setSelectedRecord(null)}>
        <SheetContent className="w-[500px] sm:max-w-[500px] bg-card border-l border-border overflow-y-auto">
          {selectedRecord && (
            <>
              <SheetHeader>
                <SheetTitle>Record Detail</SheetTitle>
                <SheetDescription>
                  {selectedRecord.category} · {nameById.get(selectedRecord.subsidiaryId) ?? selectedRecord.subsidiaryId}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-6">
                <div className="flex items-center gap-3">
                  <Badge className={cn('text-sm', STATUS_COLORS[selectedRecord.status])}>
                    {selectedRecord.status.replace('_', ' ')}
                  </Badge>
                  {selectedRecord.anomalyFlag && (
                    <Badge className="bg-amber-500/20 text-amber-700 text-sm">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Anomaly Flagged
                    </Badge>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Activity Value</p>
                    <p className="font-medium">
                      {formatNumber(selectedRecord.activityValue)} {selectedRecord.activityUnit}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Calculated Emissions</p>
                    <p className="font-medium">{formatNumber(selectedRecord.calculation.tCo2e, 3)} tCO₂e</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Reporting Period</p>
                    <p className="font-medium">
                      {selectedRecord.periodValue} {selectedRecord.reportingYear} ({selectedRecord.reportingPeriod})
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Scope</p>
                    <p className="font-medium">Scope {selectedRecord.scope}</p>
                  </div>
                </div>

                <div className="border-t border-border pt-4">
                  <h4 className="text-sm font-medium mb-3">Methodology &amp; Factor</h4>
                  <div className="space-y-3 text-sm">
                    <Row label="Emission Factor" value={`${selectedRecord.calculation.factorValue} ${selectedRecord.calculation.factorUnit}`} />
                    <Row label="Methodology" value={selectedRecord.calculation.methodology} />
                    <Row label="Geography" value={selectedRecord.calculation.geographyCode} />
                    <Row label="Normalised" value={`${formatNumber(selectedRecord.calculation.normalizedValue)} ${selectedRecord.calculation.normalizedUnit}`} />
                    <Row label="Source" value={selectedRecord.calculation.source} />
                    <Row label="Factor Version" value={selectedRecord.calculation.version} />
                  </div>
                </div>

                <div className="border-t border-border pt-4">
                  <h4 className="text-sm font-medium mb-3">Audit Trail</h4>
                  <div className="space-y-3 text-sm">
                    <Row label="Created At" value={formatDate(selectedRecord.createdAt)} />
                    <Row label="Updated At" value={formatDate(selectedRecord.updatedAt)} />
                    <Row label="Record ID" value={selectedRecord.id} mono />
                  </div>
                </div>

                {selectedRecord.varianceReason && (
                  <div className="border-t border-border pt-4">
                    <h4 className="text-sm font-medium mb-2">Reason for Variance</h4>
                    <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">
                      {selectedRecord.varianceReason}
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={cn('text-right', mono && 'font-mono text-xs break-all')}>{value}</span>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <Card className="border-border bg-card">
      <CardContent className="py-16 text-center text-muted-foreground">{message}</CardContent>
    </Card>
  );
}
