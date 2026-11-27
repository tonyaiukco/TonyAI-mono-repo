"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useStableErrorToast } from "@/lib/i18n/hooks";
import { formatComputedAmount, formatNumber } from "@/lib/i18n/number";
import { appendPage, batchActions, batchTitle, hasMoreBatches, isRevised, nextOffsets, shownOf, submittableIds, type PagedBatches } from "@/lib/fuel-batch-view";
import { FUEL_BATCH_STATUSES, type AuthUser, type FuelBatchStatus, type Locale } from "@/lib/types";
import { BatchSheet } from "./batch-sheet";
import { RowCount } from "./common";

const ALL = "__all__";

/** Batches (D16): status filter, submit one or many, open a batch to recall, declare, attach files or withdraw it. */
export function BatchesTab({ user, refreshKey, initialOpen = null }: { user: AuthUser | null; refreshKey: number; initialOpen?: string | null }) {
  const t = useTranslations("fuelFiles");
  const tIssues = useTranslations("errors.codes");
  const locale = useLocale() as Locale;
  const showError = useStableErrorToast();
  const [status, setStatus] = useState<FuelBatchStatus | typeof ALL>(ALL);
  const [paged, setPaged] = useState<PagedBatches | null>(null);
  const [more, setMore] = useState(false);
  const batches = paged ? paged.lists[0]! : null;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(initialOpen);
  useEffect(() => {
    if (initialOpen) setOpen(initialOpen);
  }, [initialOpen]);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const viewer = user ? { id: user.id, role: user.role } : null;

  const filter = useMemo(() => (status === ALL ? {} : { status }), [status]);
  const load = useCallback(async () => {
    try {
      const [list, meta] = await Promise.all([api.listFuelBatches(filter), api.fuelBatchMetadata(filter)]);
      setPaged({ lists: [list], totals: [meta.total] });
    } catch (error) {
      setPaged({ lists: [[]], totals: [0] });
      showError(error);
    }
  }, [filter, showError]);
  /** The next page (WP9 PR B review, P2: one upload can form hundreds of batches). */
  async function loadMore() {
    const offset = paged ? nextOffsets(paged)[0] : null;
    if (!paged || offset === null || offset === undefined) return;
    setMore(true);
    try {
      const page = await api.listFuelBatches({ ...filter, offset });
      setPaged({ lists: [appendPage(paged.lists[0]!, page)], totals: paged.totals });
    } catch (error) {
      showError(error);
    } finally {
      setMore(false);
    }
  }
  useEffect(() => void load(), [load, refreshKey, version]);

  const toSubmit = batches ? submittableIds(batches, selected, viewer) : [];

  async function bulkSubmit() {
    setBusy(true);
    try {
      const out = await api.bulkSubmitFuelBatches(toSubmit);
      if (out.submitted.length) toast.success(t("batches.bulkSubmitted", { count: formatNumber(out.submitted.length, locale) }));
      for (const f of out.failed) {
        const b = batches?.find((x) => x.id === f.batchId);
        toast.error(t("batches.bulkFailed", {
          batch: b ? batchTitle(b) : f.batchId,
          reason: tIssues.has(f.code as never) ? tIssues(f.code as never) : f.code,
        }));
      }
      setSelected(new Set());
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      setVersion((v) => v + 1);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="text-base">{t("batches.title")}</CardTitle>
          <CardDescription>{t("batches.description")}</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={(v) => setStatus(v as FuelBatchStatus | typeof ALL)}>
            <SelectTrigger className="h-8 w-40" aria-label={t("batches.status")}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("batches.allStatuses")}</SelectItem>
              {FUEL_BATCH_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`batchStatus.${s}`)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" className="gap-1" disabled={busy || toSubmit.length === 0} onClick={bulkSubmit}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {t("batches.submitSelected", { count: formatNumber(toSubmit.length, locale) })}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {batches === null ? (
          <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("loading")}</div>
        ) : batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("batches.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>{t("batches.invoice")}</TableHead>
                <TableHead>{t("upload.company")}</TableHead>
                <TableHead>{t("batches.status")}</TableHead>
                <TableHead>{t("uploads.rows")}</TableHead>
                <TableHead className="text-right">tCO₂e</TableHead>
                <TableHead>{t("batches.author")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.map((b) => {
                const actions = batchActions(b, viewer);
                return (
                  <TableRow key={b.id} className="cursor-pointer" onClick={() => setOpen(b.id)}>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {actions.submit && (
                        <Checkbox
                          aria-label={t("batches.select")}
                          checked={selected.has(b.id)}
                          onCheckedChange={(on) => setSelected((s) => {
                            const next = new Set(s);
                            if (on) next.add(b.id); else next.delete(b.id);
                            return next;
                          })}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-xs">{batchTitle(b)}</div>
                      <div className="text-xs text-muted-foreground">{b.accountCode} · {t(`usages.${b.usage}`)}</div>
                      {b.hasSiblings && <Badge variant="outline" className="mt-1">{t("batches.siblings")}</Badge>}
                    </TableCell>
                    <TableCell>{b.subsidiaryName}</TableCell>
                    <TableCell className="space-x-1">
                      <Badge variant="outline">{t(`batchStatus.${b.status}`)}</Badge>
                      {isRevised(b) && <Badge className="bg-amber-500/15 text-amber-700">{t("batches.revised")}</Badge>}
                      {b.evidenceCount === 0 && actions.submit && <Badge variant="outline" className="text-amber-700">{t("batches.noFiles")}</Badge>}
                    </TableCell>
                    <TableCell><RowCount count={{ rows: b.rowCount, litres: b.litres }} /></TableCell>
                    <TableCell className="text-right tabular-nums">{b.tCo2e === null ? "—" : formatComputedAmount(b.tCo2e, locale)}</TableCell>
                    <TableCell className="text-sm">
                      <div>{b.createdByName ?? "—"}</div>
                      {b.uploaders.some((u) => u.id !== b.createdBy) && (
                        <div className="text-xs text-muted-foreground">
                          {t("batches.uploadedBy", { names: b.uploaders.map((u) => u.name ?? "—").join(", ") })}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {paged && hasMoreBatches(paged) && (
          <div className="flex items-center justify-between gap-2 border-t p-3 text-sm text-muted-foreground">
            <span>{t("batches.shownOf", { shown: formatNumber(shownOf(paged).shown, locale), total: formatNumber(shownOf(paged).total, locale) })}</span>
            <Button size="sm" variant="outline" disabled={more} onClick={() => void loadMore()} data-testid="batches-more">
              {more && <Loader2 className="h-4 w-4 animate-spin" />}{t("batches.loadMore")}
            </Button>
          </div>
        )}
      </CardContent>
      <BatchSheet batchId={open} viewer={viewer} onClose={() => setOpen(null)} onChanged={() => setVersion((v) => v + 1)} />
    </Card>
  );
}
