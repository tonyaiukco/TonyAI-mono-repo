'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/dashboard/sidebar';
import { SignOutButton } from '@/components/dashboard/sign-out-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { anomalyStatement } from '@/lib/anomaly-view';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { useAuthStore } from '@/lib/store';
import { useReportingContext } from '@/lib/use-reporting-context';
import { ReportingContextBar, ReportingContextInvalid } from '@/components/reporting-context/reporting-context-bar';
import { ACTIVITY_RECORD_SEARCH_MAX_LENGTH, CATEGORIES, LOCALE_FORMAT_TAGS, isCalculated, unitSymbol } from '@/lib/types';
import type { Locale } from '@/lib/types';
import { formatNumber, formatReadAmount } from '@/lib/i18n/number';
import { showErrorToast, useActorWords, useDescribeError, useEntityWords, useRecordWords } from '@/lib/i18n/hooks';
import { emissionsError, trendLabel } from '@/lib/emissions-view';
import {
  VOID_REASON_MAX_LENGTH,
  canOfferVoid,
  entityLabel,
  voidConsequence,
  voidReasonError,
  voidSuccessMessage,
} from '@/lib/void-view';
import { recordActorLabel } from '@/lib/record-actor';
import type {
  ActivityRecordDTO,
  ActivityRecordPageFilters,
  ActivityRecordStatus,
  DataViewMode,
  EmissionsSummary,
  ReportingIntensityData,
  SubsidiaryDTO,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { TargetsPanel } from '@/components/emissions/targets-panel';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { appendById, isStaleCursor } from '@/lib/cursor-pages';
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
  // Withdrawn from the inventory (the void path): shown in the neutral grey the
  // draft state uses, struck through, because it contributes to no total on
  // this page and must not read as a figure anyone is still counting.
  voided: 'bg-[#F5F5F7] text-[#6E6E73] font-semibold line-through',
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

/** A figure with exactly `decimals` places, grouped in the user's language. */
function fixed(value: number, locale: Locale, decimals = 0): string {
  return formatNumber(value, locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** A timestamp in the user's language, in the viewer's time zone. */
function formatDate(dateString: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_FORMAT_TAGS[locale], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(dateString));
}

function scopeColorFor(scope: number): string {
  return scope === 1 ? SCOPE_COLORS.scope1 : scope === 2 ? SCOPE_COLORS.scope2 : SCOPE_COLORS.scope3;
}

/** `useReportingContext` reads the URL (`useSearchParams`), which Next wants under a Suspense boundary. */
export default function EmissionsAnalysisPage() {
  return (
    <Suspense fallback={null}>
      <EmissionsAnalysisPageInner />
    </Suspense>
  );
}

function EmissionsAnalysisPageInner() {
  const tRoles = useTranslations('users');
  const tAnomaly = useTranslations('anomaly');
  const t = useTranslations('emissions');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const words = useRecordWords();
  const entityWords = useEntityWords();
  const actorWords = useActorWords();
  const describe = useDescribeError();
  const voidCopy = useMemo(() => ({ t, locale, words, entity: entityWords }), [t, locale, words, entityWords]);
  // A failure in the user's words, read when it is shown. The toast caller is
  // stable: the loads are effect dependencies, and a language switch must not
  // re-run them.
  const describeFailure = useCallback(
    (e: unknown) => emissionsError(e, { t, locale }, describe),
    [t, locale, describe],
  );
  const latestDescribe = useRef(describeFailure);
  useEffect(() => {
    latestDescribe.current = describeFailure;
  }, [describeFailure]);
  const showError = useCallback((e: unknown) => showErrorToast(latestDescribe.current(e)), []);
  const router = useRouter();
  const { user, setUser } = useAuthStore();
  const tContext = useTranslations('reportingContext');
  // LP3-02 N1: the one reporting selection, carried in the URL. Summary,
  // breakdown, the ledger and intensity use it; Trends is the explicit
  // all-year comparison; targets inherit only the subsidiary.
  const contextView = useReportingContext();
  const contextKey = contextView.status === 'ready' ? contextView.key : null;
  const context = useMemo(
    () => (contextView.status === 'ready' ? contextView.context : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contextKey],
  );
  const scopeFilter: ScopeFilter = context?.scope ? (`scope${context.scope}` as ScopeFilter) : 'all';
  const categoryFilter: string = context?.category ?? 'all';

  const [activeTab, setActiveTab] = useState('summary');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<ActivityRecordDTO | null>(null);
  const [contributorBasis, setContributorBasis] = useState<'subsidiary' | 'category'>('subsidiary');
  const [trendPeriod, setTrendPeriod] = useState<TrendPeriod>('monthly');
  const [historyCategory, setHistoryCategory] = useState<string>('all');
  const [dataViewMode, setDataViewMode] = useState<DataViewMode>('absolute');
  const [intensity, setIntensity] = useState<ReportingIntensityData | null>(null);

  // Live data
  const [summary, setSummary] = useState<EmissionsSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  // The failure itself, worded at render so a language switch re-words it.
  const [summaryError, setSummaryError] = useState<{ cause: unknown } | null>(null);
  // Trends: every year for the selected subsidiaries (the comparison view).
  const [trendSummary, setTrendSummary] = useState<EmissionsSummary | null>(null);
  const [trendLoading, setTrendLoading] = useState(true);

  // The ledger's loaded pages (LP4-05 PR C): filtered by the server, newest
  // first; its size is the filtered set's, from GET /activity-records/metadata.
  const [records, setRecords] = useState<ActivityRecordDTO[]>([]);
  const [recordsCursor, setRecordsCursor] = useState<string | null>(null);
  const [recordsTotal, setRecordsTotal] = useState<number | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [recordsLoadingMore, setRecordsLoadingMore] = useState(false);
  // Bumped to read the first page again (a stale cursor's 400).
  const [recordsReload, setRecordsReload] = useState(0);
  // The search box's text, sent once typing pauses rather than per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [subsidiariesLoaded, setSubsidiariesLoaded] = useState(false);

  // Withdrawal (void). Kept next to the drawer it belongs to rather than in a
  // child component, because the write has to land in three places at once —
  // the ledger row, the open drawer and the server-side totals — and splitting
  // that across a boundary is how one of them gets forgotten.
  const [voidReason, setVoidReason] = useState('');
  const [voidConfirmOpen, setVoidConfirmOpen] = useState(false);
  const [voidBusy, setVoidBusy] = useState(false);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of subsidiaries) m.set(s.id, s.tradingName || s.legalName);
    return m;
  }, [subsidiaries]);

  const scopeNum = context?.scope;
  const selectedYear = context?.year;
  const selectedSubsidiaryId = context?.subsidiaryId;

  // Sequence tokens: a slower answer for an earlier selection must not land
  // over a newer one (README "Reporting context contract").
  const summarySeq = useRef(0);
  const trendSeq = useRef(0);
  const recordsSeq = useRef(0);

  const loadSummary = useCallback(async () => {
    if (!context) return;
    const mine = ++summarySeq.current;
    setSummaryLoading(true);
    try {
      const { data } = await api.reportingSummary(context);
      if (mine !== summarySeq.current) return;
      setSummary(data);
      setSummaryError(null);
    } catch (e) {
      if (mine !== summarySeq.current) return;
      // Never the previous selection's figures under the new bar (`qa-auditor` P2-1).
      setSummary(null);
      setSummaryError({ cause: e });
      showError(e);
    } finally {
      if (mine === summarySeq.current) setSummaryLoading(false);
    }
  }, [context, showError]);

  // An explicit history view (EmissionsSummaryParams): no year, on purpose.
  const hasContext = context !== null;
  const loadTrends = useCallback(async () => {
    if (!hasContext) return;
    const mine = ++trendSeq.current;
    setTrendLoading(true);
    try {
      const s = await api.emissionsSummary({ subsidiaryId: selectedSubsidiaryId });
      if (mine !== trendSeq.current) return;
      setTrendSummary(s);
    } catch (e) {
      if (mine !== trendSeq.current) return;
      setTrendSummary(null);
      showError(e);
    } finally {
      if (mine === trendSeq.current) setTrendLoading(false);
    }
  }, [hasContext, selectedSubsidiaryId, showError]);

  /**
   * The ledger's filters: the bar's year, subsidiary, scope and category, the
   * tab's own category and the search — all applied by the server, so a page
   * is a page of the filtered set. null when the two category filters name
   * different categories: nothing can match both, and no request is made.
   */
  const recordFilters = useMemo((): ActivityRecordPageFilters | null => {
    if (selectedYear === undefined) return null;
    const categories = [...new Set([categoryFilter, historyCategory].filter((c) => c !== 'all'))];
    if (categories.length > 1) return null;
    return {
      year: selectedYear,
      ...(selectedSubsidiaryId ? { subsidiaryId: selectedSubsidiaryId } : {}),
      ...(scopeNum !== undefined ? { scope: scopeNum as 1 | 2 | 3 } : {}),
      ...(categories[0] ? { category: categories[0] as ActivityRecordPageFilters['category'] } : {}),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
    };
  }, [selectedYear, selectedSubsidiaryId, scopeNum, categoryFilter, historyCategory, debouncedSearch]);

  // Identity + subsidiaries (names, the selection's labels).
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

  // The ledger's first page and its size — again whenever a filter changes,
  // which starts the cursor chain over.
  useEffect(() => {
    if (selectedYear === undefined) return;
    const mine = ++recordsSeq.current;
    if (recordFilters === null) {
      setRecords([]);
      setRecordsCursor(null);
      setRecordsTotal(0);
      setRecordsLoading(false);
      return;
    }
    setRecordsLoading(true);
    Promise.all([
      api.listActivityRecordPage(recordFilters),
      // Any refusal of the count (422 query_too_broad, a quota, an outage) shows
      // it as unknown; the list itself still loads (K7).
      api.activityRecordMetadata(recordFilters).catch(() => null),
    ])
      .then(([page, meta]) => {
        if (mine !== recordsSeq.current) return;
        setRecords(page.items);
        setRecordsCursor(page.nextCursor);
        setRecordsTotal(meta?.total ?? null);
      })
      .catch((e) => {
        if (mine !== recordsSeq.current) return;
        setRecords([]);
        setRecordsCursor(null);
        setRecordsTotal(null);
        showError(e);
      })
      .finally(() => {
        if (mine === recordsSeq.current) setRecordsLoading(false);
      });
  }, [recordFilters, selectedYear, recordsReload, showError]);

  async function loadMoreRecords() {
    if (!recordFilters || !recordsCursor) return;
    const mine = recordsSeq.current;
    setRecordsLoadingMore(true);
    try {
      const page = await api.listActivityRecordPage({ ...recordFilters, cursor: recordsCursor });
      if (mine !== recordsSeq.current) return;
      setRecords((prev) => appendById(prev, page.items));
      setRecordsCursor(page.nextCursor);
    } catch (e) {
      if (mine !== recordsSeq.current) return;
      showError(e);
      if (isStaleCursor(e)) setRecordsReload((n) => n + 1);
    } finally {
      setRecordsLoadingMore(false);
    }
  }

  // Aggregates — again whenever the selection changes.
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);
  useEffect(() => {
    void loadTrends();
  }, [loadTrends]);

  // What a mutation's follow-up refresh reads when it completes: the current
  // selection's loaders, never the ones captured when it started — those would
  // be the newest requests and land an obsolete selection under the bar.
  const latestLoaders = useRef({ loadSummary, loadTrends });
  const contextKeyRef = useRef(contextKey);
  useEffect(() => {
    latestLoaders.current = { loadSummary, loadTrends };
    contextKeyRef.current = contextKey;
  }, [loadSummary, loadTrends, contextKey]);

  const isSuperAdmin = user?.role === 'super_admin';
  const intensityAvailable = (intensity?.metrics.length ?? 0) > 0;
  // super_admin can always open the panel (to configure the first denominator);
  // viewers only when configured metrics exist ("only valid configured metrics").
  const intensityEnabled = intensityAvailable || isSuperAdmin;

  // Intensity availability + values (drives the Absolute/Intensity toggle).
  // The selected context's intensity — not "the latest year with data".
  useEffect(() => {
    if (!context) return;
    let current = true;
    api
      .reportingIntensity(context)
      .then((result) => {
        if (current) setIntensity(result.data);
      })
      .catch(() => {
        if (current) setIntensity(null);
      });
    return () => {
      current = false;
    };
  }, [context]);

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.push('/login');
    router.refresh();
  }

  /** Close the drawer without carrying a half-typed reason to the next record. */
  function closeRecordDrawer() {
    setSelectedRecord(null);
    setVoidReason('');
  }

  /**
   * Withdraw an approved figure from the inventory (WP18).
   *
   * The one irreversible write in the app. Everything after the request is
   * about not leaving the user with a screen that disagrees with the server:
   * the ledger row, the open drawer and the aggregate tiles are three separate
   * copies of the same fact, and the withdrawal changes all three.
   */
  async function handleVoid(record: ActivityRecordDTO) {
    // The selection the withdrawal started in; the user may change it before
    // the request settles (Codex B9 P2-2).
    const startKey = contextKeyRef.current;
    const reason = voidReason.trim();
    // The button that opens the confirmation is disabled while this holds, so
    // arriving here means the text changed under the dialog. Fail closed rather
    // than send a request the DTO will refuse.
    if (voidReasonError(reason, voidCopy)) return;

    setVoidBusy(true);
    try {
      const updated = await api.voidActivityRecord(record.id, { voidReason: reason });
      setRecords((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      // The drawer stays open on the now-voided record rather than closing:
      // the strikethrough, the status badge and the stored reason are the only
      // confirmation that the text was recorded as typed.
      setSelectedRecord(updated);
      setVoidReason('');
      toast.success(voidSuccessMessage(updated, voidCopy));
      // Every KPI, chart and category total here comes from the server summary,
      // not from `records`. Patching the row alone would leave the tiles
      // reporting an inventory that still contains the figure just withdrawn.
      await Promise.all([latestLoaders.current.loadSummary(), latestLoaders.current.loadTrends()]);
    } catch (e) {
      // Re-read BEFORE saying anything, and on ANY failure rather than only on
      // the statuses that mean "your page is stale" (someone else voided it:
      // 400, or 409 if the race lands mid-request; 409 = the period was locked
      // between opening the drawer and clicking). A dropped connection or a
      // timeout throws a TypeError rather than an ApiError, and that is exactly
      // the case where the server may already have COMMITTED the withdrawal —
      // so the server, not the exception, decides what the user is told.
      // Reporting failure first left someone reading "unavailable" beside a row
      // that had in fact just been withdrawn.
      let settled = false;
      try {
        // The record itself decides what is said (one read, not the ledger):
        // its fresh copy replaces the row only while that ledger is still the
        // one on screen; a record that is gone (404) leaves it.
        const current = await api.getActivityRecord(record.id).catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) return null;
          throw err;
        });
        if (contextKeyRef.current === startKey) {
          setRecords((prev) =>
            current ? prev.map((r) => (r.id === current.id ? current : r)) : prev.filter((r) => r.id !== record.id),
          );
        }
        setSelectedRecord(current);
        if (current?.status === 'voided') {
          toast.success(voidSuccessMessage(current, voidCopy));
          setVoidReason('');
          settled = true;
          await Promise.all([latestLoaders.current.loadSummary(), latestLoaders.current.loadTrends()]);
        } else if (!current) {
          // The record is gone from under the drawer. Clear the reason with it,
          // or text typed for this record pre-fills the box for whichever one
          // is opened next — the leak `closeRecordDrawer` exists to prevent, on
          // the one action that cannot be undone.
          setVoidReason('');
        }
      } catch {
        // The re-read failed too. Fall through to the error below: one message
        // about the withdrawal beats two about the network.
      }
      if (!settled) showError(e);
    } finally {
      // Closed either way. A failure here is not something a retry fixes — the
      // period is locked, or the record has already gone — and a dialog left
      // open over the toast hides the sentence that says which.
      setVoidConfirmOpen(false);
      setVoidBusy(false);
    }
  }

  // What the confirmation will say, if it is opened. Computed here rather than
  // inside the dialog so the warning is a value the drawer holds, not markup
  // assembled at the moment of the click.
  const voidWarning = selectedRecord
    ? voidConsequence(
        selectedRecord,
        nameById.get(selectedRecord.subsidiaryId) ?? selectedRecord.subsidiaryId,
        voidCopy,
      )
    : null;
  const voidBlockedBy = voidReasonError(voidReason, voidCopy);
  // Resolved once here rather than twice in the branch below, matching how
  // the sibling actor rows are built. Safe to compute unconditionally: the
  // helper's own first branch turns a null id into the muted em dash, and
  // the block that reads it only renders on a voided record anyway.
  const voidActor = recordActorLabel(
    selectedRecord?.voidedBy ?? null,
    selectedRecord?.voidedByName ?? null,
    actorWords,
  );

  const totals = summary?.totals ?? { scope1: 0, scope2: 0, scope3: 0, total: 0 };
  const byCategory = summary?.byCategory ?? [];
  const bySubsidiary = summary?.bySubsidiary ?? [];

  // Donut: scope split when unfiltered, else the selected scope's categories.
  const pieData = useMemo(() => {
    if (scopeFilter === 'all') {
      return [
        { name: t('scopeName', { scope: 1 }), value: totals.scope1, color: SCOPE_COLORS.scope1 },
        { name: t('scopeName', { scope: 2 }), value: totals.scope2, color: SCOPE_COLORS.scope2 },
        { name: t('scopeName', { scope: 3 }), value: totals.scope3, color: SCOPE_COLORS.scope3 },
      ].filter((d) => d.value > 0);
    }
    return byCategory.map((c, i) => ({
      name: words.category(c.category),
      value: c.tCo2e,
      color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    }));
  }, [scopeFilter, totals, byCategory, t, words]);

  const chartTitle =
    scopeFilter === 'all' ? t('summary.byScope') : t('summary.scopeDistribution', { scope: scopeFilter.slice(-1) });

  const topContributors = useMemo(() => {
    const source =
      contributorBasis === 'subsidiary'
        ? bySubsidiary.map((s) => ({ name: s.subsidiaryName, value: s.tCo2e }))
        : byCategory.map((c) => ({ name: words.category(c.category), value: c.tCo2e }));
    return source.slice(0, 5);
  }, [contributorBasis, bySubsidiary, byCategory, words]);

  const treemapData = useMemo(
    () =>
      byCategory
        .filter((c) => c.tCo2e > 0)
        .map((c) => ({ name: words.category(c.category), size: c.tCo2e, scope: c.scope, color: scopeColorFor(c.scope) })),
    [byCategory, words],
  );

  const currentTrendData = useMemo(() => {
    if (!trendSummary) return [];
    if (trendPeriod === 'quarterly') return trendSummary.trend.quarterly;
    if (trendPeriod === 'yearly') return trendSummary.trend.yearly;
    return trendSummary.trend.monthly;
  }, [trendSummary, trendPeriod]);

  // Change from the first to the last point of the selected trend series.
  const trendChange = useMemo(() => {
    if (currentTrendData.length < 2) return 0;
    const first = currentTrendData[0].total;
    const last = currentTrendData[currentTrendData.length - 1].total;
    if (first === 0) return 0;
    return ((last - first) / first) * 100;
  }, [currentTrendData]);

  const unitLabel = tCommon('tco2e');
  const tonnes = (value: number, decimals = 0) => t('tonnes', { value: fixed(value, locale, decimals) });
  const percent = (value: number) => t('percent', { value: fixed(value, locale, 1) });
  const periodYear = (periodValue: string, year: number) => t('periodYear', { period: words.period(periodValue), year: String(year) });
  const periodLabel = (period: string) => trendLabel(period, { t, locale }, words);
  const summaryFailure = summaryError ? describeFailure(summaryError.cause) : null;

  // --- Loading / error gates for the analytics body -------------------------

  // Shown in place of the analytics, under the selection bar, so another
  // selection stays one click away when this one cannot load.
  const analyticsError = summaryFailure && !summary ? (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-border bg-card p-12 text-center">
      <AlertTriangle className="h-10 w-10 text-[#B91C1C]" />
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('errors.loadTitle')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{summaryFailure.title}</p>
        {summaryFailure.description ? (
          <p className="mt-1 text-xs text-muted-foreground">{summaryFailure.description}</p>
        ) : null}
      </div>
      <Button onClick={() => void loadSummary()} className="gap-2">
        <RefreshCw className="h-4 w-4" />
        {t('errors.retry')}
      </Button>
    </div>
  ) : null;

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <main className="flex-1 ml-[280px] transition-all duration-300">
        <div className="p-6 space-y-6">
          {/* Page Header */}
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
              <p className="text-sm text-muted-foreground">
                {t('subtitle')}
                {user ? ` · ${user.fullName} (${tRoles(`roles.${user.role}`)})` : ''}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
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
                  {t('view.absolute')}
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
                    {t('view.intensity')}
                  </button>
                ) : (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex cursor-not-allowed items-center gap-1 px-3 py-1.5 text-sm font-medium text-muted-foreground/60">
                          <Lock className="h-3 w-3" />
                          {t('view.intensity')}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{t('view.intensityLocked')}</TooltipContent>
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
                {t('export')}
              </Button>
              <SignOutButton onClick={handleLogout} />
            </div>
          </div>

          {/* Provenance banner — these are prototype demo factors, not authoritative. */}
          <div className="flex items-start gap-2 rounded-lg border border-[#FEF3C7] bg-[#FFFBEB] px-4 py-3 text-sm text-[#92400E]">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t.rich('banner', { strong: (chunks) => <strong>{chunks}</strong> })}</span>
          </div>

          {/* The one reporting selection (LP3-02 N1): year, subsidiary, scope, category. */}
          {contextView.status === 'ready' && (
            <ReportingContextBar
              context={contextView.context}
              subsidiaries={subsidiariesLoaded ? subsidiaries : null}
              onSelect={contextView.select}
            />
          )}

          {/* Absolute view = the tabbed analytics; Intensity view = the panel (WP5) */}
          {contextView.status === 'invalid' ? (
            <ReportingContextInvalid invalid={contextView.invalid} onReset={contextView.reset} />
          ) : !context ? null : analyticsError ? (
            analyticsError
          ) : dataViewMode === 'intensity' ? (
            <IntensityPanel
              canManage={isSuperAdmin}
              subsidiaries={subsidiaries}
              nameById={nameById}
              context={context}
            />
          ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
            <TabsList className="bg-card border border-border">
              <TabsTrigger value="summary" className="gap-2">
                <PieChart className="h-4 w-4" />
                {t('tabs.summary')}
              </TabsTrigger>
              <TabsTrigger value="breakdown" className="gap-2">
                <Layers className="h-4 w-4" />
                {t('tabs.breakdown')}
              </TabsTrigger>
              <TabsTrigger value="history" className="gap-2">
                <History className="h-4 w-4" />
                {t('tabs.history')}
              </TabsTrigger>
              <TabsTrigger value="targets" className="gap-2">
                <Target className="h-4 w-4" />
                {t('tabs.targets')}
              </TabsTrigger>
              <TabsTrigger value="trends" className="gap-2">
                <BarChart3 className="h-4 w-4" />
                {t('tabs.trends')}
              </TabsTrigger>
            </TabsList>

            {/* Summary Tab */}
            <TabsContent value="summary" className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {([
                  { key: 1, label: t('summary.total1'), value: totals.scope1, hint: t('summary.hint1') },
                  { key: 2, label: t('summary.total2'), value: totals.scope2, hint: t('summary.hint2') },
                  { key: 3, label: t('summary.total3'), value: totals.scope3, hint: t('summary.hint3') },
                ]).map((card) => (
                  <Card key={card.key} className="border-border bg-card">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">{card.label}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {summaryLoading ? (
                        <Skeleton className="h-8 w-24" />
                      ) : (
                        <div className="flex items-baseline gap-2">
                          <span className="text-2xl font-bold text-foreground" data-testid={`summary-scope${card.key}`}>{fixed(card.value, locale)}</span>
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
                <EmptyState message={t('summary.empty')} />
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
                                  const share = fixed((payload[0].value as number) / total * 100, locale, 1);
                                  return (
                                    <div className="bg-popover border border-border rounded-lg p-3 shadow-lg">
                                      <p className="font-medium text-foreground">{payload[0].name}</p>
                                      <p className="text-sm text-muted-foreground">
                                        {tonnes(payload[0].value as number)}
                                      </p>
                                      <p className="text-sm text-muted-foreground">{t('summary.share', { value: share })}</p>
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
                        <CardTitle className="text-base">{t('summary.contributors')}</CardTitle>
                        <p className="text-xs text-muted-foreground mt-1">
                          {contributorBasis === 'subsidiary' ? t('summary.byCompany') : t('summary.byCategory')}
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
                          <SelectItem value="subsidiary">{t('summary.byCompany')}</SelectItem>
                          <SelectItem value="category">{t('summary.byCategory')}</SelectItem>
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
                              tickFormatter={(value) => fixed(value, locale)}
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
                                        {tonnes(payload[0].value as number)}
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
                <EmptyState message={t('breakdown.empty')} />
              ) : (
                <>
                  <Card className="border-border bg-card">
                    <CardHeader>
                      <CardTitle className="text-base">{t('breakdown.scale')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="h-[300px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <Treemap
                            data={treemapData}
                            dataKey="size"
                            nameKey="name"
                            stroke="hsl(var(--border))"
                            // Recharts types its `content` render prop as a union its own
                            // shape callbacks do not satisfy; typing this properly means
                            // reaching into recharts internals.
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            )) as any}
                          />
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-border bg-card">
                    <CardHeader>
                      <CardTitle className="text-base">{t('breakdown.performance')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('breakdown.columns.category')}</TableHead>
                            <TableHead>{t('breakdown.columns.scope')}</TableHead>
                            <TableHead className="text-right">{t('breakdown.columns.emissions')}</TableHead>
                            <TableHead className="text-right">{t('breakdown.columns.share')}</TableHead>
                            <TableHead className="text-right">{t('breakdown.columns.records')}</TableHead>
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
                              <TableCell className="font-medium">{words.category(category.category)}</TableCell>
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
                                  {t('scopeName', { scope: category.scope })}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right font-medium">
                                {tonnes(category.tCo2e)}
                              </TableCell>
                              <TableCell className="text-right">{percent(category.percentOfTotal)}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{fixed(category.recordCount, locale)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <p className="text-xs text-muted-foreground mt-4">
                        {t('breakdown.rowHint')}
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
                    placeholder={t('history.search')}
                    maxLength={ACTIVITY_RECORD_SEARCH_MAX_LENGTH}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 bg-card border-border"
                  />
                </div>
                <Select value={historyCategory} onValueChange={setHistoryCategory}>
                  <SelectTrigger className="w-[180px] bg-card border-border">
                    <SelectValue placeholder={t('history.allCategories')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('history.allCategories')}</SelectItem>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {words.category(cat)}
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
                        <TableHead>{t('history.columns.created')}</TableHead>
                        <TableHead>{t('history.columns.subsidiary')}</TableHead>
                        <TableHead>{t('history.columns.category')}</TableHead>
                        <TableHead>{t('history.columns.period')}</TableHead>
                        <TableHead className="text-right">{t('history.columns.activity')}</TableHead>
                        <TableHead>{t('history.columns.unit')}</TableHead>
                        <TableHead className="text-right">{unitLabel}</TableHead>
                        <TableHead>{t('history.columns.status')}</TableHead>
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
                      ) : records.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                            {t('history.empty')}
                          </TableCell>
                        </TableRow>
                      ) : (
                        records.map((record) => (
                          <TableRow
                            key={record.id}
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => setSelectedRecord(record)}
                          >
                            <TableCell className="text-sm">{formatDate(record.createdAt, locale)}</TableCell>
                            <TableCell className="font-medium">
                              {nameById.get(record.subsidiaryId) ?? record.subsidiaryId}
                            </TableCell>
                            <TableCell>{words.category(record.category)}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {periodYear(record.periodValue, record.reportingYear)}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {fixed(record.activityValue, locale)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{unitSymbol(record.activityUnit)}</TableCell>
                            {/* A WITHDRAWN figure is struck through and muted
                                here too, not only on its status badge. The
                                badge carried the strikethrough while the tonnes
                                sat in the same weight as every live row, so a
                                number that counts towards nothing read exactly
                                like one that counts. */}
                            <TableCell
                              className={cn(
                                'text-right font-medium',
                                record.status === 'voided' &&
                                  'font-normal text-muted-foreground line-through',
                              )}
                            >
                              {isCalculated(record.calculation) ? (
                                fixed(record.calculation.tCo2e, locale, 2)
                              ) : (
                                <span className="text-xs font-normal text-muted-foreground">
                                  {tCommon('notCalculated')}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Badge className={cn('text-xs', STATUS_COLORS[record.status])}>
                                  {words.status(record.status)}
                                </Badge>
                                {record.anomalyFlag && (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger>
                                        <AlertTriangle className="h-4 w-4 text-[#8A641C]" />
                                      </TooltipTrigger>
                                      <TooltipContent>{t('history.anomaly')}</TooltipContent>
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
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground" data-testid="history-shown">
                  {recordsLoading
                    ? ''
                    : recordsTotal === null
                      ? t('history.shown', { shown: fixed(records.length, locale) })
                      : t('history.shownOf', { shown: fixed(records.length, locale), total: fixed(recordsTotal, locale) })}
                </span>
                <LoadMoreButton
                  hasMore={recordsCursor !== null && !recordsLoading}
                  loading={recordsLoadingMore}
                  onClick={() => void loadMoreRecords()}
                  label={t('history.loadMore')}
                  testId="history-load-more"
                />
              </div>
            </TabsContent>

            {/* Targets Tab — live reduction targets + progress (WP5) */}
            <TabsContent value="targets" className="space-y-6">
              <p className="text-sm text-muted-foreground" data-testid="targets-subsidiary-only">
                {tContext('targetsHint')}
              </p>
              <TargetsPanel
                canManage={isSuperAdmin}
                subsidiaries={subsidiaries}
                nameById={nameById}
                subsidiaryId={context.subsidiaryId}
              />
            </TabsContent>

            {/* Trends Tab */}
            <TabsContent value="trends" className="space-y-6">
              {/* The explicit comparison: every year, never the selected one alone. */}
              <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="trends-all-years">
                <Badge variant="outline">{tContext('allYears')}</Badge>
                <span>{tContext('allYearsHint')}</span>
              </div>
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
                      {t(`trend.period.${period}`)}
                    </button>
                  ))}
                </div>
              </div>

              {trendLoading ? (
                <Skeleton className="h-[400px] w-full" />
              ) : currentTrendData.length === 0 ? (
                <EmptyState message={t('trend.empty', { period: t(`trend.period.${trendPeriod}`) })} />
              ) : (
                <>
                  <Card className="border-border bg-card">
                    <CardHeader>
                      <CardTitle className="text-base">{t('trend.title')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="h-[400px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={currentTrendData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                            <XAxis
                              dataKey="period"
                              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                              tickFormatter={(value) => periodLabel(String(value))}
                            />
                            <YAxis
                              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                              tickFormatter={(value) => fixed(value, locale)}
                            />
                            <RechartsTooltip
                              content={({ active, payload, label }) => {
                                if (active && payload && payload.length) {
                                  return (
                                    <div className="bg-popover border border-border rounded-lg p-3 shadow-lg">
                                      <p className="font-medium text-foreground mb-2">{periodLabel(String(label))}</p>
                                      {payload.map((entry, index) => (
                                        <p key={index} className="text-sm" style={{ color: entry.color }}>
                                          {entry.name}: {tonnes(entry.value as number)}
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
                              name={t('scopeName', { scope: 2 })}
                              stackId="1"
                              stroke={SCOPE_COLORS.scope2}
                              fill={SCOPE_COLORS.scope2}
                              fillOpacity={0.6}
                            />
                            <Area
                              type="monotone"
                              dataKey="scope1"
                              name={t('scopeName', { scope: 1 })}
                              stackId="1"
                              stroke={SCOPE_COLORS.scope1}
                              fill={SCOPE_COLORS.scope1}
                              fillOpacity={0.6}
                            />
                            <Area
                              type="monotone"
                              dataKey="scope3"
                              name={t('scopeName', { scope: 3 })}
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
                            {t('trend.change', { period: t(`trend.period.${trendPeriod}`) })}
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
                              {/* The sign follows the unrounded change, as the arrow
                                  does, and sits outside the percent sign (`+%12,3`
                                  in Turkish, `+12.3%` in English). */}
                              {trendChange > 0 ? '+' : trendChange < 0 ? '-' : ''}
                              {percent(Math.abs(trendChange))}
                            </span>
                          </div>
                        </div>
                        <p className="max-w-xs text-right text-sm text-muted-foreground">
                          {trendChange < 0
                            ? t('trend.decreased')
                            : trendChange > 0
                              ? t('trend.increased')
                              : t('trend.unchanged')}
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
      <Sheet open={!!selectedRecord} onOpenChange={closeRecordDrawer}>
        <SheetContent className="w-[500px] sm:max-w-[500px] bg-card border-l border-border overflow-y-auto">
          {selectedRecord && (
            <>
              <SheetHeader>
                <SheetTitle>{t('drawer.title')}</SheetTitle>
                <SheetDescription>
                  {words.category(selectedRecord.category)} · {nameById.get(selectedRecord.subsidiaryId) ?? selectedRecord.subsidiaryId}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-6">
                <div className="flex items-center gap-3">
                  <Badge className={cn('text-sm', STATUS_COLORS[selectedRecord.status])}>
                    {words.status(selectedRecord.status)}
                  </Badge>
                  {selectedRecord.anomalyFlag && (
                    <Badge className="bg-amber-500/20 text-amber-700 text-sm">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      {t('drawer.anomaly')}
                    </Badge>
                  )}
                </div>

                {/* The verdict in words, including the case where there is no
                    verdict: a drawer that shows a badge or nothing lets "never
                    checked" render exactly like "checked and clean". */}
                <p className="text-xs text-muted-foreground">
                  {anomalyStatement(selectedRecord, tAnomaly, locale).detail}
                </p>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">{t('drawer.activityValue')}</p>
                    <p className="font-medium">
                      {fixed(selectedRecord.activityValue, locale)} {unitSymbol(selectedRecord.activityUnit)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t('drawer.calculated')}</p>
                    {isCalculated(selectedRecord.calculation) ? (
                      <p className="font-medium">{tonnes(selectedRecord.calculation.tCo2e, 3)}</p>
                    ) : (
                      <p className="font-medium text-muted-foreground">{tCommon('notCalculated')}</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t('drawer.reportingPeriod')}</p>
                    <p className="font-medium">
                      {t('drawer.periodWithGranularity', {
                        period: words.period(selectedRecord.periodValue),
                        year: String(selectedRecord.reportingYear),
                        granularity: t(`granularity.${selectedRecord.reportingPeriod}`),
                      })}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t('drawer.scope')}</p>
                    <p className="font-medium">{t('scopeName', { scope: selectedRecord.scope })}</p>
                  </div>
                  {/* The reporting entity, which the ledger has no column for.
                      A whole-company row and its site twin differ ONLY in this
                      field and in the activity value, and this drawer is where
                      a super_admin decides which of the two to withdraw — so
                      without it the choice is made by comparing two numbers and
                      hoping. `locationName` is resolved by the API at read time
                      rather than joined here. */}
                  <div>
                    <p className="text-xs text-muted-foreground">{t('drawer.entity')}</p>
                    <p className="font-medium">{entityLabel(selectedRecord, entityWords)}</p>
                  </div>
                </div>

                <div className="border-t border-border pt-4">
                  <h4 className="text-sm font-medium mb-3">{t('drawer.methodology')}</h4>
                  {isCalculated(selectedRecord.calculation) ? (
                    <div className="space-y-3 text-sm">
                      <Row label={t('drawer.factor')} value={`${formatReadAmount(selectedRecord.calculation.factorValue, locale)} ${selectedRecord.calculation.factorUnit}`} />
                      <Row label={t('drawer.methodologyRow')} value={selectedRecord.calculation.methodology} />
                      <Row label={t('drawer.geography')} value={selectedRecord.calculation.geographyCode} />
                      <Row label={t('drawer.normalised')} value={`${fixed(selectedRecord.calculation.normalizedValue, locale)} ${unitSymbol(selectedRecord.calculation.normalizedUnit)}`} />
                      <Row label={t('drawer.source')} value={selectedRecord.calculation.source} />
                      <Row label={t('drawer.version')} value={selectedRecord.calculation.version} />
                    </div>
                  ) : (
                    // The reason is read from the stored snapshot, not composed
                    // here: what the user sees is what the API recorded at write
                    // time, so the explanation cannot drift from the data.
                    <div className="space-y-3 text-sm">
                      <Row label={t('drawer.factor')} value={tCommon('noFactor')} />
                      <Row label={t('drawer.geography')} value={selectedRecord.calculation.geographyCode} />
                      <Row
                        label={t('drawer.recordedAs')}
                        value={t('drawer.notConverted', {
                          value: fixed(selectedRecord.calculation.inputValue, locale),
                          unit: unitSymbol(selectedRecord.calculation.inputUnit),
                        })}
                      />
                      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground">
                        {selectedRecord.calculation.reason}
                      </p>
                    </div>
                  )}
                </div>

                <div className="border-t border-border pt-4">
                  <h4 className="text-sm font-medium mb-3">{t('drawer.auditTrail')}</h4>
                  <div className="space-y-3 text-sm">
                    {/* A block headed "Audit Trail" that named three timestamps
                        and no person answered "when" and never "who" — the one
                        question a trail exists for. Recoverable before this only
                        by cross-referencing /audit by record id. */}
                    {(
                      [
                        ['enteredBy', selectedRecord.createdBy, selectedRecord.createdByName],
                        ['reviewedBy', selectedRecord.reviewedBy, selectedRecord.reviewedByName],
                      ] as const
                    ).map(([key, id, name]) => {
                      const actor = recordActorLabel(id, name, actorWords);
                      return (
                        <Row key={key} label={t(`drawer.${key}`)} value={actor.text} muted={actor.muted} />
                      );
                    })}
                    <Row label={t('drawer.createdAt')} value={formatDate(selectedRecord.createdAt, locale)} />
                    <Row label={t('drawer.updatedAt')} value={formatDate(selectedRecord.updatedAt, locale)} />
                    <Row label={t('drawer.recordId')} value={selectedRecord.id} mono />
                  </div>
                </div>

                {selectedRecord.varianceReason && (
                  <div className="border-t border-border pt-4">
                    <h4 className="text-sm font-medium mb-2">{t('drawer.varianceReason')}</h4>
                    <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">
                      {selectedRecord.varianceReason}
                    </p>
                  </div>
                )}

                {/* FR §6.5: the rejection reason must reach the person who has to
                    act on it. Rejecting writes `reviewNote`, and until this was
                    rendered the submitter saw only that their record came back,
                    with no way to learn why. Kept separate from the variance
                    reason above — one is the submitter's own explanation, this
                    is the reviewer's answer to it. */}
                {/* A withdrawal, in the reader's terms. Without this a voided
                    record opens showing its original figure and nothing about
                    why it left the inventory — the audit trail has the reason,
                    but `/audit` is super_admin-only, so for every other seat
                    the record itself is the only place it could appear. */}
                {selectedRecord.status === "voided" && (
                  <div className="border-t border-border pt-4">
                    <h4 className="text-sm font-medium mb-2">
                      {t('void.why')}
                    </h4>
                    <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">
                      {selectedRecord.voidReason?.trim() || t('void.noReason')}
                    </p>
                    {/* WHO and WHEN, beside the why. The DTO has promised all
                        three since the withdrawal shipped ("why an approved
                        figure was withdrawn, by whom, and when") while this
                        block rendered only the reason — the person was
                        reachable solely through /audit, which is
                        super_admin-only, so for every other seat a restatement
                        named nobody. FR §5.4 ties a withdrawal to
                        ISO 14064-1 §9.3.1 traceability, and a restatement with
                        no attributable actor does not meet it. */}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {(() => {
                        const actor = (chunks: React.ReactNode) => (
                          <span className={voidActor.muted ? 'italic' : 'font-medium text-foreground'}>{chunks}</span>
                        );
                        return selectedRecord.voidedAt
                          ? t.rich('void.withdrawnByOn', {
                              actor,
                              name: voidActor.text,
                              date: formatDate(selectedRecord.voidedAt, locale),
                            })
                          : t.rich('void.withdrawnBy', { actor, name: voidActor.text });
                      })()}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('void.staysOnTrail')}
                    </p>
                  </div>
                )}

                {selectedRecord.status === "rejected" &&
                  selectedRecord.reviewNote?.trim() && (
                  <div className="border-t border-border pt-4">
                    <h4 className="text-sm font-medium mb-2">
                      {t('drawer.sentBack')}
                    </h4>
                    <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">
                      {selectedRecord.reviewNote}
                    </p>
                  </div>
                )}

                {/* The withdrawal control lives last, after everything the user
                    needs in order to be sure they are looking at the right
                    record. This drawer is the only surface in the app that
                    shows an approved record on its own: the review queue lists
                    pending work only, and Data Entry loads a record into the
                    form, which an approved record cannot enter. */}
                {canOfferVoid(selectedRecord, isSuperAdmin) && (
                  <div className="border-t border-border pt-4">
                    <h4 className="text-sm font-medium mb-2">
                      {t('void.title')}
                    </h4>
                    <p className="text-xs text-muted-foreground mb-3">
                      {t('void.explain')}
                    </p>
                    <label
                      htmlFor="void-reason"
                      className="text-xs text-muted-foreground"
                    >
                      {t('void.reasonLabel')}
                    </label>
                    <Textarea
                      id="void-reason"
                      value={voidReason}
                      onChange={(e) => setVoidReason(e.target.value)}
                      placeholder={t('void.reasonPlaceholder')}
                      rows={3}
                      maxLength={VOID_REASON_MAX_LENGTH}
                      // Tied to the message below, so a user who tabs back to
                      // the field hears WHY the button is dead instead of just
                      // the label. Without the association the live region
                      // announces once, on change, and is then unreachable.
                      aria-describedby="void-reason-error"
                      aria-invalid={voidReason.length > 0 && voidBlockedBy !== null}
                      className="mt-1"
                    />
                    {/* Rendered unconditionally so it is a live region from
                        first paint. Mounting it only when there is a problem
                        would put the message into the accessibility tree at the
                        same instant as the node, which screen readers do not
                        announce. */}
                    <p
                      id="void-reason-error"
                      role="status"
                      className="mt-1 min-h-4 text-xs text-amber-700"
                    >
                      {voidReason.length > 0 && voidBlockedBy ? voidBlockedBy : ''}
                    </p>
                    <Button
                      variant="destructive"
                      className="mt-2"
                      disabled={voidBusy || voidBlockedBy !== null}
                      onClick={() => setVoidConfirmOpen(true)}
                    >
                      {t('void.open')}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Void is the only write in the app with no way back — the API has no
          route out of `voided` and `audit_log` is append-only — so unlike
          approve and reject it gets a confirmation, and one that names the
          tonnage rather than asking a generic "are you sure?". */}
      <AlertDialog
        open={voidConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !voidBusy) setVoidConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          {selectedRecord && voidWarning && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('void.confirmTitle')}
                </AlertDialogTitle>
                {/* Everything the reader needs goes INSIDE the description,
                    because Radix wires `aria-describedby` to this node alone.
                    With the consequences as a sibling, a screen reader
                    announced the title and the tonnage and stopped — "It cannot
                    be undone." was never spoken, on the one action in the
                    product where that is the sentence that matters. `asChild`
                    because a <ul> inside the default <p> is invalid markup. */}
                <AlertDialogDescription asChild>
                  <div className="space-y-3">
                    <p className="font-medium text-foreground">
                      {voidWarning.subject}
                    </p>
                    <p>{voidWarning.headline}</p>
                    <ul className="list-disc space-y-1 pl-5">
                      {voidWarning.effects.map((effect) => (
                        <li key={effect}>{effect}</li>
                      ))}
                    </ul>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={voidBusy}>{tCommon('cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={voidBusy}
                  // Radix closes on click by default. The dialog has to survive
                  // the request instead, so a failure can close it deliberately
                  // and let the toast explaining why be the last thing on screen.
                  onClick={(e) => {
                    e.preventDefault();
                    void handleVoid(selectedRecord);
                  }}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {voidBusy ? t('void.withdrawing') : t('void.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
  muted = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  /** The value is a description ("deleted user", an em dash), not a datum. */
  muted?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span
        className={cn(
          'text-right',
          mono && 'font-mono text-xs break-all',
          muted && 'italic text-muted-foreground',
        )}
      >
        {value}
      </span>
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
