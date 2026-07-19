'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { REPORT_TEMPLATES } from '@/lib/types';
import type {
  EmissionsSummary,
  ReportExportType,
  ReportMetaDTO,
  ReportStatus,
  ReportTemplate,
  SubsidiaryDTO,
} from '@/lib/types';

const YEARS = [2024, 2023] as const;

const SCOPE_COLORS = { scope1: '#34C759', scope2: '#007AFF', scope3: '#AF52DE' };

const STATUS_BADGE: Record<ReportStatus, { label: string; className: string }> = {
  approved: { label: 'Approved', className: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
  draft: { label: 'Draft — pending review', className: 'bg-blue-500/15 text-blue-600 border-blue-500/30' },
  contains_incomplete_data: { label: 'Contains incomplete data', className: 'bg-amber-500/15 text-amber-600 border-amber-500/30' },
};

const fmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

export default function ReportsPage() {
  const router = useRouter();
  const { user, setUser } = useAuthStore();

  // Config (FR §5.3 — filter-aware, year-scoped v1)
  const [template, setTemplate] = useState<ReportTemplate>('executive_summary');
  const [year, setYear] = useState<number>(2024);
  const [subsidiaryId, setSubsidiaryId] = useState(''); // '' = whole organisation
  const [includeMethodology, setIncludeMethodology] = useState(true);
  const [includeEvidence, setIncludeEvidence] = useState(false);

  // Live data
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [summary, setSummary] = useState<EmissionsSummary | null>(null);
  const [meta, setMeta] = useState<ReportMetaDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState<ReportExportType | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, m] = await Promise.all([
        api.emissionsSummary({ year, subsidiaryId: subsidiaryId || undefined }),
        api.reportMeta({ year, subsidiaryId: subsidiaryId || undefined }),
      ]);
      setSummary(s);
      setMeta(m);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [year, subsidiaryId]);

  useEffect(() => {
    api.me().then(setUser).catch((e) => toast.error((e as Error).message));
    api.listSubsidiaries().then(setSubsidiaries).catch((e) => toast.error((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleDownload(kind: ReportExportType) {
    setDownloading(kind);
    try {
      await api.downloadReport(kind, {
        template,
        year,
        subsidiaryId: subsidiaryId || undefined,
        includeMethodologyNotes: includeMethodology,
        includeEvidenceSummary: includeEvidence,
      });
      toast.success(`${kind.toUpperCase()} report generated`);
    } catch (e) {
      toast.error((e as Error).message);
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
  const totals = summary?.totals ?? { scope1: 0, scope2: 0, scope3: 0, total: 0 };
  const templateName = REPORT_TEMPLATES.find((t) => t.id === template)?.name ?? template;
  const subsidiaryName = subsidiaryId
    ? (subsidiaries.find((s) => s.id === subsidiaryId)?.tradingName ?? null)
    : null;
  const badge = meta ? STATUS_BADGE[meta.status] : null;

  const pieData = useMemo(
    () =>
      [
        { name: 'Scope 1', value: totals.scope1, color: SCOPE_COLORS.scope1 },
        { name: 'Scope 2', value: totals.scope2, color: SCOPE_COLORS.scope2 },
        { name: 'Scope 3', value: totals.scope3, color: SCOPE_COLORS.scope3 },
      ].filter((d) => d.value > 0),
    [totals],
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
              <h1 className="text-2xl font-semibold text-foreground">Reports</h1>
              <p className="mt-1 text-muted-foreground">
                Audit-ready reports generated from committed activity records
                {user ? ` · ${user.fullName} (${user.role})` : ''}
              </p>
            </div>
            <Button variant="outline" onClick={handleLogout} className="gap-2">
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>

          {/* Provenance banner */}
          <div className="flex items-start gap-2 rounded-lg border border-[#FEF3C7] bg-[#FFFBEB] px-4 py-3 text-sm text-[#92400E]">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Reports are computed from committed activity records using{' '}
              <strong>prototype demo emission factors</strong> — not authoritative DEFRA/AIB values.
              Scope 3 is out of scope for Phase 1.
            </span>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Left: config + preview */}
            <div className="space-y-6 lg:col-span-2">
              {/* Config bar (report_page.md §3) */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Report configuration</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label="Template">
                    <Select value={template} onValueChange={(v) => setTemplate(v as ReportTemplate)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {REPORT_TEMPLATES.map((t) => (
                          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Scope">
                    <Select
                      value={subsidiaryId || '__all__'}
                      onValueChange={(v) => setSubsidiaryId(v === '__all__' ? '' : v)}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">Whole organisation</SelectItem>
                        {subsidiaries.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.tradingName ?? s.legalName} ({s.geographyCode})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Reporting year">
                    <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {YEARS.map((y) => (
                          <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={includeMethodology}
                      onCheckedChange={(c) => setIncludeMethodology(c === true)}
                    />
                    Methodology notes
                  </label>
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <Checkbox
                      checked={includeEvidence}
                      onCheckedChange={(c) => setIncludeEvidence(c === true)}
                    />
                    Evidence summary (file names + counts)
                  </label>
                </CardContent>
              </Card>

              {/* Data warning (report_page.md §9) */}
              {meta && meta.incompleteRatio > 0.15 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {fmt.format(meta.incompleteRatio * 100)}% of this period&apos;s records are
                    draft/rejected — this report is not suitable for final reporting.
                  </span>
                </div>
              )}

              {/* Preview canvas (report_page.md §4-§6) */}
              {loading ? (
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
                          {templateName} · Reporting year {year}
                          {subsidiaryName ? ` · ${subsidiaryName}` : ''}
                        </p>
                      </div>
                      {badge && (
                        <Badge variant="outline" className={badge.className}>{badge.label}</Badge>
                      )}
                    </div>

                    {/* Metric tiles */}
                    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                      <Tile label="Scope 1" value={`${fmt.format(totals.scope1)} tCO₂e`} />
                      <Tile label="Scope 2" value={`${fmt.format(totals.scope2)} tCO₂e`} />
                      <Tile label="Total" value={`${fmt.format(totals.total)} tCO₂e`} />
                      <Tile label="Committed records" value={String(summary?.recordCount ?? 0)} />
                    </div>

                    {/* Charts */}
                    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                      <div>
                        <h3 className="mb-2 text-sm font-semibold text-foreground">Scope split</h3>
                        <div className="h-52">
                          <ResponsiveContainer width="100%" height="100%">
                            <RechartsPieChart>
                              <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75}>
                                {pieData.map((d) => (
                                  <Cell key={d.name} fill={d.color} />
                                ))}
                              </Pie>
                              <RechartsTooltip formatter={(v: number) => `${fmt.format(v)} tCO₂e`} />
                            </RechartsPieChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                      <div>
                        <h3 className="mb-2 text-sm font-semibold text-foreground">Top contributors</h3>
                        <div className="h-52">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={topContributors} layout="vertical" margin={{ left: 24 }}>
                              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                              <XAxis type="number" hide />
                              <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                              <RechartsTooltip formatter={(v: number) => `${fmt.format(v)} tCO₂e`} />
                              <Bar dataKey="tCo2e" fill="#059669" radius={[0, 4, 4, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>

                    {/* Category breakdown (report_page.md §6) */}
                    <div>
                      <h3 className="mb-2 text-sm font-semibold text-foreground">Emissions by category</h3>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <th className="py-2">Category</th>
                            <th className="py-2">Scope</th>
                            <th className="py-2 text-right">tCO₂e</th>
                            <th className="py-2 text-right">% of total</th>
                            <th className="py-2 text-right">Records</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(summary?.byCategory ?? []).map((c) => (
                            <tr key={`${c.category}-${c.scope}`} className="border-b border-border/60">
                              <td className="py-2 font-medium">{c.category}</td>
                              <td className="py-2">Scope {c.scope}</td>
                              <td className="py-2 text-right tabular-nums">{fmt.format(c.tCo2e)}</td>
                              <td className="py-2 text-right tabular-nums">{fmt.format(c.percentOfTotal)}%</td>
                              <td className="py-2 text-right tabular-nums">{c.recordCount}</td>
                            </tr>
                          ))}
                          {(summary?.byCategory ?? []).length === 0 && (
                            <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">No committed data for this selection.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    {includeMethodology && (
                      <p className="rounded-lg bg-secondary/50 p-3 text-xs text-muted-foreground">
                        <strong>Methodology:</strong> every calculation stores an immutable snapshot of
                        the emission factor it used (value, source, version) — the full factor appendix
                        is included in the generated PDF/Excel. Boundary: operational control. Aligned
                        with ISO 14064-1 / GHG Protocol.
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
                  <CardTitle className="text-base">Generate & download</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {!canGenerate && (
                    <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                      Your role can view report data but cannot generate or export reports.
                    </p>
                  )}
                  {canGenerate && (<>
                  <Button
                    className="w-full justify-start gap-2"
                    onClick={() => handleDownload('pdf')}
                    disabled={downloading !== null}
                  >
                    <FileText className="h-4 w-4" />
                    {downloading === 'pdf' ? 'Generating PDF…' : 'Download PDF'}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-2"
                    onClick={() => handleDownload('excel')}
                    disabled={downloading !== null}
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    {downloading === 'excel' ? 'Generating Excel…' : 'Export Excel'}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-2"
                    onClick={() => handleDownload('csv')}
                    disabled={downloading !== null}
                  >
                    <Table2 className="h-4 w-4" />
                    {downloading === 'csv' ? 'Generating CSV…' : 'Export CSV'}
                  </Button>
                  </>)}
                  <p className="text-xs text-muted-foreground">
                    Excel contains Summary, Raw Activity Data and Factors Used sheets. Every
                    generation is recorded in the audit log.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Download className="h-4 w-4 text-muted-foreground" />
                    Data completeness
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {meta ? (
                    <>
                      <Row label="Total records" value={String(meta.totalCount)} />
                      <Row label="Committed" value={String(meta.committedCount)} />
                      <Row label="Awaiting review" value={String(meta.pendingCount)} />
                      <Row label="Draft / rejected" value={String(meta.incompleteCount)} />
                    </>
                  ) : (
                    <Skeleton className="h-20 w-full" />
                  )}
                  <p className="pt-1 text-xs text-muted-foreground">
                    Report sharing (link / email) arrives in a later phase.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
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
