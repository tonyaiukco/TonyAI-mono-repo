"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { toast } from "sonner";
import { CopyCheck, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useErrorToast } from "@/lib/i18n/hooks";
import { formatNumber } from "@/lib/i18n/number";
import {
  FILE_FUELS,
  FUEL_SOURCES,
  FUEL_UPLOAD_MAX_SIZE_BYTES,
  FUEL_USAGES,
  PERIOD_VALUES,
  isFuelCardSource, selectableReportingYears,
  type FormFuelBatchesResultDTO,
  type FuelFilePreviewDTO,
  type FuelSource,
  type FuelUsage,
  type Locale,
} from "@/lib/types";
import {
  canApply,
  companyLabel,
  copyToAll,
  declarationsOf,
  deliveriesToDeclare,
  formUntilDone,
  formsAfterApply,
  initialUsage,
  previewTotals,
  type DeliveryChoice,
} from "@/lib/fuel-upload-view";
import { HeldRows, RowCount } from "./common";

const MAX_SHOWN_ISSUES = 20;

/**
 * Upload (D3, D16): a file is read first and nothing is stored; the apply
 * names the digest of the file the preview read; then batches are formed in
 * steps while rows are processable.
 */
export function UploadTab({ onApplied }: { onApplied: () => void }) {
  const t = useTranslations("fuelFiles");
  const tIssues = useTranslations("errors.bulkUploadIssues");
  const tMonths = useTranslations("periods.values");
  const locale = useLocale() as Locale;
  const showError = useErrorToast();
  const input = useRef<HTMLInputElement>(null);

  const [source, setSource] = useState<FuelSource>("petrol_ofisi");
  const [usage, setUsage] = useState<FuelUsage | null>(initialUsage("petrol_ofisi"));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<FuelFilePreviewDTO | null>(null);
  const [choices, setChoices] = useState<Record<string, DeliveryChoice>>({});
  const [busy, setBusy] = useState<"reading" | "applying" | "forming" | null>(null);
  const [result, setResult] = useState<FormFuelBatchesResultDTO | null>(null);
  const [formed, setFormed] = useState({ formed: 0, joined: 0 });

  const reset = (next?: { source?: FuelSource }) => {
    setPreview(null);
    setChoices({});
    setResult(null);
    if (next?.source) {
      setSource(next.source);
      setUsage(initialUsage(next.source));
    }
  };

  async function read() {
    if (!file) return;
    if (file.size > FUEL_UPLOAD_MAX_SIZE_BYTES) {
      toast.error(t("upload.tooLarge", { megabytes: formatNumber(FUEL_UPLOAD_MAX_SIZE_BYTES / 1024 / 1024, locale) }));
      return;
    }
    setBusy("reading");
    setResult(null);
    try {
      setPreview(await api.previewFuelFile(file, { source, usage: usage ?? undefined }));
      setChoices({});
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!file || !preview || !canApply(preview, usage, choices)) return;
    setBusy("applying");
    try {
      const upload = await api.applyFuelFile(file, {
        source,
        usage: usage ?? undefined,
        fileSha256: preview.fileSha256,
        declarations: isFuelCardSource(source) ? undefined : declarationsOf(preview, choices)!,
      });
      toast.success(t("upload.applied", { rows: formatNumber(upload.rowsRead - upload.rowsRefused - upload.rowsDuplicate, locale) }));
      if (!formsAfterApply(upload)) {
        // Nothing to form now: every row already stored, waiting or excluded.
        toast.info(t("upload.nothingToForm"));
        setPreview(null);
        setFile(null);
        if (input.current) input.current.value = "";
        onApplied();
        return;
      }
      setBusy("forming");
      setFormed({ formed: 0, joined: 0 });
      const out = await formUntilDone(
        () => api.formFuelBatches(upload.id),
        (step) => {
          setResult(step);
          setFormed((f) => ({ formed: f.formed + step.formedBatches, joined: f.joined + step.joinedBatches }));
        },
      );
      toast.success(t("upload.formed", { formed: formatNumber(out.formed, locale), joined: formatNumber(out.joined, locale) }));
      setPreview(null);
      setFile(null);
      if (input.current) input.current.value = "";
      onApplied();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  const totals = preview ? previewTotals(preview) : null;
  const toDeclare = preview ? deliveriesToDeclare(preview) : [];
  const card = isFuelCardSource(source);
  // The same window as every year picker: this year and the ten before it (WP9 PR B review, P3).
  const years = selectableReportingYears();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("upload.title")}</CardTitle>
          <CardDescription>{t("upload.description")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="fuel-source">{t("upload.source")}</Label>
            <Select value={source} onValueChange={(v) => reset({ source: v as FuelSource })} disabled={busy !== null}>
              <SelectTrigger id="fuel-source"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FUEL_SOURCES.map((s) => <SelectItem key={s} value={s}>{t(`sources.${s}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {card && (
            <div className="space-y-2">
              <Label htmlFor="fuel-usage">{t("upload.usage")}</Label>
              <Select value={usage ?? undefined} onValueChange={(v) => { setUsage(v as FuelUsage); setPreview(null); }} disabled={busy !== null}>
                <SelectTrigger id="fuel-usage"><SelectValue placeholder={t("upload.choose")} /></SelectTrigger>
                <SelectContent>
                  {FUEL_USAGES.map((u) => <SelectItem key={u} value={u}>{t(`usages.${u}`)}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("upload.usageHint")}</p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="fuel-file">{t("upload.file")}</Label>
            <Input
              id="fuel-file"
              ref={input}
              type="file"
              accept=".xlsx"
              disabled={busy !== null}
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset(); }}
            />
          </div>
          <div className="md:col-span-3 flex gap-2">
            <Button onClick={read} disabled={!file || busy !== null || (card && !usage)} className="gap-2">
              {busy === "reading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
              {t("upload.read")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {preview && totals && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("upload.previewTitle", { file: preview.fileName })}</CardTitle>
            <CardDescription>
              {t("upload.previewSummary", {
                read: formatNumber(preview.rowsRead, locale),
                refused: formatNumber(preview.refused.length, locale),
                duplicates: formatNumber(preview.duplicates.length, locale),
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3 text-sm">
              {(Object.entries(totals) as Array<[keyof typeof totals, (typeof totals)[keyof typeof totals]]>)
                .filter(([, c]) => c.rows > 0)
                .map(([outcome, count]) => (
                  <div key={outcome} className="rounded-md border px-3 py-2">
                    <div className="text-muted-foreground">{t(`previewOutcomes.${outcome}`)}</div>
                    <RowCount count={count} />
                  </div>
                ))}
            </div>

            {preview.accounts.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("upload.account")}</TableHead>
                    <TableHead>{t("upload.company")}</TableHead>
                    <TableHead>{t("upload.outcome")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.accounts.map((a) => (
                    <TableRow key={a.code}>
                      <TableCell>
                        <div className="font-mono text-xs">{a.code}</div>
                        <div className="text-muted-foreground">{a.name}</div>
                      </TableCell>
                      <TableCell>
                        {a.subsidiaryId || a.subsidiaryName
                          ? companyLabel(a.subsidiaryName, t("upload.outsideScope"))
                          : a.outcomes.some((o) => o.outcome === "outside_scope")
                            ? t("upload.outsideScope")
                            : t("upload.noCompany")}
                        {a.proposed && <Badge variant="outline" className="ml-2">{t("accountStates.proposed")}</Badge>}
                      </TableCell>
                      <TableCell className="space-y-1">
                        {a.outcomes.map((o) => (
                          <div key={o.outcome} className="flex flex-wrap gap-2">
                            <span>{t(`previewOutcomes.${o.outcome}`)}</span>
                            <RowCount count={o} />
                          </div>
                        ))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {preview.unrecognisedNames.length > 0 && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                <div className="font-medium">{t("upload.unrecognised")}</div>
                <ul className="mt-1 space-y-1">
                  {preview.unrecognisedNames.map((n) => (
                    <li key={`${n.accountCode}|${n.rawName}`} className="flex flex-wrap gap-2">
                      <span className="font-mono text-xs">{n.accountCode}</span>
                      <span>“{n.rawName}”</span>
                      <RowCount count={n} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(preview.refused.length > 0 || preview.duplicates.length > 0) && (
              <div className="text-sm">
                <div className="font-medium">{t("upload.rowIssues")}</div>
                <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto text-muted-foreground">
                  {[...preview.refused, ...preview.duplicates].slice(0, MAX_SHOWN_ISSUES).map((issue, i) => (
                    <li key={`${issue.row}-${issue.code}-${i}`}>
                      {t("upload.rowIssue", { row: formatNumber(issue.row, locale), reason: tIssues(issue.code as never) })}
                    </li>
                  ))}
                </ul>
                {preview.refused.length + preview.duplicates.length > MAX_SHOWN_ISSUES && (
                  <p className="text-xs text-muted-foreground">
                    {t("upload.moreIssues", { count: formatNumber(preview.refused.length + preview.duplicates.length - MAX_SHOWN_ISSUES, locale) })}
                  </p>
                )}
              </div>
            )}

            {!card && preview.deliveries.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium">{t("upload.deliveries")}</div>
                <p className="text-xs text-muted-foreground">{t("upload.deliveriesHint")}</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("upload.documentNo")}</TableHead>
                      <TableHead>{t("upload.receiving")}</TableHead>
                      <TableHead className="text-right">{t("upload.quantity")}</TableHead>
                      <TableHead>{t("upload.fuel")}</TableHead>
                      <TableHead>{t("upload.usage")}</TableHead>
                      <TableHead>{t("upload.year")}</TableHead>
                      <TableHead>{t("upload.month")}</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.deliveries.map((d) => {
                      const choice = choices[d.documentNo] ?? {};
                      const set = (patch: DeliveryChoice) => setChoices((c) => ({ ...c, [d.documentNo]: { ...c[d.documentNo], ...patch } }));
                      const open = d.needs === "declaration";
                      return (
                        <TableRow key={d.documentNo}>
                          <TableCell className="font-mono text-xs">{d.documentNo}</TableCell>
                          <TableCell>{d.receiving}</TableCell>
                          <TableCell className="text-right"><RowCount count={{ rows: 1, litres: d.litres }} /></TableCell>
                          {open ? (
                            <>
                              <TableCell>
                                <Select value={choice.fuel} onValueChange={(v) => set({ fuel: v as DeliveryChoice["fuel"] })}>
                                  <SelectTrigger className="h-8 w-28" aria-label={t("upload.fuel")}><SelectValue placeholder={t("upload.choose")} /></SelectTrigger>
                                  <SelectContent>{FILE_FUELS.map((f) => <SelectItem key={f} value={f}>{t(`fuels.${f}`)}</SelectItem>)}</SelectContent>
                                </Select>
                              </TableCell>
                              <TableCell>
                                <Select value={choice.usage} onValueChange={(v) => set({ usage: v as FuelUsage })}>
                                  <SelectTrigger className="h-8 w-40" aria-label={t("upload.usage")}><SelectValue placeholder={t("upload.choose")} /></SelectTrigger>
                                  <SelectContent>{FUEL_USAGES.map((u) => <SelectItem key={u} value={u}>{t(`usages.${u}`)}</SelectItem>)}</SelectContent>
                                </Select>
                              </TableCell>
                              <TableCell>
                                <Select value={choice.year ? String(choice.year) : undefined} onValueChange={(v) => set({ year: Number(v) })}>
                                  <SelectTrigger className="h-8 w-24" aria-label={t("upload.year")}><SelectValue placeholder={t("upload.choose")} /></SelectTrigger>
                                  <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
                                </Select>
                              </TableCell>
                              <TableCell>
                                <Select value={choice.month ? String(choice.month) : undefined} onValueChange={(v) => set({ month: Number(v) })}>
                                  <SelectTrigger className="h-8 w-32" aria-label={t("upload.month")}><SelectValue placeholder={t("upload.choose")} /></SelectTrigger>
                                  <SelectContent>
                                    {PERIOD_VALUES.monthly.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{tMonths(m)}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </TableCell>
                              <TableCell>
                                <Button variant="ghost" size="sm" className="gap-1" onClick={() => setChoices((c) => copyToAll(preview, c, choice))}>
                                  <CopyCheck className="h-4 w-4" />
                                  {t("upload.copyToAll")}
                                </Button>
                              </TableCell>
                            </>
                          ) : (
                            <TableCell colSpan={5} className="text-muted-foreground">
                              {t(d.needs === "stored" ? "upload.deliveryStored" : "upload.deliveryRefused")}
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                {toDeclare.length > 0 && declarationsOf(preview, choices) === null && (
                  <p className="text-xs text-amber-700">{t("upload.declareAll")}</p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button onClick={apply} disabled={busy !== null || !canApply(preview, usage, choices)} className="gap-2">
                {busy === "applying" || busy === "forming" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {busy === "forming" ? t("upload.forming") : t("upload.apply")}
              </Button>
              <Button variant="ghost" onClick={() => reset()} disabled={busy !== null}>{t("upload.cancel")}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("upload.resultTitle")}</CardTitle>
            <CardDescription>
              {t("upload.resultSummary", { formed: formatNumber(formed.formed, locale), joined: formatNumber(formed.joined, locale) })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {result.processableRows > 0 && <p>{t("upload.stillProcessable", { rows: formatNumber(result.processableRows, locale) })}</p>}
            {result.held.length > 0 && (
              <div>
                <div className="font-medium">{t("upload.held")}</div>
                <HeldRows held={result.held} />
              </div>
            )}
            {result.waiting.length > 0 && (
              <div>
                <div className="font-medium">{t("upload.waiting")}</div>
                <HeldRows held={result.waiting} />
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
