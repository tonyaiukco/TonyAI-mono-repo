"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { toast } from "sonner";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useStableErrorToast } from "@/lib/i18n/hooks";
import { companyName, mayAddAccounts } from "@/lib/fuel-files-view";
import type { FuelTrayDTO, UserRole } from "@/lib/types";
import { useMappableCompanies } from "./accounts-tab";
import { RowCount } from "./common";

/**
 * Unmatched (D16): rows waiting for an account mapping or a recognised fuel
 * name. Confirming an account releases its rows; the page then forms them
 * from Uploads (their holder's step).
 */
export function TrayTab({ role, refreshKey, onChanged }: { role: UserRole | undefined; refreshKey: number; onChanged: () => void }) {
  const t = useTranslations("fuelFiles");
  const showError = useStableErrorToast();
  const companies = useMappableCompanies();
  const [tray, setTray] = useState<FuelTrayDTO | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTray(await api.fuelTray());
    } catch (error) {
      setTray({ accounts: [], fuelNames: [] });
      showError(error);
    }
  }, [showError]);
  useEffect(() => void load(), [load, refreshKey]);

  async function confirm(accountId: string, subsidiaryId: string, code: string) {
    setBusy(accountId);
    try {
      await api.confirmFuelAccount(accountId, { subsidiaryId });
      toast.success(t("accounts.confirmed", { code }));
      onChanged();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
      void load();
    }
  }

  if (tray === null) {
    return <div className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("loading")}</div>;
  }
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("tray.accountsTitle")}</CardTitle>
          <CardDescription>{t("tray.accountsDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {tray.accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("tray.noAccounts")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("upload.account")}</TableHead>
                  <TableHead>{t("tray.proposal")}</TableHead>
                  <TableHead>{t("uploads.rows")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tray.accounts.map((a) => (
                  <TableRow key={a.accountId}>
                    <TableCell>
                      <div className="font-mono text-xs">{a.code}</div>
                      <div className="text-muted-foreground">{a.name} · {t(`sources.${a.source}`)}</div>
                    </TableCell>
                    <TableCell>
                      {a.proposedSubsidiaryName ?? (a.proposedSubsidiaryId ? t("upload.outsideScope") : t("upload.noCompany"))}
                      {a.proposedSubsidiaryId && <Badge variant="outline" className="ml-2">{t("accountStates.proposed")}</Badge>}
                    </TableCell>
                    <TableCell><RowCount count={a} /></TableCell>
                    <TableCell className="space-y-2 text-right">
                      {a.canConfirm && a.proposedSubsidiaryId && (
                        <Button size="sm" className="gap-1" disabled={busy !== null} onClick={() => confirm(a.accountId, a.proposedSubsidiaryId!, a.code)}>
                          <CheckCircle2 className="h-4 w-4" />
                          {t("accounts.confirm")}
                        </Button>
                      )}
                      {mayAddAccounts(role) && (
                        <Select disabled={busy !== null} onValueChange={(v) => confirm(a.accountId, v, a.code)}>
                          <SelectTrigger className="ml-auto h-8 w-56" aria-label={t("accounts.mapTo")}>
                            <SelectValue placeholder={t("accounts.mapTo")} />
                          </SelectTrigger>
                          <SelectContent>{companies.map((c) => <SelectItem key={c.id} value={c.id}>{companyName(c)}</SelectItem>)}</SelectContent>
                        </Select>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("tray.namesTitle")}</CardTitle>
          <CardDescription>{t("tray.namesDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {tray.fuelNames.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("tray.noNames")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("tray.rawName")}</TableHead>
                  <TableHead>{t("upload.account")}</TableHead>
                  <TableHead>{t("uploads.rows")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tray.fuelNames.map((n) => (
                  <TableRow key={`${n.accountId}|${n.rawName}`}>
                    <TableCell>“{n.rawName}”</TableCell>
                    <TableCell className="font-mono text-xs">{n.accountCode} · {t(`sources.${n.source}`)}</TableCell>
                    <TableCell><RowCount count={n} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
