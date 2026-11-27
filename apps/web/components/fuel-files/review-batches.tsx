"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useStableErrorToast } from "@/lib/i18n/hooks";
import { formatComputedAmount } from "@/lib/i18n/number";
import { batchActions, batchTitle, isRevised } from "@/lib/fuel-batch-view";
import { reviewBatchFilters } from "@/lib/review-view";
import type { AuthUser, FuelBatchDTO, Locale } from "@/lib/types";
import { BatchSheet } from "./batch-sheet";
import { RowCount } from "./common";

/** The review queue's batches (D10): longest wait first; opening one the viewer decides takes it into review. */
export function ReviewBatches({
  user,
  subsidiaryId,
  showAll,
  refreshKey,
  onChanged,
}: {
  user: AuthUser;
  subsidiaryId: string | null;
  showAll: boolean;
  refreshKey: number;
  onChanged: () => void;
}) {
  const t = useTranslations("fuelFiles");
  const locale = useLocale() as Locale;
  const showError = useStableErrorToast();
  const [batches, setBatches] = useState<FuelBatchDTO[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const seq = useRef(0);
  const viewer = { id: user.id, role: user.role };

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const lists = await Promise.all(reviewBatchFilters({ subsidiaryId, showAll }).map((f) => api.listFuelBatches(f)));
      if (mine !== seq.current) return;
      const merged = lists.flat().sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "") || a.id.localeCompare(b.id));
      setBatches(merged);
    } catch (error) {
      if (mine !== seq.current) return;
      setBatches([]);
      showError(error);
    }
  }, [subsidiaryId, showAll, showError]);
  useEffect(() => void load(), [load, refreshKey]);

  return (
    <Card>
      <CardContent className="p-0">
        {batches === null ? (
          <div className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("loading")}</div>
        ) : batches.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground" data-testid="review-batches-empty">{t("review.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("batches.invoice")}</TableHead>
                <TableHead>{t("upload.company")}</TableHead>
                <TableHead>{t("batches.status")}</TableHead>
                <TableHead>{t("uploads.rows")}</TableHead>
                <TableHead className="text-right">tCO₂e</TableHead>
                <TableHead>{t("batches.author")}</TableHead>
                <TableHead>{t("batches.decidedBy")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.map((b) => (
                <TableRow key={b.id} className="cursor-pointer" data-testid="review-batch-row" onClick={() => setOpen(b.id)}>
                  <TableCell>
                    <div className="font-mono text-xs">{batchTitle(b)}</div>
                    <div className="text-xs text-muted-foreground">{b.accountCode} · {t(`usages.${b.usage}`)}</div>
                  </TableCell>
                  <TableCell>{b.subsidiaryName}</TableCell>
                  <TableCell className="space-x-1">
                    <Badge variant="outline">{t(`batchStatus.${b.status}`)}</Badge>
                    {isRevised(b) && <Badge className="bg-amber-500/15 text-amber-700">{t("batches.revised")}</Badge>}
                  </TableCell>
                  <TableCell><RowCount count={{ rows: b.rowCount, litres: b.litres }} /></TableCell>
                  <TableCell className="text-right tabular-nums">{b.tCo2e === null ? "—" : formatComputedAmount(b.tCo2e, locale)}</TableCell>
                  <TableCell className="text-sm">{b.createdByName ?? "—"}</TableCell>
                  <TableCell className="text-sm">
                    {b.approver ? t(`batches.approver.${b.approver}`) : "—"}
                    {!batchActions(b, viewer).decide && <div className="text-xs text-muted-foreground">{t("review.notYours")}</div>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <BatchSheet
        batchId={open}
        viewer={viewer}
        takeIntoReview
        onClose={() => setOpen(null)}
        onChanged={() => {
          void load();
          onChanged();
        }}
      />
    </Card>
  );
}

/** The Batches tab's count: the same filters as the list, summed per status. */
export async function reviewBatchCount(subsidiaryId: string | null, showAll: boolean): Promise<number> {
  const counts = await Promise.all(reviewBatchFilters({ subsidiaryId, showAll }).map((f) => api.fuelBatchMetadata(f)));
  return counts.reduce((sum, c) => sum + c.total, 0);
}
