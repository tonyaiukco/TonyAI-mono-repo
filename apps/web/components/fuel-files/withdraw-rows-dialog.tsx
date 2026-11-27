"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useStableErrorToast } from "@/lib/i18n/hooks";
import { formatNumber } from "@/lib/i18n/number";
import { withdrawChoices, withdrawRequest, type WithdrawChoice } from "@/lib/fuel-files-view";
import type { FuelUploadDTO, Locale } from "@/lib/types";
import { formatLitres } from "./common";

/**
 * Withdraw an upload's rows in no batch — one account's, or those waiting for
 * one fuel name — with a reason (C14, D13; WP9 PR B review, P2). The rows are
 * kept, out of every sum. An associate's excluded rows are withdrawn this way
 * once it becomes a controlled company, before the file is uploaded again (C20).
 */
export function WithdrawRowsDialog({ upload, onClose, onDone }: { upload: FuelUploadDTO | null; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("fuelFiles");
  const tCommon = useTranslations("common");
  const locale = useLocale() as Locale;
  const showError = useStableErrorToast();
  const [choices, setChoices] = useState<WithdrawChoice[] | null>(null);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setChoices(null);
    setValue("");
    setReason("");
    if (!upload) return;
    let live = true;
    api
      .fuelWithdrawable(upload.id)
      .then((w) => live && setChoices(withdrawChoices(w)))
      .catch((error) => {
        if (!live) return;
        setChoices([]);
        showError(error);
      });
    return () => {
      live = false;
    };
  }, [upload, showError]);

  const label = (c: WithdrawChoice) => {
    const count = `${t(c.rows === 1 ? "rowsOne" : "rowsMany", { count: formatNumber(c.rows, locale) })} · ${t("litres", { litres: formatLitres(c.litres, locale) })}`;
    if (c.kind === "fuel") return `${t("uploads.withdrawFuelName", { name: c.rawName })} · ${count}`;
    const excluded = c.excluded > 0 ? ` · ${t("uploads.withdrawExcluded", { count: formatNumber(c.excluded, locale) })}` : "";
    return `${c.name ? `${c.code} — ${c.name}` : c.code} · ${count}${excluded}`;
  };

  async function withdraw() {
    if (!upload || !choices) return;
    const request = withdrawRequest(choices, value, reason);
    if (!request) return;
    setBusy(true);
    try {
      await api.withdrawFuelRows(upload.id, request);
      toast.success(t("uploads.rowsWithdrawn"));
      onDone();
      onClose();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={upload !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("uploads.withdrawTitle")}</DialogTitle>
          <DialogDescription>{t("uploads.withdrawDescription")}</DialogDescription>
        </DialogHeader>
        {choices === null ? (
          <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("loading")}</div>
        ) : choices.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="withdraw-rows-none">{t("uploads.withdrawNone")}</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="withdraw-rows-choice">{t("uploads.withdrawChoose")}</Label>
              <Select value={value} onValueChange={setValue}>
                <SelectTrigger id="withdraw-rows-choice" aria-label={t("uploads.withdrawChoose")}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {choices.map((c) => <SelectItem key={c.value} value={c.value}>{label(c)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="withdraw-rows-reason">{t("uploads.withdrawReason")}</Label>
              <Textarea id="withdraw-rows-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tCommon("cancel")}</Button>
          <Button variant="destructive" disabled={busy || !choices || withdrawRequest(choices, value, reason) === null} onClick={() => void withdraw()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{t("uploads.withdraw")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
