"use client";

import { useTranslations } from "use-intl";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CATEGORIES,
  CATEGORY_SCOPE_MAP,
  REPORTING_YEARS,
  type ReportingContext,
  type SubsidiaryDTO,
} from "@/lib/types";
import { nextReportingContext, type ReportingContextUrlKey } from "@/lib/reporting-context-url";

/** Radix needs a non-empty value; the URL spells the clear `all`. */
const ALL = "__all__";

type Field = "year" | "subsidiaryId" | "scope" | "category";

/** Is the selection one the caller can see? `null` while the list loads. */
export function selectionAvailable(context: ReportingContext, subsidiaries: SubsidiaryDTO[] | null): boolean | null {
  if (context.subsidiaryId === undefined) return true;
  if (subsidiaries === null) return null;
  return subsidiaries.some((s) => s.id === context.subsidiaryId);
}

/**
 * The annual screens' one reporting selection (LP3-02 N1). It edits the URL
 * through `onSelect`; it never decides access — a selection the caller cannot
 * see stays selected (and empty) instead of turning into "all".
 */
export function ReportingContextBar({
  context,
  subsidiaries,
  onSelect,
  fields = ["year", "subsidiaryId", "scope", "category"],
  disabled = false,
}: {
  context: ReportingContext;
  /** The caller's accessible subsidiaries; `null` while loading. */
  subsidiaries: SubsidiaryDTO[] | null;
  onSelect: (next: ReportingContext) => void;
  fields?: readonly Field[];
  disabled?: boolean;
}) {
  const t = useTranslations("reportingContext");
  const tCategory = useTranslations("categories");
  const available = selectionAvailable(context, subsidiaries);
  const show = (field: Field) => fields.includes(field);

  const change = (patch: Partial<Record<keyof ReportingContext, unknown>>) => onSelect(nextReportingContext(context, patch));

  const categories = CATEGORIES.filter((c) => context.scope === undefined || CATEGORY_SCOPE_MAP[c] === context.scope);

  return (
    <div className="space-y-2" role="group" aria-label={t("label")}>
      <div className="flex flex-wrap items-center gap-3">
        {show("year") && (
          <Select
            value={String(context.year)}
            onValueChange={(v) => change({ year: Number(v) })}
            disabled={disabled}
          >
            <SelectTrigger className="w-[120px] bg-card border-border" aria-label={t("year")} data-testid="context-year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORTING_YEARS.map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {show("subsidiaryId") && (
          <Select
            value={context.subsidiaryId ?? ALL}
            onValueChange={(v) => change({ subsidiaryId: v === ALL ? undefined : v })}
            disabled={disabled}
          >
            <SelectTrigger className="w-[240px] bg-card border-border" aria-label={t("subsidiary")} data-testid="context-subsidiary">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("allSubsidiaries")}</SelectItem>
              {(subsidiaries ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.tradingName ?? s.legalName} ({s.geographyCode})
                </SelectItem>
              ))}
              {/* Named as what it is, never resolved to a visible one or to all. */}
              {context.subsidiaryId !== undefined && available === false && (
                <SelectItem value={context.subsidiaryId}>{t("unavailableSubsidiary")}</SelectItem>
              )}
            </SelectContent>
          </Select>
        )}
        {show("scope") && (
          <Select
            value={context.scope !== undefined ? String(context.scope) : ALL}
            onValueChange={(v) => change({ scope: v === ALL ? undefined : Number(v) })}
            disabled={disabled}
          >
            <SelectTrigger className="w-[140px] bg-card border-border" aria-label={t("scope")} data-testid="context-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("allScopes")}</SelectItem>
              {[1, 2, 3].map((scope) => (
                <SelectItem key={scope} value={String(scope)}>{t("scopeValue", { scope })}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {show("category") && (
          <Select
            value={context.category ?? ALL}
            onValueChange={(v) => change({ category: v === ALL ? undefined : v })}
            disabled={disabled}
          >
            <SelectTrigger className="w-[180px] bg-card border-border" aria-label={t("category")} data-testid="context-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("allCategories")}</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>{tCategory(c)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {available === false && (
        <p className="flex items-center gap-2 text-sm text-amber-600" role="status" data-testid="context-unavailable">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t("unavailableNotice")}
        </p>
      )}
    </div>
  );
}

/** A refused link: names what was refused, loads nothing, offers one way out. */
export function ReportingContextInvalid({
  invalid,
  onReset,
}: {
  invalid: readonly ReportingContextUrlKey[];
  onReset: () => void;
}) {
  const t = useTranslations("reportingContext");
  const fields = invalid.map((key) => t(`fields.${key}`)).join(", ");
  return (
    <div
      className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-4 text-sm"
      role="alert"
      data-testid="context-invalid"
    >
      <div className="flex items-center gap-2 font-medium text-foreground">
        <AlertTriangle className="h-4 w-4 text-destructive" />
        {t("invalidTitle")}
      </div>
      <p className="text-muted-foreground">{t("invalidBody", { fields })}</p>
      <Button variant="outline" size="sm" onClick={onReset} className="gap-2">
        <RotateCcw className="h-4 w-4" />
        {t("invalidReset")}
      </Button>
    </div>
  );
}
