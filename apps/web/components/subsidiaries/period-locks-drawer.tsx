'use client';

import { useCallback, useEffect, useState } from 'react';
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
import type { PeriodLockDTO, ReportingPeriod, SubsidiaryDTO } from '@/lib/types';

const YEARS = [2024, 2023] as const;
const PERIODS: { value: ReportingPeriod; label: string }[] = [
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'annual', label: 'Annual' },
];
const PERIOD_VALUES: Record<ReportingPeriod, string[]> = {
  quarterly: ['Q1', 'Q2', 'Q3', 'Q4'],
  monthly: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
  annual: ['Annual'],
};

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
  const [locks, setLocks] = useState<PeriodLockDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [year, setYear] = useState<number>(2024);
  const [period, setPeriod] = useState<ReportingPeriod>('quarterly');
  const [periodValue, setPeriodValue] = useState('Q1');

  const refresh = useCallback(async () => {
    if (!subsidiary) return;
    setLoading(true);
    try {
      setLocks(await api.listPeriodLocks({ subsidiaryId: subsidiary.id }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [subsidiary]);

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
      toast.success(`Locked ${periodValue} ${year} — records in this period are now frozen`);
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleUnlock(lock: PeriodLockDTO) {
    try {
      await api.unlockPeriod(lock.id);
      toast.success(`Unlocked ${lock.periodValue} ${lock.reportingYear}`);
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
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
                Period locks
              </SheetTitle>
              <SheetDescription>
                {subsidiary.tradingName ?? subsidiary.legalName} — a locked
                period rejects any new, edited or submitted records (FR §4.2).
              </SheetDescription>
            </SheetHeader>

            <div className="mt-6 space-y-6">
              {/* Locked periods */}
              {loading ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
              ) : locks.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No locked periods — all reporting periods are open.
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
                          {l.periodValue} {l.reportingYear}
                        </span>
                        <span className="text-xs text-muted-foreground">({l.reportingPeriod})</span>
                      </div>
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1.5 px-2 text-xs"
                          onClick={() => void handleUnlock(l)}
                        >
                          <LockOpen className="h-3.5 w-3.5" />
                          Unlock
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Lock a period — super_admin only */}
              {canManage ? (
                <div className="space-y-4 border-t border-border pt-4">
                  <h4 className="text-sm font-medium">Close a reporting period</h4>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1.5">
                      <Label>Year</Label>
                      <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {YEARS.map((y) => (
                            <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Period</Label>
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
                            <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Value</Label>
                      <Select value={periodValue} onValueChange={setPeriodValue}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {PERIOD_VALUES[period].map((v) => (
                            <SelectItem key={v} value={v}>{v}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Button className="w-full gap-2" onClick={handleLock} disabled={saving}>
                    <Lock className="h-4 w-4" />
                    {saving ? 'Locking…' : 'Lock period'}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Committed records in the period flip to <em>locked</em>;
                    unlocking reverts them to <em>approved</em>. Both actions are audited.
                  </p>
                </div>
              ) : (
                <p className="border-t border-border pt-4 text-xs text-muted-foreground">
                  Only a super_admin can lock or unlock reporting periods.
                </p>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
