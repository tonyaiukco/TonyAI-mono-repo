'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { api } from '@/lib/api';
import type {
  EmissionsScope,
  SubsidiaryDTO,
  TargetBasis,
  TargetDTO,
  TargetProgressDTO,
  TargetStatus,
} from '@/lib/types';

const BASIS_LABEL: Record<TargetBasis, string> = {
  science_based: 'Science-based',
  internal_annual: 'Internal annual',
  baseline_reduction: 'Baseline reduction',
};

const SCOPE_LABEL: Record<EmissionsScope, string> = {
  all: 'All scopes',
  scope1: 'Scope 1',
  scope2: 'Scope 2',
  scope3: 'Scope 3',
};

const STATUS_STYLE: Record<TargetStatus, { label: string; bar: string; badge: string }> = {
  on_track: { label: 'On track', bar: 'bg-emerald-500', badge: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
  at_risk: { label: 'At risk', bar: 'bg-amber-500', badge: 'bg-amber-500/15 text-amber-600 border-amber-500/30' },
  off_track: { label: 'Off track', bar: 'bg-red-500', badge: 'bg-red-500/15 text-red-600 border-red-500/30' },
};

const numberFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

interface TargetsPanelProps {
  canManage: boolean;
  subsidiaries: SubsidiaryDTO[];
  nameById: Map<string, string>;
}

const emptyForm = {
  subsidiaryId: '',
  name: '',
  basis: 'science_based' as TargetBasis,
  scope: 'all' as EmissionsScope,
  baselineYear: '2023',
  baselineTCo2e: '',
  targetYear: '2030',
  targetTCo2e: '',
};

/** Targets tab (WP5): live reduction targets + progress; super_admin CRUD. */
export function TargetsPanel({ canManage, subsidiaries, nameById }: TargetsPanelProps) {
  const [targets, setTargets] = useState<TargetDTO[]>([]);
  const [progress, setProgress] = useState<TargetProgressDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const progressById = useMemo(() => {
    const m = new Map<string, TargetProgressDTO>();
    for (const p of progress) m.set(p.targetId, p);
    return m;
  }, [progress]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [t, p] = await Promise.all([api.listTargets(), api.targetProgress()]);
      setTargets(t);
      setProgress(p);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    const baselineTCo2e = Number(form.baselineTCo2e);
    const targetTCo2e = Number(form.targetTCo2e);
    if (!form.subsidiaryId || form.name.trim().length < 2) {
      toast.error('Pick a subsidiary and enter a target name.');
      return;
    }
    setSaving(true);
    try {
      await api.createTarget({
        subsidiaryId: form.subsidiaryId,
        name: form.name.trim(),
        basis: form.basis,
        scope: form.scope,
        baselineYear: Number(form.baselineYear),
        baselineTCo2e,
        targetYear: Number(form.targetYear),
        targetTCo2e,
      });
      toast.success('Target created');
      setAddOpen(false);
      setForm(emptyForm);
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(t: TargetDTO) {
    try {
      await api.deleteTarget(t.id);
      toast.success('Target removed');
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
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
          Reduction targets with live progress against committed emissions.
        </p>
        {canManage && (
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                Add target
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add reduction target</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 py-2">
                <Field label="Subsidiary">
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
                </Field>
                <Field label="Name">
                  <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Net-zero pathway 2030" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Basis">
                    <Select value={form.basis} onValueChange={(v) => setForm((f) => ({ ...f, basis: v as TargetBasis }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(Object.keys(BASIS_LABEL) as TargetBasis[]).map((b) => (
                          <SelectItem key={b} value={b}>{BASIS_LABEL[b]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Scope">
                    <Select value={form.scope} onValueChange={(v) => setForm((f) => ({ ...f, scope: v as EmissionsScope }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(Object.keys(SCOPE_LABEL) as EmissionsScope[]).map((s) => (
                          <SelectItem key={s} value={s}>{SCOPE_LABEL[s]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Baseline year">
                    <Input type="number" value={form.baselineYear} onChange={(e) => setForm((f) => ({ ...f, baselineYear: e.target.value }))} />
                  </Field>
                  <Field label="Baseline tCO₂e">
                    <Input type="number" value={form.baselineTCo2e} onChange={(e) => setForm((f) => ({ ...f, baselineTCo2e: e.target.value }))} placeholder="e.g. 1600" />
                  </Field>
                  <Field label="Target year">
                    <Input type="number" value={form.targetYear} onChange={(e) => setForm((f) => ({ ...f, targetYear: e.target.value }))} />
                  </Field>
                  <Field label="Target tCO₂e">
                    <Input type="number" value={form.targetTCo2e} onChange={(e) => setForm((f) => ({ ...f, targetTCo2e: e.target.value }))} placeholder="e.g. 900" />
                  </Field>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>Cancel</Button>
                <Button onClick={handleCreate} disabled={saving}>{saving ? 'Saving…' : 'Create target'}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {targets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <TargetIcon className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No reduction targets yet</p>
            <p className="text-sm text-muted-foreground">
              {canManage ? 'Add a target to track progress against committed emissions.' : 'A super_admin can define reduction targets.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {targets.map((t) => {
            const p = progressById.get(t.id);
            const naProgress = !p || p.progressPercent === null || p.status === null;
            const style = !naProgress && p?.status ? STATUS_STYLE[p.status] : null;
            return (
              <Card key={t.id}>
                <CardContent className="space-y-4 pt-6">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-semibold text-foreground">{t.name}</h3>
                      <p className="text-xs text-muted-foreground">{nameById.get(t.subsidiaryId) ?? t.subsidiaryId}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {style ? (
                        <Badge variant="outline" className={style.badge}>{style.label}</Badge>
                      ) : (
                        <Badge variant="outline" className="bg-muted text-muted-foreground">Progress n/a</Badge>
                      )}
                      {canManage && (
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-red-600" onClick={() => handleDelete(t)} aria-label="Delete target">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{BASIS_LABEL[t.basis]}</Badge>
                    <Badge variant="outline">{SCOPE_LABEL[t.scope]}</Badge>
                    <Badge variant="outline">−{numberFmt.format(t.reductionPercent)}%</Badge>
                  </div>

                  {/* Progress bar or honest n/a */}
                  {naProgress ? (
                    <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                      Progress is not yet available — no committed data for a year after the {t.baselineYear} baseline.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div className={`h-full ${style!.bar}`} style={{ width: `${p!.progressPercent}%` }} />
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{numberFmt.format(p!.progressPercent!)}% of the way to target</span>
                        <span>{p!.currentYear} current: {numberFmt.format(p!.currentTCo2e!)} tCO₂e</span>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-between text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Baseline {t.baselineYear}</p>
                      <p className="font-medium text-foreground">{numberFmt.format(t.baselineTCo2e)} tCO₂e</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">Target {t.targetYear}</p>
                      <p className="font-medium text-foreground">{numberFmt.format(t.targetTCo2e)} tCO₂e</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
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
