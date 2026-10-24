"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "use-intl";
import { toast } from "sonner";
import { CheckCircle2, CopyPlus, FilePlus2, Info, LogOut, Trash2 } from "lucide-react";
import { Sidebar } from "@/components/dashboard/sidebar";
import { DeclarationEditor, type EditorSite } from "@/components/inventory-boundary/declaration-editor";
import { ReportingContextBar, ReportingContextInvalid } from "@/components/reporting-context/reporting-context-bar";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError } from "@/lib/api";
import { formatNumber } from "@/lib/i18n/number";
import { useErrorToast } from "@/lib/i18n/hooks";
import {
  draftFromSnapshot,
  emptyDraft,
  storedDeclaration,
  versionFingerprint,
  type DeclarationDraft,
} from "@/lib/inventory-boundary-form";
import {
  boundaryActions,
  boundaryName,
  gapLines,
  newestFirst,
  subsidiaryRows,
  undeclaredSubsidiaries,
  versionState,
  type SubsidiaryRow,
  type VersionState,
} from "@/lib/inventory-boundary-view";
import { useAuthStore } from "@/lib/store";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import {
  LOCALE_FORMAT_TAGS,
  PERIOD_VALUES,
  REPORTING_YEAR_MIN,
  type InventoryBoundaryVersionDTO,
  type InventoryBoundaryVersionSummary,
  type Locale,
  type PutInventoryBoundarySubsidiaryRequest,
  type SubsidiaryDTO,
} from "@/lib/types";
import { useReportingContext } from "@/lib/use-reporting-context";

const STATE_STYLES: Record<VersionState, string> = {
  open: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  confirmed: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  frozenUnconfirmed: "bg-amber-500/15 text-amber-700 border-amber-500/30",
};

/** A refusal that means the screen's picture of the year is stale: reload it. */
const STALE_CODES = new Set(["boundary_frozen", "boundary_draft_open", "boundary_not_found", "boundary_confirm_requires_copy"]);

interface EditorTarget {
  /** The version it was opened in: a save goes there or nowhere. */
  versionId: string;
  subsidiaryId: string;
  name: string;
  /** The stored declaration it was opened on — a save refuses if it has moved since. */
  baseline: string;
  initial: DeclarationDraft;
  sites: EditorSite[];
}

/** `useReportingContext` reads the URL (`useSearchParams`), which Next wants under a Suspense boundary. */
export default function InventoryBoundaryPage() {
  return (
    <Suspense fallback={null}>
      <InventoryBoundaryScreen />
    </Suspense>
  );
}

/**
 * The inventory boundary editor (LP4-03 PR C, Decisions 2026-10-24 D1–D10):
 * a year's versions, and in the selected one each subsidiary's declaration.
 * Every write is super_admin's on the year's open version; a frozen version —
 * confirmed, or captured into a report dataset — is read-only, and new facts
 * start a new version (a copy). Every other role reads; a data_entry user
 * reads only its granted subsidiaries' part (the API's `granted_subsidiaries`).
 */
function InventoryBoundaryScreen() {
  const t = useTranslations("boundary");
  const tCommon = useTranslations("common");
  const tContext = useTranslations("reportingContext");
  const tPeriods = useTranslations("periods");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const errorToast = useErrorToast();
  const { user, setUser } = useAuthStore();
  const contextView = useReportingContext();
  const year = contextView.status === "ready" ? contextView.context.year : null;

  const [versions, setVersions] = useState<InventoryBoundaryVersionSummary[] | null>(null);
  const [priorNewest, setPriorNewest] = useState<InventoryBoundaryVersionSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InventoryBoundaryVersionDTO | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SubsidiaryRow | null>(null);
  // Each load is numbered; an answer for an earlier year or version is dropped.
  const loadSeq = useRef(0);
  const detailSeq = useRef(0);

  const formatDate = useMemo(
    () => new Intl.DateTimeFormat(LOCALE_FORMAT_TAGS[locale], { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );
  const month = useCallback((m: number) => tPeriods(`values.${PERIOD_VALUES.monthly[m - 1]}` as never), [tPeriods]);

  useEffect(() => {
    api.me().then(setUser).catch(() => {
      /* the proxy sends a visitor without a session to /login */
    });
    api.listSubsidiaries().then(setSubsidiaries).catch(errorToast);
  }, [setUser, errorToast]);

  const loadDetail = useCallback(async (id: string | null) => {
    const seq = ++detailSeq.current;
    setSelectedId(id);
    if (id === null) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    try {
      const dto = await api.getInventoryBoundary(id);
      if (seq === detailSeq.current) setDetail(dto);
    } catch (e) {
      if (seq !== detailSeq.current) return;
      setDetail(null);
      errorToast(e);
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, [errorToast]);

  /** The year's versions and the previous year's newest (a new year starts from it); then `select`, else the newest. */
  const loadYear = useCallback(async (forYear: number, select?: string | null) => {
    const seq = ++loadSeq.current;
    setVersions(null);
    setFailed(false);
    try {
      const [list, prior] = await Promise.all([
        api.listInventoryBoundaries(forYear),
        // Feeds one copy button only: its failure costs the button, not the year.
        forYear > REPORTING_YEAR_MIN
          ? api.listInventoryBoundaries(forYear - 1).catch((): InventoryBoundaryVersionSummary[] => [])
          : Promise.resolve([]),
      ]);
      if (seq !== loadSeq.current) return;
      const sorted = newestFirst(list);
      setVersions(sorted);
      setPriorNewest(newestFirst(prior)[0] ?? null);
      const keep = select !== undefined && sorted.some((v) => v.id === select) ? select : sorted[0]?.id ?? null;
      await loadDetail(keep);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setVersions([]);
      setDetail(null);
      setFailed(true);
      errorToast(e);
    }
  }, [errorToast, loadDetail]);

  useEffect(() => {
    if (year !== null) void loadYear(year);
  }, [year, loadYear]);

  // A write can finish after the user has moved on (Back/Forward changes the
  // year under an open dialog): its answer is shown only while the screen still
  // shows its version, and a reload reads the year the screen is on now.
  const yearRef = useRef(year);
  yearRef.current = year;
  const reload = useCallback((select?: string | null) => {
    if (yearRef.current !== null) void loadYear(yearRef.current, select);
  }, [loadYear]);
  const showIfCurrent = useCallback((dto: InventoryBoundaryVersionDTO) => {
    setDetail((shown) => (shown?.id === dto.id ? dto : shown));
  }, []);

  // An editor never outlives the version it was opened in.
  const shownId = detail?.id ?? null;
  useEffect(() => {
    setEditor((open) => (open && open.versionId !== shownId ? null : open));
  }, [shownId]);

  /** A refusal toasted; a stale picture of the year reloaded. */
  const refused = useCallback((e: unknown) => {
    errorToast(e);
    if (e instanceof ApiError && e.code && STALE_CODES.has(e.code)) reload(selectedId);
  }, [errorToast, reload, selectedId]);

  const actions = boundaryActions({ role: user?.role, versions: versions ?? [], selected: detail });
  const rows = detail ? subsidiaryRows(detail, subsidiaries) : [];
  const state = detail ? versionState(detail) : null;
  const openVersion = versions?.find((v) => v.frozenAt === null) ?? null;
  const readOnlyRole = user !== null && user.role !== "super_admin";

  async function create(copyOf?: InventoryBoundaryVersionSummary) {
    if (year === null) return;
    setBusy("create");
    try {
      const dto = await api.createInventoryBoundary(copyOf ? { reportingYear: year, copyOf: copyOf.id } : { reportingYear: year });
      toast.success(t("toast.created", { version: dto.version }));
      reload(dto.id);
    } catch (e) {
      refused(e);
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    if (!detail || year === null) return;
    setBusy("confirm");
    try {
      // A confirmation freezes for good, and the API takes no precondition:
      // confirm only what this screen shows, else show what changed first.
      const fresh = await api.getInventoryBoundary(detail.id);
      if (fresh.frozenAt === null && versionFingerprint(fresh.boundary) !== versionFingerprint(detail.boundary)) {
        toast.error(t("toast.versionChanged", { version: detail.version }));
        setConfirmOpen(false);
        showIfCurrent(fresh);
        return;
      }
      const dto = await api.confirmInventoryBoundary(detail.id);
      toast.success(t("toast.confirmed", { version: dto.version }));
      setConfirmOpen(false);
      reload(dto.id);
    } catch (e) {
      setConfirmOpen(false);
      refused(e);
      // Whatever refused it (gaps added meanwhile, a lost race), the screen reads the version again.
      if (!(e instanceof ApiError && e.code && STALE_CODES.has(e.code))) reload(detail.id);
    } finally {
      setBusy(null);
    }
  }

  async function deleteVersion() {
    if (!detail || year === null) return;
    setBusy("delete");
    try {
      await api.deleteInventoryBoundary(detail.id);
      toast.success(t("toast.deleted", { version: detail.version }));
      setDeleteOpen(false);
      reload();
    } catch (e) {
      setDeleteOpen(false);
      refused(e);
    } finally {
      setBusy(null);
    }
  }

  async function removeSubsidiary(row: SubsidiaryRow) {
    if (!detail) return;
    setBusy(`remove:${row.id}`);
    try {
      showIfCurrent(await api.deleteInventoryBoundarySubsidiary(detail.id, row.id));
      toast.success(t("toast.removed", { name: row.name }));
    } catch (e) {
      refused(e);
      // Removed or changed elsewhere meanwhile: the screen reads the version again.
      if (!(e instanceof ApiError && e.code && STALE_CODES.has(e.code))) reload(detail.id);
    } finally {
      setRemoveTarget(null);
      setBusy(null);
    }
  }

  async function openEditor(row: SubsidiaryRow) {
    if (!detail) return;
    setBusy(`open:${row.id}`);
    try {
      const declared = draftFromSnapshot(detail.boundary, row.id);
      const declaredSites = detail.boundary.entities
        .filter((e) => e.subsidiaryId === row.id && e.locationId !== null)
        .map((e) => ({ id: e.locationId as string, name: e.locationName ?? (e.locationId as string) }));
      // A frozen version shows what it declares; an open one offers the subsidiary's locations too.
      const listed = actions.edit
        ? (await api.listLocations(row.id)).filter((l) => l.subsidiaryId === row.id).map((l) => ({ id: l.id, name: l.name }))
        : [];
      const sites = [...declaredSites, ...listed.filter((l) => !declaredSites.some((d) => d.id === l.id))];
      setEditor({
        versionId: detail.id,
        subsidiaryId: row.id,
        name: row.name,
        baseline: storedDeclaration(detail.boundary, row.id),
        initial: declared ?? emptyDraft(),
        sites,
      });
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  }

  async function save(request: PutInventoryBoundarySubsidiaryRequest) {
    if (!editor || year === null) return;
    setBusy("save");
    try {
      // D4: the API's last write wins, so a save first checks that nobody
      // changed this subsidiary's declaration since the form was opened.
      const fresh = await api.getInventoryBoundary(editor.versionId);
      if (fresh.frozenAt !== null) {
        toast.error(t("toast.frozenElsewhere"));
        setEditor(null);
        reload(editor.versionId);
        return;
      }
      if (storedDeclaration(fresh.boundary, editor.subsidiaryId) !== editor.baseline) {
        toast.error(t("toast.changedElsewhere", { name: editor.name }));
        setEditor(null);
        showIfCurrent(fresh);
        return;
      }
      const dto = await api.putInventoryBoundarySubsidiary(editor.versionId, editor.subsidiaryId, request);
      showIfCurrent(dto);
      const gaps = gapLines(dto, editor.subsidiaryId).length;
      toast.success(t("toast.saved", { name: editor.name }), gaps > 0 ? { description: t("toast.savedWithGaps", { count: formatNumber(gaps, locale) }) } : undefined);
      setEditor(null);
    } catch (e) {
      // The form stays open with the user's edits unless the version moved on.
      if (e instanceof ApiError && e.code && STALE_CODES.has(e.code)) setEditor(null);
      refused(e);
    } finally {
      setBusy(null);
    }
  }

  const handleLogout = async () => {
    await getSupabaseBrowserClient().auth.signOut();
    router.push("/login");
  };

  const undeclared = detail ? undeclaredSubsidiaries(detail, subsidiaries) : [];
  const gapCount = detail?.boundaryGaps.length ?? 0;

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-[280px]">
        <div className="p-8 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">{t("title")}</h1>
              <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
            </div>
            <Button variant="outline" onClick={handleLogout} className="gap-2">
              <LogOut className="h-4 w-4" />
              {tCommon("signOut")}
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{tContext("label")}</p>
            {contextView.status === "ready" ? (
              <ReportingContextBar
                context={contextView.context}
                subsidiaries={null}
                onSelect={contextView.select}
                fields={["year"]}
                disabled={busy !== null}
              />
            ) : (
              <ReportingContextInvalid invalid={contextView.invalid} onReset={contextView.reset} />
            )}
          </div>

          {readOnlyRole && (
            <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="boundary-read-only">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              {t("readOnly")}
            </p>
          )}
          {detail?.view === "granted_subsidiaries" && (
            <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="boundary-granted-view">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              {t("grantedView")}
            </p>
          )}

          {year !== null && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
                <CardTitle className="text-base">{t("versions.title", { year })}</CardTitle>
                {actions.create && versions !== null && (
                  <div className="flex flex-wrap justify-end gap-2">
                    {detail && (
                      <Button size="sm" className="gap-2" disabled={busy !== null} onClick={() => void create(detail)}>
                        <CopyPlus className="h-4 w-4" />
                        {t("actions.copySelected", { version: detail.version })}
                      </Button>
                    )}
                    {versions.length === 0 && priorNewest && (
                      <Button size="sm" className="gap-2" disabled={busy !== null} onClick={() => void create(priorNewest)}>
                        <CopyPlus className="h-4 w-4" />
                        {t("actions.copyPrevious", { year: priorNewest.reportingYear, version: priorNewest.version })}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="gap-2" disabled={busy !== null} onClick={() => void create()}>
                      <FilePlus2 className="h-4 w-4" />
                      {t("actions.startEmpty")}
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {user?.role === "super_admin" && openVersion && openVersion.id !== selectedId && (
                  <p className="text-sm text-muted-foreground">{t("openExists", { version: openVersion.version })}</p>
                )}
                {versions === null ? (
                  <Skeleton className="h-16 w-full" />
                ) : failed ? (
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    {t("versions.failed")}
                    <Button size="sm" variant="outline" onClick={() => void loadYear(year)}>{t("versions.retry")}</Button>
                  </div>
                ) : versions.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="boundary-empty">
                    {readOnlyRole ? t("versions.emptyReader", { year }) : t("versions.empty", { year })}
                  </p>
                ) : (
                  <Table data-testid="boundary-versions">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("versions.column.version")}</TableHead>
                        <TableHead>{t("versions.column.state")}</TableHead>
                        <TableHead>{t("versions.column.created")}</TableHead>
                        <TableHead>{t("versions.column.decided")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {versions.map((v) => {
                        const s = versionState(v);
                        return (
                          <TableRow
                            key={v.id}
                            className={v.id === selectedId ? "bg-muted/60" : "cursor-pointer"}
                            onClick={() => v.id !== selectedId && void loadDetail(v.id)}
                            aria-selected={v.id === selectedId}
                            data-testid={`boundary-version-${v.version}`}
                          >
                            <TableCell className="font-medium">{t("versions.label", { version: v.version })}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className={STATE_STYLES[s]}>{t(`state.${s}`)}</Badge>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{formatDate.format(new Date(v.createdAt))}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {v.decidedAt ? formatDate.format(new Date(v.decidedAt)) : "—"}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}

          {detailLoading && !detail && <Skeleton className="h-40 w-full" />}

          {detail && state && (
            <Card data-testid="boundary-detail" data-state={state}>
              <CardHeader className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    {t("versions.labelWithYear", { version: detail.version, year: detail.reportingYear })}
                    <Badge variant="outline" className={STATE_STYLES[state]}>{t(`state.${state}`)}</Badge>
                  </CardTitle>
                  {actions.edit && (
                    <div className="flex gap-2">
                      <Button size="sm" className="gap-2" disabled={busy !== null} onClick={() => setConfirmOpen(true)}>
                        <CheckCircle2 className="h-4 w-4" />
                        {t("actions.confirm")}
                      </Button>
                      <Button size="sm" variant="outline" className="gap-2" disabled={busy !== null} onClick={() => setDeleteOpen(true)}>
                        <Trash2 className="h-4 w-4" />
                        {t("actions.delete")}
                      </Button>
                    </div>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{t(`stateNote.${state}`)}</p>
                <p className="text-sm" data-testid="boundary-summary">
                  {detail.view === "organisation" && t("summary.declared", {
                    declared: formatNumber(detail.boundary.subsidiaryIds.length, locale),
                    total: formatNumber(rows.length, locale),
                  })}
                  {detail.view === "organisation" && " · "}
                  {gapCount === 0 ? t("summary.noGaps") : t("summary.gaps", { count: formatNumber(gapCount, locale) })}
                </p>
              </CardHeader>
              <CardContent className="p-0">
                <Table data-testid="boundary-subsidiaries">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("subsidiaries.column.name")}</TableHead>
                      <TableHead>{t("subsidiaries.column.months")}</TableHead>
                      <TableHead className="text-right">{t("subsidiaries.column.sites")}</TableHead>
                      <TableHead className="text-right">{t("subsidiaries.column.sources")}</TableHead>
                      <TableHead className="text-right">{t("subsidiaries.column.gaps")}</TableHead>
                      <TableHead className="text-right">{t("subsidiaries.column.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                          {t("subsidiaries.empty")}
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map((row) => (
                        <TableRow key={row.id} data-testid="boundary-subsidiary" data-subsidiary={row.id}>
                          <TableCell>
                            <div className="font-medium">{row.name}</div>
                            {row.status && row.status !== "active" && (
                              <div className="text-xs text-muted-foreground">{t(`subsidiaries.status.${row.status as "inactive" | "pending"}`)}</div>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            {row.months
                              ? t("subsidiaries.monthRange", { first: month(row.months.first), last: month(row.months.last) })
                              : <span className="text-muted-foreground">{t("subsidiaries.notDeclared")}</span>}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{row.declared ? formatNumber(row.sites, locale) : "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.declared ? formatNumber(row.sources, locale) : "—"}</TableCell>
                          <TableCell className={`text-right tabular-nums ${row.gaps > 0 ? "text-amber-700" : ""}`}>
                            {row.declared ? formatNumber(row.gaps, locale) : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              {(row.declared || actions.edit) && (
                                <Button
                                  size="sm"
                                  variant={actions.edit && !row.declared ? "default" : "outline"}
                                  disabled={busy !== null}
                                  onClick={() => void openEditor(row)}
                                  aria-label={t(actions.edit ? (row.declared ? "actions.editFor" : "actions.declareFor") : "actions.viewFor", { name: row.name })}
                                >
                                  {t(actions.edit ? (row.declared ? "actions.edit" : "actions.declare") : "actions.view")}
                                </Button>
                              )}
                              {actions.edit && row.declared && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy !== null}
                                  onClick={() => setRemoveTarget(row)}
                                  aria-label={t("actions.removeFor", { name: row.name })}
                                >
                                  {t("actions.remove")}
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      {editor && detail?.id === editor.versionId && (
        <DeclarationEditor
          open
          onOpenChange={(open) => !open && busy !== "save" && setEditor(null)}
          title={t("editor.title", { name: editor.name, version: detail.version })}
          readOnly={!actions.edit}
          initial={editor.initial}
          sites={editor.sites}
          gaps={gapLines(detail, editor.subsidiaryId)}
          saving={busy === "save"}
          onSave={(request) => void save(request)}
        />
      )}

      <AlertDialog open={confirmOpen} onOpenChange={(open) => busy !== "confirm" && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmDialog.title", { version: detail?.version ?? 0 })}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirmDialog.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          {undeclared.length > 0 && (
            <p className="text-sm text-amber-700" data-testid="confirm-undeclared">
              {t("confirmDialog.undeclared", { names: undeclared.map(boundaryName).join(", ") })}
            </p>
          )}
          {actions.confirmBlock && (
            <p className="text-sm text-destructive" data-testid="confirm-blocked">
              {actions.confirmBlock === "empty"
                ? t("confirmDialog.blockedEmpty")
                : t("confirmDialog.blockedGaps", { count: formatNumber(gapCount, locale) })}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "confirm"}>{t("confirmDialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "confirm" || actions.confirmBlock !== null}
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              {t("confirmDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={(open) => busy !== "delete" && setDeleteOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDialog.title", { version: detail?.version ?? 0 })}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteDialog.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "delete"}>{t("deleteDialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "delete"}
              onClick={(e) => {
                e.preventDefault();
                void deleteVersion();
              }}
            >
              {t("deleteDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removeTarget !== null} onOpenChange={(open) => !open && busy === null && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeDialog.title", { name: removeTarget?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("removeDialog.body", { name: removeTarget?.name ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>{t("removeDialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy !== null}
              onClick={(e) => {
                e.preventDefault();
                if (removeTarget) void removeSubsidiary(removeTarget);
              }}
            >
              {t("removeDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
