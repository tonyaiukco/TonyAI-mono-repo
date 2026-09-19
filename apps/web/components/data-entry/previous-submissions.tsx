"use client";

import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Loader2,
  Paperclip,
  Send,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { formatTCo2e } from "@/lib/calculation-display";
import {
  allEligibleSelected,
  capRefusedNotice,
  draftsSubmitLabel,
  failuresToShow,
  liveSelection,
  othersWarning,
  selectableDrafts,
  selectAllEligible,
  selectAllNotices,
  selectedFromOthers,
  submitConfirmation,
  submitErrorMessage,
  SUBMIT_ISSUE_LABEL,
  summariseSubmit,
  toggleSelected,
} from "@/lib/bulk-submit-view";
import {
  attachableRecords,
  attachButtonLabel,
  attachConfirmation,
  attachErrorMessage,
  attachSuccessMessage,
  toggleAttach,
} from "@/lib/evidence-view";
import {
  EVIDENCE_ALLOWED_MIME_TYPES,
  EVIDENCE_MAX_SIZE_BYTES,
  isSubmittable,
  WHOLE_COMPANY_ENTITY_LABEL,
} from "@/lib/types";
import type {
  ActivityRecordDTO,
  ActivityRecordStatus,
  AuthUser,
  BulkSubmitReportDTO,
  PeriodLockDTO,
} from "@/lib/types";

/**
 * The record list beside the Data Entry form.
 *
 * Lifted out of `page.tsx`, rendering byte-identically — the one substitution
 * was the tCO₂e cell, which built the "Not calculated" label itself instead of
 * calling `formatTCo2e`, the module that exists to own that compliance rule.
 * It is not filtered by author or by status on purpose: it is the surface WP18 left for resolving a
 * double-counted month, which means it has to show the rows that caused one.
 *
 * Note what this file cannot have: `vitest.config.ts` collects only `lib/**`,
 * so every decision made here is permanently uncovered. Anything that decides
 * something belongs in `lib/bulk-submit-view.ts`, and this component renders
 * what that module returns.
 */

// --- Status badge styling (matches subsidiaries page emerald/amber palette) --

const statusBadge: Record<
  ActivityRecordStatus,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  draft: {
    label: "Draft",
    className: "bg-muted text-muted-foreground border-border",
    icon: Clock,
  },
  submitted: {
    label: "Submitted",
    className: "bg-blue-500/15 text-blue-600 border-blue-500/30",
    icon: Send,
  },
  under_review: {
    label: "Under review",
    className: "bg-purple-500/15 text-purple-600 border-purple-500/30",
    icon: Clock,
  },
  approved: {
    label: "Approved",
    className: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
    icon: CheckCircle2,
  },
  rejected: {
    label: "Rejected",
    className: "bg-red-500/15 text-red-600 border-red-500/30",
    icon: XCircle,
  },
  locked: {
    label: "Locked",
    className: "bg-slate-500/15 text-slate-600 border-slate-500/30",
    icon: CheckCircle2,
  },
  // Deliberately muted rather than red. A voided record is not a failure or a
  // rejection — it is a figure a reviewer accepted and someone later withdrew
  // by an audited void. Red would read as "this went wrong"; `rejected` already owns
  // that colour and means something different.
  voided: {
    label: "Voided",
    className: "bg-muted text-muted-foreground border-border line-through",
    icon: Ban,
  },
};

// Its own formatter, which is what `formatTCo2e` is built for — it takes the
// caller's number style precisely so each screen keeps its own.
const numberFmt = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 3,
});

export interface PreviousSubmissionsProps {
  records: ActivityRecordDTO[];
  loading: boolean;
  /** Open a record in the form beside this list. */
  onOpen: (record: ActivityRecordDTO) => void;
  /** `null` while `api.me()` is in flight — no checkboxes until it lands. */
  user: AuthUser | null;
  /** Closed periods for this subsidiary; the page already holds them. */
  locks: PeriodLockDTO[];
  /** Refetch after a submit: statuses on screen have changed. */
  onSubmitted: () => void;
  /** Refetch after one file was attached to several records: their evidence
   *  counts, and the open record's vault, have changed. */
  onEvidenceAttached: () => void;
}

export function PreviousSubmissions({
  records,
  loading,
  onOpen,
  user,
  locks,
  onSubmitted,
  onEvidenceAttached,
}: PreviousSubmissionsProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [report, setReport] = useState<BulkSubmitReportDTO | null>(null);
  // "Attach one file" mode (WP8 PR7): its own selection, because the records
  // it is for — drafts waiting for their invoice — are exactly the ones the
  // submit selection has to leave out.
  const [attachMode, setAttachMode] = useState(false);
  const [attachSelected, setAttachSelected] = useState<string[]>([]);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [attaching, setAttaching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { selectableIds, ownSelectableIds, reasonById } = useMemo(
    () => selectableDrafts(records, user, locks),
    [records, user, locks],
  );
  // Selection is by id against a list that refetches under it. Anything no
  // longer selectable — submitted by this very call, or edited in another tab —
  // has to leave the selection, or the next submit sends ids the server will
  // refuse and the count on the button is a lie.
  const live = liveSelection(selected, selectableIds);
  // `selectableIds` is already empty when there is no user, so this is the
  // whole condition.
  const showSelection = selectableIds.length > 0;
  // The master control speaks for what `select all` can take — your own rows —
  // not for rows you ticked one at a time from someone else.
  const liveOwn = live.filter((id) => ownSelectableIds.includes(id));
  const fromOthers = selectedFromOthers(records, live, user);
  const warning = othersWarning(fromOthers);
  const summary = report ? summariseSubmit(report) : null;

  const attach = useMemo(
    () => attachableRecords(records, user, locks),
    [records, user, locks],
  );
  const liveAttach = attachSelected.filter((id) => attach.attachableIds.includes(id));
  const attachRows = records.filter((r) => liveAttach.includes(r.id));

  function startAttach() {
    setSelected([]);
    setReport(null);
    setAttachSelected([]);
    setAttachMode(true);
  }

  function stopAttach() {
    setAttachMode(false);
    setAttachSelected([]);
    setPendingFile(null);
  }

  function toggleAttachRow(id: string) {
    const next = toggleAttach(liveAttach, id);
    if (next.refusedByCap) {
      toast.info(capRefusedNotice());
      return;
    }
    setAttachSelected(next.selected);
  }

  function chooseFile(file: File | undefined) {
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    // The API's checks, mirrored so a wrong file is refused before it uploads.
    if (!(EVIDENCE_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
      toast.error(`${file.name}: unsupported type (PDF, JPG, PNG, XLSX, CSV only)`);
      return;
    }
    if (file.size > EVIDENCE_MAX_SIZE_BYTES) {
      toast.error(`${file.name}: exceeds the 10 MB limit`);
      return;
    }
    setPendingFile(file);
  }

  async function attachFile() {
    if (!pendingFile || attaching || liveAttach.length === 0) return;
    setAttaching(true);
    try {
      const file = await api.uploadEvidenceForRecords(pendingFile, liveAttach);
      toast.success(attachSuccessMessage(file));
      stopAttach();
      onEvidenceAttached();
    } catch (e) {
      // All or nothing: nothing was attached, and the sentence names each
      // record that refused. The selection stays, so the user can untick them.
      toast.error(attachErrorMessage(e));
      setPendingFile(null);
    } finally {
      setAttaching(false);
    }
  }

  function toggle(id: string) {
    const next = toggleSelected(live, id);
    if (next.refusedByCap) {
      toast.info(capRefusedNotice());
      return;
    }
    setReport(null);
    setSelected(next.selected);
  }

  function selectAll() {
    // Own rows only — see `DraftSelection.ownSelectableIds`. A `super_admin`
    // may still tick a colleague's row deliberately; what they cannot do is
    // sweep a subsidiary's worth of other people's drafts with one click.
    const { selected: next, overCap } = selectAllEligible(ownSelectableIds);
    setReport(null);
    setSelected(next);
    for (const notice of selectAllNotices(
      next.length,
      selectableIds.length - ownSelectableIds.length,
      overCap,
    )) {
      toast.info(notice);
    }
  }

  async function submitSelected() {
    if (submitting || live.length === 0) return;
    setConfirming(false);
    setSubmitting(true);
    try {
      setReport(await api.bulkSubmitActivityRecords(live));
      setSelected([]);
    } catch (e) {
      toast.error(submitErrorMessage(e));
    } finally {
      setSubmitting(false);
      // In `finally`, and for the panel's reason: there is no transaction, so a
      // call that threw may still have moved records. Refreshing only on
      // success would leave the list insisting nothing happened.
      onSubmitted();
    }
  }

  return (
    <Card data-testid="previous-submissions">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Previous submissions
        </CardTitle>
        {!attachMode && attach.attachableIds.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            // Wraps rather than overflowing: this column is narrow beside the
            // form, and a one-line label pushed the page into sideways scroll.
            className="h-auto min-h-7 w-fit max-w-full gap-1.5 whitespace-normal py-1 text-left text-xs"
            data-testid="evidence-attach-start"
            onClick={startAttach}
          >
            <Paperclip className="h-3.5 w-3.5" />
            Attach one file to several records
          </Button>
        )}
        {!attachMode && ownSelectableIds.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              data-testid="drafts-select-all"
              checked={allEligibleSelected(liveOwn.length, ownSelectableIds.length)}
              onCheckedChange={(on) => (on ? selectAll() : setSelected([]))}
              // Starts with the visible text (WCAG 2.5.3, label in name): a
              // voice-control user says what they see — "Select all 3" — and a
              // name that never contains it cannot be activated that way.
              aria-label={`Select all ${ownSelectableIds.length}: every draft you entered and can send`}
            />
            Select all {ownSelectableIds.length}
          </label>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {attachMode && (
          <div
            // Stacked, not side by side: the column is narrow beside the form
            // and the button names how many records it will cover.
            className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2"
            data-testid="evidence-attach-bar"
          >
            <span className="text-xs text-muted-foreground">
              {liveAttach.length === 0
                ? "Tick the records this one document evidences."
                : `${liveAttach.length.toLocaleString("en-GB")} selected`}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={stopAttach}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-auto min-h-8 max-w-full whitespace-normal py-1 text-left"
                data-testid="evidence-attach-choose"
                disabled={liveAttach.length === 0 || attaching}
                onClick={() => fileInputRef.current?.click()}
              >
                {attaching ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Paperclip className="mr-2 h-3.5 w-3.5" />
                )}
                {attachButtonLabel(liveAttach.length)}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                data-testid="evidence-attach-input"
                accept=".pdf,.jpg,.jpeg,.png,.xlsx,.csv"
                className="hidden"
                onChange={(e) => chooseFile(e.target.files?.[0])}
              />
            </div>
          </div>
        )}

        {!attachMode && live.length > 0 && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2"
            data-testid="drafts-submit-bar"
          >
            <span className="text-xs text-muted-foreground">
              {live.length.toLocaleString("en-GB")} selected
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                Clear
              </Button>
              <Button
                size="sm"
                data-testid="drafts-submit-button"
                onClick={() => setConfirming(true)}
                disabled={submitting}
              >
                {submitting ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {draftsSubmitLabel(live.length)}
              </Button>
            </div>
          </div>
        )}

        {report && summary && (
          <div className="space-y-1.5" data-testid="drafts-submit-verdict">
            <div
              role="status"
              className={cn(
                "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm",
                summary.tone === "clean" &&
                  "border-status-complete-text/30 bg-status-complete-bg text-status-complete-text",
                summary.tone !== "clean" &&
                  "border-status-incomplete-text/30 bg-status-incomplete-bg text-status-incomplete-text",
              )}
            >
              {summary.tone === "clean" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <div>
                <p className="font-medium">{summary.headline}</p>
                {summary.detail && <p>{summary.detail}</p>}
              </div>
            </div>
            {report.failed.length > 0 && (
              <div
                className="rounded-lg border border-status-missing-text/30 bg-status-missing-bg/60 px-3 py-2 text-xs"
                data-testid="drafts-submit-failures"
              >
                <ul className="space-y-1">
                  {failuresToShow(report.failed).shown.map((f) => (
                    <li key={f.recordId}>
                      <span className="font-medium">
                        {SUBMIT_ISSUE_LABEL[f.code]}
                      </span>
                      <span className="block opacity-80">{f.message}</span>
                    </li>
                  ))}
                </ul>
                {failuresToShow(report.failed).remainder > 0 && (
                  <p className="mt-1.5 opacity-80">
                    +{failuresToShow(report.failed).remainder} more not shown.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : records.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No submissions yet for this subsidiary.
          </p>
        ) : (
          <div className="space-y-2">
            {records.map((r) => {
              const badge = statusBadge[r.status];
              const Icon = badge.icon;
              const selectable = attachMode
                ? attach.attachableIds.includes(r.id)
                : selectableIds.includes(r.id);
              const checked = attachMode ? liveAttach.includes(r.id) : live.includes(r.id);
              const onToggle = attachMode ? toggleAttachRow : toggle;
              const reason = attachMode ? attach.reasonById[r.id] : reasonById[r.id];
              return (
                <div key={r.id} className="flex items-start gap-2">
                  {/* A SIBLING of the row button, never a child. Radix renders
                      `<button role="checkbox">`, and a button inside a button
                      is invalid markup that would also fold this control's
                      label into the row's accessible name — which two shipped
                      specs locate the row by. */}
                  {showSelection || attachMode ? (
                    selectable ? (
                      <Checkbox
                        className="mt-3.5 shrink-0"
                        checked={checked}
                        onCheckedChange={() => onToggle(r.id)}
                        // The reporting ENTITY too, for the reason spelled out
                        // forty lines below: uniqueness includes `location_id`,
                        // so a whole-subsidiary row and a site row for the same
                        // period and category are two different records. Without
                        // it their checkboxes carry byte-identical accessible
                        // names — indistinguishable to a screen reader, and a
                        // strict-mode collision for anything locating them.
                        aria-label={`${attachMode ? "Attach the file to" : "Select"} ${r.periodValue} ${r.reportingYear} ${r.category}, ${
                          r.locationId ? (r.locationName ?? "A site") : WHOLE_COMPANY_ENTITY_LABEL
                        }`}
                      />
                    ) : (
                      // Keeps the rows aligned. A DISABLED checkbox was the
                      // other option and is worse: it is unfocusable, so the
                      // reason below never reaches anyone who cannot see it.
                      <span className="mt-3.5 h-4 w-4 shrink-0" aria-hidden />
                    )
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onOpen(r)}
                    // Deliberately NOT aria-disabled: a non-editable row
                    // still answers "why can't I edit this?" when
                    // activated, and marking it disabled is what stops
                    // assistive tech (and Playwright) from ever reaching
                    // that answer. The hover affordance below carries the
                    // distinction instead.
                    className={`flex w-full items-center gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-left transition-colors ${
                      // The lifecycle rule from the contract, not a
                      // third hand-written copy of it.
                      isSubmittable(r.status)
                        ? "hover:border-primary/40 hover:bg-secondary"
                        : "cursor-default"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {r.periodValue} {r.reportingYear}
                        </span>
                        <Badge
                          variant="outline"
                          className={`px-1.5 py-0 text-[10px] ${badge.className}`}
                        >
                          {badge.label}
                        </Badge>
                      </div>
                      {/* The reporting entity, which this list did not
                          show. Uniqueness includes `location_id`, so a
                          whole-company record and a site record for the
                          same month and category are two different rows
                          — and here they were two identical-looking
                          lines. A user asked to resolve a
                          double-counted month could not tell which one
                          they were opening. Built as one string: the
                          same JSX whitespace trap as above. */}
                      {/* A withdrawn figure is struck through here too:
                          the badge already says "Voided", but the
                          tonnes beside it read like any other row. */}
                      <div
                        className={cn(
                          "text-xs text-muted-foreground",
                          r.status === "voided" && "line-through",
                        )}
                      >
                        {[
                          r.category,
                          // `locationName` is optional on the contract,
                          // so a bare `??` would label a site row as the
                          // whole company if the include were ever
                          // dropped — a false claim on the one screen
                          // built to tell the two apart. The label is the
                          // shared one: this list said "Whole subsidiary"
                          // while the import template and every report say
                          // "Whole company" about the same records.
                          r.locationId
                            ? (r.locationName ?? "A site")
                            : WHOLE_COMPANY_ENTITY_LABEL,
                          formatTCo2e(
                            r.calculation,
                            (v) => `${numberFmt.format(v)} tCO₂e`,
                          ),
                        ].join(" · ")}
                      </div>
                      {/* Only for the rows that LOOK selectable — the list
                          already shows a status badge, so "Already approved."
                          beside an Approved badge is noise on every line. */}
                      {reason && (
                        <div className="mt-0.5 text-xs text-status-incomplete-text">
                          {reason}
                        </div>
                      )}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* Mounted only while open. Not for the reason first written here — a
          closed Radix dialog has no `forceMount` and is absent from the DOM
          either way, so there was never a duplicate-text hazard. The real
          difference is that this skips the `submitConfirmation(…)` CALL,
          where the panel's JSX children are evaluated on every render. */}
      {pendingFile && (
        <Dialog open onOpenChange={(open) => !open && setPendingFile(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Attach this file?</DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-2 text-sm text-muted-foreground">
                  {(() => {
                    const { lead, records: named } = attachConfirmation(
                      pendingFile.name,
                      attachRows,
                    );
                    return (
                      <>
                        <p>{lead}</p>
                        <ul
                          className="max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5"
                          data-testid="evidence-attach-records"
                        >
                          {named.map((label, i) => (
                            <li key={attachRows[i].id}>{label}</li>
                          ))}
                        </ul>
                      </>
                    );
                  })()}
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setPendingFile(null)}>
                Cancel
              </Button>
              <Button
                data-testid="evidence-attach-confirm"
                onClick={() => void attachFile()}
                disabled={attaching}
              >
                {attaching && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Attach
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {confirming && (
        <Dialog open onOpenChange={setConfirming}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Send these for review?</DialogTitle>
              <DialogDescription>
                {submitConfirmation(live.length)}
                {/* The sentence the shared one cannot carry: on the import
                    surface every row is the importer's own by construction, so
                    this case only exists here. */}
                {warning && (
                  <span className="mt-2 block" data-testid="drafts-submit-others">
                    {warning}
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                data-testid="drafts-submit-confirm"
                onClick={() => void submitSelected()}
                disabled={submitting}
              >
                Send for review
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
