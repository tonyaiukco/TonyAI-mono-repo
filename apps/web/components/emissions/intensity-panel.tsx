'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
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
import { checkDecimal } from '@/lib/i18n/number';
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

const numberFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 4 });
const wholeFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

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
  const year = context.year;
  const [intensity, setIntensity] = useState<ReportingIntensityData | null>(null);
  const [denominators, setDenominators] = useState<DenominatorDTO[]>([]);
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
  const refresh = useCallback(async () => {
    const mine = ++loadSeq.current;
    setLoading(true);
    try {
      const [i, d] = await Promise.all([
        api.reportingIntensity(context),
        api.listDenominators({ year: context.year, subsidiaryId: context.subsidiaryId }),
      ]);
      if (mine !== loadSeq.current) return;
      setIntensity(i.data);
      setDenominators(d);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      // Neither the previous selection's figures nor its deletable denominators
      // stay under the new bar (Codex B9 P2-1).
      setIntensity(null);
      setDenominators([]);
      toast.error((e as Error).message);
    } finally {
      if (mine === loadSeq.current) setLoading(false);
    }
  }, [context]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
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
      toast.error('Pick a subsidiary and enter a value above zero.');
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
      toast.success('Denominator configured');
      setAddOpen(false);
      valueInput.setValue(null);
      await refreshLatest.current();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(d: DenominatorDTO) {
    try {
      await api.deleteDenominator(d.id);
      toast.success('Denominator removed');
      await refreshLatest.current();
    } catch (e) {
      toast.error((e as Error).message);
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
            Emissions intensity · {year}
          </h2>
          <p className="text-sm text-muted-foreground">
            Committed emissions per configured denominator. Only metrics with a
            configured value for {year} are shown.
          </p>
        </div>
        {canManage && (
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                Add denominator
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Configure intensity denominator · {year}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 py-2">
                <div className="space-y-1.5">
                  <Label>Subsidiary</Label>
                  <Select value={form.subsidiaryId} onValueChange={(v) => setForm((f) => ({ ...f, subsidiaryId: v }))}>
                    <SelectTrigger><SelectValue placeholder="Select subsidiary" /></SelectTrigger>
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
                    <Label>Metric</Label>
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
                          <SelectItem key={m} value={m}>{INTENSITY_METRIC_META[m].label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Unit</Label>
                    <Input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Value</Label>
                  <Input type="text" inputMode="decimal" autoComplete="off" value={valueInput.text} onChange={(e) => valueInput.setText(e.target.value)} placeholder="e.g. 320" aria-describedby="denominator-value-note" aria-invalid={valueInput.text.trim() !== '' && !valueCheck.ok} />
                  <DecimalNote id="denominator-value-note" check={valueCheck} otherReading={valueInput.otherReading} locale={valueInput.locale} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>Cancel</Button>
                <Button onClick={handleCreate} disabled={saving}>{saving ? 'Saving…' : 'Save denominator'}</Button>
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
            <p className="text-sm font-medium text-foreground">No intensity denominators configured for {year}</p>
            <p className="text-sm text-muted-foreground">
              {canManage
                ? 'Add a denominator (revenue, headcount, area, production output or sales output) to compute intensity.'
                : 'A super_admin can configure intensity denominators.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {metrics.map((m) => (
            <Card key={`${m.metric}-${m.unit}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">
                  {INTENSITY_METRIC_META[m.metric].label}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-foreground">{numberFmt.format(m.intensity)}</span>
                  <span className="text-xs text-muted-foreground">tCO₂e / {m.unit}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {wholeFmt.format(m.emissionsTotal)} tCO₂e ÷ {wholeFmt.format(m.denominatorTotal)} {m.unit}
                </p>
                {/* Coverage is disclosed, never assumed (D14): a subsidiary
                    without this denominator is missing, not zero. */}
                <p className="text-xs text-muted-foreground" data-testid="intensity-coverage">
                  {t('intensityCoverage', { contributing: m.contributingSubsidiaryIds.length, selected: selectedCount, year })}
                </p>
                {m.uncalculatedRecordCount > 0 && (
                  <p className="text-xs text-amber-600">
                    {t('intensityUncalculated', { count: m.uncalculatedRecordCount })}
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
            <CardTitle className="text-base">Configured denominators · {year}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {denominators.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{INTENSITY_METRIC_META[d.metric].label}</Badge>
                  <span className="text-foreground">{wholeFmt.format(d.value)} {d.unit}</span>
                  <span className="text-xs text-muted-foreground">· {nameById.get(d.subsidiaryId) ?? d.subsidiaryId}</span>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-red-600" onClick={() => handleDelete(d)} aria-label="Delete denominator">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
