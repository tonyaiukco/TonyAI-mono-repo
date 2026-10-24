'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Lock, LockOpen } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { appendById, isStaleCursor } from '@/lib/cursor-pages';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { DEFAULT_REPORTING_YEAR, PERIOD_VALUES, REPORTING_YEARS } from '@/lib/types';
import type { PeriodLockDTO, ReportingPeriod, SubsidiaryDTO } from '@/lib/types';
import { useTranslations } from 'use-intl';
import { useErrorToast, useRecordWords } from '@/lib/i18n/hooks';

/** In the order the form offers them; named by `periods.granularity.*`. */
const PERIODS: readonly ReportingPeriod[] = ['quarterly', 'monthly', 'annual'];
// Same canonical vocabulary the entry form and the server use — a lock keyed
// on a spelling no record carries would close nothing.

interface PeriodLocksDrawerProps {
  subsidiary: SubsidiaryDTO | null;
  /** Only super_admin may lock/unlock (permissions §5.3). */
  canManage: boolean;
  onClose: () => void;
}

/** Closed reporting periods of one subsidiary (FR §4.2): list + lock/unlock. */
export function PeriodLocksDrawer({
  subsidiary,
  canManage,
  onClose,
}: PeriodLocksDrawerProps) {
  const t = useTranslations('subsidiaries');
  const tPeriods = useTranslations('periods');
  const tCommon = useTranslations('common');
  const words = useRecordWords();
  const showError = useErrorToast();
  // The ref keeps `refresh` stable: a language switch re-words, never re-reads.
  const showErrorRef = useRef(showError);
  useEffect(() => {
    showErrorRef.current = showError;
  }, [showError]);
  // The loaded pages of this subsidiary's locks, newest first (LP4-05 PR C).
  const [locks, setLocks] = useState<PeriodLockDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [year, setYear] = useState<number>(DEFAULT_REPORTING_YEAR);
  const [period, setPeriod] = useState<ReportingPeriod>('quarterly');
  const [periodValue, setPeriodValue] = useState('Q1');

  // The drawer outlives the subsidiary it shows: a page that answers after it
  // was closed, or reopened for another subsidiary, must never land — its rows
  // carry Unlock buttons (qa-auditor P3-2).
  const loadSeq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++loadSeq.current;
    setLocks([]);
    setNextCursor(null);
    if (!subsidiary) return;
    setLoading(true);
    try {
      const page = await api.listPeriodLockPage({ subsidiaryId: subsidiary.id });
      if (mine !== loadSeq.current) return;
      setLocks(page.items);
      setNextCursor(page.nextCursor);
    } catch (e) {
      if (mine === loadSeq.current) showErrorRef.current(e);
    } finally {
      if (mine === loadSeq.current) setLoading(false);
    }
  }, [subsidiary]);

  async function loadMore() {
    if (!subsidiary || !nextCursor) return;
    const mine = loadSeq.current;
    setLoadingMore(true);
    try {
      const page = await api.listPeriodLockPage({ subsidiaryId: subsidiary.id, cursor: nextCursor });
      if (mine !== loadSeq.current) return;
      setLocks((list) => appendById(list, page.items));
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

  async function handleLock() {
    if (!subsidiary) return;
    setSaving(true);
    try {
      await api.lockPeriod({
        subsidiaryId: subsidiary.id,
        reportingYear: year,
        reportingPeriod: period,
        periodValue,
      });
      toast.success(t('locks.locked', { period: words.period(periodValue), year }));
      await refresh();
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  }

  async function handleUnlock(lock: PeriodLockDTO) {
    try {
      await api.unlockPeriod(lock.id);
      toast.success(t('locks.unlocked', { period: words.period(lock.periodValue), year: lock.reportingYear }));
      await refresh();
    } catch (e) {
      showError(e);
    }
  }

  return (
    <Sheet open={!!subsidiary} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[440px] overflow-y-auto sm:max-w-[440px]">
        {subsidiary && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-primary" />
                {t('locks.title')}
              </SheetTitle>
              <SheetDescription>
                {t('locks.description', { name: subsidiary.tradingName ?? subsidiary.legalName })}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-6 space-y-6">
              {/* Locked periods */}
              {loading ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{tCommon('loading')}</p>
              ) : locks.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {t('locks.empty')}
                </p>
              ) : (
                <div className="space-y-2">
                  {locks.map((l) => (
                    <div
                      key={l.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
                    >
                      <div className="flex items-center gap-2 text-sm">
                        <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium text-foreground">
                          {t('locks.periodYear', { period: words.period(l.periodValue), year: l.reportingYear })}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t('locks.granularity', {
                            granularity: tPeriods.has(`granularityInline.${l.reportingPeriod}`)
                              ? tPeriods(`granularityInline.${l.reportingPeriod as ReportingPeriod}`)
                              : l.reportingPeriod,
                          })}
                        </span>
                      </div>
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1.5 px-2 text-xs"
                          onClick={() => void handleUnlock(l)}
                        >
                          <LockOpen className="h-3.5 w-3.5" />
                          {t('locks.unlock')}
                        </Button>
                      )}
                    </div>
                  ))}
                  <LoadMoreButton
                    hasMore={nextCursor !== null}
                    loading={loadingMore}
                    onClick={() => void loadMore()}
                    label={t('locks.loadMore')}
                    testId="period-locks-load-more"
                  />
                </div>
              )}

              {/* Lock a period — super_admin only */}
              {canManage ? (
                <div className="space-y-4 border-t border-border pt-4">
                  <h4 className="text-sm font-medium">{t('locks.closeTitle')}</h4>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1.5">
                      <Label>{t('locks.year')}</Label>
                      <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {REPORTING_YEARS.map((y) => (
                            <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>{t('locks.period')}</Label>
                      <Select
                        value={period}
                        onValueChange={(v) => {
                          const p = v as ReportingPeriod;
                          setPeriod(p);
                          setPeriodValue(PERIOD_VALUES[p][0]);
                        }}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {PERIODS.map((p) => (
                            <SelectItem key={p} value={p}>{tPeriods(`granularity.${p}`)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>{t('locks.value')}</Label>
                      <Select value={periodValue} onValueChange={setPeriodValue}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {PERIOD_VALUES[period].map((v) => (
                            <SelectItem key={v} value={v}>{words.period(v)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Button className="w-full gap-2" onClick={handleLock} disabled={saving}>
                    <Lock className="h-4 w-4" />
                    {saving ? t('locks.locking') : t('locks.lock')}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {t.rich('locks.hint', { em: (chunks) => <em>{chunks}</em> })}
                  </p>
                </div>
              ) : (
                <p className="border-t border-border pt-4 text-xs text-muted-foreground">
                  {t('locks.readOnly')}
                </p>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
