"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileText,
  LogOut,
  Paperclip,
  ShieldAlert,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import { anomalyStatement } from "@/lib/anomaly-view";
import { useAuthStore } from "@/lib/store";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import {
  isCalculated,
  PENDING_REVIEW_STATUSES,
  unitSymbol,
  type ActivityRecordDTO,
  type EvidenceDTO,
  type SubsidiaryDTO,
} from "@/lib/types";
import { entityLabel } from "@/lib/void-view";
import { byLongestWait, waitingLabel } from "@/lib/review-view";
import { recordActorLabel } from "@/lib/record-actor";
import {
  formatTCo2e,
  notCalculatedReason,
  NOT_CALCULATED_LABEL,
  NO_FACTOR_LABEL,
} from "@/lib/calculation-display";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;
const ANY = "__any__";

/** Same palette as the emissions History tab — a record must not change colour
 * depending on which screen you are looking at it from. */
const STATUS_COLORS: Record<string, string> = {
  submitted: "bg-[#E8F0FE] text-[#0066CC] font-semibold",
  under_review: "bg-[#FEF3C7] text-[#92400E] font-semibold",
};

function humanise(value: string): string {
  return value.replace(/_/g, " ");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function ReviewPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [rows, setRows] = useState<ActivityRecordDTO[]>([]);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [subsidiaryId, setSubsidiaryId] = useState<string>(ANY);
  const [selected, setSelected] = useState<ActivityRecordDTO | null>(null);
  const [evidence, setEvidence] = useState<EvidenceDTO[] | null>(null);
  const [evidenceError, setEvidenceError] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * Who may do what. The API is the authority — a consultant who forged a
   * request still gets a 403 from `APPROVE_ROLES`. These flags only decide
   * whether to render a control the caller would be refused for using, because
   * offering a button that always fails is worse than not offering it.
   */
  const canReview = user?.role === "super_admin" || user?.role === "consultant";
  const canApprove = user?.role === "super_admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [records, subs] = await Promise.all([
        api.listActivityRecords({ status: PENDING_REVIEW_STATUSES }),
        api.listSubsidiaries(),
      ]);
      // Longest wait first: a review queue sorted newest-first buries the
      // record that has waited longest, which is the one most likely to hold
      // up a period close. The API returns newest-first for every other screen.
      //
      // Sorted on the field the Waiting column MEASURES. It sorted on
      // `createdAt` while the column counted from there too; once the column
      // moved, the two disagreed and the row order — which is what a reviewer
      // acts on — kept the old misstatement.
      setRows([...records].sort(byLongestWait));
      setSubsidiaries(subs);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        toast.error("Your session has expired — please sign in again.");
      } else {
        toast.error((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The store is in-memory, so a hard load has no user until this runs — and
  // here it also decides which action buttons exist, so the page must not
  // render its role branch before it resolves.
  useEffect(() => {
    api.me().then(setUser).catch(() => {
      /* the proxy already redirects an unauthenticated visitor to /login */
    });
  }, [setUser]);

  // Evidence is fetched per record, on open: a reviewer approving a figure
  // without being able to open the invoice behind it is rubber-stamping.
  useEffect(() => {
    if (!selected) return;
    setEvidence(null);
    setEvidenceError(false);
    let cancelled = false;
    api
      .listEvidence(selected.id)
      .then((files) => !cancelled && setEvidence(files))
      // NOT `[]`. A 403, a 500 or a dropped connection rendered identically to
      // "this record genuinely has no evidence" — on the one screen where
      // someone decides whether to accept a figure into the inventory, that is
      // the rubber-stamping this panel exists to prevent.
      .catch(() => !cancelled && setEvidenceError(true));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  async function openEvidence(id: string) {
    try {
      const { url } = await api.getEvidenceUrl(id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /**
   * Runs one review verb and reconciles the queue with what came back.
   *
   * The API's response is the source of truth for the new status, not an
   * assumption made here: `review` keeps the record in the queue (it becomes
   * `under_review`), while `approve`/`reject` remove it. Deciding that from the
   * returned status means a server-side rule change cannot leave this list
   * showing a record that is no longer pending.
   */
  async function act(
    verb: "review" | "approve" | "reject",
    record: ActivityRecordDTO,
  ) {
    setBusy(true);
    try {
      const updated =
        verb === "review"
          ? await api.reviewActivityRecord(record.id)
          : verb === "approve"
            ? await api.approveActivityRecord(record.id)
            : await api.rejectActivityRecord(record.id, {
                varianceReason: reason.trim(),
              });

      const stillPending = (
        PENDING_REVIEW_STATUSES as readonly string[]
      ).includes(updated.status);
      setRows((prev) =>
        stillPending
          ? prev.map((r) => (r.id === updated.id ? updated : r))
          : prev.filter((r) => r.id !== updated.id),
      );
      setSelected(stillPending ? updated : null);
      if (!stillPending) setReason("");
      toast.success(
        verb === "review"
          ? "Taken into review"
          : verb === "approve"
            ? "Record approved"
            : "Record rejected — the reason is now visible to the submitter",
      );
    } catch (e) {
      // 409 is the period lock, 400 a state-machine violation: both mean the
      // queue this page is showing is stale, so reload rather than leave the
      // reviewer clicking a row that can no longer move.
      toast.error((e as Error).message);
      if (e instanceof ApiError && (e.status === 409 || e.status === 400)) {
        void load();
      }
    } finally {
      setBusy(false);
    }
  }

  const filtered =
    subsidiaryId === ANY
      ? rows
      : rows.filter((r) => r.subsidiaryId === subsidiaryId);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamped: deciding the last record on a page shrinks the list under the
  // current offset, and the slice then came back empty — so the queue announced
  // "Nothing is waiting for review" while the header still counted 25 waiting.
  // On a screen whose whole purpose is that nothing gets lost, that state is
  // worse than a wrong page number.
  const safeOffset = Math.min(offset, (pages - 1) * PAGE_SIZE);
  const visible = filtered.slice(safeOffset, safeOffset + PAGE_SIZE);
  const page = Math.floor(safeOffset / PAGE_SIZE) + 1;

  const subsidiaryName = (id: string) =>
    subsidiaries.find((s) => s.id === id)?.legalName ?? id;

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-[280px]">
        <div className="p-8 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">Review Queue</h1>
              <p className="text-sm text-muted-foreground">
                Records awaiting a decision
                {user ? ` · ${user.fullName ?? user.email} (${user.role})` : ""}
              </p>
            </div>
            <Button variant="outline" onClick={handleLogout} className="gap-2">
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>

          {!user ? (
            // The store is in-memory, so `user` is null on every hard load. The
            // old `user && !canReview` rendered the FULL queue to every role —
            // including executive_viewer — until /me resolved. The API refuses
            // their actions, but the page should not contradict its own rule.
            <Card>
              <CardContent className="py-8">
                <Skeleton className="h-6 w-full" />
              </CardContent>
            </Card>
          ) : !canReview ? (
            <Card>
              <CardContent className="flex items-start gap-3 py-8">
                <ShieldAlert className="h-5 w-5 text-amber-500 shrink-0" />
                <div className="space-y-1">
                  <p className="font-medium">
                    Reviewing is done by a consultant or a super_admin
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {/* Precise: this is not hidden data. A data_entry user can
                        see these same records on Emissions — what they cannot do
                        is decide them.
                        (An earlier version of this comment claimed "nobody may
                        approve their own work". That is false for super_admin,
                        who may create, submit and approve one record; four eyes
                        is a property of the consultant seat only. The actor
                        columns added alongside this now SURFACE that — the same
                        name on "Entered by" and "Reviewed by" — rather than
                        preventing it.) */}
                    This is not hidden data — records you can already see on the
                    Emissions page are the same ones being decided here. Your role
                    is <span className="font-mono">{user.role}</span>.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Select
                  value={subsidiaryId}
                  onValueChange={(v) => {
                    setSubsidiaryId(v);
                    setOffset(0);
                  }}
                >
                  <SelectTrigger className="w-[260px]">
                    <SelectValue placeholder="All subsidiaries" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>All subsidiaries</SelectItem>
                    {subsidiaries.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.legalName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-sm text-muted-foreground ml-auto">
                  {filtered.length} awaiting review
                </span>
              </div>

              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Subsidiary</TableHead>
                        <TableHead>Period</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Activity</TableHead>
                        <TableHead className="text-right">tCO₂e</TableHead>
                        <TableHead>Status</TableHead>
                        {/* "Entered by", not "Submitted by": this renders
                            `createdBy`, the DRAFT AUTHOR. Nothing records who
                            pressed Submit, and the two can differ — the author
                            gate applies only to a RESUBMIT, so a colleague's
                            first submit of someone else's draft is allowed.
                            The column beside it IS headed "Waiting" now,
                            because the record carries a real `submittedAt`;
                            WHO submitted is still not recorded, only WHEN. */}
                        <TableHead>Entered by</TableHead>
                        <TableHead>Waiting</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {loading ? (
                        [...Array(6)].map((_, i) => (
                          <TableRow key={i}>
                            <TableCell colSpan={8}>
                              <Skeleton className="h-6 w-full" />
                            </TableCell>
                          </TableRow>
                        ))
                      ) : visible.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={8}
                            className="text-center py-8 text-muted-foreground"
                          >
                            {/* An empty queue is the good outcome here, not an
                                error — say so, so it does not read as a failed
                                load. */}
                            Nothing is waiting for review.
                          </TableCell>
                        </TableRow>
                      ) : (
                        visible.map((row) => (
                          <TableRow
                            key={row.id}
                            className="cursor-pointer"
                            onClick={() => {
                              setSelected(row);
                              setReason("");
                            }}
                          >
                            <TableCell className="text-sm">
                              {subsidiaryName(row.subsidiaryId)}
                              {/* Uniqueness includes the location, so two rows
                                  can differ only by this. Without it a reviewer
                                  sees two identical rows and cannot tell which
                                  figure they are deciding. */}
                              {row.locationName && (
                                <span className="block text-xs text-muted-foreground">
                                  {row.locationName}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-sm whitespace-nowrap">
                              {row.periodValue} {row.reportingYear}
                            </TableCell>
                            <TableCell className="text-sm">
                              <span className="flex items-center gap-2">
                                {row.category}
                                {row.anomalyFlag && (
                                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                                )}
                              </span>
                            </TableCell>
                            <TableCell className="text-right text-sm font-mono">
                              {row.activityValue.toLocaleString("en-GB")}{" "}
                              {unitSymbol(row.activityUnit)}
                            </TableCell>
                            <TableCell className="text-right text-sm font-mono">
                              {formatTCo2e(row.calculation, (v) =>
                                v.toLocaleString("en-GB", {
                                  maximumFractionDigits: 3,
                                }),
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge
                                className={cn(
                                  "text-xs",
                                  STATUS_COLORS[row.status],
                                )}
                              >
                                {humanise(row.status)}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm whitespace-nowrap">
                              {/* A reviewer decides someone else's number, so
                                  whose it is belongs in the queue rather than
                                  one click into the audit screen. */}
                              {(() => {
                                const actor = recordActorLabel(
                                  row.createdBy,
                                  row.createdByName,
                                );
                                return (
                                  <span
                                    className={cn(
                                      actor.muted &&
                                        "italic text-muted-foreground",
                                    )}
                                  >
                                    {actor.text}
                                  </span>
                                );
                              })()}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                              {/* Whole days since the record was SUBMITTED, so
                                  the column measures a reviewer's backlog
                                  rather than how long ago a draft was started.
                                  It was headed "Age" and counted from
                                  `createdAt` until the record carried a real
                                  submission time. An em dash means never
                                  submitted — never a fallback to `createdAt`,
                                  which is the misstatement this replaced. */}
                              {waitingLabel(row.submittedAt)}
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
                    disabled={safeOffset === 0 || loading}
                    onClick={() => setOffset(Math.max(0, safeOffset - PAGE_SIZE))}
                  >
                    <ChevronLeft className="h-4 w-4" /> Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={safeOffset + PAGE_SIZE >= filtered.length || loading}
                    onClick={() => setOffset(safeOffset + PAGE_SIZE)}
                  >
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </main>

      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setReason("");
          }
        }}
      >
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {selected
                ? `${selected.category} · ${selected.periodValue} ${selected.reportingYear}`
                : ""}
            </SheetTitle>
          </SheetHeader>
          {selected && (
            <div className="space-y-5 mt-4 text-sm">
              <div className="grid grid-cols-3 gap-2">
                <span className="text-muted-foreground">Subsidiary</span>
                <span className="col-span-2">
                  {subsidiaryName(selected.subsidiaryId)}
                </span>
                <span className="text-muted-foreground">Reporting entity</span>
                <span className="col-span-2">{entityLabel(selected)}</span>
                <span className="text-muted-foreground">Activity</span>
                <span className="col-span-2 font-mono">
                  {selected.activityValue.toLocaleString("en-GB")}{" "}
                  {unitSymbol(selected.activityUnit)}
                </span>
                <span className="text-muted-foreground">Emissions</span>
                <span className="col-span-2 font-mono">
                  {isCalculated(selected.calculation) ? (
                    `${selected.calculation.tCo2e.toLocaleString("en-GB", {
                      maximumFractionDigits: 3,
                    })} tCO₂e`
                  ) : (
                    <span className="font-sans text-muted-foreground">
                      {NOT_CALCULATED_LABEL}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground">Factor</span>
                <span className="col-span-2 text-xs">
                  {/* The reviewer is signing off on a number, so the provenance
                      of that number belongs on this screen, not one click away.
                      When there is no number, that is the single most important
                      thing on the screen: an approval here commits an entry to
                      the inventory that carries no emissions figure at all. */}
                  {isCalculated(selected.calculation)
                    ? `${selected.calculation.source} v${selected.calculation.version}`
                    : NO_FACTOR_LABEL}
                </span>
                {/* Both, because they answer different questions: when the
                    work was started, and when it reached this queue. They are
                    the same date only for a record submitted the day it was
                    drafted. */}
                <span className="text-muted-foreground">Created</span>
                <span className="col-span-2">
                  {formatDate(selected.createdAt)}
                </span>
                <span className="text-muted-foreground">Submitted</span>
                <span
                  className={cn(
                    "col-span-2",
                    selected.submittedAt === null &&
                      "italic text-muted-foreground",
                  )}
                >
                  {selected.submittedAt === null
                    ? "not recorded"
                    : formatDate(selected.submittedAt)}
                </span>
                {/* Both actors, always — including "not reviewed yet", which is
                    a fact about the record a reviewer needs, and which a field
                    that appeared only once populated would hide. */}
                {(
                  [
                    ["Entered by", selected.createdBy, selected.createdByName],
                    ["Reviewed by", selected.reviewedBy, selected.reviewedByName],
                  ] as const
                ).map(([label, id, name]) => {
                  const actor = recordActorLabel(id, name);
                  return (
                    <Fragment key={label}>
                      <span className="text-muted-foreground">{label}</span>
                      <span
                        className={cn(
                          "col-span-2",
                          actor.muted && "italic text-muted-foreground",
                        )}
                      >
                        {actor.text}
                      </span>
                    </Fragment>
                  );
                })}
              </div>

              {/* Stated as its own block, not a dash in the table: approving
                  this record admits an entry to the inventory with no emissions
                  figure, and the reviewer has to make that call knowingly. */}
              {notCalculatedReason(selected.calculation) && (
                <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 space-y-1">
                  <p className="flex items-center gap-2 font-medium text-sky-900">
                    <AlertTriangle className="h-4 w-4" />
                    No emissions figure for this entry
                  </p>
                  <p className="text-xs text-sky-900/80">
                    {notCalculatedReason(selected.calculation)}
                  </p>
                </div>
              )}

              {selected.anomalyFlag && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-1">
                  <p className="flex items-center gap-2 font-medium text-amber-800">
                    <AlertTriangle className="h-4 w-4" />
                    {anomalyStatement(selected).headline}
                  </p>
                  {/* What the verdict was taken against, so a reviewer deciding
                      on the figure is not asked to trust an average nobody
                      shows them. */}
                  <p className="text-xs text-amber-900/80">
                    {anomalyStatement(selected).detail}
                  </p>
                  <p className="text-xs text-amber-900/80">
                    {selected.varianceReason
                      ? `Submitter's explanation: ${selected.varianceReason}`
                      : "No explanation was recorded."}
                  </p>
                </div>
              )}

              {/* The absence of a flag is not a verdict when the rule never
                  ran. A reviewer approving on the strength of "nothing was
                  flagged" is the exact failure this states out loud. */}
              {!selected.anomalyFlag &&
                anomalyStatement(selected).tone === "not_evaluated" && (
                  <div className="rounded-lg border bg-muted/40 p-3 space-y-1">
                    <p className="font-medium">
                      {anomalyStatement(selected).headline}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {anomalyStatement(selected).detail}
                    </p>
                  </div>
                )}

              {selected.reviewNote && (
                <div className="rounded-lg border bg-muted/40 p-3 space-y-1">
                  <p className="font-medium">Previous review note</p>
                  <p className="text-xs text-muted-foreground">
                    {selected.reviewNote}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-muted-foreground flex items-center gap-2">
                  <Paperclip className="h-4 w-4" />
                  Evidence
                </p>
                {evidenceError ? (
                  <p className="text-xs text-red-600">
                    Could not load the evidence for this record — do not decide
                    it until you can see the files.{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => setSelected({ ...selected })}
                    >
                      Retry
                    </button>
                  </p>
                ) : evidence === null ? (
                  <Skeleton className="h-8 w-full" />
                ) : evidence.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No files attached.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {evidence.map((f) => (
                      <li key={f.id}>
                        <button
                          type="button"
                          onClick={() => openEvidence(f.id)}
                          className="flex items-center gap-2 text-xs text-primary hover:underline"
                        >
                          <FileText className="h-3.5 w-3.5" />
                          {f.fileName}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-2 border-t pt-4">
                <label
                  htmlFor="review-reason"
                  className="text-muted-foreground"
                >
                  Reason (required to reject)
                </label>
                <Textarea
                  id="review-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="What must the submitter change?"
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">
                  A rejection sends this text back to the submitter, so it has to
                  say what to fix.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {canReview && selected.status === "submitted" && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => act("review", selected)}
                  >
                    Start review
                  </Button>
                )}
                {canReview && (
                  <Button
                    variant="destructive"
                    disabled={busy || !reason.trim()}
                    onClick={() => act("reject", selected)}
                  >
                    Reject
                  </Button>
                )}
                {canApprove && (
                  <Button
                    disabled={busy}
                    onClick={() => act("approve", selected)}
                  >
                    Approve
                  </Button>
                )}
              </div>
              {canReview && !canApprove && (
                <p className="text-xs text-muted-foreground">
                  Approval is reserved for a super_admin — as a consultant you can
                  take a record into review or send it back.
                </p>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
