'use client';

import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
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
import { Plus, Target as TargetIcon, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { DecimalNote } from '@/components/i18n/decimal-note';
import { api } from '@/lib/api';
import { appendById, isStaleCursor } from '@/lib/cursor-pages';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { checkDecimal, formatNumber, parseYearInput } from '@/lib/i18n/number';
import { useErrorToast, useStableErrorToast } from '@/lib/i18n/hooks';
import { TARGET_BASES } from '@/lib/vocabulary';
import { useLocale, useTranslations } from 'use-intl';
import { useDecimalInput } from '@/lib/i18n/use-decimal-input';
import type {
  EmissionsScope,
  SubsidiaryDTO,
  TargetBasis,
  TargetDTO,
  TargetProgressDTO,
  TargetStatus,
} from '@/lib/types';

/** The scopes a target can cover, in the order the form offers them. */
const SCOPES: readonly EmissionsScope[] = ['all', 'scope1', 'scope2', 'scope3'];

const STATUS_STYLE: Record<TargetStatus, { bar: string; badge: string }> = {
  on_track: { bar: 'bg-emerald-500', badge: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
  at_risk: { bar: 'bg-amber-500', badge: 'bg-amber-500/15 text-amber-600 border-amber-500/30' },
  off_track: { bar: 'bg-red-500', badge: 'bg-red-500/15 text-red-600 border-red-500/30' },
};

const ONE_DECIMAL = { maximumFractionDigits: 1 } as const;

interface TargetsPanelProps {
  canManage: boolean;
  subsidiaries: SubsidiaryDTO[];
  nameById: Map<string, string>;
  /** The page's selected subsidiary (LP3-02 N1). Targets inherit only this:
   * they keep their own baseline, target and progress years. */
  subsidiaryId?: string;
}

const emptyForm = {
  subsidiaryId: '',
  name: '',
  basis: 'science_based' as TargetBasis,
  scope: 'all' as EmissionsScope,
  baselineYear: '2023',
  targetYear: '2030',
};

/** Targets tab (WP5): live reduction targets + progress; super_admin CRUD. */
export function TargetsPanel({ canManage, subsidiaries, nameById, subsidiaryId }: TargetsPanelProps) {
  const t = useTranslations('targets');
  const tCommon = useTranslations('common');
  const tStatus = useTranslations('targetStatus');
  const tBasis = useTranslations('targetBasis');
  const locale = useLocale();
  const showError = useErrorToast();
  // `refresh` is an effect's dependency: a language switch must not reload it.
  const showLoadError = useStableErrorToast();
  const figure = (value: number) => formatNumber(value, locale, ONE_DECIMAL);
  const [targets, setTargets] = useState<TargetDTO[]>([]);
  const [progress, setProgress] = useState<TargetProgressDTO[]>([]);
  // Loaded pages of targets (LP4-05 PR C); progress is read for each page's ids.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);
  // Quantities are typed in the user's locale (D15) — the same reading Data
  // Entry gives, never the browser's `type="number"` one (independent review
  // P2-1: Firefox in Turkish read an English `45,000` as 45).
  const baselineInput = useDecimalInput();
  const targetInput = useDecimalInput();
  const baselineCheck = checkDecimal(baselineInput.parsed, 'non_negative');
  const targetCheck = checkDecimal(targetInput.parsed, 'non_negative');

  const progressById = useMemo(() => {
    const m = new Map<string, TargetProgressDTO>();
    for (const p of progress) m.set(p.targetId, p);
    return m;
  }, [progress]);

  // A slower answer for an earlier selection must not land over a newer one.
  const loadSeq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++loadSeq.current;
    setLoading(true);
    try {
      const page = await api.listTargetPage(subsidiaryId ? { subsidiaryId } : {});
      // Progress only for the targets on this page — never every target.
      const p = page.items.length ? await api.targetPageProgress({ targetIds: page.items.map((t) => t.id) }) : [];
      if (mine !== loadSeq.current) return;
      setTargets(page.items);
      setProgress(p);
      setNextCursor(page.nextCursor);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      // Never the previous subsidiary's targets under the new selection.
      setTargets([]);
      setProgress([]);
      setNextCursor(null);
      showLoadError(e);
    } finally {
      if (mine === loadSeq.current) setLoading(false);
    }
  }, [subsidiaryId, showLoadError]);

  async function loadMore() {
    if (!nextCursor) return;
    const mine = loadSeq.current;
    setLoadingMore(true);
    try {
      const page = await api.listTargetPage({ ...(subsidiaryId ? { subsidiaryId } : {}), cursor: nextCursor });
      const p = page.items.length ? await api.targetPageProgress({ targetIds: page.items.map((t) => t.id) }) : [];
      if (mine !== loadSeq.current) return;
      setTargets((list) => appendById(list, page.items));
      setProgress((list) => [...list, ...p]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      showError(e);
      if (isStaleCursor(e)) void refresh();
    } finally {
      setLoadingMore(false);
    }
  }

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
    if (!form.subsidiaryId || form.name.trim().length < 2) {
      toast.error(t('pickRequired'));
      return;
    }
    const baselineYear = parseYearInput(form.baselineYear);
    const targetYear = parseYearInput(form.targetYear);
    if (baselineYear === null || targetYear === null || !baselineCheck.ok || !targetCheck.ok) {
      toast.error(t('invalidNumbers'));
      return;
    }
    const baselineTCo2e = baselineCheck.value;
    const targetTCo2e = targetCheck.value;
    setSaving(true);
    try {
      await api.createTarget({
        subsidiaryId: form.subsidiaryId,
        name: form.name.trim(),
        basis: form.basis,
        scope: form.scope,
        baselineYear,
        baselineTCo2e,
        targetYear,
        targetTCo2e,
      });
      toast.success(t('created'));
      setAddOpen(false);
      setForm(emptyForm);
      baselineInput.setValue(null);
      targetInput.setValue(null);
      await refreshLatest.current();
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(target: TargetDTO) {
    try {
      await api.deleteTarget(target.id);
      toast.success(t('removed'));
      await refreshLatest.current();
    } catch (e) {
      showError(e);
    }
  }

  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('intro')}
        </p>
        {canManage && (
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                {t('add')}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('dialogTitle')}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 py-2">
                <Field label={t('subsidiary')}>
                  <Select value={form.subsidiaryId} onValueChange={(v) => setForm((f) => ({ ...f, subsidiaryId: v }))}>
                    <SelectTrigger><SelectValue placeholder={t('subsidiaryPlaceholder')} /></SelectTrigger>
                    <SelectContent>
                      {subsidiaries.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.tradingName ?? s.legalName} ({s.geographyCode})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('name')}>
                  <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={t('namePlaceholder')} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('basis')}>
                    <Select value={form.basis} onValueChange={(v) => setForm((f) => ({ ...f, basis: v as TargetBasis }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TARGET_BASES.map((b) => (
                          <SelectItem key={b} value={b}>{tBasis(b)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label={t('scope')}>
                    <Select value={form.scope} onValueChange={(v) => setForm((f) => ({ ...f, scope: v as EmissionsScope }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SCOPES.map((s) => (
                          <SelectItem key={s} value={s}>{t(`scopes.${s}`)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('baselineYear')}>
                    <Input type="text" inputMode="numeric" autoComplete="off" value={form.baselineYear} onChange={(e) => setForm((f) => ({ ...f, baselineYear: e.target.value }))} />
                  </Field>
                  <Field label={t('baselineTonnes')}>
                    <Input type="text" inputMode="decimal" autoComplete="off" value={baselineInput.text} onChange={(e) => baselineInput.setText(e.target.value)} placeholder={t('baselinePlaceholder')} aria-describedby="target-baseline-note" aria-invalid={baselineInput.text.trim() !== '' && !baselineCheck.ok} />
                    <DecimalNote id="target-baseline-note" check={baselineCheck} otherReading={baselineInput.otherReading} locale={baselineInput.locale} />
                  </Field>
                  <Field label={t('targetYear')}>
                    <Input type="text" inputMode="numeric" autoComplete="off" value={form.targetYear} onChange={(e) => setForm((f) => ({ ...f, targetYear: e.target.value }))} />
                  </Field>
                  <Field label={t('targetTonnes')}>
                    <Input type="text" inputMode="decimal" autoComplete="off" value={targetInput.text} onChange={(e) => targetInput.setText(e.target.value)} placeholder={t('targetPlaceholder')} aria-describedby="target-target-note" aria-invalid={targetInput.text.trim() !== '' && !targetCheck.ok} />
                    <DecimalNote id="target-target-note" check={targetCheck} otherReading={targetInput.otherReading} locale={targetInput.locale} />
                  </Field>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>{tCommon('cancel')}</Button>
                <Button onClick={handleCreate} disabled={saving}>{saving ? tCommon('saving') : t('create')}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {targets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <TargetIcon className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">{t('empty')}</p>
            <p className="text-sm text-muted-foreground">
              {canManage ? t('emptyManage') : t('emptyView')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {targets.map((target) => {
            const p = progressById.get(target.id);
            const naProgress = !p || p.progressPercent === null || p.status === null;
            const status = !naProgress && p?.status ? p.status : null;
            const style = status ? STATUS_STYLE[status] : null;
            return (
              <Card key={target.id}>
                <CardContent className="space-y-4 pt-6">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-semibold text-foreground">{target.name}</h3>
                      <p className="text-xs text-muted-foreground">{nameById.get(target.subsidiaryId) ?? target.subsidiaryId}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {status && style ? (
                        <Badge variant="outline" className={style.badge}>{tStatus(status)}</Badge>
                      ) : (
                        <Badge variant="outline" className="bg-muted text-muted-foreground">{t('progressNa')}</Badge>
                      )}
                      {canManage && (
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-red-600" onClick={() => handleDelete(target)} aria-label={t('delete')}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{tBasis(target.basis)}</Badge>
                    <Badge variant="outline">{t(`scopes.${target.scope}`)}</Badge>
                    <Badge variant="outline">{t('reduction', { value: figure(target.reductionPercent) })}</Badge>
                  </div>

                  {/* Progress bar or honest n/a */}
                  {naProgress ? (
                    <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                      {t('noProgress', { year: String(target.baselineYear) })}
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div className={`h-full ${style!.bar}`} style={{ width: `${p!.progressPercent}%` }} />
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{t('wayToTarget', { value: figure(p!.progressPercent!) })}</span>
                        <span>{t('current', { year: String(p!.currentYear), value: figure(p!.currentTCo2e!) })}</span>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-between text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">{t('baseline', { year: String(target.baselineYear) })}</p>
                      <p className="font-medium text-foreground">{t('tonnes', { value: figure(target.baselineTCo2e) })}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">{t('target', { year: String(target.targetYear) })}</p>
                      <p className="font-medium text-foreground">{t('tonnes', { value: figure(target.targetTCo2e) })}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <LoadMoreButton
        hasMore={!loading && nextCursor !== null}
        loading={loadingMore}
        onClick={() => void loadMore()}
        label={t('loadMore')}
        testId="targets-load-more"
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  // space-y-2 matches the data-entry field convention so E2E `pickByFieldLabel`
  // can target these dropdowns.
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
