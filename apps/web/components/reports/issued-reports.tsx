'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { toast } from 'sonner';
import { AlertTriangle, Archive, CheckCircle2, FileSpreadsheet, FileText, Search, Stamp, Table2 } from 'lucide-react';
import { api, type IssuedFileFormat } from '@/lib/api';
import { useErrorToast } from '@/lib/i18n/hooks';
import { formatNumber } from '@/lib/i18n/number';
import { issuanceGapCounts } from '@/lib/report-coverage-view';
import { LOCALE_FORMAT_TAGS, REPORT_TEMPLATES, SUPPORTED_LOCALES } from '@/lib/types';
import type {
  InventoryBoundaryVersionSummary,
  Locale,
  ReportDatasetSummary,
  ReportIssuanceList,
  ReportIssuancePreview,
  ReportTemplate,
  UserRole,
} from '@/lib/types';
import { BoundaryLink } from '@/components/inventory-boundary/boundary-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The issued side of Reports (LP4-03 PR B; K5, K7, K8): the year's captured
 * datasets and issued reports, a capture of the newest boundary version, the
 * gate's preview on request, the issue itself, and each issued report's PDF,
 * workbook and CSV — retained or written from the retained dataset, never
 * regenerated from live data.
 *
 * Every write and every dataset-sized read here takes the EXPORT quota (five a
 * minute), so nothing is fetched per row: a preview runs when its button is
 * pressed, and one action runs at a time.
 */

const ISSUERS: ReadonlySet<UserRole> = new Set(['super_admin', 'consultant']);
const READERS: ReadonlySet<UserRole> = new Set(['super_admin', 'consultant', 'executive_viewer']);

interface Loaded {
  datasets: ReportDatasetSummary[];
  datasetsTruncated: boolean;
  issuances: ReportIssuanceList;
  newest: InventoryBoundaryVersionSummary | null;
}

export function IssuedReports({ year, role, language }: { year: number; role: UserRole | null; language: Locale }) {
  const t = useTranslations('reports.issued');
  const tReports = useTranslations('reports');
  const tContext = useTranslations('reportingContext');
  const locale = useLocale() as Locale;
  const showError = useErrorToast();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, ReportIssuancePreview>>({});
  const [issuing, setIssuing] = useState<{ dataset: ReportDatasetSummary; preview: ReportIssuancePreview } | null>(null);
  const seq = useRef(0);

  const canRead = role !== null && READERS.has(role);
  const canIssue = role !== null && ISSUERS.has(role);
  const date = useMemo(
    () => new Intl.DateTimeFormat(LOCALE_FORMAT_TAGS[locale], { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setFailed(false);
    setLoaded(null);
    setPreviews({});
    if (!canRead) return;
    try {
      // One after another: the dataset list and the issuance list are reads,
      // the boundary list too — none takes the export quota.
      const datasets = await api.listReportDatasets(year);
      const issuances = await api.listReportIssuances(year);
      const versions = await api.listInventoryBoundaries(year);
      if (mine !== seq.current) return;
      const newest = versions.reduce<InventoryBoundaryVersionSummary | null>((a, v) => (a === null || v.version > a.version ? v : a), null);
      setLoaded({ datasets: datasets.items, datasetsTruncated: datasets.truncated, issuances, newest });
    } catch (e) {
      if (mine !== seq.current) return;
      setFailed(true);
      showError(e);
    }
  }, [year, canRead, showError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (role === null) return <Skeleton className="h-64 w-full" />;
  if (!canRead) {
    return <p className="rounded-lg bg-muted/60 px-4 py-3 text-sm text-muted-foreground" data-testid="issued-not-for-role">{t('notForRole')}</p>;
  }

  async function capture(boundaryId: string) {
    setBusy('capture');
    try {
      await api.captureReportDataset({ boundaryId });
      toast.success(t('captured'));
      await load();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }

  async function check(datasetId: string): Promise<ReportIssuancePreview | null> {
    setBusy(`check:${datasetId}`);
    try {
      const preview = await api.previewIssuance(datasetId);
      setPreviews((p) => ({ ...p, [datasetId]: preview }));
      return preview;
    } catch (e) {
      showError(e);
      return null;
    } finally {
      setBusy(null);
    }
  }

  // Issuing is irreversible, so the dialog always shows what it will issue:
  // the dataset is checked first unless it just was (`architect` P2 on PR B).
  async function openIssue(d: ReportDatasetSummary) {
    const preview = previews[d.datasetId] ?? (await check(d.datasetId));
    if (preview) setIssuing({ dataset: d, preview });
  }

  async function download(issuanceId: string, format: IssuedFileFormat) {
    setBusy(`download:${issuanceId}:${format}`);
    try {
      await api.downloadIssuance(issuanceId, format);
      toast.success(t('downloaded'));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }

  const newest = loaded?.newest ?? null;
  // A consultant captures a frozen version only (V1): super_admin freezes an open one by capturing it.
  const consultantBlocked = role === 'consultant' && newest !== null && newest.frozenAt === null;

  return (
    <div className="space-y-6" data-testid="issued-reports">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('heading', { year })}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p>
        {!canIssue && <p className="mt-2 text-xs text-muted-foreground">{t('readOnly')}</p>}
      </div>

      {failed ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-8 text-center text-sm">
          <AlertTriangle className="h-6 w-6 text-[#B91C1C]" />
          <p className="text-muted-foreground">{t('loadFailed')}</p>
          <Button variant="outline" onClick={() => void load()}>{tContext('retry')}</Button>
        </div>
      ) : loaded === null ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          {/* Issued reports */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Stamp className="h-4 w-4" />{t('issuancesHeading')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {loaded.issuances.items.length === 0 && <p className="text-muted-foreground">{t('noIssuances', { year })}</p>}
              {loaded.issuances.items.map((i) => {
                const current = i.issuanceId === loaded.issuances.currentFinalIssuanceId;
                return (
                  <div key={i.issuanceId} className="rounded-lg border border-border p-3" data-testid="issuance-row" data-status={i.status}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={i.status === 'final'
                        ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
                        : 'bg-amber-500/15 text-amber-700 border-amber-500/30'}
                      >
                        {i.status === 'final' ? t('statusFinal') : t('statusPartial')}
                      </Badge>
                      {current && (
                        <Badge variant="outline" className="gap-1 border-emerald-600 text-emerald-700" title={t('currentNote')}>
                          <CheckCircle2 className="h-3 w-3" />{t('current')}
                        </Badge>
                      )}
                      <span className="font-medium">
                        {t('issuanceLine', { template: templateName(i.template, tReports), language: t(`languages.${i.language}` as never) })}
                      </span>
                      {i.status === 'partial' && <span className="text-muted-foreground">{t('gapCount', { count: formatNumber(i.gapCount, locale) })}</span>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{t('issuedAt', { date: date.format(new Date(i.issuedAt)) })}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {([
                        ['pdf', FileText, t('downloadPdf')],
                        ['xlsx', FileSpreadsheet, t('downloadXlsx')],
                        ['csv', Table2, t('downloadCsv')],
                      ] as const).map(([format, Icon, label]) => (
                        <Button key={format} size="sm" variant="outline" className="gap-1"
                          disabled={busy !== null} onClick={() => void download(i.issuanceId, format)}
                        >
                          <Icon className="h-3.5 w-3.5" />{label}
                        </Button>
                      ))}
                    </div>
                  </div>
                );
              })}
              {loaded.issuances.truncated && <p className="text-xs text-muted-foreground">{t('truncated', { count: formatNumber(loaded.issuances.items.length, locale) })}</p>}
              {loaded.issuances.currentFinalIssuanceId !== null && (
                <p className="text-xs text-muted-foreground">
                  {loaded.issuances.items.some((i) => i.issuanceId === loaded.issuances.currentFinalIssuanceId)
                    ? t('currentNote')
                    : t('currentOutside')}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Captured datasets */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Archive className="h-4 w-4" />{t('datasetsHeading')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {canIssue && (
                newest === null ? (
                  <p className="text-muted-foreground">{t('noBoundary', { year })}</p>
                ) : (
                  <div className="space-y-1">
                    <Button className="gap-2" disabled={busy !== null || consultantBlocked} onClick={() => void capture(newest.id)}>
                      <Archive className="h-4 w-4" />{busy === 'capture' ? t('capturing') : t('capture')}
                    </Button>
                    <p className="text-xs text-muted-foreground">{consultantBlocked ? t('consultantOpen') : t('captureNote')}</p>
                  </div>
                )
              )}
              <BoundaryLink year={year} />
              {loaded.datasets.length === 0 && <p className="text-muted-foreground">{t('noDatasets', { year })}</p>}
              {loaded.datasets.map((d) => {
                const preview = previews[d.datasetId];
                return (
                  <div key={d.datasetId} className="rounded-lg border border-border p-3" data-testid="dataset-row" data-dataset-id={d.datasetId}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {t('datasetLine', {
                          version: d.boundary.version,
                          decision: d.boundary.decision === 'confirmed' ? t('decisionConfirmed') : t('decisionUnconfirmed'),
                        })}
                      </span>
                      <Badge variant="outline">{d.selection === 'inventory' ? t('selectionInventory') : t('selectionExtract')}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('capturedAt', { date: date.format(new Date(d.capturedAt)) })} · {t('fingerprint', { hex: d.fingerprint.hex.slice(0, 12) })}
                    </p>
                    {preview && <PreviewSummary preview={preview} className="mt-2" />}
                    {canIssue && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" className="gap-1" disabled={busy !== null} onClick={() => void check(d.datasetId)}>
                          <Search className="h-3.5 w-3.5" />{busy === `check:${d.datasetId}` ? t('checking') : t('check')}
                        </Button>
                        {/* A final the caller may not issue is not offered: the API would refuse it (`security-rls` P3-2). */}
                        <Button size="sm" className="gap-1" disabled={busy !== null || (preview?.status === 'final' && !preview.finalAllowed)} onClick={() => void openIssue(d)}>
                          <Stamp className="h-3.5 w-3.5" />{t('issue')}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
              {loaded.datasetsTruncated && (
                <p className="text-xs text-muted-foreground">{t('datasetsTruncated', { count: formatNumber(loaded.datasets.length, locale) })}</p>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {issuing && (
        <IssueDialog
          dataset={issuing.dataset}
          preview={issuing.preview}
          defaultLanguage={language}
          onClose={() => setIssuing(null)}
          onIssued={async () => {
            setIssuing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

/** What issuing a dataset would produce, from its preview: the status and each blocking gap, named. */
function PreviewSummary({ preview, className = '' }: { preview: ReportIssuancePreview; className?: string }) {
  const t = useTranslations('reports');
  const locale = useLocale() as Locale;
  const gaps = issuanceGapCounts(preview.gaps);
  return (
    <div className={`space-y-1 text-xs ${className}`} data-testid="issuance-preview" data-status={preview.status}>
      <p>
        {preview.status === 'final'
          ? t('issued.previewFinal')
          : t('issued.previewPartial', { count: formatNumber(preview.gaps.length, locale) })}
        {preview.status === 'final' && !preview.finalAllowed ? ` ${t('issued.finalForbidden')}` : ''}
      </p>
      {gaps.length > 0 && (
        <ul className="list-inside list-disc text-muted-foreground" data-testid="issuance-preview-gaps">
          {gaps.map((g) => (
            <li key={g.code}>{t('coverage.gapCount', { label: t(`issuanceGap.${g.code}` as never), count: formatNumber(g.count, locale) })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function templateName(id: ReportTemplate, t: ReturnType<typeof useTranslations<'reports'>>): string {
  return REPORT_TEMPLATES.some((r) => r.id === id) ? t(`templates.${id}` as never) : id;
}

function IssueDialog({
  dataset,
  preview,
  defaultLanguage,
  onClose,
  onIssued,
}: {
  dataset: ReportDatasetSummary;
  preview: ReportIssuancePreview;
  defaultLanguage: Locale;
  onClose: () => void;
  onIssued: () => Promise<void>;
}) {
  const t = useTranslations('reports.issued');
  const tReports = useTranslations('reports');
  const showError = useErrorToast();
  const [template, setTemplate] = useState<ReportTemplate>('executive_summary');
  const [language, setLanguage] = useState<Locale>(defaultLanguage);
  const [methodology, setMethodology] = useState(false);
  const [evidence, setEvidence] = useState(false);
  const [saving, setSaving] = useState(false);

  async function issue() {
    setSaving(true);
    try {
      const issued = await api.issueReport({
        datasetId: dataset.datasetId, template, language,
        includeMethodologyNotes: methodology, includeEvidenceSummary: evidence,
      });
      toast.success(issued.status === 'final' ? t('issuedFinal') : t('issuedPartial'));
      await onIssued();
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('issueTitle')}</DialogTitle>
          <DialogDescription>{t('issueIntro')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <PreviewSummary preview={preview} className="rounded-md border border-border bg-muted/40 p-3" />
          <div className="space-y-2">
            <Label htmlFor="issue-template">{tReports('template')}</Label>
            <Select value={template} onValueChange={(v) => setTemplate(v as ReportTemplate)}>
              <SelectTrigger id="issue-template"><SelectValue /></SelectTrigger>
              <SelectContent>
                {REPORT_TEMPLATES.map((r) => (
                  <SelectItem key={r.id} value={r.id}>{tReports(`templates.${r.id}` as never)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="issue-language">{t('language')}</Label>
            <Select value={language} onValueChange={(v) => setLanguage(v as Locale)}>
              <SelectTrigger id="issue-language"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SUPPORTED_LOCALES.map((l) => (
                  <SelectItem key={l} value={l}>{t(`languages.${l}` as never)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={methodology} onCheckedChange={(c) => setMethodology(c === true)} />
            {tReports('methodologyNotes')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={evidence} onCheckedChange={(c) => setEvidence(c === true)} />
            {tReports('evidenceSummary')}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{t('cancel')}</Button>
          <Button onClick={() => void issue()} disabled={saving || (preview.status === 'final' && !preview.finalAllowed)}>
            {saving ? t('issuing') : t('issue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
