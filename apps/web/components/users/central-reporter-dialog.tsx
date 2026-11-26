import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useDescribeError } from "@/lib/i18n/hooks";
import { CATEGORIES, type Category, type Locale, type SubsidiaryDTO, type UserSummaryDTO } from "@/lib/types";
import {
  grantPayload,
  grantPreview,
  grantableCompanies,
  initialGrantDraft,
  singleEntryLines,
  usersErrorKey,
  type GrantChange,
  type GrantDraft,
} from "@/lib/users-view";

/**
 * A standard user's central reporter grant (inc26-central-reporter-onboarding,
 * INC-2.6 §4.1): the companies that hold records — a carried-over account's
 * held companies among them — and one category checklist, with the change
 * shown before it is saved (C7). Only a masterkey opens it; a refusal stays in
 * the dialog, in the reader's language. Used by the users screen and by the
 * setup wizard's step 7.
 */
export function CentralReporterDialog({
  target,
  companies,
  names,
  onClose,
  onSaved,
}: {
  target: UserSummaryDTO | null;
  /** The organisation's companies; those that hold records are offered. */
  companies: readonly SubsidiaryDTO[];
  names: ReadonlyMap<string, string>;
  onClose: () => void;
  onSaved: (updated: UserSummaryDTO) => void;
}) {
  const t = useTranslations("users");
  const tCategory = useTranslations("categories");
  const locale = useLocale() as Locale;
  const describe = useDescribeError();
  const offered = useMemo(() => grantableCompanies(companies), [companies]);
  const [draft, setDraft] = useState<GrantDraft>({ subsidiaryIds: [], categories: [] });
  const [refusal, setRefusal] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(target ? initialGrantDraft(target) : { subsidiaryIds: [], categories: [] });
    setRefusal(null);
  }, [target]);

  const preview = target ? grantPreview(target, draft) : null;
  const nameOf = (id: string) => names.get(id) ?? "—";
  const list = new Intl.ListFormat(locale, { style: "short", type: "conjunction" });
  const words = (categories: Category[]) => (categories.length ? list.format(categories.map((c) => tCategory(c))) : t("grantDialog.noCategories"));
  const state = (side: GrantChange["before"], empty: string) =>
    side === null ? empty : side.kind === "assigned" ? t("grantDialog.asMain", { categories: words(side.categories) }) : t("grantDialog.asGrant", { categories: words(side.categories) });
  const noMain = draft.subsidiaryIds.length > 0 && preview?.mainCompanyId === null;
  const noCategory = draft.subsidiaryIds.length > 0 && draft.categories.length === 0;

  const toggle = <K extends keyof GrantDraft>(key: K, value: GrantDraft[K][number], checked: boolean) =>
    setDraft((d) => ({
      ...d,
      [key]: checked ? [...(d[key] as string[]), value] : (d[key] as string[]).filter((v) => v !== value),
    }));

  async function save() {
    if (!target) return;
    setSaving(true);
    setRefusal(null);
    try {
      const updated = await api.setCentralReporterGrant(target.id, grantPayload(draft));
      toast.success(t("grantDialog.saved"));
      onSaved(updated);
    } catch (e) {
      const lines = singleEntryLines(e, names, (c) => tCategory(c), { t, locale });
      const key = usersErrorKey(e);
      setRefusal(lines ?? [key ? t(key) : describe(e).title]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="central-reporter-dialog">
        <DialogHeader>
          <DialogTitle>{t("grantDialog.title", { name: target?.fullName ?? "" })}</DialogTitle>
          <DialogDescription>{t("grantDialog.description")}</DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <p className="text-sm font-medium">{t("grantDialog.companiesHeading")}</p>
          <div className="grid gap-1.5" data-testid="grant-companies">
            {offered.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.subsidiaryIds.includes(s.id)}
                  onCheckedChange={(checked) => toggle("subsidiaryIds", s.id, checked === true)}
                />
                {nameOf(s.id)}
              </label>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <p className="text-sm font-medium">{t("grantDialog.categoriesHeading")}</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5" data-testid="grant-categories">
            {CATEGORIES.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <Checkbox checked={draft.categories.includes(c)} onCheckedChange={(checked) => toggle("categories", c, checked === true)} />
                {tCategory(c)}
              </label>
            ))}
          </div>
        </section>

        {preview && (
          <section className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm" data-testid="grant-preview">
            <p className="font-medium">{t("grantDialog.changesHeading")}</p>
            {preview.mainCompanyId && <p>{t("grantDialog.mainCompany", { name: nameOf(preview.mainCompanyId) })}</p>}
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-normal">{t("grantDialog.company")}</th>
                  <th className="py-1 pr-2 font-normal">{t("grantDialog.now")}</th>
                  <th className="py-1 font-normal">{t("grantDialog.after")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.changes.map((c) => (
                  <tr key={c.subsidiaryId} data-testid="grant-preview-row">
                    <td className="py-1 pr-2">{nameOf(c.subsidiaryId)}</td>
                    <td className="py-1 pr-2">{state(c.before, t("grantDialog.notHeld"))}</td>
                    <td className="py-1">{state(c.after, t("grantDialog.withdrawn"))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {draft.subsidiaryIds.length === 0 && <p className="text-muted-foreground">{t("grantDialog.withdrawNote")}</p>}
          </section>
        )}

        {(noMain || noCategory) && (
          <p className="flex items-start gap-2 text-xs text-amber-700" data-testid="grant-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {noMain ? t("grantDialog.noMainCompany") : t("grantDialog.noCategory")}
          </p>
        )}
        {refusal && (
          <div role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="grant-refusal">
            {refusal.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("grantDialog.cancel")}
          </Button>
          <Button disabled={saving || !target || noCategory} onClick={save}>
            {saving ? t("grantDialog.submitting") : t("grantDialog.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
