"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { useStableErrorToast } from "@/lib/i18n/hooks";
import { accountActions, companyName, mappableCompanies, mayAddAccounts } from "@/lib/fuel-files-view";
import { FUEL_SOURCES, type FuelAccountDTO, type FuelSource, type SubsidiaryDTO, type UserRole } from "@/lib/types";
import { RowCount } from "./common";

const UNMAPPED = "__none__";

/** The companies the reader may map to, loaded once. */
export function useMappableCompanies(): SubsidiaryDTO[] {
  const showError = useStableErrorToast();
  const [companies, setCompanies] = useState<SubsidiaryDTO[]>([]);
  useEffect(() => {
    api.listSubsidiaries().then((list) => setCompanies(mappableCompanies(list))).catch(showError);
  }, [showError]);
  return companies;
}

/** A masterkey's form for an account mapped by hand before any upload (B7); also the wizard's step 7. */
export function AddAccountForm({ companies, onAdded }: { companies: SubsidiaryDTO[]; onAdded: () => void }) {
  const t = useTranslations("fuelFiles");
  const showError = useStableErrorToast();
  const [source, setSource] = useState<FuelSource>("petrol_ofisi");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [subsidiaryId, setSubsidiaryId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const ready = code.trim() !== "" && name.trim() !== "" && subsidiaryId !== "";

  async function add() {
    setSaving(true);
    try {
      await api.createFuelAccount({ source, code: code.trim(), name: name.trim(), subsidiaryId });
      toast.success(t("accounts.added", { code: code.trim() }));
      setCode("");
      setName("");
      onAdded();
    } catch (error) {
      showError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-3 md:grid-cols-5 md:items-end">
      <div className="space-y-1">
        <Label htmlFor="acc-source">{t("upload.source")}</Label>
        <Select value={source} onValueChange={(v) => setSource(v as FuelSource)}>
          <SelectTrigger id="acc-source"><SelectValue /></SelectTrigger>
          <SelectContent>{FUEL_SOURCES.map((s) => <SelectItem key={s} value={s}>{t(`sources.${s}`)}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="acc-code">{t("accounts.code")}</Label>
        <Input id="acc-code" value={code} maxLength={64} onChange={(e) => setCode(e.target.value)} className="font-mono" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="acc-name">{t("accounts.name")}</Label>
        <Input id="acc-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="acc-company">{t("upload.company")}</Label>
        <Select value={subsidiaryId || undefined} onValueChange={setSubsidiaryId}>
          <SelectTrigger id="acc-company"><SelectValue placeholder={t("upload.choose")} /></SelectTrigger>
          <SelectContent>{companies.map((c) => <SelectItem key={c.id} value={c.id}>{companyName(c)}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Button onClick={add} disabled={!ready || saving} className="gap-2">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        {t("accounts.add")}
      </Button>
    </div>
  );
}

/** The accounts list: state, company, rows; confirm, change or withdraw the mapping (D7). */
export function AccountsList({ role, refreshKey = 0, compact = false }: { role: UserRole | undefined; refreshKey?: number; compact?: boolean }) {
  const t = useTranslations("fuelFiles");
  const showError = useStableErrorToast();
  const companies = useMappableCompanies();
  const [accounts, setAccounts] = useState<FuelAccountDTO[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      setAccounts(await api.listFuelAccounts());
    } catch (error) {
      setAccounts([]);
      showError(error);
    }
  }, [showError]);
  useEffect(() => void load(), [load, refreshKey, version]);

  async function act(account: FuelAccountDTO, run: () => Promise<unknown>, done: string) {
    setBusy(account.id);
    try {
      await run();
      toast.success(done);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
      setVersion((v) => v + 1);
    }
  }

  return (
    <div className="space-y-4">
      {mayAddAccounts(role) && <AddAccountForm companies={companies} onAdded={() => setVersion((v) => v + 1)} />}
      {accounts === null ? (
        <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("loading")}</div>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("accounts.empty")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("upload.account")}</TableHead>
              <TableHead>{t("upload.company")}</TableHead>
              {!compact && <TableHead>{t("uploads.rows")}</TableHead>}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => {
              const actions = accountActions(a, role);
              return (
                <TableRow key={a.id}>
                  <TableCell>
                    <div className="font-mono text-xs">{a.code}</div>
                    <div className="text-muted-foreground">{a.name} · {t(`sources.${a.source}`)}</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{a.subsidiaryName ?? (a.subsidiaryId ? t("upload.outsideScope") : t("upload.noCompany"))}</span>
                      <Badge variant={a.state === "confirmed" ? "default" : "outline"}>{t(`accountStates.${a.state}`)}</Badge>
                      {a.subsidiaryIsAssociate && <Badge variant="outline">{t("accounts.associate")}</Badge>}
                    </div>
                    {a.holdsExcludedOfControlledCompany && (
                      <p className="mt-1 text-xs text-amber-700">{t("accounts.excludedNote")}</p>
                    )}
                  </TableCell>
                  {!compact && (
                    <TableCell className="space-y-1 text-sm">
                      {(["assigned", "ready", "held", "waiting_fuel", "excluded"] as const)
                        .filter((s) => a.rows[s].rows > 0)
                        .map((s) => (
                          <div key={s} className="flex flex-wrap gap-2">
                            <Badge variant="outline">{t(`rowStates.${s}`)}</Badge>
                            <RowCount count={a.rows[s]} />
                          </div>
                        ))}
                    </TableCell>
                  )}
                  <TableCell className="space-y-2 text-right">
                    {actions.confirm && a.subsidiaryId && (
                      <Button size="sm" className="gap-1" disabled={busy !== null}
                        onClick={() => act(a, () => api.confirmFuelAccount(a.id, { subsidiaryId: a.subsidiaryId! }), t("accounts.confirmed", { code: a.code }))}>
                        <CheckCircle2 className="h-4 w-4" />
                        {t("accounts.confirm")}
                      </Button>
                    )}
                    {actions.change && (
                      <Select
                        value={a.state === "confirmed" && a.subsidiaryId ? a.subsidiaryId : undefined}
                        disabled={busy !== null}
                        onValueChange={(v) =>
                          act(
                            a,
                            () => a.state === "confirmed"
                              ? api.updateFuelAccount(a.id, { subsidiaryId: v === UNMAPPED ? null : v })
                              : api.confirmFuelAccount(a.id, { subsidiaryId: v }),
                            t("accounts.changed", { code: a.code }),
                          )
                        }
                      >
                        <SelectTrigger className="ml-auto h-8 w-56" aria-label={t("accounts.mapTo")}>
                          <SelectValue placeholder={t("accounts.mapTo")} />
                        </SelectTrigger>
                        <SelectContent>
                          {companies.map((c) => <SelectItem key={c.id} value={c.id}>{companyName(c)}</SelectItem>)}
                          {a.state === "confirmed" && <SelectItem value={UNMAPPED}>{t("accounts.unmap")}</SelectItem>}
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function AccountsTab({ role, refreshKey }: { role: UserRole | undefined; refreshKey: number }) {
  const t = useTranslations("fuelFiles");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("accounts.title")}</CardTitle>
        <CardDescription>{t("accounts.description")}</CardDescription>
      </CardHeader>
      <CardContent><AccountsList role={role} refreshKey={refreshKey} /></CardContent>
    </Card>
  );
}
