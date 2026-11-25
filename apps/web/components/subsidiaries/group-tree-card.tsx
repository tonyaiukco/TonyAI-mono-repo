"use client";

import { useLocale, useTranslations } from "use-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import {
  admitsChild,
  ghgBasis,
  mayBeAssociate,
  type ConsolidationApproach,
  type SubsidiaryDTO,
  type UpdateSubsidiaryInput,
} from "@/lib/types";
import { useErrorToast } from "@/lib/i18n/hooks";
import { formatNumber } from "@/lib/i18n/number";
import { parseNaceCode, parseSharePercent } from "@/lib/subsidiaries-view";

type Locale = "en" | "tr";

/**
 * A company node's place in the group tree (inc26-group-tree): its type
 * (fixed), its parent (a readable one, or none said), its derived GHG basis,
 * the role that created it and — for a masterkey — its control, NACE code,
 * share percent and a move. Every refusal is the API's code, worded by the
 * catalogue (`useErrorToast`): `tree_cycle`, `node_move_blocked`,
 * `control_change_blocked`, `node_placement_invalid`.
 */
export function GroupTreeCard({
  subsidiary,
  canManage,
  onSaved,
}: {
  subsidiary: SubsidiaryDTO;
  canManage: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const t = useTranslations("subsidiaries");
  const tRoles = useTranslations("users");
  const locale = useLocale() as Locale;
  const showError = useErrorToast();
  const [nodes, setNodes] = useState<SubsidiaryDTO[]>([]);
  const [approach, setApproach] = useState<ConsolidationApproach | null>(null);
  const [associate, setAssociate] = useState(subsidiary.control === "associate");
  const [nace, setNace] = useState(subsidiary.naceCode ?? "");
  const [share, setShare] = useState(subsidiary.sharePercent === null ? "" : formatNumber(subsidiary.sharePercent, locale, { useGrouping: false }));
  const [parentId, setParentId] = useState(subsidiary.parentId ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAssociate(subsidiary.control === "associate");
    setNace(subsidiary.naceCode ?? "");
    setShare(subsidiary.sharePercent === null ? "" : formatNumber(subsidiary.sharePercent, locale, { useGrouping: false }));
    setParentId(subsidiary.parentId ?? "");
  }, [subsidiary, locale]);

  useEffect(() => {
    // The parent's name and the move's choices; the approach for the basis.
    Promise.all([api.listSubsidiaries(), api.getOrganisation()])
      .then(([list, org]) => {
        setNodes(list);
        setApproach(org.consolidationApproach);
      })
      .catch(showError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsidiary.id]);

  const parent = nodes.find((n) => n.id === subsidiary.parentId) ?? null;
  // Where it may move: a readable node admitting its type, never itself.
  // The API refuses a node beneath it (`tree_cycle`) — the screen does not
  // walk the tree to hide them, so the refusal is the one rule.
  const moveOptions = useMemo(
    () => nodes.filter((n) => n.id !== subsidiary.id && admitsChild(n, subsidiary.nodeType)),
    [nodes, subsidiary],
  );
  const basis = approach ? ghgBasis(subsidiary.control, approach) : null;

  async function save() {
    const sharePercent = parseSharePercent(share, locale);
    if (sharePercent === "invalid") {
      toast.error(t("tree.sharePercentInvalid"));
      return;
    }
    const naceCode = parseNaceCode(nace);
    if (naceCode === "invalid") {
      toast.error(t("tree.naceInvalid"));
      return;
    }
    const body: UpdateSubsidiaryInput = {};
    if (sharePercent !== subsidiary.sharePercent) body.sharePercent = sharePercent;
    if (naceCode !== subsidiary.naceCode) body.naceCode = naceCode;
    const control = associate ? "associate" : "controlled";
    if (control !== subsidiary.control) body.control = control;
    if (parentId && parentId !== (subsidiary.parentId ?? "")) body.parentId = parentId;
    if (Object.keys(body).length === 0) return;
    setSaving(true);
    try {
      await api.updateSubsidiary(subsidiary.id, body);
      toast.success(t("detail.saved"));
      await onSaved();
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="group-tree-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t(`tree.types.${subsidiary.nodeType}`)}
          {subsidiary.control === "associate" && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/15 text-amber-700">
              {t("tree.associateLabel")}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        {subsidiary.control === "associate" && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm md:col-span-2">
            {t("tree.associateClosed")}
          </p>
        )}
        <Fact label={t("tree.parent")} value={parent ? parent.legalName : t("tree.parentTop")} />
        <Fact
          label={t("tree.createdBy")}
          value={subsidiary.createdByRole ? tRoles(`roles.${subsidiary.createdByRole}`) : t("tree.carriedOver")}
        />
        <div className="space-y-1 md:col-span-2">
          <Label>{t("tree.ghgBasis")}</Label>
          <p className="text-sm" data-testid="ghg-basis">
            {basis === null
              ? "—"
              : basis.inScope12
                ? t("tree.ghgBasisControlled", { approach: t(`consolidation.approaches.${basis.basis as ConsolidationApproach}`) })
                : t("tree.ghgBasisAssociate")}
          </p>
          <p className="text-xs text-muted-foreground">{t("tree.ghgBasisHint")}</p>
        </div>

        {canManage ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="tree-nace">{t("tree.nace")}</Label>
              <Input id="tree-nace" value={nace} onChange={(e) => setNace(e.target.value)} placeholder={t("tree.naceHint")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tree-share">{t("tree.sharePercent")}</Label>
              <Input id="tree-share" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t("tree.sharePercentHint")}</p>
            </div>
            {subsidiary.nodeType !== "holding" && (
              <div className="space-y-2">
                <Label>{t("tree.move")}</Label>
                <Select value={parentId} onValueChange={setParentId}>
                  <SelectTrigger aria-label={t("tree.move")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {moveOptions.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        {n.legalName} · {t(`tree.types.${n.nodeType}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("tree.moveHint")}</p>
              </div>
            )}
            {mayBeAssociate(subsidiary.nodeType) && (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={associate} onCheckedChange={(v) => setAssociate(v === true)} />
                <span>
                  {t("tree.control")}
                  <span className="block text-xs text-muted-foreground">{t("tree.controlHint")}</span>
                </span>
              </label>
            )}
            <div className="md:col-span-2">
              <Button onClick={save} disabled={saving}>
                {t("tree.save")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Fact label={t("tree.nace")} value={subsidiary.naceCode ?? "—"} />
            <Fact
              label={t("tree.sharePercent")}
              value={subsidiary.sharePercent === null ? "—" : `${formatNumber(subsidiary.sharePercent, locale)} %`}
            />
          </>
        )}
        <p className="text-xs text-muted-foreground md:col-span-2">{t("tree.typeFixed")}</p>
      </CardContent>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <p className="text-sm">{value}</p>
    </div>
  );
}
