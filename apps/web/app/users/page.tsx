"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "use-intl";
import { toast } from "sonner";
import { AlertTriangle, LogOut, MoreHorizontal, ShieldAlert, UserPlus } from "lucide-react";
import { Sidebar } from "@/components/dashboard/sidebar";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError } from "@/lib/api";
import { useErrorToast } from "@/lib/i18n/hooks";
import { useAuthStore } from "@/lib/store";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import {
  LOCALE_FORMAT_TAGS,
  SUPPORTED_LOCALES,
  type Locale,
  type SubsidiaryDTO,
  type UserRole,
  type UserSummaryDTO,
} from "@/lib/types";
import { accessSummary, appendPage, canResend, invitationNote, replaceUser } from "@/lib/users-view";
import { cn } from "@/lib/utils";

const ROLES: readonly UserRole[] = ["super_admin", "consultant", "data_entry", "executive_viewer"];

const STATUS_STYLES: Record<UserSummaryDTO["status"], string> = {
  active: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  invited: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  disabled: "bg-slate-500/15 text-slate-600 border-slate-500/30",
};

/**
 * User and access management (LP4-01) — a super_admin's, for their own
 * organisation. Every change goes through the API, which answers the member
 * as they now stand; the row is replaced with that answer, so a step that did
 * not go through (an undelivered invitation, a pending sign-in block) shows at
 * once. Other roles see why they cannot use it rather than a missing page.
 */
export default function UsersPage() {
  const t = useTranslations("users");
  const tCommon = useTranslations("common");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const errorToast = useErrorToast();
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
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  /** Runs one action on a member and puts the API's answer in its row. */
  async function act(target: UserSummaryDTO, call: () => Promise<UserSummaryDTO>, done: (updated: UserSummaryDTO) => void) {
    setBusyId(target.id);
    try {
      const updated = await call();
      setUsers((list) => replaceUser(list, updated));
      done(updated);
    } catch (e) {
      errorToast(e);
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
              {!forbidden && (
                <Button onClick={() => setInviteOpen(true)} className="gap-2" disabled={loading}>
                  <UserPlus className="h-4 w-4" />
                  {t("invite")}
                </Button>
              )}
              <Button variant="outline" onClick={handleLogout} className="gap-2">
                <LogOut className="h-4 w-4" />
                {tCommon("signOut")}
              </Button>
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
                        const access = accessSummary(member);
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
                            <TableCell
                              className="text-sm text-muted-foreground"
                              title={member.subsidiaryIds.map((id) => subsidiaryNames.get(id) ?? id).join(", ") || undefined}
                            >
                              {access.key === "accessCount" ? t("accessCount", access.values) : t(access.key)}
                            </TableCell>
                            <TableCell className="text-right">
                              {!self && (
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
                                    <DropdownMenuItem onSelect={() => setRoleTarget(member)}>
                                      {t("actions.changeRole")}
                                    </DropdownMenuItem>
                                    {member.role === "data_entry" && (
                                      <DropdownMenuItem onSelect={() => setAccessTarget(member)}>
                                        {t("actions.editAccess")}
                                      </DropdownMenuItem>
                                    )}
                                    {canResend(member) && (
                                      <DropdownMenuItem
                                        onSelect={() =>
                                          void act(member, () => api.resendInvitation(member.id), (u) => afterDelivery(u, "resent"))
                                        }
                                      >
                                        {t("actions.resend")}
                                      </DropdownMenuItem>
                                    )}
                                    <DropdownMenuSeparator />
                                    {member.status === "disabled" ? (
                                      <DropdownMenuItem
                                        onSelect={() =>
                                          void act(member, () => api.enableUser(member.id), (u) => afterEnabledChange(u, "enabledToast"))
                                        }
                                      >
                                        {t("actions.enable")}
                                      </DropdownMenuItem>
                                    ) : (
                                      <DropdownMenuItem className="text-destructive" onSelect={() => setDisableTarget(member)}>
                                        {t("actions.disable")}
                                      </DropdownMenuItem>
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
        subsidiaries={subsidiaries}
        defaultLanguage={locale}
        onInvited={(created) => {
          setUsers((list) => [created, ...list.filter((u) => u.id !== created.id)]);
          afterDelivery(created, "invited");
        }}
      />
      <RoleDialog
        target={roleTarget}
        onClose={() => setRoleTarget(null)}
        onSave={(target, role) =>
          act(target, () => api.setUserRole(target.id, { role }), () => {
            setRoleTarget(null);
            toast.success(t("roleChanged"));
          })
        }
      />
      <AccessDialog
        target={accessTarget}
        subsidiaries={subsidiaries}
        onClose={() => setAccessTarget(null)}
        onSave={(target, subsidiaryIds) =>
          act(target, () => api.replaceUserAccess(target.id, { subsidiaryIds }), () => {
            setAccessTarget(null);
            toast.success(t("accessSaved"));
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

function SubsidiaryChecklist({
  subsidiaries,
  selected,
  onChange,
}: {
  subsidiaries: SubsidiaryDTO[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useTranslations("users");
  if (subsidiaries.length === 0) return <p className="text-sm text-muted-foreground">{t("inviteDialog.noSubsidiaries")}</p>;
  return (
    <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
      {subsidiaries.map((s) => (
        <label key={s.id} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={selected.includes(s.id)}
            onCheckedChange={(checked) =>
              onChange(checked ? [...selected, s.id] : selected.filter((id) => id !== s.id))
            }
          />
          {s.legalName}
        </label>
      ))}
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  subsidiaries,
  defaultLanguage,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subsidiaries: SubsidiaryDTO[];
  defaultLanguage: Locale;
  onInvited: (created: UserSummaryDTO) => void;
}) {
  const t = useTranslations("users");
  const errorToast = useErrorToast();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<UserRole>("data_entry");
  const [language, setLanguage] = useState<Locale>(defaultLanguage);
  const [subsidiaryIds, setSubsidiaryIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setFullName("");
    setRole("data_entry");
    setLanguage(defaultLanguage);
    setSubsidiaryIds([]);
  }, [open, defaultLanguage]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    try {
      const created = await api.inviteUser({
        email: email.trim(),
        fullName: fullName.trim(),
        role,
        language,
        subsidiaryIds: role === "data_entry" ? subsidiaryIds : [],
      });
      onOpenChange(false);
      onInvited(created);
    } catch (error) {
      errorToast(error);
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
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
              <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
                <SelectTrigger aria-label={t("inviteDialog.role")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
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
          {role === "data_entry" && (
            <div className="space-y-2">
              <Label>{t("inviteDialog.subsidiaries")}</Label>
              <p className="text-xs text-muted-foreground">{t("inviteDialog.subsidiariesHelp")}</p>
              <SubsidiaryChecklist subsidiaries={subsidiaries} selected={subsidiaryIds} onChange={setSubsidiaryIds} />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("inviteDialog.cancel")}
            </Button>
            <Button type="submit" disabled={sending}>
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
  onClose,
  onSave,
}: {
  target: UserSummaryDTO | null;
  onClose: () => void;
  onSave: (target: UserSummaryDTO, role: UserRole) => Promise<void>;
}) {
  const t = useTranslations("users");
  const [role, setRole] = useState<UserRole>("data_entry");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (target) setRole(target.role);
  }, [target]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("roleDialog.title", { name: target?.fullName ?? "" })}</DialogTitle>
          <DialogDescription>{t("roleDialog.description")}</DialogDescription>
        </DialogHeader>
        <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
          <SelectTrigger aria-label={t("columns.role")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
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
            disabled={saving || !target || role === target.role}
            onClick={async () => {
              if (!target) return;
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
  subsidiaries,
  onClose,
  onSave,
}: {
  target: UserSummaryDTO | null;
  subsidiaries: SubsidiaryDTO[];
  onClose: () => void;
  onSave: (target: UserSummaryDTO, subsidiaryIds: string[]) => Promise<void>;
}) {
  const t = useTranslations("users");
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (target) setSelected(target.subsidiaryIds);
  }, [target]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("accessDialog.title", { name: target?.fullName ?? "" })}</DialogTitle>
          <DialogDescription>{t("accessDialog.description")}</DialogDescription>
        </DialogHeader>
        <SubsidiaryChecklist subsidiaries={subsidiaries} selected={selected} onChange={setSelected} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("accessDialog.cancel")}
          </Button>
          <Button
            disabled={saving || !target}
            onClick={async () => {
              if (!target) return;
              setSaving(true);
              await onSave(target, selected);
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
