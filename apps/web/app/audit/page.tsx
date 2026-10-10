"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, LogOut, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, ApiError } from "@/lib/api";
import { actorLabel, summariseBatch } from "@/lib/audit-view";
import { useAuthStore } from "@/lib/store";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  type AuditAction,
  type AuditLogDTO,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

const ANY = "__any__";

/** Colour by consequence, not by entity: a reader scanning the trail is looking
 * for the destructive and the decisive, not for which table changed. */
const ACTION_COLORS: Record<AuditAction, string> = {
  create: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  update: "bg-slate-500/15 text-slate-700 border-slate-500/30",
  delete: "bg-red-500/15 text-red-700 border-red-500/30",
  submit: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  review: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  approve: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  reject: "bg-red-500/15 text-red-700 border-red-500/30",
  lock: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  unlock: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  // Red, with `delete`. This map colours by CONSEQUENCE, and a void removes a
  // reviewed figure from the reported inventory — the most destructive thing
  // that can happen to a number in this product, even though the row survives.
  void: "bg-red-500/15 text-red-700 border-red-500/30",
  // Slate, with `update`: the FIGURE did not change, only the system's
  // judgement about it, and colouring a re-score like an approval or a
  // withdrawal would overstate what happened. These rows carry no actor —
  // `pnpm anomaly:recompute` performed them, not a person — which the trail
  // already renders, since a deleted profile produces the same shape.
  rescore: "bg-slate-500/15 text-slate-700 border-slate-500/30",
  generate: "bg-violet-500/15 text-violet-700 border-violet-500/30",
  // Violet, with `generate`: a batch act whose row summarises a file, not a
  // figure — the figures are the per-record `create` rows beside it.
  bulk_import: "bg-violet-500/15 text-violet-700 border-violet-500/30",
  // Blue, with `submit`: the same consequence, for many records at once.
  bulk_submit: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  // Amber: an evidence file taken off one record while it still backs others.
  // Less than a `delete` (the file survives), more than an `update`.
  detach: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  // LP4-01, the user lifecycle. Emerald: someone joins or comes back.
  invite: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  accept: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  enable: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  // Red: access withdrawn from a person, or from a whole organisation.
  disable: "bg-red-500/15 text-red-700 border-red-500/30",
  offboard: "bg-red-500/15 text-red-700 border-red-500/30",
  // Amber: a reset link went out (no person is the actor) — worth a look.
  password_reset: "bg-amber-500/15 text-amber-700 border-amber-500/30",
};

const NEUTRAL_ACTION = "bg-slate-500/15 text-slate-700 border-slate-500/30";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function humanise(value: string): string {
  return value.replace(/_/g, " ");
}

/**
 * One line describing what a row changed, derived from the diff. Deliberately
 * conservative: the diff shape varies per entity, so anything not recognised
 * falls back to nothing rather than guessing and misreporting a change.
 */
function summarise(row: AuditLogDTO): string | null {
  const diff = row.diff;
  if (!diff) return null;
  const transition = diff.transition as { from?: string; to?: string } | undefined;
  if (transition?.from && transition?.to) {
    return `${humanise(transition.from)} → ${humanise(transition.to)}`;
  }
  if (row.entity === "report") {
    const parts = [diff.template, diff.exportType, diff.year].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  }
  if (diff.bulk === true) return summariseBatch(diff);
  const after = diff.after as Record<string, unknown> | undefined;
  const before = diff.before as Record<string, unknown> | undefined;
  const name = (after?.legalName ?? after?.name ?? before?.legalName ?? before?.name) as
    | string
    | undefined;
  return name ?? null;
}

export default function AuditPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [rows, setRows] = useState<AuditLogDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [entity, setEntity] = useState<string>(ANY);
  const [action, setAction] = useState<string>(ANY);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<AuditLogDTO | null>(null);
  /**
   * Offset paging over a table that grows AT THE HEAD shifts every page down as
   * new rows land mid-session — page 2 would silently re-show what was page 1.
   * Freezing an upper bound on first load turns the browse into a stable
   * snapshot (and stops `total` moving under the reader). `to` is exclusive.
   */
  const [readWindow] = useState(() => new Date().toISOString());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.listAudit({
        limit: PAGE_SIZE,
        offset,
        to: readWindow,
        ...(entity !== ANY ? { entity: entity as never } : {}),
        ...(action !== ANY ? { action: action as never } : {}),
      });
      setRows(page.items);
      setTotal(page.total);
      setForbidden(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setForbidden(true);
        setRows([]);
        setTotal(0);
      } else if (e instanceof ApiError && e.status === 401) {
        toast.error("Your session has expired — please sign in again.");
      } else {
        toast.error((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [entity, action, offset, readWindow]);

  useEffect(() => {
    void load();
  }, [load]);

  // The store is in-memory, so a hard load of /audit has no user until this
  // runs — without it the header renders "· ()" and the forbidden card says
  // "Your role is ⟨blank⟩". Every other page does the same bootstrap.
  useEffect(() => {
    api.me().then(setUser).catch(() => {
      /* the proxy already redirects an unauthenticated visitor to /login */
    });
  }, [setUser]);

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  // Client-side narrowing on top of the server filters: the server already
  // bounded the page, this just helps scan it.
  const visible = search.trim()
    ? rows.filter((r) =>
        [r.userEmail, r.userFullName, r.entityId, r.entity, r.action]
          .filter(Boolean)
          .some((v) => (v as string).toLowerCase().includes(search.trim().toLowerCase())),
      )
    : rows;

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-[280px]">
        <div className="p-8 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">Audit Trail</h1>
              <p className="text-sm text-muted-foreground">
                {/* Precise on purpose: this records mutations that go through
                    the API's audited paths. It is not a claim that nothing else
                    can ever change — user management, when it lands, must be
                    audited too or this line becomes false. */}
                Append-only record of audited changes
                {user ? ` · ${user.fullName ?? user.email} (${user.role})` : ""}
              </p>
            </div>
            <Button variant="outline" onClick={handleLogout} className="gap-2">
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>

          {forbidden ? (
            <Card>
              <CardContent className="flex items-start gap-3 py-8">
                <ShieldAlert className="h-5 w-5 text-amber-500 shrink-0" />
                <div className="space-y-1">
                  <p className="font-medium">Only a super_admin can read the audit trail</p>
                  <p className="text-sm text-muted-foreground">
                    The trail spans every subsidiary in the organisation, so it is
                    restricted at both the API and the database. Your role is{" "}
                    <span className="font-mono">{user?.role}</span>.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                {/* Deliberately labelled as page-scoped. It filters the rows
                    already loaded, NOT the trail: an auditor who typed an email
                    here and saw "no matches" would otherwise conclude that
                    person never acted. Entity/action below are server-side. */}
                <Input
                  placeholder="Filter this page…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="max-w-xs"
                />
                <Select
                  value={entity}
                  onValueChange={(v) => {
                    setEntity(v);
                    setOffset(0);
                  }}
                >
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder="All entities" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>All entities</SelectItem>
                    {AUDIT_ENTITIES.map((e) => (
                      <SelectItem key={e} value={e}>
                        {humanise(e)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={action}
                  onValueChange={(v) => {
                    setAction(v);
                    setOffset(0);
                  }}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="All actions" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>All actions</SelectItem>
                    {AUDIT_ACTIONS.map((a) => (
                      <SelectItem key={a} value={a}>
                        {humanise(a)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-sm text-muted-foreground ml-auto">
                  {total} {total === 1 ? "entry" : "entries"}
                </span>
              </div>

              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>Actor</TableHead>
                        <TableHead>Role at the time</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>Entity</TableHead>
                        <TableHead>Change</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {loading ? (
                        [...Array(6)].map((_, i) => (
                          <TableRow key={i}>
                            <TableCell colSpan={6}>
                              <Skeleton className="h-6 w-full" />
                            </TableCell>
                          </TableRow>
                        ))
                      ) : visible.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={6}
                            className="text-center py-8 text-muted-foreground"
                          >
                            {search.trim()
                              ? "No entries on this page match that text. The text filter only searches the loaded page — use the entity and action filters, or another page, to search the whole trail."
                              : "No audit entries match these filters."}
                          </TableCell>
                        </TableRow>
                      ) : (
                        visible.map((row) => (
                          <TableRow
                            key={row.id}
                            className="cursor-pointer"
                            onClick={() => setSelected(row)}
                          >
                            <TableCell className="text-sm whitespace-nowrap">
                              {formatDateTime(row.createdAt)}
                            </TableCell>
                            <TableCell className="text-sm">
                              {(() => {
                                const actor = actorLabel(row);
                                return actor.muted ? (
                                  <span className="text-muted-foreground italic">
                                    {actor.text}
                                  </span>
                                ) : (
                                  actor.text
                                );
                              })()}
                            </TableCell>
                            <TableCell className="text-sm">
                              {row.role ? (
                                <span className="font-mono text-xs">{row.role}</span>
                              ) : (
                                // Pre-WP7 rows have no role. Saying so is more
                                // honest than rendering today's role, which
                                // would misstate who was allowed to do what.
                                <span className="text-muted-foreground text-xs">
                                  not recorded
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge
                                className={cn(
                                  "text-xs",
                                  // Typed map so a new action fails to compile;
                                  // tolerant lookup so a RETIRED one still
                                  // renders instead of crashing the page.
                                  ACTION_COLORS[row.action] ?? NEUTRAL_ACTION,
                                )}
                              >
                                {humanise(row.action)}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm">{humanise(row.entity)}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {summarise(row) ?? "—"}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  Page {page} of {pages}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset === 0 || loading}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    <ChevronLeft className="h-4 w-4" /> Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset + PAGE_SIZE >= total || loading}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </main>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {selected ? `${selected.action} · ${humanise(selected.entity)}` : ""}
            </SheetTitle>
          </SheetHeader>
          {selected && (
            <div className="space-y-4 mt-4 text-sm">
              <div className="grid grid-cols-3 gap-2">
                <span className="text-muted-foreground">When</span>
                <span className="col-span-2">{formatDateTime(selected.createdAt)}</span>
                <span className="text-muted-foreground">Actor</span>
                <span className="col-span-2">
                  {actorLabel(selected).text}
                </span>
                <span className="text-muted-foreground">Role at the time</span>
                <span className="col-span-2 font-mono text-xs">
                  {selected.role ?? "not recorded"}
                </span>
                <span className="text-muted-foreground">Entity id</span>
                <span className="col-span-2 font-mono text-xs break-all">
                  {selected.entityId ?? "—"}
                </span>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Change</p>
                <pre className="rounded-lg bg-muted/60 p-3 text-xs overflow-x-auto">
                  {JSON.stringify(selected.diff, null, 2) ?? "—"}
                </pre>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
