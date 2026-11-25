"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { toast } from "sonner";
import { AlertTriangle, Info, MoreHorizontal, ShieldAlert, UserPlus } from "lucide-react";
import { Sidebar } from "@/components/dashboard/sidebar";
import { SignOutButton } from "@/components/dashboard/sign-out-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError } from "@/lib/api";
import { isStaleCursor } from "@/lib/cursor-pages";
import { useErrorToast } from "@/lib/i18n/hooks";
import { formatNumber } from "@/lib/i18n/number";
import { useAuthStore } from "@/lib/store";
import {
  CATEGORIES,
  LOCALE_FORMAT_TAGS,
  SUPPORTED_LOCALES,
  type Locale,
  type SubsidiaryDTO,
  type UserAccessGrantDTO,
  type UserRole,
  type UserSummaryDTO,
} from "@/lib/types";
import {
  accessPayload,
  accessSummary,
  accessWarnings,
  appendPage,
  assignableCompanies,
  categorySelection,
  chooseCompany,
  clearCategories,
  companySelection,
  initialDraft,
  invitableRoles,
  invitationNote,
  invitePayload,
  isCarriedOver,
  pickerKind,
  replaceUser,
  restoreCompany,
  roleChangeFollowUp,
  roleChangeOptions,
  initialRoleChoice,
  rowActions,
  selectAllCategories,
  selectAllCompanies,
  toggleCategory,
  toggleCompany,
  usersErrorKey,
  withdrawCompany,
  type AccessDraft,
  type InviteDrafts,
  reloadAfterAccessSave,
} from "@/lib/users-view";
import { cn } from "@/lib/utils";
import { useSignOut } from "@/lib/use-sign-out";

const STATUS_STYLES: Record<UserSummaryDTO["status"], string> = {
  active: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  invited: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  disabled: "bg-slate-500/15 text-slate-600 border-slate-500/30",
};

/** Toasts a refusal: the users screen's own sentence for a code it words, the shared one otherwise. */
function useUsersErrorToast(): (error: unknown) => void {
  const t = useTranslations("users");
  const errorToast = useErrorToast();
  return useCallback(
    (error: unknown) => {
      const key = usersErrorKey(error);
      if (key) toast.error(t(key));
      else errorToast(error);
    },
    [t, errorToast],
  );
}

/**
 * User and access management (LP4-01; the four roles of
 * inc26-roles-approval-chain). A masterkey administers super_admins and
 * auditors across the organisation; a super_admin the standard users of its
 * own companies. Every change goes through the API, which answers the member
 * as they now stand; the row is replaced with that answer, so a step that did
 * not go through (an undelivered invitation, a pending sign-in block) shows at
 * once. Other roles see why they cannot use it rather than a missing page.
 * Every decision is `lib/users-view.ts`'s; this file renders.
 */
export default function UsersPage() {
  const t = useTranslations("users");
  const locale = useLocale() as Locale;
  const signOut = useSignOut();
  const errorToast = useErrorToast();
  const usersErrorToast = useUsersErrorToast();
  const { user, setUser } = useAuthStore();
  const [users, setUsers] = useState<UserSummaryDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleTarget, setRoleTarget] = useState<UserSummaryDTO | null>(null);
  const [accessTarget, setAccessTarget] = useState<UserSummaryDTO | null>(null);
  const [disableTarget, setDisableTarget] = useState<UserSummaryDTO | null>(null);

  const formatDate = useMemo(
    () => new Intl.DateTimeFormat(LOCALE_FORMAT_TAGS[locale], { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );
  const subsidiaryNames = useMemo(() => new Map(subsidiaries.map((s) => [s.id, s.legalName])), [subsidiaries]);
  const assignable = useMemo(() => assignableCompanies(user, subsidiaries), [user, subsidiaries]);
  const inviteRoles = invitableRoles(user);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.listUsersPage();
      setUsers(page.items);
      setNextCursor(page.nextCursor);
      setForbidden(false);
      setSubsidiaries(await api.listSubsidiaries());
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setForbidden(true);
        setUsers([]);
      } else {
        errorToast(e);
      }
    } finally {
      setLoading(false);
    }
  }, [errorToast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.me().then(setUser).catch(() => {
      /* the proxy sends a visitor without a session to /login */
    });
  }, [setUser]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.listUsersPage({ cursor: nextCursor });
      setUsers((list) => appendPage(list, page.items));
      setNextCursor(page.nextCursor);
    } catch (e) {
      errorToast(e);
      // A cursor from before a release (the users list's version 1): start again.
      if (isStaleCursor(e)) void load();
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleLogout() {
    await signOut();
  }

  /** Runs one action on a member and puts the API's answer in its row. */
  async function act(target: UserSummaryDTO, call: () => Promise<UserSummaryDTO>, done: (updated: UserSummaryDTO) => void) {
    setBusyId(target.id);
    try {
      const updated = await call();
      setUsers((list) => replaceUser(list, updated));
      done(updated);
    } catch (e) {
      usersErrorToast(e);
    } finally {
      setBusyId(null);
    }
  }

  function afterDelivery(updated: UserSummaryDTO, sentKey: "invited" | "resent") {
    if (updated.invitation?.status === "sent") toast.success(t(sentKey, { email: updated.email }));
    else toast.warning(t("invitedNotDelivered", { email: updated.email }));
  }

  function afterEnabledChange(updated: UserSummaryDTO, key: "disabledToast" | "enabledToast") {
    toast.success(t(key, { name: updated.fullName }), updated.authSyncPending ? { description: t("authSyncWarning") } : undefined);
  }

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-[280px]">
        <div className="p-8 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">{t("title")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("subtitle")}
                {user ? ` · ${user.fullName || user.email} (${t(`roles.${user.role}`)})` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              {!forbidden && inviteRoles.length > 0 && (
                <Button onClick={() => setInviteOpen(true)} className="gap-2" disabled={loading}>
                  <UserPlus className="h-4 w-4" />
                  {t("invite")}
                </Button>
              )}
              <SignOutButton onClick={handleLogout} />
            </div>
          </div>

          {forbidden ? (
            <Card>
              <CardContent className="flex items-start gap-3 py-8">
                <ShieldAlert className="h-5 w-5 shrink-0 text-amber-500" />
                <div className="space-y-1">
                  <p className="font-medium">{t("forbiddenTitle")}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("forbidden", { role: user ? t(`roles.${user.role}`) : "—" })}
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("columns.name")}</TableHead>
                      <TableHead>{t("columns.role")}</TableHead>
                      <TableHead>{t("columns.status")}</TableHead>
                      <TableHead>{t("columns.access")}</TableHead>
                      <TableHead className="w-16 text-right">{t("columns.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 4 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={5}>
                            <Skeleton className="h-6 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : users.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                          {t("empty")}
                        </TableCell>
                      </TableRow>
                    ) : (
                      users.map((member) => {
                        const note = invitationNote(member);
                        const access = accessSummary(member, subsidiaryNames, LOCALE_FORMAT_TAGS[locale]);
                        const actions = rowActions(user, member);
                        const self = member.id === user?.id;
                        return (
                          <TableRow key={member.id} className={cn(member.status === "disabled" && "opacity-70")}>
                            <TableCell>
                              <div className="font-medium">
                                {member.fullName}
                                {self && <span className="ml-1 text-xs text-muted-foreground">({t("you")})</span>}
                              </div>
                              <div className="text-xs text-muted-foreground">{member.email}</div>
                            </TableCell>
                            <TableCell>{t(`roles.${member.role}`)}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className={STATUS_STYLES[member.status]}>
                                {t(`status.${member.status}`)}
                              </Badge>
                              {note && (
                                <div
                                  className={cn(
                                    "mt-1 text-xs",
                                    note.key === "deliveryFailed" ? "text-amber-700" : "text-muted-foreground",
                                  )}
                                >
                                  {note.key === "invitationSent"
                                    ? t("invitationSent", { date: formatDate.format(new Date(note.values.date)) })
                                    : t(note.key)}
                                </div>
                              )}
                              {member.authSyncPending && (
                                <div className="mt-1 flex items-center gap-1 text-xs text-amber-700">
                                  <AlertTriangle className="h-3 w-3" />
                                  {t("authSyncPending")}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-sm">
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                {access.key === "named" ? (
                                  <span
                                    className="flex min-w-0 max-w-xs items-baseline gap-1"
                                    title={access.all.join(", ") || undefined}
                                  >
                                    <span className="truncate text-foreground" data-testid="user-access-names">
                                      {access.names.join(", ")}
                                    </span>
                                    {access.overflow > 0 && (
                                      <span className="shrink-0 text-muted-foreground">
                                        {t("accessMore", { count: formatNumber(access.overflow, locale) })}
                                      </span>
                                    )}
                                  </span>
                                ) : access.key === "noAccess" ? (
                                  <span className="flex items-center gap-1 text-amber-700" data-testid="user-access-none">
                                    <AlertTriangle className="h-3.5 w-3.5" />
                                    {t("noAccess")}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">{t("wholeOrganisation")}</span>
                                )}
                                {actions.editAccess && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7"
                                    disabled={busyId === member.id}
                                    aria-label={t("actions.editAccessFor", { name: member.fullName })}
                                    onClick={() => setAccessTarget(member)}
                                  >
                                    {t("actions.editAccess")}
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              {actions.menu && (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      disabled={busyId === member.id}
                                      aria-label={t("actions.menu", { name: member.fullName })}
                                    >
                                      <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    {actions.changeRole && (
                                      <DropdownMenuItem onSelect={() => setRoleTarget(member)}>
                                        {t("actions.changeRole")}
                                      </DropdownMenuItem>
                                    )}
                                    {actions.editAccess && (
                                      <DropdownMenuItem onSelect={() => setAccessTarget(member)}>
                                        {t("actions.editAccess")}
                                      </DropdownMenuItem>
                                    )}
                                    {actions.resend && (
                                      <DropdownMenuItem
                                        onSelect={() =>
                                          void act(member, () => api.resendInvitation(member.id), (u) => afterDelivery(u, "resent"))
                                        }
                                      >
                                        {t("actions.resend")}
                                      </DropdownMenuItem>
                                    )}
                                    {actions.toggleEnabled && (
                                      <>
                                        <DropdownMenuSeparator />
                                        {member.status === "disabled" ? (
                                          <DropdownMenuItem
                                            onSelect={() =>
                                              void act(member, () => api.enableUser(member.id), (u) =>
                                                afterEnabledChange(u, "enabledToast"),
                                              )
                                            }
                                          >
                                            {t("actions.enable")}
                                          </DropdownMenuItem>
                                        ) : (
                                          <DropdownMenuItem className="text-destructive" onSelect={() => setDisableTarget(member)}>
                                            {t("actions.disable")}
                                          </DropdownMenuItem>
                                        )}
                                      </>
                                    )}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {nextCursor && !forbidden && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                {t("loadMore")}
              </Button>
            </div>
          )}
        </div>
      </main>

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        roles={inviteRoles}
        assignable={assignable}
        names={subsidiaryNames}
        defaultLanguage={locale}
        onInvited={(created) => {
          setUsers((list) => [created, ...list.filter((u) => u.id !== created.id)]);
          afterDelivery(created, "invited");
        }}
      />
      <RoleDialog
        target={roleTarget}
        options={roleChangeOptions(user)}
        onClose={() => setRoleTarget(null)}
        onSave={(target, role) =>
          act(target, () => api.setUserRole(target.id, { role }), (updated) => {
            setRoleTarget(null);
            const next = roleChangeFollowUp(user, target.role, updated);
            if (next === "superAdminAssigns") {
              toast.success(t("roleChanged"), { description: t("roleChangedStandardUser") });
            } else {
              toast.success(t("roleChanged"));
            }
            // A new super_admin holds no grant: go straight to choosing their companies.
            if (next === "openAccessEditor") setAccessTarget(updated);
          })
        }
      />
      <AccessDialog
        target={accessTarget}
        assignable={assignable}
        names={subsidiaryNames}
        onClose={() => setAccessTarget(null)}
        onSave={(target, draft) =>
          act(target, () => api.replaceUserAccess(target.id, { access: accessPayload(target.role, draft) }), (updated) => {
            setAccessTarget(null);
            toast.success(t("accessSaved"));
            // The last grant this super_admin could see is gone: the API, not
            // the row, says whether the account is still listed.
            if (reloadAfterAccessSave(user, target, updated)) void load();
          })
        }
      />
      <AlertDialog open={disableTarget !== null} onOpenChange={(open) => !open && setDisableTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("disableDialog.title", { name: disableTarget?.fullName ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("disableDialog.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("disableDialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                const target = disableTarget;
                setDisableTarget(null);
                if (target) void act(target, () => api.disableUser(target.id), (u) => afterEnabledChange(u, "disabledToast"));
              }}
            >
              {t("disableDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function WarningLine({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-amber-700" role="status" data-testid={testId}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {children}
    </p>
  );
}

/** Two small text buttons: select all and clear. */
function SelectAllClear({
  onSelectAll,
  onClear,
  selectAllDisabled,
  clearDisabled,
  selectAllLabel,
  clearLabel,
}: {
  onSelectAll: () => void;
  onClear: () => void;
  selectAllDisabled: boolean;
  clearDisabled: boolean;
  selectAllLabel?: string;
  clearLabel?: string;
}) {
  const t = useTranslations("users");
  return (
    <div className="flex gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        disabled={selectAllDisabled}
        aria-label={selectAllLabel}
        onClick={onSelectAll}
      >
        {t("picker.selectAll")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        disabled={clearDisabled}
        aria-label={clearLabel}
        onClick={onClear}
      >
        {t("picker.clear")}
      </Button>
    </div>
  );
}

/** One company's category checklist, with its own count, select all and clear; nothing is ticked for a newly chosen company. */
function CategoryChecklist({
  grant,
  name,
  onChange,
}: {
  grant: UserAccessGrantDTO;
  name: string;
  onChange: (change: (draft: AccessDraft) => AccessDraft) => void;
}) {
  const t = useTranslations("users");
  const tCategory = useTranslations("categories");
  const locale = useLocale() as Locale;
  const state = categorySelection(grant);
  const id = grant.subsidiaryId;
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3" data-testid="category-picker">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{t("picker.categoriesHeading", { name })}</span>
        <SelectAllClear
          onSelectAll={() => onChange((d) => selectAllCategories(d, id))}
          onClear={() => onChange((d) => clearCategories(d, id))}
          selectAllDisabled={state.allSelected}
          clearDisabled={state.noneSelected}
          selectAllLabel={t("picker.selectAllCategoriesFor", { name })}
          clearLabel={t("picker.clearCategoriesFor", { name })}
        />
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="category-picker-count">
        {t("picker.categoriesCount", { count: formatNumber(state.count, locale), total: formatNumber(state.total, locale) })}
      </p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {CATEGORIES.map((c) => (
          <label key={c} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={grant.categories.includes(c)}
              onCheckedChange={(checked) => onChange((d) => toggleCategory(d, id, c, checked === true))}
            />
            {tCategory(c)}
          </label>
        ))}
      </div>
      {state.noneSelected && (
        <WarningLine testId="category-picker-empty">{t("picker.noCategoryWarning", { name })}</WarningLine>
      )}
    </div>
  );
}

/**
 * The one access picker (invite and access dialogs). Lists only the companies
 * the reader may assign. A super_admin's: several companies, "n of m
 * selected", select all and clear. A standard user's: one company and its
 * category checklist; a carried-over account's several companies are shown
 * as held and removable, with none addable. Empty selections are warned,
 * never refused.
 */
function AccessPicker({
  role,
  initial,
  draft,
  onChange,
  assignable,
  names,
  help,
}: {
  role: UserRole;
  /** The account's grants when the dialog opened (none for an invitation). */
  initial: readonly UserAccessGrantDTO[];
  draft: AccessDraft;
  onChange: (change: (draft: AccessDraft) => AccessDraft) => void;
  assignable: SubsidiaryDTO[];
  names: ReadonlyMap<string, string>;
  help?: string;
}) {
  const t = useTranslations("users");
  const locale = useLocale() as Locale;
  const kind = pickerKind(role);
  const warnings = accessWarnings(role, draft, assignable);
  const carriedOver = isCarriedOver(role, initial);
  const nameOf = (id: string) => names.get(id) ?? "";

  const none = (
    <p className="rounded-md border p-3 text-sm text-muted-foreground" data-testid="subsidiary-picker-none">
      {t("picker.noneAssignable")}
    </p>
  );

  let body: React.ReactNode;
  if (kind === "companies") {
    const state = companySelection(draft, assignable);
    const ticked = new Set(draft.map((g) => g.subsidiaryId));
    body = (
      <>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground" aria-live="polite" data-testid="subsidiary-picker-count">
            {t("picker.selectedCount", { count: formatNumber(state.count, locale), total: formatNumber(state.total, locale) })}
          </span>
          <SelectAllClear
            onSelectAll={() => onChange((d) => selectAllCompanies(d, assignable))}
            onClear={() => onChange(() => [])}
            selectAllDisabled={state.total === 0 || state.allSelected}
            clearDisabled={draft.length === 0}
          />
        </div>
        {warnings.noneAssignable ? (
          none
        ) : (
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
            {assignable.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={ticked.has(s.id)}
                  onCheckedChange={(checked) => onChange((d) => toggleCompany(d, s.id, checked === true))}
                />
                {s.legalName}
              </label>
            ))}
          </div>
        )}
      </>
    );
  } else if (carriedOver) {
    const current = new Map(draft.map((g) => [g.subsidiaryId, g]));
    body = (
      <>
        <p className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs" data-testid="held-companies-note">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {t("picker.heldNote")}
        </p>
        <div className="max-h-[22rem] space-y-3 overflow-y-auto">
          {initial.map((held) => {
            const name = nameOf(held.subsidiaryId);
            const grant = current.get(held.subsidiaryId);
            return (
              <div key={held.subsidiaryId} className="space-y-2" data-testid="held-company">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className={cn("font-medium", !grant && "text-muted-foreground line-through")}>{name}</span>
                  {grant ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-destructive"
                      aria-label={t("picker.withdrawFor", { name })}
                      onClick={() => onChange((d) => withdrawCompany(d, held.subsidiaryId))}
                    >
                      {t("picker.withdraw")}
                    </Button>
                  ) : (
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {t("picker.withdrawn")}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2"
                        aria-label={t("picker.restoreFor", { name })}
                        onClick={() => onChange((d) => restoreCompany(d, initial, held.subsidiaryId))}
                      >
                        {t("picker.restore")}
                      </Button>
                    </span>
                  )}
                </div>
                {grant && <CategoryChecklist grant={grant} name={name} onChange={onChange} />}
              </div>
            );
          })}
        </div>
      </>
    );
  } else {
    const chosen = draft[0];
    const state = companySelection(draft, assignable);
    body = (
      <>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground" aria-live="polite" data-testid="subsidiary-picker-count">
            {t("picker.selectedCount", { count: formatNumber(state.count, locale), total: formatNumber(state.total, locale) })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={draft.length === 0}
            aria-label={t("picker.clearCompany")}
            onClick={() => onChange(() => [])}
          >
            {t("picker.clear")}
          </Button>
        </div>
        {warnings.noneAssignable ? (
          none
        ) : (
          <RadioGroup
            value={chosen?.subsidiaryId ?? ""}
            onValueChange={(id) => onChange((d) => chooseCompany(d, id))}
            className="max-h-40 gap-2 overflow-y-auto rounded-md border p-3"
            aria-label={t("picker.singleHeading")}
          >
            {assignable.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <RadioGroupItem value={s.id} />
                {s.legalName}
              </label>
            ))}
          </RadioGroup>
        )}
        {chosen && <CategoryChecklist grant={chosen} name={nameOf(chosen.subsidiaryId)} onChange={onChange} />}
      </>
    );
  }

  const heading = kind === "companies" ? t("picker.heading") : carriedOver ? t("picker.heldHeading") : t("picker.singleHeading");
  return (
    <fieldset className="space-y-2" data-testid="subsidiary-picker">
      <legend className="text-sm font-medium leading-none">{heading}</legend>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      {body}
      {/* Shown with no subsidiary at all too: an invitation sent before any exists still leaves the user unable to work. */}
      {warnings.noCompany && <WarningLine testId="subsidiary-picker-empty">{t("picker.emptyWarning")}</WarningLine>}
    </fieldset>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  roles,
  assignable,
  names,
  defaultLanguage,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: readonly UserRole[];
  assignable: SubsidiaryDTO[];
  names: ReadonlyMap<string, string>;
  defaultLanguage: Locale;
  onInvited: (created: UserSummaryDTO) => void;
}) {
  const t = useTranslations("users");
  const usersErrorToast = useUsersErrorToast();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<UserRole | null>(roles[0] ?? null);
  const [language, setLanguage] = useState<Locale>(defaultLanguage);
  const [drafts, setDrafts] = useState<InviteDrafts>({});
  const [sending, setSending] = useState(false);
  const firstRole = roles[0] ?? null;

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setFullName("");
    setRole(firstRole);
    setLanguage(defaultLanguage);
    setDrafts({});
  }, [open, defaultLanguage, firstRole]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!role) return;
    setSending(true);
    try {
      const created = await api.inviteUser(invitePayload({ email, fullName, role, language, drafts }));
      onOpenChange(false);
      onInvited(created);
    } catch (error) {
      // An organisation past its bound of refused invitations answers its own
      // code, `invite_refusals_exhausted`, worded by the errors catalogue.
      usersErrorToast(error);
    } finally {
      setSending(false);
    }
  }

  const kind = role ? pickerKind(role) : "wholeOrganisation";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <form onSubmit={onSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("inviteDialog.title")}</DialogTitle>
            <DialogDescription>{t("inviteDialog.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="invite-email">{t("inviteDialog.email")}</Label>
            <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-name">{t("inviteDialog.name")}</Label>
            <Input id="invite-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required maxLength={200} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>{t("inviteDialog.role")}</Label>
              <Select value={role ?? undefined} onValueChange={(v) => setRole(v as UserRole)} disabled={roles.length < 2}>
                <SelectTrigger aria-label={t("inviteDialog.role")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`roles.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("inviteDialog.language")}</Label>
              <Select value={language} onValueChange={(v) => setLanguage(v as Locale)}>
                <SelectTrigger aria-label={t("inviteDialog.language")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_LOCALES.map((l) => (
                    <SelectItem key={l} value={l}>
                      {t(`languages.${l}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {role && kind !== "wholeOrganisation" ? (
            <AccessPicker
              role={role}
              initial={[]}
              draft={drafts[role] ?? []}
              onChange={(change) => setDrafts((all) => ({ ...all, [role]: change(all[role] ?? []) }))}
              assignable={assignable}
              names={names}
              help={kind === "companies" ? t("inviteDialog.superAdminHelp") : t("inviteDialog.standardUserHelp")}
            />
          ) : role ? (
            <p className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm" data-testid="invite-role-access-note">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              {t("roleAccessNote.auditor")}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("inviteDialog.cancel")}
            </Button>
            <Button type="submit" disabled={sending || !role}>
              {sending ? t("inviteDialog.submitting") : t("inviteDialog.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoleDialog({
  target,
  options,
  onClose,
  onSave,
}: {
  target: UserSummaryDTO | null;
  options: readonly UserRole[];
  onClose: () => void;
  onSave: (target: UserSummaryDTO, role: UserRole) => Promise<void>;
}) {
  const t = useTranslations("users");
  const [role, setRole] = useState<UserRole | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (target) setRole(initialRoleChoice(target, options));
  }, [target, options]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("roleDialog.title", { name: target?.fullName ?? "" })}</DialogTitle>
          <DialogDescription>{t("roleDialog.description")}</DialogDescription>
        </DialogHeader>
        <Select value={role ?? ""} onValueChange={(v) => setRole(v as UserRole)}>
          <SelectTrigger aria-label={t("columns.role")}>
            <SelectValue placeholder={t("roleDialog.placeholder")} />
          </SelectTrigger>
          <SelectContent>
            {options.map((r) => (
              <SelectItem key={r} value={r}>
                {t(`roles.${r}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("roleDialog.cancel")}
          </Button>
          <Button
            disabled={saving || !target || !role || role === target.role}
            onClick={async () => {
              if (!target || !role) return;
              setSaving(true);
              await onSave(target, role);
              setSaving(false);
            }}
          >
            {saving ? t("roleDialog.submitting") : t("roleDialog.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccessDialog({
  target,
  assignable,
  names,
  onClose,
  onSave,
}: {
  target: UserSummaryDTO | null;
  assignable: SubsidiaryDTO[];
  names: ReadonlyMap<string, string>;
  onClose: () => void;
  onSave: (target: UserSummaryDTO, draft: AccessDraft) => Promise<void>;
}) {
  const t = useTranslations("users");
  const initial = useMemo(() => (target ? initialDraft(target) : []), [target]);
  const [draft, setDraft] = useState<AccessDraft>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const kind = target ? pickerKind(target.role) : "companies";
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("accessDialog.title", { name: target?.fullName ?? "" })}</DialogTitle>
          <DialogDescription>
            {kind === "singleCompany" ? t("accessDialog.standardUserDescription") : t("accessDialog.superAdminDescription")}
          </DialogDescription>
        </DialogHeader>
        {target && (
          <AccessPicker
            role={target.role}
            initial={initial}
            draft={draft}
            onChange={(change) => setDraft((d) => change(d))}
            assignable={assignable}
            names={names}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("accessDialog.cancel")}
          </Button>
          <Button
            disabled={saving || !target}
            onClick={async () => {
              if (!target) return;
              setSaving(true);
              await onSave(target, draft);
              setSaving(false);
            }}
          >
            {saving ? t("accessDialog.submitting") : t("accessDialog.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
