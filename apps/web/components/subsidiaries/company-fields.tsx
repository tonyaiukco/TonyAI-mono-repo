import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  admitsChild,
  mayBeAssociate,
  NODE_TYPES,
  SUBSIDIARY_STATUSES,
  type NodeType,
  type SubsidiaryDTO,
  type SubsidiaryStatus,
} from "@/lib/types";
import { geographyLabel } from "@/lib/vocabulary";

/** A company being created: what the company screen's dialog and the setup wizard's step 4 collect. */
export const EMPTY_COMPANY_FORM = {
  legalName: "",
  tradingName: "",
  location: "",
  // Set when the form opens, from what the library prices (owner review of WP7).
  geographyCode: "",
  sector: "",
  reportingStatus: "pending" as SubsidiaryStatus,
  // The group tree (inc26-group-tree): where the node sits and what it is.
  parentId: "",
  nodeType: "company" as NodeType,
  associate: false,
  naceCode: "",
  sharePercent: "",
};
export type CompanyForm = typeof EMPTY_COMPANY_FORM;

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/**
 * A company's fields (inc26-central-reporter-onboarding, task 8.1): name,
 * parent and type, geography, status, sector, NACE, share percent and the
 * associate tick — extracted from the company screen's create dialog so the
 * setup wizard's step 4 uses the same form. The caller validates and writes.
 */
export function CompanyFields({
  form,
  onChange,
  subsidiaries,
  parentOptions,
  typeOptions,
  canManage,
  geographyChoices,
  geographyFailed,
}: {
  form: CompanyForm;
  onChange: (form: CompanyForm) => void;
  /** Every node read, for the parent's geography and its admitted types. */
  subsidiaries: readonly SubsidiaryDTO[];
  parentOptions: readonly SubsidiaryDTO[];
  typeOptions: readonly NodeType[];
  canManage: boolean;
  geographyChoices: (preferred?: string) => readonly string[];
  geographyFailed: boolean;
}) {
  const t = useTranslations("subsidiaries");
  const tStatus = useTranslations("subsidiaryStatus");
  const tGeography = useTranslations("geography");
  return (
    <>
      {/* Where the node sits in the group tree (inc26-group-tree). */}
      {parentOptions.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("tree.parent")}>
            <Select
              value={form.parentId}
              onValueChange={(v) => {
                const parent = subsidiaries.find((s) => s.id === v);
                const types = canManage && parent ? NODE_TYPES.filter((type) => admitsChild(parent, type)) : ["child_company" as NodeType];
                onChange({ ...form, parentId: v, nodeType: types.includes(form.nodeType) ? form.nodeType : types[0] });
              }}
            >
              <SelectTrigger aria-label={t("tree.parent")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {parentOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.legalName} · {t(`tree.types.${s.nodeType}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("tree.type")}>
            <Select
              value={form.nodeType}
              onValueChange={(v) => onChange({ ...form, nodeType: v as NodeType, associate: mayBeAssociate(v as NodeType) && form.associate })}
              disabled={typeOptions.length < 2}
            >
              <SelectTrigger aria-label={t("tree.type")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {typeOptions.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`tree.types.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
      <Field label={t("fields.legalNameRequired")}>
        <Input
          value={form.legalName}
          onChange={(e) => onChange({ ...form, legalName: e.target.value })}
          placeholder={t("create.legalNamePlaceholder")}
        />
      </Field>
      <Field label={t("fields.tradingName")}>
        <Input
          value={form.tradingName}
          onChange={(e) => onChange({ ...form, tradingName: e.target.value })}
        />
      </Field>
      <Field label={t("fields.location")}>
        <Input
          value={form.location}
          onChange={(e) => onChange({ ...form, location: e.target.value })}
          placeholder={t("create.locationPlaceholder")}
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label={t("fields.geography")}>
          {form.nodeType === "sector_group" ? (
            // A sector group takes its parent's geography (D10): nothing
            // to choose, and nothing priced is needed (owner review of WP7, P2).
            <p className="pt-2 text-sm text-muted-foreground" data-testid="sector-group-geography">
              {t("fields.geographyFromParent", {
                geography: geographyLabel(subsidiaries.find((p) => p.id === form.parentId)?.geographyCode ?? "", tGeography),
              })}
            </p>
          ) : (
          <Select
            value={form.geographyCode}
            onValueChange={(v) => onChange({ ...form, geographyCode: v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* The list is UK + Türkiye, plus whatever this record
                  already holds — otherwise editing the seeded EU
                  subsidiary would bind the Select to a value with no
                  matching item and render a blank trigger. */}
              {geographyChoices(subsidiaries.find((p) => p.id === form.parentId)?.geographyCode).map((g) => (
                <SelectItem key={g} value={g}>
                  {geographyLabel(g, tGeography)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          )}
          {geographyFailed && form.nodeType !== "sector_group" && (
            <p className="pt-1 text-xs text-destructive">{t("fields.geographyUnavailable")}</p>
          )}
        </Field>
        <Field label={t("fields.status")}>
          <Select
            value={form.reportingStatus}
            onValueChange={(v) =>
              onChange({ ...form, reportingStatus: v as typeof form.reportingStatus })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBSIDIARY_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {tStatus(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label={t("fields.sector")}>
        <Input
          value={form.sector}
          onChange={(e) => onChange({ ...form, sector: e.target.value })}
          placeholder={t("create.sectorPlaceholder")}
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label={t("tree.nace")}>
          <Input
            value={form.naceCode}
            onChange={(e) => onChange({ ...form, naceCode: e.target.value })}
            placeholder={t("tree.naceHint")}
          />
        </Field>
        <Field label={t("tree.sharePercent")}>
          <Input
            inputMode="decimal"
            value={form.sharePercent}
            onChange={(e) => onChange({ ...form, sharePercent: e.target.value })}
            aria-describedby="share-percent-hint"
          />
          <p id="share-percent-hint" className="text-xs text-muted-foreground">{t("tree.sharePercentHint")}</p>
        </Field>
      </div>
      {canManage && mayBeAssociate(form.nodeType) && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={form.associate}
            onCheckedChange={(v) => onChange({ ...form, associate: v === true })}
            aria-describedby="associate-hint"
          />
          <span>
            {t("tree.control")}
            <span id="associate-hint" className="block text-xs text-muted-foreground">{t("tree.controlHint")}</span>
          </span>
        </label>
      )}
      <p className="text-xs text-muted-foreground">{t("tree.pricedOnly")}</p>
    </>
  );
}
