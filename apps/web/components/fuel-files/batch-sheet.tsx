"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Paperclip, RotateCcw, Send, Trash2, Undo2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useErrorToast } from "@/lib/i18n/hooks";
import { formatComputedAmount, formatNumber } from "@/lib/i18n/number";
import { batchActions, batchTitle, isRevised, type Viewer } from "@/lib/fuel-batch-view";
import {
  FILE_FUELS,
  FUEL_USAGES,
  PERIOD_VALUES,
  type FileFuel,
  type FuelBatchDetailDTO,
  type FuelBatchRowDTO,
  type FuelUsage,
  type Locale,
} from "@/lib/types";
import { formatLitres } from "./common";

const ROW_PAGE = 50;

/**
 * One batch: its records, files, rows in pages, and the steps the viewer may
 * take (D9–D13). A decision names the submission the sheet loaded, so a
 * batch recalled and resubmitted meanwhile is refused (`record_changed`) and
 * the sheet reloads. `takeIntoReview`: opening it from the review queue
 * takes a submitted batch into review, which closes its recall.
 */
export function BatchSheet({
  batchId,
  viewer,
  takeIntoReview = false,
  onClose,
  onChanged,
}: {
  batchId: string | null;
  viewer: Viewer | null;
  takeIntoReview?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("fuelFiles");
  const tMonths = useTranslations("periods.values");
  const tStatus = useTranslations("recordStatus.label");
  const tTypes = useTranslations("dataEntry.activityTypes");
  const locale = useLocale() as Locale;
  const showError = useErrorToast();
  const [batch, setBatch] = useState<FuelBatchDetailDTO | null>(null);
  const [rows, setRows] = useState<{ rows: FuelBatchRowDTO[]; total: number; offset: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [variance, setVariance] = useState("");
  const [declared, setDeclared] = useState<{ usage?: FuelUsage; fuel?: FileFuel; year?: number; month?: number }>({});
  const file = useRef<HTMLInputElement>(null);
  const opened = useRef<string | null>(null);

  const load = useCallback(async (id: string) => {
    const detail = await api.getFuelBatch(id);
    setBatch(detail);
    setDeclared({ usage: detail.usage });
    return detail;
  }, []);

  const loadRows = useCallback(async (id: string, offset: number) => {
    const page = await api.fuelBatchRows(id, { offset, limit: ROW_PAGE });
    setRows({ ...page, offset });
  }, []);

  useEffect(() => {
    setBatch(null);
    setRows(null);
    setReason("");
    setVariance("");
    if (!batchId) return;
    (async () => {
      try {
        let detail = await load(batchId);
        if (takeIntoReview && detail.status === "submitted" && batchActions(detail, viewer).decide && opened.current !== batchId) {
          opened.current = batchId;
          detail = await api.reviewFuelBatch(batchId, { seenSubmittedAt: detail.submittedAt });
          setBatch(detail);
          onChanged();
        }
        await loadRows(batchId, 0);
      } catch (error) {
        showError(error);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  async function run(step: () => Promise<FuelBatchDetailDTO | unknown>, done: string, close = false) {
    if (!batch) return;
    setBusy(true);
    try {
      const out = await step();
      toast.success(done);
      onChanged();
      if (close) onClose();
      else if (out && typeof out === "object" && "records" in (out as object)) setBatch(out as FuelBatchDetailDTO);
      else await load(batch.id);
    } catch (error) {
      showError(error);
      // A stale answer (recalled, resubmitted, decided elsewhere): show the batch as it is now.
      await load(batch.id).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const actions = batch ? batchActions(batch, viewer) : null;
  const tanker = batch?.source === "tanker";
  const seen = batch?.submittedAt ?? null;

  return (
    <Sheet open={batchId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        {!batch || !actions ? (
          <div className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("loading")}</div>
        ) : (
          <div className="space-y-5 p-1">
            <SheetHeader>
              <SheetTitle className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{batchTitle(batch)}</span>
                <Badge variant="outline">{t(`batchStatus.${batch.status}`)}</Badge>
                {isRevised(batch) && <Badge className="bg-amber-500/15 text-amber-700">{t("batches.revised")}</Badge>}
                {batch.hasSiblings && <Badge variant="outline">{t("batches.siblings")}</Badge>}
              </SheetTitle>
              <SheetDescription>
                {t("batches.line", {
                  company: batch.subsidiaryName,
                  account: batch.accountCode,
                  source: t(`sources.${batch.source}`),
                  usage: t(`usages.${batch.usage}`),
                })}
              </SheetDescription>
            </SheetHeader>

            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-muted-foreground">{t("batches.author")}</dt><dd>{batch.createdByName ?? "—"}</dd></div>
              <div>
                <dt className="text-muted-foreground">{t("batches.uploaders")}</dt>
                <dd>{batch.uploaders.map((u) => u.name ?? "—").join(", ") || "—"}</dd>
              </div>
              {batch.reportingSubsidiaryName && (
                <div><dt className="text-muted-foreground">{t("batches.reporting")}</dt><dd>{batch.reportingSubsidiaryName}</dd></div>
              )}
              {batch.approver && <div><dt className="text-muted-foreground">{t("batches.decidedBy")}</dt><dd>{t(`batches.approver.${batch.approver}`)}</dd></div>}
              <div>
                <dt className="text-muted-foreground">{t("batches.total")}</dt>
                <dd className="tabular-nums">
                  {t("litres", { litres: formatLitres(batch.litres, locale) })}
                  {batch.tCo2e !== null && ` · ${formatComputedAmount(batch.tCo2e, locale)} tCO₂e`}
                </dd>
              </div>
              {batch.reviewNote && <div className="col-span-2"><dt className="text-muted-foreground">{t("batches.returnReason")}</dt><dd>{batch.reviewNote}</dd></div>}
              {batch.varianceReason && <div className="col-span-2"><dt className="text-muted-foreground">{t("batches.varianceReason")}</dt><dd>{batch.varianceReason}</dd></div>}
              {batch.withdrawnReason && <div className="col-span-2"><dt className="text-muted-foreground">{t("batches.withdrawReason")}</dt><dd>{batch.withdrawnReason}</dd></div>}
            </dl>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t("batches.records")}</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("upload.month")}</TableHead>
                    <TableHead>{t("upload.fuel")}</TableHead>
                    <TableHead className="text-right">{t("upload.quantity")}</TableHead>
                    <TableHead className="text-right">tCO₂e</TableHead>
                    <TableHead>{t("batches.status")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batch.records.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{tMonths(PERIOD_VALUES.monthly[r.month - 1]!)} {r.reportingYear}</TableCell>
                      <TableCell>{tTypes.has(r.activityType as never) ? tTypes(r.activityType as never) : r.activityType}</TableCell>
                      <TableCell className="text-right tabular-nums">{t("litres", { litres: formatLitres(r.litres, locale) })}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.tCo2e === null ? "—" : formatComputedAmount(r.tCo2e, locale)}</TableCell>
                      <TableCell>{tStatus(r.status)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t("batches.files")}</h3>
              {batch.evidence.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("batches.noFiles")}</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {batch.evidence.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-2">
                      <button type="button" className="truncate text-left text-primary hover:underline"
                        onClick={() => api.getEvidenceUrl(e.id).then((u) => window.open(u.url, "_blank", "noopener")).catch(showError)}>
                        {e.fileName}
                      </button>
                      {actions.files && (
                        <Button size="sm" variant="ghost" disabled={busy} aria-label={t("batches.detach")}
                          onClick={() => run(() => api.detachFuelBatchEvidence(batch.id, e.id), t("batches.detached"))}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {actions.files && (
                <div className="flex items-center gap-2">
                  <Input ref={file} type="file" className="max-w-xs" disabled={busy} />
                  <Button size="sm" variant="outline" className="gap-1" disabled={busy}
                    onClick={() => {
                      const chosen = file.current?.files?.[0];
                      if (!chosen) return;
                      void run(() => api.uploadFuelBatchEvidence(batch.id, chosen), t("batches.attached")).then(() => {
                        if (file.current) file.current.value = "";
                      });
                    }}>
                    <Paperclip className="h-4 w-4" />
                    {t("batches.attach")}
                  </Button>
                </div>
              )}
            </section>

            {rows && (
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("batches.rows", { total: formatNumber(rows.total, locale) })}</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("batches.when")}</TableHead>
                      <TableHead>{t("tray.rawName")}</TableHead>
                      <TableHead className="text-right">{t("upload.quantity")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.rows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="tabular-nums">{r.transactionAt?.replace("T", " ") ?? `${r.year}-${String(r.month).padStart(2, "0")}`}</TableCell>
                        <TableCell>{r.rawFuel}</TableCell>
                        <TableCell className="text-right tabular-nums">{t("litres", { litres: formatLitres(r.litres, locale) })}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-end gap-2">
                  <Button size="sm" variant="outline" disabled={rows.offset === 0} onClick={() => loadRows(batch.id, Math.max(rows.offset - ROW_PAGE, 0)).catch(showError)}>
                    {t("batches.previous")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={rows.offset + ROW_PAGE >= rows.total} onClick={() => loadRows(batch.id, rows.offset + ROW_PAGE).catch(showError)}>
                    {t("batches.next")}
                  </Button>
                </div>
              </section>
            )}

            {actions.declarations && (
              <section className="space-y-2 rounded-md border p-3">
                <h3 className="text-sm font-medium">{t("batches.declarations")}</h3>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label>{t("upload.usage")}</Label>
                    <Select value={declared.usage} onValueChange={(v) => setDeclared((d) => ({ ...d, usage: v as FuelUsage }))}>
                      <SelectTrigger className="h-8 w-48"><SelectValue /></SelectTrigger>
                      <SelectContent>{FUEL_USAGES.map((u) => <SelectItem key={u} value={u}>{t(`usages.${u}`)}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  {tanker && (
                    <>
                      <div className="space-y-1">
                        <Label>{t("upload.fuel")}</Label>
                        <Select value={declared.fuel} onValueChange={(v) => setDeclared((d) => ({ ...d, fuel: v as FileFuel }))}>
                          <SelectTrigger className="h-8 w-28"><SelectValue placeholder={t("upload.choose")} /></SelectTrigger>
                          <SelectContent>{FILE_FUELS.map((f) => <SelectItem key={f} value={f}>{t(`fuels.${f}`)}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label>{t("upload.year")}</Label>
                        <Input type="number" className="h-8 w-24" value={declared.year ?? ""} onChange={(e) => setDeclared((d) => ({ ...d, year: e.target.value ? Number(e.target.value) : undefined }))} />
                      </div>
                      <div className="space-y-1">
                        <Label>{t("upload.month")}</Label>
                        <Select value={declared.month ? String(declared.month) : undefined} onValueChange={(v) => setDeclared((d) => ({ ...d, month: Number(v) }))}>
                          <SelectTrigger className="h-8 w-32"><SelectValue placeholder={t("upload.choose")} /></SelectTrigger>
                          <SelectContent>{PERIOD_VALUES.monthly.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{tMonths(m)}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                    </>
                  )}
                  <Button size="sm" variant="outline" disabled={busy || !declared.usage}
                    onClick={() => run(() => api.changeFuelBatchDeclarations(batch.id, {
                      usage: declared.usage!,
                      ...(tanker && declared.fuel ? { fuel: declared.fuel } : {}),
                      ...(tanker && declared.year ? { year: declared.year } : {}),
                      ...(tanker && declared.month ? { month: declared.month } : {}),
                    }), t("batches.declared"))}>
                    {t("batches.saveDeclarations")}
                  </Button>
                </div>
              </section>
            )}

            {(actions.submit || actions.recall || actions.withdraw || actions.decide) && (
              <section className="space-y-3 rounded-md border p-3">
                {actions.submit && (
                  <div className="space-y-2">
                    <Label htmlFor="batch-variance">{t("batches.varianceLabel")}</Label>
                    <Input id="batch-variance" value={variance} maxLength={500} onChange={(e) => setVariance(e.target.value)} placeholder={t("batches.variancePlaceholder")} />
                  </div>
                )}
                {(actions.withdraw || actions.decide) && (
                  <div className="space-y-2">
                    <Label htmlFor="batch-reason">{actions.decide ? t("batches.returnReason") : t("batches.withdrawReason")}</Label>
                    <Textarea id="batch-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {actions.submit && (
                    <Button className="gap-1" disabled={busy}
                      onClick={() => run(() => api.submitFuelBatch(batch.id, variance.trim() ? { varianceReason: variance.trim() } : {}), t("batches.submitted"))}>
                      <Send className="h-4 w-4" />{t("batches.submit")}
                    </Button>
                  )}
                  {actions.recall && (
                    <Button variant="outline" className="gap-1" disabled={busy} onClick={() => run(() => api.recallFuelBatch(batch.id), t("batches.recalled"))}>
                      <Undo2 className="h-4 w-4" />{t("batches.recall")}
                    </Button>
                  )}
                  {actions.withdraw && (
                    <Button variant="outline" className="gap-1 text-red-700" disabled={busy || reason.trim() === ""}
                      onClick={() => run(() => api.withdrawFuelBatch(batch.id, { reason: reason.trim() }), t("batches.withdrawn"), true)}>
                      <RotateCcw className="h-4 w-4" />{t("batches.withdraw")}
                    </Button>
                  )}
                  {actions.decide && (
                    <>
                      <Button className="gap-1" disabled={busy}
                        onClick={() => run(() => api.approveFuelBatch(batch.id, { seenSubmittedAt: seen }), t("batches.approved"), true)}>
                        <CheckCircle2 className="h-4 w-4" />{t("batches.approve")}
                      </Button>
                      <Button variant="outline" className="gap-1 text-red-700" disabled={busy || reason.trim() === ""}
                        onClick={() => run(() => api.rejectFuelBatch(batch.id, { varianceReason: reason.trim(), seenSubmittedAt: seen }), t("batches.returned"), true)}>
                        <XCircle className="h-4 w-4" />{t("batches.return")}
                      </Button>
                    </>
                  )}
                </div>
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
