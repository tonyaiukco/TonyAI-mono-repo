"use client";

import { useLocale, useTranslations } from "use-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import {
  can,
  CONSOLIDATION_APPROACHES,
  UPCOMING_CONSOLIDATION_APPROACHES,
  type BoundaryExclusionDTO,
  type ConsolidationApproach,
  type OrganisationDTO,
  type UserRole,
} from "@/lib/types";
import { useErrorToast, useStableErrorToast } from "@/lib/i18n/hooks";
import { formatNumber } from "@/lib/i18n/number";

/**
 * The organisation's consolidation approach and the boundary-exclusions note
 * (inc26-group-tree, INC-2.6 §3, design D8, RD11). Every member reads the
 * approach; a masterkey changes it (equity share is shown, disabled, as
 * "coming soon"). The note lists the associates left outside Scope 1 and 2 —
 * read by a masterkey and an auditor, the roles that read the whole group.
 */
export function ConsolidationCard({
  role,
  onApproach,
  refreshKey = 0,
}: {
  role: UserRole | undefined;
  /** Bumped by the page whenever its company list is read again (a create, a
   *  delete): the exclusions note follows the tree (owner review of WP7, P2). */
  refreshKey?: number;
  /** The approach as loaded or saved — the tree's GHG basis reads it. */
  onApproach?: (approach: ConsolidationApproach) => void;
}) {
  const t = useTranslations("subsidiaries");
  const locale = useLocale();
  const showError = useErrorToast();
  const showStableError = useStableErrorToast();
  const [organisation, setOrganisation] = useState<OrganisationDTO | null>(null);
  const [exclusions, setExclusions] = useState<BoundaryExclusionDTO[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const canSet = can(role, "consolidation.write");
  const readsExclusions = can(role, "scope.organisation");

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [org, excluded] = await Promise.all([
        api.getOrganisation(),
        readsExclusions ? api.listBoundaryExclusions() : Promise.resolve(null),
      ]);
      setOrganisation(org);
      setExclusions(excluded);
      onApproach?.(org.consolidationApproach);
    } catch (e) {
      // Never the previous answer after a failed re-read: a deleted associate
      // would stay named, or "none" would outlive a new one (owner's fourth
      // review of WP7, P2). The note says it could not be read.
      setExclusions(null);
      setFailed(true);
      showStableError(e);
    }
  }, [readsExclusions, onApproach, showStableError]);

  useEffect(() => {
    if (role !== undefined) void load();
  }, [role, load, refreshKey]);

  async function choose(value: string) {
    if (!organisation || value === organisation.consolidationApproach) return;
    setSaving(true);
    try {
      const saved = await api.setConsolidationApproach({ consolidationApproach: value as ConsolidationApproach });
      setOrganisation(saved);
      onApproach?.(saved.consolidationApproach);
      toast.success(t("consolidation.saved"));
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="consolidation-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t("consolidation.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed ? (
          <p className="text-sm text-muted-foreground">{t("consolidation.loadFailed")}</p>
        ) : !organisation ? (
          <div className="h-9 w-56 animate-pulse rounded-md bg-muted" aria-hidden />
        ) : canSet ? (
          <Select value={organisation.consolidationApproach} onValueChange={choose} disabled={saving}>
            <SelectTrigger className="w-72" aria-label={t("consolidation.title")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONSOLIDATION_APPROACHES.map((a) => (
                <SelectItem key={a} value={a}>
                  {t(`consolidation.approaches.${a}`)}
                </SelectItem>
              ))}
              {UPCOMING_CONSOLIDATION_APPROACHES.map((a) => (
                <SelectItem key={a} value={a} disabled>
                  {t(`consolidation.approaches.${a}`)} · {t("consolidation.comingSoon")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-sm">
            <span className="font-medium" data-testid="consolidation-approach">
              {t(`consolidation.approaches.${organisation.consolidationApproach}`)}
            </span>{" "}
            <span className="text-muted-foreground">· {t("consolidation.readOnly")}</span>
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t("consolidation.hint")}</p>

        {readsExclusions && organisation && (
          <div className="space-y-1 border-t border-border pt-3" data-testid="boundary-exclusions">
            <p className="text-sm font-medium">{t("exclusions.title")}</p>
            {exclusions === null ? (
              <p className="text-sm text-muted-foreground">{t("exclusions.loadFailed")}</p>
            ) : exclusions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("exclusions.none")}</p>
            ) : (
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {exclusions.map((x) => (
                  <li key={x.subsidiaryId}>
                    {x.sharePercent === null
                      ? t("exclusions.item", { name: x.legalName })
                      : t("exclusions.itemShare", { name: x.legalName, share: formatNumber(x.sharePercent, locale) })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
