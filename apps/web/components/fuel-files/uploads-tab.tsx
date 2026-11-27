"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { toast } from "sonner";
import { Hand, Loader2, RotateCcw, Layers, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useStableErrorToast } from "@/lib/i18n/hooks";
import { formatNumber } from "@/lib/i18n/number";
import { formUntilDone } from "@/lib/fuel-upload-view";
import { uploadActions } from "@/lib/fuel-files-view";
import { FUEL_UPLOAD_PAGE, fuelUploadCursor, type FuelUploadDTO, type Locale, type UserRole } from "@/lib/types";
import { HeldRows, RowCount } from "./common";
import { WithdrawRowsDialog } from "./withdraw-rows-dialog";

/** Uploads (D16): each applied file, its rows by state, held rows by reason; "try again", forming, and a masterkey's takeover. */
export function UploadsTab({ role, refreshKey }: { role: UserRole | undefined; refreshKey: number }) {
  const t = useTranslations("fuelFiles");
  const locale = useLocale() as Locale;
  const showError = useStableErrorToast();
  const [uploads, setUploads] = useState<FuelUploadDTO[] | null>(null);
  /** A full last page may have more after it (WP9 PR B review, P2: the list was cut at 100). */
  const [maybeMore, setMaybeMore] = useState(false);
  const [more, setMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<FuelUploadDTO | null>(null);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    // While the first page is read again, no further page is asked for: its cursor would come from the old list.
    setRefreshing(true);
    try {
      const page = await api.listFuelUploads();
      if (mine !== seq.current) return;
      setUploads(page);
      setMaybeMore(page.length === FUEL_UPLOAD_PAGE);
    } catch (error) {
      if (mine !== seq.current) return;
      setUploads([]);
      setMaybeMore(false);
      showError(error);
    } finally {
      if (mine === seq.current) setRefreshing(false);
    }
  }, [showError]);

  async function loadMore() {
    const base = uploads;
    const last = base?.[base.length - 1];
    if (!base || !last || refreshing) return;
    const mine = seq.current;
    setMore(true);
    try {
      const page = await api.listFuelUploads(fuelUploadCursor(last));
      if (mine !== seq.current) return;
      // Appended only to the list its cursor came from (third review of the branch, P2).
      setUploads((now) => {
        if (now !== base) return now;
        const seen = new Set(now.map((u) => u.id));
        return [...now, ...page.filter((u) => !seen.has(u.id))];
      });
      setMaybeMore(page.length === FUEL_UPLOAD_PAGE);
    } catch (error) {
      showError(error);
    } finally {
      setMore(false);
    }
  }
  useEffect(() => void load(), [load, refreshKey]);

  async function form(upload: FuelUploadDTO, retryHeld: boolean) {
    setBusy(upload.id);
    try {
      let first = retryHeld;
      const out = await formUntilDone(() => {
        const body = first ? { retryHeld: true } : {};
        first = false;
        return api.formFuelBatches(upload.id, body);
      });
      toast.success(t("upload.formed", { formed: formatNumber(out.formed, locale), joined: formatNumber(out.joined, locale) }));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
      void load();
    }
  }

  async function takeOver(upload: FuelUploadDTO) {
    setBusy(upload.id);
    try {
      await api.takeOverFuelRows(upload.id);
      toast.success(t("uploads.takenOver"));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
      void load();
    }
  }

  if (uploads === null) {
    return <div className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("loading")}</div>;
  }
  if (uploads.length === 0) {
    return <Card><CardContent className="p-6 text-muted-foreground">{t("uploads.empty")}</CardContent></Card>;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("uploads.title")}</CardTitle>
        <CardDescription>{t("uploads.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("uploads.file")}</TableHead>
              <TableHead>{t("uploads.uploadedBy")}</TableHead>
              <TableHead>{t("uploads.rows")}</TableHead>
              <TableHead>{t("uploads.heldByReason")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {uploads.map((u) => {
              const actions = uploadActions(u, role);
              return (
                <TableRow key={u.id}>
                  <TableCell>
                    <div className="font-medium">{u.fileName}</div>
                    <div className="text-xs text-muted-foreground">
                      {t(`sources.${u.source}`)} · {new Date(u.createdAt).toLocaleString(locale)}
                    </div>
                  </TableCell>
                  <TableCell>{u.uploadedByName ?? "—"}</TableCell>
                  <TableCell className="space-y-1 text-sm">
                    <div className="text-muted-foreground">
                      {t("uploads.readLine", {
                        read: formatNumber(u.rowsRead, locale),
                        refused: formatNumber(u.rowsRefused, locale),
                        duplicates: formatNumber(u.rowsDuplicate, locale),
                      })}
                    </div>
                    {(["assigned", "ready", "waiting_account", "waiting_fuel", "excluded"] as const)
                      .filter((s) => u.rows[s].rows > 0)
                      .map((s) => (
                        <div key={s} className="flex flex-wrap gap-2">
                          <Badge variant="outline">{t(`rowStates.${s}`)}</Badge>
                          <RowCount count={u.rows[s]} />
                        </div>
                      ))}
                  </TableCell>
                  <TableCell><HeldRows held={u.held} /></TableCell>
                  <TableCell className="space-x-2 whitespace-nowrap text-right">
                    {actions.form && (
                      <Button size="sm" className="gap-1" disabled={busy !== null} onClick={() => form(u, false)}>
                        {busy === u.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
                        {t("uploads.form")}
                      </Button>
                    )}
                    {actions.retry && (
                      <Button size="sm" variant="outline" className="gap-1" disabled={busy !== null} onClick={() => form(u, true)}>
                        <RotateCcw className="h-4 w-4" />
                        {t("uploads.retry")}
                      </Button>
                    )}
                    {actions.withdraw && (
                      <Button size="sm" variant="outline" className="gap-1" disabled={busy !== null} onClick={() => setWithdrawing(u)} data-testid="upload-withdraw-rows">
                        <Undo2 className="h-4 w-4" />
                        {t("uploads.withdraw")}
                      </Button>
                    )}
                    {actions.takeOver && (
                      <Button size="sm" variant="outline" className="gap-1" disabled={busy !== null} onClick={() => takeOver(u)}>
                        <Hand className="h-4 w-4" />
                        {t("uploads.takeOver")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {maybeMore && (
          <div className="flex justify-end border-t pt-3">
            <Button size="sm" variant="outline" disabled={more || refreshing} onClick={() => void loadMore()} data-testid="uploads-more">
              {more && <Loader2 className="h-4 w-4 animate-spin" />}{t("batches.loadMore")}
            </Button>
          </div>
        )}
      </CardContent>
      <WithdrawRowsDialog upload={withdrawing} onClose={() => setWithdrawing(null)} onDone={() => void load()} />
    </Card>
  );
}
