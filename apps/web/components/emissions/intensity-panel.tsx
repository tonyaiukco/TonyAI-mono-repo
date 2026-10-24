'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Gauge, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { DecimalNote } from '@/components/i18n/decimal-note';
import { api } from '@/lib/api';
import { appendById, isStaleCursor } from '@/lib/cursor-pages';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { checkDecimal, formatNumber } from '@/lib/i18n/number';
import { useErrorToast, useStableErrorToast } from '@/lib/i18n/hooks';
import { useDecimalInput } from '@/lib/i18n/use-decimal-input';
import {
  INTENSITY_METRIC_KEYS,
  INTENSITY_METRIC_META,
} from '@/lib/types';
import type {
  DenominatorDTO,
  IntensityMetricKey,
  ReportingContext,
  ReportingIntensityData,
  SubsidiaryDTO,
} from '@/lib/types';

const FOUR_DECIMALS = { maximumFractionDigits: 4 } as const;
const WHOLE = { maximumFractionDigits: 0 } as const;

interface IntensityPanelProps {
  canManage: boolean;
  subsidiaries: SubsidiaryDTO[];
  nameById: Map<string, string>;
  /** The page's reporting context (LP3-02 N1): year, subsidiary, scope and category. */
  context: ReportingContext;
}

/** Intensity view (WP5): emissions per configured denominator + super_admin CRUD. */
export function IntensityPanel({ canManage, subsidiaries, nameById, context }: IntensityPanelProps) {
  const t = useTranslations('reportingContext');
  const tIntensity = useTranslations('intensity');
  const tMetric = useTranslations('intensityMetrics');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const showError = useErrorToast();
  // `refresh` is an effect's dependency: a language switch must not reload it.
  const showLoadError = useStableErrorToast();
  const year = context.year;
  const yearText = String(year);
  const [intensity, setIntensity] = useState<ReportingIntensityData | null>(null);
  const [denominators, setDenominators] = useState<DenominatorDTO[]>([]);
  // The management list's loaded pages (LP4-05 PR C); the intensity figures
  // above come from the aggregate route, never from this list.
  const [denominatorsCursor, setDenominatorsCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    subsidiaryId: '',
    metric: 'revenue' as IntensityMetricKey,
    unit: INTENSITY_METRIC_META.revenue.defaultUnit,
  });

  // Typed in the user's locale (D15), as on Data Entry — never the browser's
  // `type="number"` reading (independent review P2-1).
  const valueInput = useDecimalInput();
  const valueCheck = checkDecimal(valueInput.parsed, 'positive');

  // A slower answer for an earlier selection must not land over a newer one.
  const loadSeq = useRef(0);
  const denominatorFilters = useCallback(
    () => ({ year: context.year, ...(context.subsidiaryId ? { subsidiaryId: context.subsidiaryId } : {}) }),
    [context],
  );
  const refresh = useCallback(async () => {
    const mine = ++loadSeq.current;
    setLoading(true);
    try {
      const [i, d] = await Promise.all([
        api.reportingIntensity(context),
        api.listDenominatorPage(denominatorFilters()),
      ]);
      if (mine !== loadSeq.current) return;
      setIntensity(i.data);
      setDenominators(d.items);
      setDenominatorsCursor(d.nextCursor);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      // Neither the previous selection's figures nor its deletable denominators
      // stay under the new bar (Codex B9 P2-1).
      setIntensity(null);
      setDenominators([]);
      setDenominatorsCursor(null);
      showLoadError(e);
    } finally {
      if (mine === loadSeq.current) setLoading(false);
    }
  }, [context, denominatorFilters, showLoadError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function loadMoreDenominators() {
    if (!denominatorsCursor) return;
    const mine = loadSeq.current;
    setLoadingMore(true);
    try {
      const page = await api.listDenominatorPage({ ...denominatorFilters(), cursor: denominatorsCursor });
      if (mine !== loadSeq.current) return;
      setDenominators((list) => appendById(list, page.items));
      setDenominatorsCursor(page.nextCursor);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      showError(e);
      if (isStaleCursor(e)) void refresh();
    } finally {
      setLoadingMore(false);
    }
  }
  // A mutation's follow-up refresh runs for the selection on screen when the
  // mutation completes, not the one captured when it started: that refresh
  // would be the newest request and land an obsolete selection's rows under
  // the current bar (Codex B9 P2-2).
  const refreshLatest = useRef(refresh);
  useEffect(() => {
    refreshLatest.current = refresh;
  }, [refresh]);

  async function handleCreate() {
    if (!form.subsidiaryId || !valueCheck.ok) {
      toast.error(tIntensity('pickRequired'));
      return;
    }
    setSaving(true);
    try {
      await api.createDenominator({
        subsidiaryId: form.subsidiaryId,
        year,
        metric: form.metric,
        value: valueCheck.value,
        unit: form.unit.trim() || INTENSITY_METRIC_META[form.metric].defaultUnit,
      });
      toast.success(tIntensity('configured'));
      setAddOpen(false);
      valueInput.setValue(null);
      await refreshLatest.current();
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(d: DenominatorDTO) {
    try {
      await api.deleteDenominator(d.id);
      toast.success(tIntensity('removed'));
      await refreshLatest.current();
    } catch (e) {
      showError(e);
    }
  }

  if (loading) {
    return <Skeleton className="h-48 w-full" />;
  }

  const metrics = intensity?.metrics ?? [];
  const selectedCount = intensity?.selectedSubsidiaryIds.length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <Gauge className="h-5 w-5 text-primary" />
            {tIntensity('title', { year: yearText })}
          </h2>
          <p className="text-sm text-muted-foreground">
            {tIntensity('intro', { year: yearText })}
          </p>
        </div>
        {canManage && (
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                {tIntensity('add')}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{tIntensity('dialogTitle', { year: yearText })}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 py-2">
                <div className="space-y-1.5">
                  <Label>{tIntensity('subsidiary')}</Label>
                  <Select value={form.subsidiaryId} onValueChange={(v) => setForm((f) => ({ ...f, subsidiaryId: v }))}>
                    <SelectTrigger><SelectValue placeholder={tIntensity('subsidiaryPlaceholder')} /></SelectTrigger>
                    <SelectContent>
                      {subsidiaries.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.tradingName ?? s.legalName} ({s.geographyCode})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{tIntensity('metric')}</Label>
                    <Select
                      value={form.metric}
                      onValueChange={(v) =>
                        setForm((f) => ({
                          ...f,
                          metric: v as IntensityMetricKey,
                          unit: INTENSITY_METRIC_META[v as IntensityMetricKey].defaultUnit,
                        }))
                      }
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {INTENSITY_METRIC_KEYS.map((m) => (
                          <SelectItem key={m} value={m}>{tMetric(m)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{tIntensity('unit')}</Label>
                    <Input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>{tIntensity('value')}</Label>
                  <Input type="text" inputMode="decimal" autoComplete="off" value={valueInput.text} onChange={(e) => valueInput.setText(e.target.value)} placeholder={tIntensity('valuePlaceholder')} aria-describedby="denominator-value-note" aria-invalid={valueInput.text.trim() !== '' && !valueCheck.ok} />
                  <DecimalNote id="denominator-value-note" check={valueCheck} otherReading={valueInput.otherReading} locale={valueInput.locale} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>{tCommon('cancel')}</Button>
                <Button onClick={handleCreate} disabled={saving}>{saving ? tCommon('saving') : tIntensity('save')}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {context.subsidiaryId === undefined && (
        <p className="text-xs text-muted-foreground">{t('intensityGroupOnly')}</p>
      )}

      {metrics.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Gauge className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">{tIntensity('empty', { year: yearText })}</p>
            <p className="text-sm text-muted-foreground">
              {canManage ? tIntensity('emptyManage') : tIntensity('emptyView')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {metrics.map((m) => (
            <Card key={`${m.metric}-${m.unit}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">
                  {tMetric(m.metric)}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-foreground">{formatNumber(m.intensity, locale, FOUR_DECIMALS)}</span>
                  <span className="text-xs text-muted-foreground">{tIntensity('perUnit', { unit: m.unit })}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {tIntensity('formula', {
                    emissions: formatNumber(m.emissionsTotal, locale, WHOLE),
                    denominator: formatNumber(m.denominatorTotal, locale, WHOLE),
                    unit: m.unit,
                  })}
                </p>
                {/* Coverage is disclosed, never assumed (D14): a subsidiary
                    without this denominator is missing, not zero. */}
                <p className="text-xs text-muted-foreground" data-testid="intensity-coverage">
                  {t('intensityCoverage', {
                    contributing: formatNumber(m.contributingSubsidiaryIds.length, locale),
                    selected: formatNumber(selectedCount, locale),
                    year: yearText,
                  })}
                </p>
                {m.uncalculatedRecordCount > 0 && (
                  <p className="text-xs text-amber-600">
                    {t('intensityUncalculated', { count: formatNumber(m.uncalculatedRecordCount, locale) })}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Configured denominators (management list) */}
      {canManage && denominators.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tIntensity('listTitle', { year: yearText })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {denominators.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{tMetric(d.metric)}</Badge>
                  <span className="text-foreground">{formatNumber(d.value, locale, WHOLE)} {d.unit}</span>
                  <span className="text-xs text-muted-foreground">· {nameById.get(d.subsidiaryId) ?? d.subsidiaryId}</span>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-red-600" onClick={() => handleDelete(d)} aria-label={tIntensity('delete')}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <LoadMoreButton
              hasMore={!loading && denominatorsCursor !== null}
              loading={loadingMore}
              onClick={() => void loadMoreDenominators()}
              label={tIntensity('loadMore')}
              testId="denominators-load-more"
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
