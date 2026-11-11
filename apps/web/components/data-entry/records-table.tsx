"use client";

import { useLocale, useTranslations } from "use-intl";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  Paperclip,
  Pencil,
  Send,
  Undo2,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { evidenceCell, type RecordsFilter } from "@/lib/records-table-view";
import { cn } from "@/lib/utils";
import { recordActions, type RecordActions } from "@/lib/record-edit-view";
import { api } from "@/lib/api";
import { formatTCo2e } from "@/lib/calculation-display";
import {
  allEligibleSelected,
  capRefusedNotice,
  draftsSubmitLabel,
  failuresToShow,
  liveSelection,
  selectableDrafts,
  selectAllEligible,
  selectAllNotices,
  submitConfirmation,
  submitErrorMessage,
  submitIssueLabel,
  submitIssueMessage,
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
  ACTIVITY_RECORD_STATUSES,
  CATEGORIES,
  isSubmittable,
  recordActivityTypesFor,
  unitSymbol,
} from "@/lib/types";
import type {
  ActivityRecordDTO,
  ActivityRecordPageItemDTO,
  ActivityRecordStatus,
  AuthUser,
  BulkSubmitReportDTO,
} from "@/lib/types";
import { LoadMoreButton } from "@/components/ui/load-more-button";
import { useDescribeError, useRecordWords, showErrorToast } from "@/lib/i18n/hooks";
import { formatNumber } from "@/lib/i18n/number";
import type { RecordWords } from "@/lib/vocabulary";
import type { Messages } from "@/messages";

/**
 * The records table under the Data Entry form (BUG-R2-05; before it, the
 * "Previous submissions" list beside the form).
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
  { className: string; icon: typeof CheckCircle2 }
> = {
  draft: {
    className: "bg-muted text-muted-foreground border-border",
    icon: Clock,
  },
  submitted: {
    className: "bg-blue-500/15 text-blue-600 border-blue-500/30",
    icon: Send,
  },
  under_review: {
    className: "bg-purple-500/15 text-purple-600 border-purple-500/30",
    icon: Clock,
  },
  approved: {
    className: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
    icon: CheckCircle2,
  },
  rejected: {
    className: "bg-red-500/15 text-red-600 border-red-500/30",
    icon: XCircle,
  },
  locked: {
    className: "bg-slate-500/15 text-slate-600 border-slate-500/30",
    icon: CheckCircle2,
  },
  // Deliberately muted rather than red. A voided record is not a failure or a
  // rejection — it is a figure a reviewer accepted and someone later withdrew
  // by an audited void. Red would read as "this went wrong"; `rejected` already owns
  // that colour and means something different.
  voided: {
    className: "bg-muted text-muted-foreground border-border line-through",
    icon: Ban,
  },
};


export interface RecordsTableProps {
  /** The pages loaded so far (LP4-05 PR C), newest first. Each row carries
   *  whether its own period is locked, read with it. */
  records: ActivityRecordPageItemDTO[];
  loading: boolean;
  /** The subsidiary's whole record count (metadata), null when unknown. */
  total: number | null;
  /** The API has another page, and reading it. */
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Open a record in the form above this table. */
  onOpen: (record: ActivityRecordPageItemDTO) => void;
  /** Open the record in Edit mode — only offered where `recordActions` allows it (BUG-R2-03). */
  onEdit: (record: ActivityRecordPageItemDTO) => void;
  /** Recall a submitted record to draft, after the user confirms (BUG-R2-03). */
  onRecall: (record: ActivityRecordPageItemDTO) => void;
  /** Pre-fill a new draft from a voided record (BUG-R2-03). */
  onCopy: (record: ActivityRecordPageItemDTO) => void;
  /** `null` while `api.me()` is in flight — no checkboxes until it lands. */
  user: AuthUser | null;
  /** Refetch after a submit: statuses on screen have changed. */
  onSubmitted: () => void;
  /** Refetch after one file was attached to several records: their evidence
   *  counts, and the open record's vault, have changed. */
  onEvidenceAttached: () => void;
  /** The filters in force (year, status, category), applied by the API. */
  filter: RecordsFilter;
  onFilterChange: (change: Partial<RecordsFilter>) => void;
  /** The years the year filter offers, newest first. */
  yearOptions: readonly number[];
  /** A filter narrows the list: an empty table means nothing matches. */
  narrowed: boolean;
}


/**
 * The category as a row names it, with its activity type when it has one
 * (LP3-03): diesel and petrol of one site and month are two records, and
 * without the type their rows — and their checkboxes' accessible names — would
 * be identical.
 */
function categoryWithActivity(
  r: Pick<ActivityRecordDTO, "category" | "activityType">,
  words: RecordWords,
  activity: (key: `activityTypes.${keyof Messages["dataEntry"]["activityTypes"]}`) => string,
): string {
  const category = words.category(r.category);
  if (!r.activityType) return category;
  const known = recordActivityTypesFor(r.category).some((type) => type.value === r.activityType);
  const label = known ? activity(`activityTypes.${r.activityType as keyof Messages["dataEntry"]["activityTypes"]}`) : r.activityType;
  return `${category} (${label})`;
}

/**
 * Edit, Recall and Copy to new draft for one row (BUG-R2-03): siblings of the
 * row button, never children, for the reason the checkbox above is one. Each
 * names its record, so two rows' buttons are never the same control to a
 * screen reader.
 */
function RowActions({
  actions,
  record,
  onEdit,
  onRecall,
  onCopy,
}: {
  actions: RecordActions;
  record: string;
  onEdit: () => void;
  onRecall: () => void;
  onCopy: () => void;
}) {
  const t = useTranslations("dataEntry");
  if (!actions.edit && !actions.recall && !actions.copy) return null;
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-1">
      {actions.edit && (
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={onEdit} aria-label={t("rowActions.editRecord", { record })}>
          <Pencil className="h-3.5 w-3.5" />
          {t("rowActions.edit")}
        </Button>
      )}
      {actions.recall && (
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={onRecall} aria-label={t("rowActions.recallRecord", { record })}>
          <Undo2 className="h-3.5 w-3.5" />
          {t("rowActions.recall")}
        </Button>
      )}
      {actions.copy && (
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={onCopy} aria-label={t("rowActions.copyRecord", { record })}>
          <Copy className="h-3.5 w-3.5" />
          {t("rowActions.copy")}
        </Button>
      )}
    </div>
  );
}

export function RecordsTable({
  records,
  loading,
  total,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpen,
  onEdit,
  onRecall,
  onCopy,
  user,
  onSubmitted,
  onEvidenceAttached,
  filter,
  onFilterChange,
  yearOptions,
  narrowed,
}: RecordsTableProps) {
  const tErrors = useTranslations("errors");
  const t = useTranslations("dataEntry");
  const tStatus = useTranslations("recordStatus");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const words = useRecordWords();
  const describe = useDescribeError();
  const submitCopy = { t: useTranslations("bulkSubmit"), locale };
  const evidenceCopy = { t: useTranslations("evidence"), locale, words };
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

  const { selectableIds, reasonById } = useMemo(
    () => selectableDrafts(records, user, submitCopy, words),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the copy follows `locale`/`words`
    [records, user, locale, words],
  );
  // Selection is by id against a list that refetches under it. Anything no
  // longer selectable — submitted by this very call, or edited in another tab —
  // has to leave the selection, or the next submit sends ids the server will
  // refuse and the count on the button is a lie.
  const live = liveSelection(selected, selectableIds);
  // `selectableIds` is already empty when there is no user, so this is the
  // whole condition.
  const showSelection = selectableIds.length > 0;
  const summary = report ? summariseSubmit(report, tErrors, submitCopy) : null;

  const attach = useMemo(
    () => attachableRecords(records, user, evidenceCopy),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the copy follows `locale`/`words`
    [records, user, locale, words],
  );
  // Page-local selections: a refresh that drops a later page drops its ticks
  // too, rather than keeping them hidden to reappear checked when that page
  // is loaded again (qa-auditor P3-8).
  useEffect(() => {
    setSelected((ids) => {
      const kept = liveSelection(ids, selectableIds);
      return kept.length === ids.length ? ids : kept;
    });
    setAttachSelected((ids) => {
      const kept = ids.filter((id) => attach.attachableIds.includes(id));
      return kept.length === ids.length ? ids : kept;
    });
  }, [selectableIds, attach.attachableIds]);
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
      toast.info(capRefusedNotice(submitCopy));
      return;
    }
    setAttachSelected(next.selected);
  }

  function chooseFile(file: File | undefined) {
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    // The API's checks, mirrored so a wrong file is refused before it uploads.
    if (!(EVIDENCE_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
      toast.error(evidenceCopy.t("unsupportedType", { fileName: file.name }));
      return;
    }
    if (file.size > EVIDENCE_MAX_SIZE_BYTES) {
      toast.error(t("submissions.tooLarge", { fileName: file.name }));
      return;
    }
    setPendingFile(file);
  }

  async function attachFile() {
    if (!pendingFile || attaching || liveAttach.length === 0) return;
    setAttaching(true);
    try {
      const file = await api.uploadEvidenceForRecords(pendingFile, liveAttach);
      toast.success(attachSuccessMessage(file, evidenceCopy));
      stopAttach();
      onEvidenceAttached();
    } catch (e) {
      // All or nothing: nothing was attached, and the sentence names each
      // record that refused. The selection stays, so the user can untick them.
      showErrorToast(attachErrorMessage(e, evidenceCopy, describe));
      setPendingFile(null);
    } finally {
      setAttaching(false);
    }
  }

  function toggle(id: string) {
    const next = toggleSelected(live, id);
    if (next.refusedByCap) {
      toast.info(capRefusedNotice(submitCopy));
      return;
    }
    setReport(null);
    setSelected(next.selected);
  }

  function selectAll() {
    const { selected: next, overCap } = selectAllEligible(selectableIds);
    setReport(null);
    setSelected(next);
    for (const notice of selectAllNotices(next.length, overCap, submitCopy)) {
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
      showErrorToast(submitErrorMessage(e, submitCopy, describe));
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
      <CardHeader className="space-y-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-muted-foreground" />
          {t("records.title")}
        </CardTitle>
        {/* Filters (BUG-R2-05): sent to the API, so Load more honours them. */}
        <div className="flex flex-wrap items-center gap-2" data-testid="records-filters">
          <Select
            value={String(filter.year)}
            onValueChange={(v) => onFilterChange({ year: v === "all" ? "all" : Number(v) })}
          >
            <SelectTrigger className="h-8 w-[130px]" aria-label={t("records.filters.year")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("records.filters.allYears")}</SelectItem>
              {yearOptions.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filter.status}
            onValueChange={(v) => onFilterChange({ status: v as RecordsFilter["status"] })}
          >
            <SelectTrigger className="h-8 w-[160px]" aria-label={t("records.filters.status")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("records.filters.allStatuses")}</SelectItem>
              {ACTIVITY_RECORD_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {tStatus(`label.${status}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filter.category}
            onValueChange={(v) => onFilterChange({ category: v as RecordsFilter["category"] })}
          >
            <SelectTrigger className="h-8 w-[200px]" aria-label={t("records.filters.category")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("records.filters.allCategories")}</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {words.category(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {!attachMode && attach.attachableIds.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="h-auto min-h-7 w-fit max-w-full gap-1.5 whitespace-normal py-1 text-left text-xs"
            data-testid="evidence-attach-start"
            onClick={startAttach}
          >
            <Paperclip className="h-3.5 w-3.5" />
            {t("submissions.attachStart")}
          </Button>
        )}
        {!attachMode && selectableIds.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              data-testid="drafts-select-all"
              checked={allEligibleSelected(live.length, selectableIds.length)}
              onCheckedChange={(on) => (on ? selectAll() : setSelected([]))}
              // Starts with the visible text (WCAG 2.5.3, label in name): a
              // voice-control user says what they see — "Select all 3 loaded"
              // — and a name that never contains it cannot be activated that
              // way. "Loaded": a selection covers the pages on screen, never
              // the subsidiary's whole history (LP4-05's contract).
              aria-label={t("selectAllLoadedName", { count: selectableIds.length })}
            />
            {t("selectAllLoaded", { count: selectableIds.length })}
          </label>
        )}
        </div>
      </CardHeader>
      {/* Not `space-y-2`: `pickByFieldLabel` finds a form field as a
          `div.space-y-2` holding its label, and the table's headers ("Value",
          "Category") would answer for the form's. */}
      <CardContent className="space-y-3">
        {attachMode && (
          <div
            // Stacked, not side by side: the column is narrow beside the form
            // and the button names how many records it will cover.
            className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2"
            data-testid="evidence-attach-bar"
          >
            <span className="text-xs text-muted-foreground">
              {liveAttach.length === 0
                ? t("submissions.attachHint")
                : t("submissions.selectedCount", { count: formatNumber(liveAttach.length, locale) })}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={stopAttach}>
                {tCommon("cancel")}
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
                {attachButtonLabel(liveAttach.length, evidenceCopy)}
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
              {t("submissions.selectedCount", { count: formatNumber(live.length, locale) })}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                {t("submissions.clear")}
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
                {draftsSubmitLabel(live.length, submitCopy)}
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
                        {submitIssueLabel(f.code, tErrors)}
                      </span>
                      {submitIssueMessage(f, tErrors) && <span className="block opacity-80">{submitIssueMessage(f, tErrors)}</span>}
                    </li>
                  ))}
                </ul>
                {failuresToShow(report.failed).remainder > 0 && (
                  <p className="mt-1.5 opacity-80">
                    {t("submissions.moreNotShown", { count: formatNumber(failuresToShow(report.failed).remainder, locale) })}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : records.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" data-testid="records-table-empty">
            {narrowed ? t("records.noMatch") : t("submissions.empty")}
          </p>
        ) : (
          <Table data-testid="records-table">
            <TableHeader>
              <TableRow>
                {(showSelection || attachMode) && (
                  <TableHead className="w-8">
                    <span className="sr-only">{t("records.columns.select")}</span>
                  </TableHead>
                )}
                <TableHead>{t("records.columns.period")}</TableHead>
                <TableHead>{t("records.columns.category")}</TableHead>
                <TableHead>{t("records.columns.entity")}</TableHead>
                <TableHead className="text-right">{t("records.columns.value")}</TableHead>
                <TableHead className="text-right">{t("records.columns.emissions")}</TableHead>
                <TableHead>{t("records.columns.evidence")}</TableHead>
                <TableHead>{t("records.columns.status")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("records.columns.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
            {records.map((r) => {
              const badge = statusBadge[r.status];
              const Icon = badge.icon;
              const selectable = attachMode
                ? attach.attachableIds.includes(r.id)
                : selectableIds.includes(r.id);
              const checked = attachMode ? liveAttach.includes(r.id) : live.includes(r.id);
              const onToggle = attachMode ? toggleAttachRow : toggle;
              const reason = attachMode ? attach.reasonById[r.id] : reasonById[r.id];
              const category = categoryWithActivity(r, words, t);
              // `locationName` is optional on the contract, so a bare `??`
              // would label a site row as the whole company if the include
              // were ever dropped — a false claim on the one screen built to
              // tell the two apart. The label is the shared one: the import
              // template and every report say "Whole company".
              const entity = r.locationId ? (r.locationName ?? t("submissions.aSite")) : t("wholeCompany");
              // Uniqueness includes `location_id`, so a whole-company record
              // and a site record for the same period and category are two
              // rows; this name tells them apart for the open button and the
              // checkbox alike.
              const named = `${words.period(r.periodValue)} ${r.reportingYear} ${category}, ${entity}`;
              const evidence = evidenceCell(r);
              const voided = r.status === "voided";
              return (
                <TableRow key={r.id} data-testid="records-table-row" className="align-top">
                  {(showSelection || attachMode) && (
                    <TableCell className="pt-3">
                      {selectable ? (
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => onToggle(r.id)}
                          aria-label={t(attachMode ? "submissions.checkboxAttach" : "submissions.checkboxSelect", {
                            record: named,
                          })}
                        />
                      ) : (
                        // Keeps the rows aligned. A DISABLED checkbox was the
                        // other option and is worse: it is unfocusable, so the
                        // reason below never reaches anyone who cannot see it.
                        <span className="block h-4 w-4" aria-hidden />
                      )}
                    </TableCell>
                  )}
                  <TableCell className="whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onOpen(r)}
                      // Named by the record, starting with its period: a
                      // screen reader hears which record opens, and the name
                      // stays what specs and voice users already match.
                      aria-label={named}
                      // Deliberately NOT aria-disabled: a non-editable row
                      // still answers "why can't I edit this?" when activated,
                      // and marking it disabled is what stops assistive tech
                      // (and Playwright) from ever reaching that answer.
                      className={cn(
                        "inline-flex items-center gap-2 rounded-md text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        // The lifecycle rule from the contract, not a third
                        // hand-written copy of it.
                        isSubmittable(r.status) ? "underline-offset-4 hover:text-primary hover:underline" : "cursor-default",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      {words.period(r.periodValue)} {r.reportingYear}
                    </button>
                  </TableCell>
                  <TableCell className="min-w-40 whitespace-normal">
                    {category}
                    {/* Only for the rows that LOOK selectable — the status
                        column already says "Approved", so "Already approved."
                        beside it is noise on every line. */}
                    {reason && <div className="mt-0.5 text-xs text-status-incomplete-text">{reason}</div>}
                  </TableCell>
                  <TableCell className="min-w-32 whitespace-normal text-muted-foreground">{entity}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", voided && "line-through text-muted-foreground")}>
                    {formatNumber(r.activityValue, locale, { maximumFractionDigits: 3 })} {unitSymbol(r.activityUnit)}
                  </TableCell>
                  {/* A withdrawn figure is struck through: the status says
                      "Voided", but the tonnes beside it would otherwise read
                      like any other row's. */}
                  <TableCell className={cn("text-right tabular-nums", voided && "line-through text-muted-foreground")}>
                    {formatTCo2e(
                      r.calculation,
                      (v) => t("submissions.tonnes", { value: formatNumber(v, locale, { maximumFractionDigits: 3 }) }),
                      tCommon("notCalculated"),
                    )}
                  </TableCell>
                  <TableCell>
                    {evidence.kind === "missing" ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-status-incomplete-text">
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                        {t("records.evidenceMissing")}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Paperclip className="h-3.5 w-3.5" aria-hidden />
                        {t(evidence.count === 1 ? "records.evidenceOne" : "records.evidenceMany", { value: formatNumber(evidence.count, locale) })}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`px-1.5 py-0 text-[10px] ${badge.className}`}>
                      {tStatus(`label.${r.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-1">
                    <RowActions
                      actions={recordActions(user, r)}
                      record={`${words.period(r.periodValue)} ${r.reportingYear} ${category}`}
                      onEdit={() => onEdit(r)}
                      onRecall={() => onRecall(r)}
                      onCopy={() => onCopy(r)}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
            </TableBody>
          </Table>
        )}
        {!loading && records.length > 0 && (
          <div className="flex flex-col items-center gap-2 pt-1">
            <p className="text-center text-xs text-muted-foreground" data-testid="previous-submissions-shown">
              {total === null
                ? t("previousShownLoaded", { shown: records.length })
                : t("previousShown", { shown: records.length, total })}
            </p>
            <LoadMoreButton
              hasMore={hasMore}
              loading={loadingMore}
              onClick={onLoadMore}
              label={t("previousLoadMore")}
              testId="previous-submissions-load-more"
            />
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
              <DialogTitle>{t("submissions.attachTitle")}</DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-2 text-sm text-muted-foreground">
                  {(() => {
                    const { lead, records: named } = attachConfirmation(
                      pendingFile.name,
                      attachRows,
                      evidenceCopy,
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
                {tCommon("cancel")}
              </Button>
              <Button
                data-testid="evidence-attach-confirm"
                onClick={() => void attachFile()}
                disabled={attaching}
              >
                {attaching && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                {t("submissions.attach")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {confirming && (
        <Dialog open onOpenChange={setConfirming}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("submissions.submitTitle")}</DialogTitle>
              <DialogDescription>
                {submitConfirmation(live.length, submitCopy)}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {tCommon("cancel")}
              </Button>
              <Button
                data-testid="drafts-submit-confirm"
                onClick={() => void submitSelected()}
                disabled={submitting}
              >
                {t("submissions.sendForReview")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
