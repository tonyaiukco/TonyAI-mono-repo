"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useStableErrorToast } from "@/lib/i18n/hooks";
import { formatComputedAmount, formatNumber } from "@/lib/i18n/number";
import { batchActions, batchTitle, hasMoreBatches, isRevised, nextCursors, periodsLabel, shownOf, withPage, type PagedBatches } from "@/lib/fuel-batch-view";
import { reviewBatchFilters, waitingLabel } from "@/lib/review-view";
import { FUEL_BATCH_PAGE, LOCALE_FORMAT_TAGS, type AuthUser, type Locale } from "@/lib/types";
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
  const tReview = useTranslations("review");
  const locale = useLocale() as Locale;
  const showError = useStableErrorToast();
  const [paged, setPaged] = useState<PagedBatches | null>(null);
  const [more, setMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const seq = useRef(0);
  const viewer = { id: user.id, role: user.role };

  const filters = useMemo(() => reviewBatchFilters({ subsidiaryId, showAll }), [subsidiaryId, showAll]);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setRefreshing(true);
    try {
      const [lists, totals] = await Promise.all([
        Promise.all(filters.map((f) => api.listFuelBatches(f))),
        Promise.all(filters.map((f) => api.fuelBatchMetadata(f).then((m) => m.total))),
      ]);
      if (mine !== seq.current) return;
      setPaged({ lists, totals });
    } catch (error) {
      if (mine !== seq.current) return;
      setPaged({ lists: filters.map(() => []), totals: filters.map(() => 0) });
      showError(error);
    } finally {
      if (mine === seq.current) setRefreshing(false);
    }
  }, [filters, showError]);
  useEffect(() => void load(), [load, refreshKey]);

  /** The next page of each list that has more (WP9 PR B review, P2). */
  async function loadMore() {
    const base = paged;
    if (!base || refreshing) return;
    const mine = seq.current;
    setMore(true);
    try {
      const cursors = nextCursors(base);
      const pages = await Promise.all(filters.map((f, i) => (cursors[i] === null ? Promise.resolve(null) : api.listFuelBatches({ ...f, after: cursors[i]! }))));
      if (mine !== seq.current) return;
      // Appended only to the lists their cursors came from (fourth review of the branch, P2).
      setPaged((now) => (now === base ? pages.reduce((acc, page, i) => (acc && page ? withPage(acc, i, page, FUEL_BATCH_PAGE) : acc), now) : now));
    } catch (error) {
      showError(error);
    } finally {
      setMore(false);
    }
  }

  const batches = paged
    ? paged.lists.flat().sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "") || a.id.localeCompare(b.id))
    : null;

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
                <TableHead>{t("review.periods")}</TableHead>
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
                    <div className="text-xs text-muted-foreground">{t(`sources.${b.source}`)} · {b.accountCode} · {t(`usages.${b.usage}`)}</div>
                  </TableCell>
                  {/* What the batch covers and how long it has waited, without opening it (opening takes it into review; D10). */}
                  <TableCell className="text-sm">
                    <div>{periodsLabel(b.periods, LOCALE_FORMAT_TAGS[locale]) || "—"}</div>
                    {/* Waiting, as the Records list says it (the same helper and words). */}
                    <div className="text-xs text-muted-foreground" data-testid="review-batch-waiting">{waitingLabel(b.submittedAt, { t: tReview, locale })}</div>
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
        {paged && hasMoreBatches(paged) && (
          <div className="flex items-center justify-between gap-2 border-t p-3 text-sm text-muted-foreground">
            <span>{t("batches.shownOf", { shown: formatNumber(shownOf(paged).shown, locale), total: formatNumber(shownOf(paged).total, locale) })}</span>
            <Button size="sm" variant="outline" disabled={more || refreshing} onClick={() => void loadMore()} data-testid="review-batches-more">
              {more && <Loader2 className="h-4 w-4 animate-spin" />}{t("batches.loadMore")}
            </Button>
          </div>
        )}
      </CardContent>
      <BatchSheet
        batchId={open}
        viewer={viewer}
        takeIntoReview
        onClose={() => setOpen(null)}
        onOpenBatch={(id) => setOpen(id)}
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
