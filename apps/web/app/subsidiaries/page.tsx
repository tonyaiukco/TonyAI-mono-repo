"use client";

import { useLocale, useTranslations } from "use-intl";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { SignOutButton } from "@/components/dashboard/sign-out-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, Building2, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Clock, Globe, Lock, MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { LocationsDrawer } from "@/components/subsidiaries/locations-drawer";
import { PeriodLocksDrawer } from "@/components/subsidiaries/period-locks-drawer";
import {
  admitsChild,
  can,
  holdsRecords,
  MAX_LOCATIONS_PER_CREATE,
  mayBeAssociate,
  NODE_TYPES,
  SUBSIDIARY_STATUSES,
  selectableReportingYears,
} from "@/lib/types";
import type {
  CreateSubsidiaryLocationInput,
  LocationDTO,
  NodeType,
  RollUpRow,
  ScopeFigures,
  SubsidiaryDTO,
  SubsidiaryStatus,
} from "@/lib/types";
import { Checkbox } from "@/components/ui/checkbox";
import { ConsolidationCard } from "@/components/subsidiaries/consolidation-card";
import { NonAuthoritativeWarning } from "@/components/non-authoritative-warning";
import { usePricedGeographies } from "@/lib/use-priced-geographies";
import { treeFigure, parseNaceCode, parseSharePercent, treeRows } from "@/lib/subsidiaries-view";
import { useErrorToast } from "@/lib/i18n/hooks";
import { formatNumber } from "@/lib/i18n/number";
import { geographyLabel } from "@/lib/vocabulary";
import { useSignOut } from "@/lib/use-sign-out";

const statusClass: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  pending: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  inactive: "bg-red-500/15 text-red-600 border-red-500/30",
};

const emptyForm = {
  legalName: "",
  tradingName: "",
  location: "",
  // Set when the dialog opens, from what the library prices (owner review of WP7).
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

/** The reporting years the roll-up columns offer: this year and the four before. */

export default function SubsidiariesPage() {
  const tRoles = useTranslations("users");
  const t = useTranslations("subsidiaries");
  const tStatus = useTranslations("subsidiaryStatus");
  const tGeography = useTranslations("geography");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const showError = useErrorToast();
  const router = useRouter();
  const signOut = useSignOut();
  const { user, setUser } = useAuthStore();
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [locations, setLocations] = useState<LocationDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  // Set only while the geography confirmation is open; the save resumes from
  // the confirm action rather than being re-driven through handleSave.
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);
  /**
   * Locations collected before the subsidiary exists, sent with the create.
   *
   * Not `<LocationsPanel>`: that component persists every change immediately
   * and is keyed on ids that only exist server-side. Its two confirmations —
   * geography change, delete — protect committed records, and a row that has
   * never existed has none, so reusing it would mean flags switching off
   * exactly the guards that justify it.
   */
  const [draftLocations, setDraftLocations] = useState<CreateSubsidiaryLocationInput[]>([]);
  const [draftName, setDraftName] = useState("");
  const [draftGeo, setDraftGeo] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [locSubsidiaryId, setLocSubsidiaryId] = useState<string | null>(null);
  const [lockSubsidiaryId, setLockSubsidiaryId] = useState<string | null>(null);
  // The tree (inc26-group-tree): collapsed branches, the roll-up of the chosen
  // year, and the geographies the factor library can price.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // The years every reporting screen offers (owner review of WP7, P3).
  const [year, setYear] = useState<number>(selectableReportingYears()[0]);
  const [rollUp, setRollUp] = useState<Map<string, RollUpRow> | null>(null);
  const [rollUpState, setRollUpState] = useState<"loading" | "ready" | "failed">("loading");
  // A picker offers only what the library prices (D10; owner review of WP7, P2).
  const pricedGeos = usePricedGeographies();

  const [listVersion, setListVersion] = useState(0);
  async function refresh() {
    setLoading(true);
    try {
      const [list, locs] = await Promise.all([
        api.listSubsidiaries(),
        api.listLocations(),
      ]);
      setSubsidiaries(list);
      setLocations(locs);
      // Every reading of the list after the first: the exclusions note and
      // the roll-up read again with it.
      setListVersion((v) => v + 1);
    } catch (e) {
      showError(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(showError);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let live = true;
    setRollUpState("loading");
    api
      .rollUp(year)
      .then((res) => {
        if (!live) return;
        setRollUp(new Map(res.rows.map((r) => [r.subsidiaryId, r])));
        setRollUpState("ready");
      })
      .catch(() => {
        if (live) setRollUpState("failed");
      });
    return () => {
      live = false;
    };
  }, [year, listVersion]);

  const rows = useMemo(() => treeRows(subsidiaries, collapsed, locale), [subsidiaries, collapsed, locale]);
  // A figure that rests, in part, on a factor that is not authoritative now
  // says so where it is shown, as the dashboard does (owner review of WP7, P1).
  const figure = (f: ScopeFigures | null | undefined, testId: string) =>
    f ? (
      <span className="inline-flex items-center justify-end gap-1">
        {/* Records with no figure behind it: incomplete, and never a
            measured zero (owner review of WP7, P2). */}
        {f.uncalculatedRecordCount > 0 && (
          <CircleDashed
            className="h-3.5 w-3.5 text-muted-foreground"
            data-testid={testId.replace("non-authoritative", "uncalculated")}
            role="img"
            aria-label={t("tree.uncalculatedMark", { count: formatNumber(f.uncalculatedRecordCount, locale) })}
          >
            <title>{t("tree.uncalculatedMark", { count: formatNumber(f.uncalculatedRecordCount, locale) })}</title>
          </CircleDashed>
        )}
        {f.nonAuthoritativeRecordCount > 0 && (
          <AlertTriangle
            className="h-3.5 w-3.5 text-amber-600"
            data-testid={testId}
            role="img"
            aria-label={t("tree.nonAuthoritativeMark", { count: formatNumber(f.nonAuthoritativeRecordCount, locale) })}
          >
            <title>{t("tree.nonAuthoritativeMark", { count: formatNumber(f.nonAuthoritativeRecordCount, locale) })}</title>
          </AlertTriangle>
        )}
        {treeFigure(f.total, locale)}
      </span>
    ) : (
      "—"
    );
  const anyNonAuthoritative =
    rollUp !== null && [...rollUp.values()].some((r) => (r.rollUp?.nonAuthoritativeRecordCount ?? 0) > 0);
  const anyUncalculated =
    rollUp !== null && [...rollUp.values()].some((r) => (r.rollUp?.uncalculatedRecordCount ?? 0) > 0);
  function toggle(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  }

  const total = subsidiaries.length;
  const active = subsidiaries.filter((s) => s.reportingStatus === "active").length;
  const pending = subsidiaries.filter((s) => s.reportingStatus === "pending").length;
  const geographies = new Set(subsidiaries.map((s) => s.geographyCode)).size;

  // Single source of truth for masterkey-only write controls on this page
  // (create/delete subsidiary, and the lock/location write forms in the drawers).
  // The API + RLS remain the real enforcement; hiding these is UX/defense-in-depth.
  // The capability table (design Decision 3): companies and period locks are
  // the masterkey's; facilities a super_admin's too, in granted companies.
  const canManage = can(user?.role, "company.write");
  // A super_admin creates child companies under its own (inc26-group-tree, D5).
  const canCreate = canManage || can(user?.role, "company.create_child");
  // Where a new node may go, for this role: a masterkey under any node that
  // admits a child, a super_admin under one of its companies.
  const parentOptions = subsidiaries.filter((s) =>
    canManage
      ? NODE_TYPES.some((type) => admitsChild(s, type))
      : admitsChild(s, "child_company"),
  );
  const formParent = subsidiaries.find((s) => s.id === form.parentId) ?? null;
  const typeOptions: NodeType[] = !canManage
    ? ["child_company"]
    : formParent
      ? NODE_TYPES.filter((type) => admitsChild(formParent, type))
      : ["holding"];
  // A new company and its draft facilities: priced geographies only — a
  // parent's geography when priced, never one the library does not price.
  const geographyChoices = (preferred?: string | null) => pricedGeos.choices(undefined, preferred);
  const canManageLocations = can(user?.role, "location.write");
  const canLockPeriods = can(user?.role, "period_lock.write");
  const locSubsidiary = subsidiaries.find((s) => s.id === locSubsidiaryId) ?? null;
  const lockSubsidiary = subsidiaries.find((s) => s.id === lockSubsidiaryId) ?? null;
  const locCount = (subsidiaryId: string) =>
    locations.filter((l) => l.subsidiaryId === subsidiaryId).length;

  // Coverage read after the dialog opened: its default, once known.
  useEffect(() => {
    if (!addOpen || form.geographyCode !== "" || pricedGeos.priced === null) return;
    const parent = subsidiaries.find((s) => s.id === form.parentId);
    setForm((f) => (f.geographyCode === "" ? { ...f, geographyCode: pricedGeos.defaultFor(parent?.geographyCode) } : f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addOpen, pricedGeos.priced]);

  function openAdd() {
    // Under the root by default (a masterkey), or the first company a
    // super_admin may parent a child company under.
    const root = parentOptions.find((s) => s.nodeType === "holding") ?? parentOptions[0];
    const parentId = root?.id ?? "";
    const nodeType: NodeType = !canManage ? "child_company" : root ? "company" : "holding";
    setForm({ ...emptyForm, parentId, nodeType, geographyCode: pricedGeos.defaultFor(root?.geographyCode) });
    setDraftLocations([]);
    setDraftName("");
    setDraftGeo("");
    setAddOpen(true);
  }

  function addDraftLocation() {
    const name = draftName.trim();
    if (name.length === 0) {
      toast.error(t("create.draftNameRequired"));
      return;
    }
    if (draftLocations.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      toast.error(t("create.draftDuplicate", { name }));
      return;
    }
    // The same number the API enforces, from the same constant — a cap the
    // client cannot see is a 400 that arrives after the rows are typed.
    if (draftLocations.length >= MAX_LOCATIONS_PER_CREATE) {
      toast.error(t("create.draftCap", { max: formatNumber(MAX_LOCATIONS_PER_CREATE, locale) }));
      return;
    }
    // Never a facility with no geography — chosen, or the company's once known
    // (owner review of WP7, P2).
    const geographyCode = draftGeo || form.geographyCode;
    if (!geographyCode) {
      toast.error(t("create.draftGeographyRequired"));
      return;
    }
    setDraftLocations([...draftLocations, { name, geographyCode }]);
    setDraftName("");
    setDraftGeo("");
  }

  async function handleSave() {
    if (form.legalName.trim().length < 2) {
      toast.error(t("fields.legalNameMissing"));
      return;
    }
    // Round-1 SUB-3: locations are the subsidiary's operational borders, and
    // WP17's completeness denominator is their count — so the form asks for one
    // rather than letting a subsidiary start life with undefined borders. The
    // API stays permissive, deliberately (see CreateSubsidiaryDto).
    if (form.nodeType !== "sector_group" && draftLocations.length === 0) {
      toast.error(t("create.locationRequired"));
      return;
    }
    if (form.nodeType !== "sector_group" && !form.geographyCode) {
      toast.error(t("fields.geographyRequired"));
      return;
    }
    if (parseSharePercent(form.sharePercent, locale as "en" | "tr") === "invalid") {
      toast.error(t("tree.sharePercentInvalid"));
      return;
    }
    if (parseNaceCode(form.naceCode) === "invalid") {
      toast.error(t("tree.naceInvalid"));
      return;
    }
    await persist();
  }

  async function persist() {
    setSaving(true);
    try {
      const body = {
        legalName: form.legalName.trim(),
        tradingName: form.tradingName || null,
        location: form.location || null,
        // A sector group's is its parent's, set by the API (D10).
        ...(form.nodeType === "sector_group" ? {} : { geographyCode: form.geographyCode }),
        sector: form.sector || null,
        reportingStatus: form.reportingStatus,
        ...(form.parentId ? { parentId: form.parentId } : {}),
        nodeType: form.nodeType,
        ...(canManage && mayBeAssociate(form.nodeType) && form.associate ? { control: "associate" as const } : {}),
        naceCode: parseNaceCode(form.naceCode) as string | null,
        sharePercent: parseSharePercent(form.sharePercent, locale as "en" | "tr") as number | null,
      };
      const created = await api.createSubsidiary({
        ...body,
        locations: form.nodeType === "sector_group" ? [] : draftLocations,
      });
      toast.success(t("list.created"));
      setAddOpen(false);
      setForm(emptyForm);
      setDraftLocations([]);
      // Straight to its own page: everything else about a subsidiary — contact,
      // more locations, what depends on it — lives there, and landing on the
      // register would mean finding the row you just made.
      router.push(`/subsidiaries/${created.id}`);
    } catch (e) {
      showError(e);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deletingId) return;
    try {
      await api.deleteSubsidiary(deletingId);
      toast.success(t("list.deleted"));
      await refresh();
    } catch (e) {
      showError(e);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleLogout() {
    await signOut();
  }

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-[280px] transition-all duration-300">
        <div className="space-y-6 p-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">{t("list.title")}</h1>
              <p className="mt-1 text-muted-foreground">
                {user
                  ? t("list.subtitleUser", { name: user.fullName ?? "", role: tRoles(`roles.${user.role}`) })
                  : t("list.subtitle")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {canCreate && (
                <Button onClick={openAdd} className="gap-2" disabled={!canManage && parentOptions.length === 0}>
                  <Plus className="h-4 w-4" />
                  {t("list.add")}
                </Button>
              )}
              <SignOutButton onClick={handleLogout} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <SummaryCard title={t("list.cards.total")} value={formatNumber(total, locale)} icon={<Building2 className="h-4 w-4 text-primary" />} hint={t("list.cards.totalHint")} />
            <SummaryCard title={t("list.cards.active")} value={formatNumber(active, locale)} icon={<CheckCircle2 className="h-4 w-4 text-primary" />} hint={t("list.cards.activeHint")} />
            <SummaryCard title={t("list.cards.pending")} value={formatNumber(pending, locale)} icon={<Clock className="h-4 w-4 text-primary" />} hint={t("list.cards.pendingHint")} />
            <SummaryCard title={t("list.cards.geographies")} value={formatNumber(geographies, locale)} icon={<Globe className="h-4 w-4 text-primary" />} hint={t("list.cards.geographiesHint")} />
          </div>

          <ConsolidationCard role={user?.role} refreshKey={listVersion} />

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4">
              <CardTitle className="text-base">{t("list.register")}</CardTitle>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>{t("tree.year")}</span>
                <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                  <SelectTrigger className="h-8 w-24" aria-label={t("tree.year")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectableReportingYears(year).map((y) => (
                      <SelectItem key={y} value={String(y)}>
                        {y}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{tCommon("loading")}</p>
              ) : subsidiaries.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("list.empty")}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("list.columns.legalName")}</TableHead>
                      <TableHead>{t("tree.columns.type")}</TableHead>
                      <TableHead className="text-right">{t("tree.columns.own")}</TableHead>
                      <TableHead className="text-right">{t("tree.columns.rollUp")}</TableHead>
                      <TableHead>{t("list.columns.tradingName")}</TableHead>
                      <TableHead>{t("list.columns.location")}</TableHead>
                      <TableHead>{t("list.columns.geo")}</TableHead>
                      <TableHead>{t("list.columns.sector")}</TableHead>
                      <TableHead>{t("list.columns.locations")}</TableHead>
                      <TableHead>{t("list.columns.status")}</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(({ node: s, depth, hasChildren }) => (
                      <TableRow key={s.id} data-testid={`tree-row-${s.id}`} data-depth={depth}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-1" style={{ paddingLeft: depth * 20 }}>
                            {hasChildren ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={() => toggle(s.id)}
                                aria-expanded={!collapsed.has(s.id)}
                                aria-label={collapsed.has(s.id) ? t("tree.expand", { name: s.legalName }) : t("tree.collapse", { name: s.legalName })}
                              >
                                {collapsed.has(s.id) ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                              </Button>
                            ) : (
                              <span className="inline-block w-6" aria-hidden />
                            )}
                            <span>{s.legalName}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge variant="outline">{t(`tree.types.${s.nodeType}`)}</Badge>
                            {s.control === "associate" && (
                              <Badge variant="outline" className="border-amber-500/30 bg-amber-500/15 text-amber-700">
                                {t("tree.associateLabel")}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {rollUpState === "ready" && holdsRecords(s) ? figure(rollUp?.get(s.id)?.own, `non-authoritative-own-${s.id}`) : rollUpState === "ready" ? "—" : ""}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {rollUpState === "ready" ? figure(rollUp?.get(s.id)?.rollUp, `non-authoritative-rollup-${s.id}`) : ""}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{s.tradingName ?? "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{s.location ?? "—"}</TableCell>
                        <TableCell>{s.geographyCode}</TableCell>
                        <TableCell className="text-muted-foreground">{s.sector ?? "—"}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setLocSubsidiaryId(s.id)}
                            className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                            aria-label={t("list.manageLocations")}
                          >
                            <MapPin className="h-3.5 w-3.5" />
                            {formatNumber(locCount(s.id), locale)}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setLockSubsidiaryId(s.id)}
                            className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                            aria-label={t("list.manageLocks")}
                          >
                            <Lock className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={statusClass[s.reportingStatus]}>
                            {tStatus(s.reportingStatus)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {/* The register is a list; everything about one
                              company lives on its own page — its contact
                              details, dependent counts, GHG basis and why an
                              associate takes no data — so every reader opens
                              it (owner review of WP7, P2); only a writer edits
                              there. */}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => router.push(`/subsidiaries/${s.id}`)}
                            aria-label={canManage ? t("list.open") : t("list.view")}
                          >
                            {canManage ? (
                              <Pencil className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                          </Button>
                          {canManage && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setDeletingId(s.id)}
                                aria-label={t("list.delete")}
                              >
                                <Trash2 className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {rollUpState === "ready" && anyUncalculated && (
                <p className="pt-3 text-xs text-muted-foreground" data-testid="tree-uncalculated">
                  {t("tree.uncalculatedNote")}
                </p>
              )}
              {rollUpState === "ready" && anyNonAuthoritative && (
                <div className="pt-3">
                  <NonAuthoritativeWarning testId="tree-non-authoritative">{t("tree.nonAuthoritativeNote")}</NonAuthoritativeWarning>
                </div>
              )}
              {!loading && subsidiaries.length > 0 && rollUpState !== "ready" && (
                <p className="pt-3 text-xs text-muted-foreground" role="status">
                  {rollUpState === "loading" ? t("tree.figuresLoading") : t("tree.figuresFailed")}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        {/* The form grows with each draft location: it scrolls inside the
            viewport so the last fields and the footer stay reachable (QA BUG-07). */}
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("create.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Where the node sits in the group tree (inc26-group-tree). */}
            {parentOptions.length > 0 && (
              <div className="grid grid-cols-2 gap-4">
                <Field label={t("tree.parent")}>
                  <Select
                    value={form.parentId}
                    onValueChange={(v) => {
                      const parent = subsidiaries.find((s) => s.id === v);
                      const types = canManage && parent ? NODE_TYPES.filter((type) => admitsChild(parent, type)) : ["child_company" as NodeType];
                      setForm({ ...form, parentId: v, nodeType: types.includes(form.nodeType) ? form.nodeType : types[0] });
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
                    onValueChange={(v) => setForm({ ...form, nodeType: v as NodeType, associate: mayBeAssociate(v as NodeType) && form.associate })}
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
                onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                placeholder={t("create.legalNamePlaceholder")}
              />
            </Field>
            <Field label={t("fields.tradingName")}>
              <Input
                value={form.tradingName}
                onChange={(e) => setForm({ ...form, tradingName: e.target.value })}
              />
            </Field>
            <Field label={t("fields.location")}>
              <Input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
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
                  onValueChange={(v) => setForm({ ...form, geographyCode: v })}
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
                {pricedGeos.failed && form.nodeType !== "sector_group" && (
                  <p className="pt-1 text-xs text-destructive">{t("fields.geographyUnavailable")}</p>
                )}
              </Field>
              <Field label={t("fields.status")}>
                <Select
                  value={form.reportingStatus}
                  onValueChange={(v) =>
                    setForm({ ...form, reportingStatus: v as typeof form.reportingStatus })
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
                onChange={(e) => setForm({ ...form, sector: e.target.value })}
                placeholder={t("create.sectorPlaceholder")}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label={t("tree.nace")}>
                <Input
                  value={form.naceCode}
                  onChange={(e) => setForm({ ...form, naceCode: e.target.value })}
                  placeholder={t("tree.naceHint")}
                />
              </Field>
              <Field label={t("tree.sharePercent")}>
                <Input
                  inputMode="decimal"
                  value={form.sharePercent}
                  onChange={(e) => setForm({ ...form, sharePercent: e.target.value })}
                  aria-describedby="share-percent-hint"
                />
                <p id="share-percent-hint" className="text-xs text-muted-foreground">{t("tree.sharePercentHint")}</p>
              </Field>
            </div>
            {canManage && mayBeAssociate(form.nodeType) && (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={form.associate}
                  onCheckedChange={(v) => setForm({ ...form, associate: v === true })}
                  aria-describedby="associate-hint"
                />
                <span>
                  {t("tree.control")}
                  <span id="associate-hint" className="block text-xs text-muted-foreground">{t("tree.controlHint")}</span>
                </span>
              </label>
            )}
            <p className="text-xs text-muted-foreground">{t("tree.pricedOnly")}</p>
          </div>

          {/* Operational locations, collected as a draft and written with the
              subsidiary in one transaction (round-1 SUB-3). The geography
              select is labelled "Facility geography" so it cannot be confused with
              the subsidiary's own "Geography" — they sit in one dialog, and a
              label-scoped selector matching both would be ambiguous. */}
          {form.nodeType === "sector_group" ? (
            <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">{t("tree.noFacilitySectorGroup")}</p>
          ) : (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <MapPin className="h-4 w-4 text-primary" />
              {t("create.locationsTitle")}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("create.locationsHint")}
            </p>

            {draftLocations.length > 0 && (
              <ul className="space-y-1">
                {draftLocations.map((l, i) => (
                  <li
                    key={`${l.name}-${i}`}
                    className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2 text-sm"
                  >
                    <span>
                      {l.name}{" "}
                      <span className="text-muted-foreground">
                        · {geographyLabel(l.geographyCode, tGeography)}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("create.removeDraft", { name: l.name })}
                      onClick={() =>
                        setDraftLocations(draftLocations.filter((_, j) => j !== i))
                      }
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
              <Input
                aria-label={t("create.draftName")}
                placeholder={t("create.draftNamePlaceholder")}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
              />
              <Select
                value={draftGeo || form.geographyCode}
                onValueChange={setDraftGeo}
              >
                <SelectTrigger aria-label={t("create.siteGeography")} className="sm:w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {geographyChoices(form.geographyCode).map((code) => (
                    <SelectItem key={code} value={code}>
                      {geographyLabel(code, tGeography)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={addDraftLocation}>
                <Plus className="h-4 w-4" /> {t("create.addDraft")}
              </Button>
            </div>
          </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? tCommon("saving") : t("create.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LocationsDrawer
        subsidiary={locSubsidiary}
        locations={locations.filter((l) => l.subsidiaryId === locSubsidiaryId)}
        canManage={canManageLocations}
        onClose={() => setLocSubsidiaryId(null)}
        onChanged={refresh}
      />

      <PeriodLocksDrawer
        subsidiary={lockSubsidiary}
        canManage={canLockPeriods}
        onClose={() => setLockSubsidiaryId(null)}
      />

      <AlertDialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("list.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("list.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("list.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SummaryCard({
  title,
  value,
  icon,
  hint,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  hint: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
