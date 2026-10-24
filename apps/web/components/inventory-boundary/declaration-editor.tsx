"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/i18n/number";
import {
  addSite,
  cellKey,
  declarationField,
  declarationIssues,
  MONTHS,
  newSource,
  removeSite,
  requestFromDraft,
  withCategory,
  type Applicability,
  type DeclarationDraft,
  type DeclarationIssue,
  type SourceDraft,
} from "@/lib/inventory-boundary-form";
import type { GapLine } from "@/lib/inventory-boundary-view";
import {
  INVENTORY_CATEGORIES,
  PERIOD_VALUES,
  recordActivityTypesFor,
  REPORTING_PERIODS,
  type InventoryCategory,
  type InventoryMonth,
  type Locale,
  type PutInventoryBoundarySubsidiaryRequest,
  type ReportingPeriod,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/** Radix needs a non-empty value for "nothing chosen". */
const NONE = "__none__";
/** A choice not made yet — distinct from NONE where "none" is itself a choice (evidence). */
const UNSET = "__unset__";
const APPLICABILITIES: readonly Applicability[] = ["included", "excluded", "undetermined"];

export interface EditorSite {
  id: string;
  name: string;
}

/**
 * One subsidiary's declaration in a version (LP4-03 PR C, D3): its months,
 * sites, each category's attribution and decisions, and its named sources.
 * Read-only for a frozen version or a caller who may not write — the same
 * form, every field disabled, so what is shown is exactly what is stored.
 */
export function DeclarationEditor({
  open,
  onOpenChange,
  title,
  readOnly,
  initial,
  sites,
  gaps,
  saving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  readOnly: boolean;
  initial: DeclarationDraft;
  /** The subsidiary's locations the screen knows — its listed ones and the version's declared sites. */
  sites: readonly EditorSite[];
  gaps: readonly GapLine[];
  saving: boolean;
  onSave: (request: PutInventoryBoundarySubsidiaryRequest) => void;
}) {
  const t = useTranslations("boundary");
  const tCategories = useTranslations("categories");
  const tPeriods = useTranslations("periods");
  const tActivity = useTranslations("dataEntry");
  const tReports = useTranslations("reports");
  const locale = useLocale() as Locale;
  const [draft, setDraft] = useState<DeclarationDraft>(initial);
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(initial);
      setAttempted(false);
    }
  }, [open, initial]);

  const issues = useMemo(() => declarationIssues(draft), [draft]);
  const siteName = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);
  const declaredSites = draft.sites.map((s) => s.locationId);
  const month = (m: number) => tPeriods(`values.${PERIOD_VALUES.monthly[m - 1]}` as never);
  const cadence = (p: ReportingPeriod) => tPeriods(`granularity.${p}` as never);
  const category = (c: InventoryCategory) => tCategories(c as never);
  const entityLabel = (locationId: string | null) =>
    locationId === null ? t("editor.company") : siteName.get(locationId) ?? locationId;

  const issueAt = (field: string): DeclarationIssue | undefined =>
    attempted ? issues.find((i) => i.field === field) : undefined;
  const issueNote = (field: string) => {
    const issue = issueAt(field);
    if (!issue) return null;
    const values = {
      max: issue.values?.max ?? 0,
      category: issue.values?.category ? category(issue.values.category) : "",
    };
    return (
      <p className="text-xs text-destructive" role="alert" data-testid="declaration-issue">
        {t(`editor.issues.${issue.code}` as never, values as never)}
      </p>
    );
  };

  const update = (patch: Partial<DeclarationDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const updateSource = (key: string, patch: Partial<SourceDraft>) =>
    setDraft((d) => ({ ...d, sources: d.sources.map((s) => (s.key === key ? { ...s, ...patch } : s)) }));

  function save() {
    setAttempted(true);
    if (issues.length > 0) {
      toast.error(t("toast.fixIssues", { count: formatNumber(issues.length, locale) }));
      return;
    }
    onSave(requestFromDraft(draft));
  }

  const monthSelect = (value: number, onChange: (m: InventoryMonth) => void, label: string, testId?: string) => (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v) as InventoryMonth)} disabled={readOnly}>
      <SelectTrigger className="w-[150px]" aria-label={label} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MONTHS.map((m) => (
          <SelectItem key={m} value={String(m)}>{month(m)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl" data-testid="declaration-editor">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{readOnly ? t("editor.readOnly") : t("editor.description")}</DialogDescription>
        </DialogHeader>

        {gaps.length > 0 && (
          <section className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="declaration-gaps">
            <p className="font-medium">{t("gaps.saved")}</p>
            <ul className="list-inside list-disc text-xs">
              {gaps.map((g, i) => (
                <li key={i}>{gapText(g)}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("editor.months")}</h3>
          <div className="flex flex-wrap items-center gap-3">
            {monthSelect(draft.firstMonth, (m) => update({ firstMonth: m }), t("editor.firstMonth"), "declaration-first-month")}
            <span className="text-muted-foreground">–</span>
            {monthSelect(draft.lastMonth, (m) => update({ lastMonth: m }), t("editor.lastMonth"), "declaration-last-month")}
          </div>
          {issueNote(declarationField.months)}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("editor.sites")}</h3>
          {!readOnly && <p className="text-xs text-muted-foreground">{t("editor.sitesHint")}</p>}
          {sites.length === 0 ? (
            <p className="text-sm text-muted-foreground">{readOnly ? t("editor.noSitesDeclared") : t("editor.noLocations")}</p>
          ) : (
            <ul className="space-y-2">
              {sites.map((site) => {
                const declared = draft.sites.find((s) => s.locationId === site.id);
                return (
                  <li key={site.id} className="flex flex-wrap items-center gap-3">
                    <div className="flex min-w-[220px] items-center gap-2">
                      <Checkbox
                        id={`site-${site.id}`}
                        checked={declared !== undefined}
                        disabled={readOnly}
                        onCheckedChange={(checked) =>
                          setDraft((d) => (checked ? addSite(d, site.id) : removeSite(d, site.id)))
                        }
                      />
                      <Label htmlFor={`site-${site.id}`}>{site.name}</Label>
                    </div>
                    {declared && (
                      <div className="flex items-center gap-2">
                        {monthSelect(
                          declared.firstMonth,
                          (m) => update({ sites: draft.sites.map((s) => (s.locationId === site.id ? { ...s, firstMonth: m } : s)) }),
                          t("editor.siteFirstMonth", { site: site.name }),
                        )}
                        <span className="text-muted-foreground">–</span>
                        {monthSelect(
                          declared.lastMonth,
                          (m) => update({ sites: draft.sites.map((s) => (s.locationId === site.id ? { ...s, lastMonth: m } : s)) }),
                          t("editor.siteLastMonth", { site: site.name }),
                        )}
                      </div>
                    )}
                    <div className="basis-full">
                      {issueNote(declarationField.site(site.id))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">{t("editor.categories")}</h3>
          {!readOnly && <p className="text-xs text-muted-foreground">{t("editor.categoriesHint")}</p>}
          {INVENTORY_CATEGORIES.map((c) => {
            const policy = draft.attribution[c];
            const entities: (string | null)[] = [null, ...declaredSites];
            const selected = (locationId: string | null) =>
              policy === undefined ? true : policy.level === "company" ? locationId === null : locationId !== null;
            return (
              <div key={c} className="space-y-2 rounded-md border border-border p-3" data-testid={`declaration-category-${c}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-[160px] font-medium">{category(c)}</span>
                  <Select
                    value={policy?.level ?? NONE}
                    disabled={readOnly}
                    onValueChange={(v) => {
                      const next = { ...draft.attribution };
                      if (v === NONE) delete next[c];
                      else next[c] = { level: v as "company" | "sites", reportingPeriod: policy?.reportingPeriod ?? null };
                      update({ attribution: next });
                    }}
                  >
                    <SelectTrigger className="w-[180px]" aria-label={t("editor.level", { category: category(c) })}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t("editor.levelNone")}</SelectItem>
                      <SelectItem value="company">{t("editor.levels.company")}</SelectItem>
                      <SelectItem value="sites">{t("editor.levels.sites")}</SelectItem>
                    </SelectContent>
                  </Select>
                  {policy && (
                    <Select
                      value={policy.reportingPeriod ?? NONE}
                      disabled={readOnly}
                      onValueChange={(v) =>
                        update({ attribution: { ...draft.attribution, [c]: { ...policy, reportingPeriod: v === NONE ? null : (v as ReportingPeriod) } } })
                      }
                    >
                      <SelectTrigger className="w-[160px]" aria-label={t("editor.cadence", { category: category(c) })}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{t("editor.choose")}</SelectItem>
                        {REPORTING_PERIODS.map((p) => (
                          <SelectItem key={p} value={p}>{cadence(p)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {issueNote(declarationField.policy(c))}
                <ul className="space-y-2 pl-2">
                  {entities.map((locationId) => {
                    const key = cellKey(locationId, c);
                    const cell = draft.cells[key];
                    const entity = entityLabel(locationId);
                    return (
                      <li key={key} className="flex flex-wrap items-center gap-3">
                        <span className={cn("min-w-[200px] text-sm", !selected(locationId) && "text-muted-foreground")}>
                          {entity}
                          {!selected(locationId) && <span className="ml-1 text-xs">({t("editor.notSelected")})</span>}
                        </span>
                        <Select
                          value={cell?.applicability ?? NONE}
                          disabled={readOnly}
                          onValueChange={(v) => {
                            const cells = { ...draft.cells };
                            if (v === NONE) delete cells[key];
                            else cells[key] = { applicability: v as Applicability, reason: cell?.reason ?? "" };
                            update({ cells });
                          }}
                        >
                          <SelectTrigger className="w-[170px]" aria-label={t("editor.decision", { category: category(c), entity })}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>{t("editor.cellNone")}</SelectItem>
                            {APPLICABILITIES.map((a) => (
                              <SelectItem key={a} value={a}>{t(`editor.applicability.${a}`)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {cell && cell.applicability !== "included" && (
                          <Input
                            className="min-w-[260px] flex-1"
                            value={cell.reason}
                            disabled={readOnly}
                            placeholder={t("editor.reason")}
                            aria-label={t("editor.reasonFor", { category: category(c), entity })}
                            onChange={(e) => update({ cells: { ...draft.cells, [key]: { ...cell, reason: e.target.value } } })}
                          />
                        )}
                        <div className="basis-full">
                          {issueNote(declarationField.cell(key))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t("editor.sources")}</h3>
            {!readOnly && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => update({ sources: [...draft.sources, newSource()] })}
              >
                <Plus className="h-4 w-4" />
                {t("editor.addSource")}
              </Button>
            )}
          </div>
          {!readOnly && <p className="text-xs text-muted-foreground">{t("editor.sourcesHint")}</p>}
          {draft.sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("editor.noSources")}</p>
          ) : (
            draft.sources.map((s, index) => {
              const field = (part: Parameters<typeof declarationField.source>[1]) => declarationField.source(s.key, part);
              const types = s.category ? recordActivityTypesFor(s.category) : [];
              const included = s.applicability === "included";
              const n = index + 1;
              return (
                <div key={s.key} className="space-y-2 rounded-md border border-border p-3" data-testid="declaration-source">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-[240px] flex-1 space-y-1">
                      <Input
                        value={s.name}
                        disabled={readOnly}
                        placeholder={t("editor.sourceName")}
                        aria-label={t("editor.sourceNameFor", { n })}
                        onChange={(e) => updateSource(s.key, { name: e.target.value })}
                      />
                      {issueNote(field("name"))}
                    </div>
                    <div className="space-y-1">
                      <Select
                        value={s.locationId ?? NONE}
                        disabled={readOnly}
                        onValueChange={(v) => updateSource(s.key, { locationId: v === NONE ? null : v })}
                      >
                        <SelectTrigger className="w-[200px]" aria-label={t("editor.sourceEntityFor", { n })}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>{t("editor.company")}</SelectItem>
                          {declaredSites.map((id) => (
                            <SelectItem key={id} value={id}>{entityLabel(id)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {issueNote(field("location"))}
                    </div>
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("editor.removeSourceFor", { n })}
                        onClick={() => update({ sources: draft.sources.filter((x) => x.key !== s.key) })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-start gap-3">
                    <Select
                      value={s.kind}
                      disabled={readOnly}
                      onValueChange={(v) =>
                        updateSource(s.key, v === "mapped"
                          ? { kind: "mapped", scope: null, reportingPeriod: null, unsupportedReason: "" }
                          : { kind: "unsupported", category: null, activityType: null })
                      }
                    >
                      <SelectTrigger className="w-[170px]" aria-label={t("editor.mappingFor", { n })}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="mapped">{t("editor.mappings.mapped")}</SelectItem>
                        <SelectItem value="unsupported">{t("editor.mappings.unsupported")}</SelectItem>
                      </SelectContent>
                    </Select>
                    {s.kind === "mapped" ? (
                      <>
                        <div className="space-y-1">
                          <Select
                            value={s.category ?? NONE}
                            disabled={readOnly}
                            onValueChange={(v) => v !== NONE && setDraft((d) => ({
                              ...d,
                              sources: d.sources.map((x) => (x.key === s.key ? withCategory(x, v as InventoryCategory) : x)),
                            }))}
                          >
                            <SelectTrigger className="w-[190px]" aria-label={t("editor.categoryFor", { n })}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE} disabled>{t("editor.choose")}</SelectItem>
                              {INVENTORY_CATEGORIES.map((c) => (
                                <SelectItem key={c} value={c}>{category(c)}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {issueNote(field("category"))}
                        </div>
                        {types.length > 0 && (
                          <div className="space-y-1">
                            <Select
                              value={s.activityType ?? NONE}
                              disabled={readOnly}
                              onValueChange={(v) => updateSource(s.key, { activityType: v === NONE ? null : v })}
                            >
                              <SelectTrigger className="w-[230px]" aria-label={t("editor.activityTypeFor", { n })}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NONE} disabled>{t("editor.choose")}</SelectItem>
                                {types.map((type) => (
                                  <SelectItem key={type.value} value={type.value}>
                                    {tActivity(`activityTypes.${type.value}` as never)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {issueNote(field("activityType"))}
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="min-w-[240px] flex-1 space-y-1">
                          <Input
                            value={s.unsupportedReason}
                            disabled={readOnly}
                            placeholder={t("editor.unsupportedReason")}
                            aria-label={t("editor.unsupportedReasonFor", { n })}
                            onChange={(e) => updateSource(s.key, { unsupportedReason: e.target.value })}
                          />
                          {issueNote(field("unsupportedReason"))}
                        </div>
                        <div className="space-y-1">
                          <Select
                            value={s.scope === null ? NONE : String(s.scope)}
                            disabled={readOnly}
                            onValueChange={(v) => updateSource(s.key, { scope: v === NONE ? null : (Number(v) as 1 | 2) })}
                          >
                            <SelectTrigger className="w-[130px]" aria-label={t("editor.scopeFor", { n })}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE} disabled>{t("editor.choose")}</SelectItem>
                              <SelectItem value="1">{t("editor.scope1")}</SelectItem>
                              <SelectItem value="2">{t("editor.scope2")}</SelectItem>
                            </SelectContent>
                          </Select>
                          {issueNote(field("scope"))}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap items-start gap-3">
                    <Select
                      value={s.applicability}
                      disabled={readOnly}
                      onValueChange={(v) => updateSource(s.key, { applicability: v as Applicability })}
                    >
                      <SelectTrigger className="w-[170px]" aria-label={t("editor.sourceDecisionFor", { n })}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {APPLICABILITIES.map((a) => (
                          <SelectItem key={a} value={a}>{t(`editor.applicability.${a}`)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {included ? (
                      <>
                        {s.kind === "unsupported" && (
                          <div className="space-y-1">
                            <Select
                              value={s.reportingPeriod ?? NONE}
                              disabled={readOnly}
                              onValueChange={(v) => updateSource(s.key, { reportingPeriod: v === NONE ? null : (v as ReportingPeriod) })}
                            >
                              <SelectTrigger className="w-[160px]" aria-label={t("editor.sourceCadenceFor", { n })}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NONE} disabled>{t("editor.choose")}</SelectItem>
                                {REPORTING_PERIODS.map((p) => (
                                  <SelectItem key={p} value={p}>{cadence(p)}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {issueNote(field("reportingPeriod"))}
                          </div>
                        )}
                        <div className="space-y-1">
                          <Select
                            value={s.evidenceReportingPeriod === undefined ? UNSET : s.evidenceReportingPeriod ?? NONE}
                            disabled={readOnly}
                            onValueChange={(v) => v !== UNSET && updateSource(s.key, { evidenceReportingPeriod: v === NONE ? null : (v as ReportingPeriod) })}
                          >
                            <SelectTrigger className="w-[200px]" aria-label={t("editor.evidenceFor", { n })}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNSET} disabled>{t("editor.choose")}</SelectItem>
                              <SelectItem value={NONE}>{t("editor.evidenceNone")}</SelectItem>
                              {REPORTING_PERIODS.map((p) => (
                                <SelectItem key={p} value={p}>{t("editor.evidenceCadence", { cadence: cadence(p) })}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {issueNote(field("evidence"))}
                        </div>
                      </>
                    ) : (
                      <div className="min-w-[260px] flex-1 space-y-1">
                        <Input
                          value={s.reason}
                          disabled={readOnly}
                          placeholder={t("editor.reason")}
                          aria-label={t("editor.sourceReasonFor", { n })}
                          onChange={(e) => updateSource(s.key, { reason: e.target.value })}
                        />
                        {issueNote(field("reason"))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </section>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {readOnly ? t("editor.close") : t("editor.cancel")}
          </Button>
          {!readOnly && (
            <Button type="button" onClick={save} disabled={saving} data-testid="declaration-save">
              {saving ? t("editor.saving") : t("editor.save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  function gapText(g: GapLine): string {
    const where = [g.siteName ?? t("editor.company"), g.category ? category(g.category) : null].filter(Boolean).join(" · ");
    const label = tReports(`coverageGap.${g.code}` as never);
    return g.sourceNames.length > 0
      ? t("gaps.lineWithSources", { label, where, sources: g.sourceNames.join(", ") })
      : t("gaps.line", { label, where });
  }
}
