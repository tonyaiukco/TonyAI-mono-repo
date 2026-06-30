'use client';

import { useState, useMemo, useEffect } from 'react';
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
  FlaskConical,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { useAuthStore } from '@/lib/store';
import { subsidiaries as demoSubsidiaries, calculateKPIs, alerts } from '@/lib/data';
import type { Subsidiary, DashboardKpi, SubsidiaryDTO } from '@/lib/types';

const statusClass: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  pending: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  inactive: 'bg-red-500/15 text-red-600 border-red-500/30',
};

export default function CarbonDashboard() {
  const router = useRouter();
  const { user, setUser } = useAuthStore();

  // Live data (API: /me, /kpi, /subsidiaries)
  const [kpi, setKpi] = useState<DashboardKpi | null>(null);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Demo-only detail sheet (mock view model, no backend yet)
  const [selectedSubsidiary, setSelectedSubsidiary] = useState<Subsidiary | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch((e) => toast.error((e as Error).message));

    setLoading(true);
    Promise.all([api.kpi(), api.listSubsidiaries()])
      .then(([kpiData, list]) => {
        setKpi(kpiData);
        setSubsidiaries(list);
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredSubsidiaries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return subsidiaries;
    return subsidiaries.filter((s) =>
      [s.legalName, s.tradingName, s.location, s.sector, s.geographyCode]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q)),
    );
  }, [subsidiaries, searchQuery]);

  // Demo KPIs/charts keep using the mock dataset (no emissions backend yet).
  const demoKpiData = useMemo(() => calculateKPIs(demoSubsidiaries), []);

  const handleDemoSubsidiaryClick = (subsidiary: Subsidiary) => {
    setSelectedSubsidiary(subsidiary);
    setDetailOpen(true);
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
              <Badge
                variant="outline"
                className="gap-1.5 rounded-lg border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
              >
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Live data
              </Badge>
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

          {/* DEMO: emissions / scopes — no backend yet */}
          <DemoSection
            title="Emissions Overview"
            note="Scope 1–3 emissions, category tracking and alerts are not wired to the API yet (no emissions endpoint). Showing illustrative sample data."
          >
            <div className="space-y-6">
              <KPICards data={demoKpiData} />

              <TrackingMatrix
                subsidiaries={demoSubsidiaries}
                onSubsidiaryClick={handleDemoSubsidiaryClick}
              />

              <div className="grid gap-6 lg:grid-cols-3">
                <div className="lg:col-span-1">
                  <AlertsPanel alerts={alerts} />
                </div>
                <div className="lg:col-span-2">
                  <EmissionsCharts subsidiaries={demoSubsidiaries} />
                </div>
              </div>
            </div>
          </DemoSection>
        </div>
      </main>

      {/* Demo detail sheet (mock view model) */}
      <SubsidiaryDetail
        subsidiary={selectedSubsidiary}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
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

function DemoSection({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-[#1D1D1F]">{title}</h2>
        <Badge
          variant="outline"
          className="gap-1.5 rounded-lg border-amber-500/40 bg-amber-500/10 text-amber-700"
        >
          <FlaskConical className="h-3.5 w-3.5" />
          Demo data
        </Badge>
      </div>
      <p className="-mt-2 text-sm text-muted-foreground">{note}</p>
      {children}
    </section>
  );
}
