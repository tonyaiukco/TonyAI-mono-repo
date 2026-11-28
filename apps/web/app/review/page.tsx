"use client";

import { useLocale, useTranslations } from "use-intl";
import {
  awaitedApprover,
  canApproveRecord,
  isOwnRecordForApprover,
  isNewerRecord,
  isRevised,
  isSelfApproval,
  keepNewerRows,
  mayUseReviewQueue,
  shouldStartReviewOnOpen,
} from "@/lib/record-lifecycle-view";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  FileText,
  History,
  Info,
  Paperclip,
  ShieldAlert,
} from "lucide-react";
import { Sidebar } from "@/components/dashboard/sidebar";
import { RecordTrail } from "@/components/record-trail";
import { SignOutButton } from "@/components/dashboard/sign-out-button";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { LoadMoreButton } from "@/components/ui/load-more-button";
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
import { anomalyStatement, isFirstPeriodRecord } from "@/lib/anomaly-view";
import { factorReleaseId, formatSealDate, sealDateFor } from "@/lib/release-seal-view";
import { useReleaseSealDates } from "@/lib/use-release-seal-dates";
import { useAuthStore } from "@/lib/store";
import {
  entityLabel,
  isCalculated,
  LOCALE_FORMAT_TAGS,
  assistantRecordFuel,
  mayReadRecordTrail,
  PENDING_REVIEW_STATUSES,
  unitSymbol,
  type ActivityRecordDTO,
  type ActivityRecordPageFilters,
  type EvidenceDTO,
  type Locale,
  type SubsidiaryDTO,
  holdsRecords,
} from "@/lib/types";
import { appendById, isStaleCursor } from "@/lib/cursor-pages";
import { readEvidencePage, sharedWithNote } from "@/lib/evidence-view";
import { EvidenceAssistantPanel } from "@/components/fuel-files/evidence-assistant-panel";
import { useActorWords, useEntityWords, useErrorToast, useRecordWords, useStableErrorToast } from "@/lib/i18n/hooks";
import { formatComputedAmount, formatNumber, formatReadAmount } from "@/lib/i18n/number";
import { reviewCalorificBasis, reviewRecordFilters, reviewReferences, reviewReportingEntity, reviewSelfGeneration, waitingLabel } from "@/lib/review-view";
import { ReviewBatches, reviewBatchCount } from "@/components/fuel-files/review-batches";
import { categoryWithActivity } from "@/lib/vocabulary";
import { recordActorLabel } from "@/lib/record-actor";
import {
  formatTCo2e,
  notCalculatedReason,
} from "@/lib/calculation-display";
import { cn } from "@/lib/utils";
import { useSignOut } from "@/lib/use-sign-out";

const ANY = "__any__";

/** Same palette as the emissions History tab — a record must not change colour
 * depending on which screen you are looking at it from. */
const STATUS_COLORS: Record<string, string> = {
  submitted: "bg-[#E8F0FE] text-[#0066CC] font-semibold",
  under_review: "bg-[#FEF3C7] text-[#92400E] font-semibold",
};

/** A second badge, never a status (WP5): violet, a colour neither status nor
 *  the anomaly marker's amber uses. */
const REVISED_BADGE_CLASS = "bg-[#EDE9FE] text-[#5B21B6] font-semibold";

function formatDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_FORMAT_TAGS[locale], {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

export default function ReviewPage() {
  const tRoles = useTranslations("users");
  const tAnomaly = useTranslations("anomaly");
  const tEvidence = useTranslations("evidence");
  const tCommon = useTranslations("common");
  const t = useTranslations("review");
  const tFuel = useTranslations("fuelFiles");
  const showError = useErrorToast();
  const showStableError = useStableErrorToast();
  const entityWords = useEntityWords();
  const actorWords = useActorWords();
  const recordWords = useRecordWords();
  const locale = useLocale();
  // The package seal date beside the release behind a figure (UAT round 2, S2).
  const sealDates = useReleaseSealDates();
  const signOut = useSignOut();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [rows, setRows] = useState<ActivityRecordDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // The whole queue's size from GET /activity-records/metadata, never the
  // loaded rows' count; null while unknown or refused as query_too_broad.
  const [total, setTotal] = useState<number | null>(null);
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  // The selection on screen could not be read: said so, never "nothing waiting".
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [subsidiaryId, setSubsidiaryId] = useState<string>(ANY);
  const [selected, setSelected] = useState<ActivityRecordDTO | null>(null);
  const [evidence, setEvidence] = useState<EvidenceDTO[] | null>(null);
  const [evidenceCursor, setEvidenceCursor] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState(false);
  // Every load and "load more" carries the sequence it started under; one that
  // returns after a newer load (a filter change, a refresh) is dropped.
  const loadSeq = useRef(0);
  // The filters the rows on screen — and so `nextCursor` — belong to. A "load
  // more" continues THAT chain, never the selection picked since (Codex P2-1).
  const chainFilters = useRef<ActivityRecordPageFilters | null>(null);
  const selectedId = useRef<string | null>(null);
  useEffect(() => {
    selectedId.current = selected?.id ?? null;
  }, [selected]);
  // The sheet reads its record again when it opens (self-gen-form, outside
  // review of 833db34c): a queue row is as old as the queue, and the record's
  // read-time facts, such as whether its fuel record exists, may have changed
  // since. A write's answer is newer than that read, so it bumps the sequence
  // and a read answered after it is dropped.
  const sheetRead = useRef(0);
  // Decisions wait for that read (outside review of 001d6f1c): a reason typed
  // against the row could otherwise go out with a newer submission's
  // `seenSubmittedAt`, and a decision could be offered on a record no longer
  // pending or on an unconfirmed fuel notice.
  const [sheetState, setSheetState] = useState<"reading" | "ready" | "failed">("ready");
  // Each opening of the sheet is a session; a review step's answer updates only
  // the opening it was sent from, so a late answer from an earlier opening of
  // the same record cannot overrule this one's read (outside review of b8b0d78b).
  const sheetSession = useRef(0);
  // The start of review an opening sent, still unanswered (WP5): the fallback
  // "Start review" button waits for it rather than send a second one.
  const [startingReview, setStartingReview] = useState(false);
  // The open record's history dialog (WP5).
  const [trailOpen, setTrailOpen] = useState(false);
  const tTrail = useTranslations("recordTrail");
  // The history belongs to the record on the sheet: any other record, or none
  // (the sheet closed, or a read found it decided), closes it.
  const trailRecordId = selected?.id ?? null;
  useEffect(() => {
    setTrailOpen(false);
  }, [trailRecordId]);
  /**
   * Opening a record a user may approve takes it into review (WP5, INC-2.6
   * §1.2), naming the submission the sheet's read saw. Sent once per opening
   * the USER made (`startReview`): the re-read that follows a refused action
   * passes false, so a refusal that persists can never loop. A refused start
   * reads the record again, which shows what it is now (closed if no longer
   * pending, "Under review" if another reviewer won); any other failure keeps
   * the sheet on the submitted record, where Approve, Return and the fallback
   * button stay offered. No toast on success: the status badge is the news.
   */
  const startReviewOnOpen = (fresh: ActivityRecordDTO) => {
    const session = sheetSession.current;
    const seq = sheetRead.current;
    setStartingReview(true);
    api
      .reviewActivityRecord(fresh.id, { seenSubmittedAt: fresh.submittedAt })
      .then((updated) => {
        // The row too only if it still shows what this start answered for: a
        // queue read since may hold a newer submission (returned and sent
        // again), which a late answer must not turn back.
        setRows((prev) => prev.map((r) => (r.id === updated.id && !isNewerRecord(r, updated) ? updated : r)));
        // Only the opening this was sent from, and only if nothing newer (a
        // decision's answer, a re-read) has spoken since.
        if (sheetSession.current === session && sheetRead.current === seq && selectedId.current === fresh.id) {
          setSelected(updated);
        }
      })
      .catch((err) => {
        if (sheetSession.current !== session || selectedId.current !== fresh.id) return;
        if (err instanceof ApiError && (err.status === 409 || err.status === 400)) {
          void loadRef.current({ quiet: true });
          openRecord(fresh, { startReview: false });
          return;
        }
        showError(err);
        // Its approver changed since the read (a grant withdrawn, an author's
        // role changed): the re-read states the record's approver now.
        if (err instanceof ApiError && err.code === "not_record_approver") {
          void loadRef.current({ quiet: true });
          openRecord(fresh, { startReview: false });
        }
      })
      .finally(() => {
        if (sheetSession.current === session) setStartingReview(false);
      });
  };
  const openRecord = (row: ActivityRecordDTO, opts: { startReview: boolean } = { startReview: true }) => {
    sheetSession.current += 1;
    setStartingReview(false);
    const seq = (sheetRead.current += 1);
    setSelected(row);
    setReason("");
    setSheetState("reading");
    api
      .getActivityRecord(row.id)
      .then((fresh) => {
        if (sheetRead.current !== seq || selectedId.current !== row.id) return;
        if (!(PENDING_REVIEW_STATUSES as readonly string[]).includes(fresh.status)) {
          // Decided elsewhere since the queue was read: it leaves the queue.
          setRows((prev) => prev.filter((r) => r.id !== fresh.id));
          setSelected(null);
          setReason("");
          setSheetState("ready");
          toast.info(t("sheet.noLongerPending"));
          void loadRef.current({ quiet: true });
          return;
        }
        // Submitted again since the queue was read: what was typed and the
        // files shown belong to the earlier submission.
        if (fresh.submittedAt !== row.submittedAt) {
          setReason("");
          setEvidenceRetry((n) => n + 1);
        }
        setSelected(fresh);
        setRows((prev) => prev.map((r) => (r.id === fresh.id ? fresh : r)));
        setSheetState("ready");
        if (opts.startReview && shouldStartReviewOnOpen(user, fresh)) startReviewOnOpen(fresh);
      })
      .catch((err) => {
        if (sheetRead.current !== seq || selectedId.current !== row.id) return;
        // Gone (deleted, or out of reach now): it leaves the queue, no Retry.
        if (err instanceof ApiError && err.status === 404) {
          setRows((prev) => prev.filter((r) => r.id !== row.id));
          setSelected(null);
          setReason("");
          setSheetState("ready");
          toast.info(t("sheet.noLongerPending"));
          void loadRef.current({ quiet: true });
          return;
        }
        setSheetState("failed");
        showError(err);
      });
  };
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * Who may do what. The API is the authority — a forged request still gets
   * its 403 (`record.decide`, then `not_record_approver` inside the record's
   * lock). These flags only decide whether to render a control the caller
   * would be refused for using, because offering a button that always fails is
   * worse than not offering it. Start review, Return and Approve belong to the
   * record's approver alone (`mayDecideRecord` over its `approver`).
   */
  const canReview = mayUseReviewQueue(user);
  const canApprove = canApproveRecord(user, selected);

  /**
   * By default the queue lists only what awaits THIS user's decision — the API
   * applies the routing (`awaitingMyDecision`), so paging and the count stay
   * right. The switch shows every pending record the user can read; those not
   * theirs to decide say who decides them and offer no decision.
   */
  const [showAll, setShowAll] = useState(false);

  /**
   * Records and fuel batches are two lists, each with its own count
   * (inc28-fuel-bulk D10): a batch's records are decided with the batch, so
   * the Records list leaves them out (`inBatch=false`).
   */
  const [queueTab, setQueueTab] = useState<"records" | "batches">("records");
  const [batchTotal, setBatchTotal] = useState<number | null>(null);
  const [batchVersion, setBatchVersion] = useState(0);
  useEffect(() => {
    if (!user || !mayUseReviewQueue(user)) return;
    let live = true;
    reviewBatchCount(subsidiaryId === ANY ? null : subsidiaryId, showAll)
      .then((n) => live && setBatchTotal(n))
      .catch(() => live && setBatchTotal(null));
    return () => {
      live = false;
    };
  }, [user, subsidiaryId, showAll, batchVersion]);

  /** The queue's filters: the pending statuses, the subsidiary picked, and whose decision. */
  const queueFilters = useCallback(
    (): ActivityRecordPageFilters =>
      reviewRecordFilters({ statuses: PENDING_REVIEW_STATUSES, subsidiaryId: subsidiaryId === ANY ? null : subsidiaryId, showAll }),
    [subsidiaryId, showAll],
  );

  /**
   * The first page of the queue and its size. A refresh, a filter change and a
   * decision each start the cursor chain again (LP4-05's contract).
   *
   * Longest wait first, from the API (`review_queue`: submittedAt ASC, nulls
   * last, id): a queue sorted newest-first buries the record that has waited
   * longest, which is the one most likely to hold up a period close. Sorted on
   * the field the Waiting column MEASURES.
   */
  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    const seq = ++loadSeq.current;
    // A refresh after a decision keeps the table on screen while it reloads.
    if (!options.quiet) setLoading(true);
    const filters = queueFilters();
    try {
      const [page, subs, meta] = await Promise.all([
        api.listActivityRecordPage({ ...filters, sort: "review_queue" }),
        api.listSubsidiaries(),
        // Any refusal of the count (422 query_too_broad, a quota, an outage) shows
        // it as unknown; the list itself still loads (K7).
        api.activityRecordMetadata(filters).catch(() => null),
      ]);
      if (seq !== loadSeq.current) return;
      chainFilters.current = filters;
      setLoadFailed(false);
      // A page read before a step this screen saw answered (a review started on
      // opening, say) must not turn that row back: the newer version stays.
      setRows((prev) => keepNewerRows(prev, page.items));
      setNextCursor(page.nextCursor);
      setTotal(meta?.total ?? null);
      setSubsidiaries(subs);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      // Never the previous selection's records and count under the new
      // selector: they are actionable, and they are not what it names (Codex P2-1).
      chainFilters.current = null;
      setLoadFailed(true);
      setRows([]);
      setNextCursor(null);
      setTotal(null);
      // A 401 reads "Your session has expired" from the catalogue, as before.
      showStableError(e);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [queueFilters, showStableError]);

  async function loadMore() {
    const filters = chainFilters.current;
    if (!nextCursor || !filters) return;
    const seq = loadSeq.current;
    setLoadingMore(true);
    try {
      const page = await api.listActivityRecordPage({ ...filters, sort: "review_queue", cursor: nextCursor });
      if (seq !== loadSeq.current) return;
      setRows((prev) => appendById(prev, page.items));
      setNextCursor(page.nextCursor);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      showError(e);
      // A cursor refused after a deployment: start the queue again.
      if (isStaleCursor(e)) void loadRef.current();
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);
  // The loader of the selection on screen NOW. A decision that settles after
  // the reviewer picked another subsidiary refreshes that one, never the
  // selection it started under (Codex P2-2).
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
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
  // without being able to open the invoice behind it is rubber-stamping. Keyed
  // on the record's id and an explicit retry, never on the record object: the
  // sheet's own re-read of the record on open (self-gen-form) and a review
  // step's answer replace the object without changing the files.
  const selectedRecordId = selected?.id ?? null;
  const [evidenceRetry, setEvidenceRetry] = useState(0);
  // Which list of files the pages on screen belong to: a continuation page
  // answered after the list started again (another record, a newer
  // submission, a retry) is dropped, never appended (outside review of b8b0d78b).
  const evidenceGen = useRef(0);
  useEffect(() => {
    evidenceGen.current += 1;
    if (!selectedRecordId) return;
    setEvidence(null);
    setEvidenceCursor(null);
    setEvidenceError(false);
    let cancelled = false;
    readEvidencePage(selectedRecordId)
      .then((page) => {
        if (cancelled) return;
        setEvidence(page.items);
        setEvidenceCursor(page.nextCursor);
      })
      // NOT `[]`. A 403, a 500 or a dropped connection rendered identically to
      // "this record genuinely has no evidence" — on the one screen where
      // someone decides whether to accept a figure into the inventory, that is
      // the rubber-stamping this panel exists to prevent.
      .catch(() => !cancelled && setEvidenceError(true));
    return () => {
      cancelled = true;
    };
  }, [selectedRecordId, evidenceRetry]);

  async function loadMoreEvidence() {
    if (!selected || !evidenceCursor) return;
    const recordId = selected.id;
    const gen = evidenceGen.current;
    const current = () => evidenceGen.current === gen && selectedId.current === recordId;
    try {
      const page = await readEvidencePage(recordId, evidenceCursor);
      // The sheet may have moved to another record, or its list started again, while this page loaded.
      if (!current()) return;
      setEvidence((prev) => appendById(prev ?? [], page.items));
      setEvidenceCursor(page.nextCursor);
    } catch (e) {
      if (!current()) return;
      showError(e);
      if (!isStaleCursor(e)) return;
      // A cursor refused after a deployment: the files start again from their
      // first page, for the record still open (Codex P2-3).
      try {
        const first = await readEvidencePage(recordId);
        if (!current()) return;
        setEvidenceError(false);
        setEvidence(first.items);
        setEvidenceCursor(first.nextCursor);
      } catch {
        if (!current()) return;
        // The error state's Retry reloads the record; no stale cursor is left
        // behind a second "load more" (Codex P3 on the re-check).
        setEvidenceCursor(null);
        setEvidenceError(true);
      }
    }
  }

  async function handleLogout() {
    await signOut();
  }

  async function openEvidence(id: string) {
    try {
      const { url } = await api.getEvidenceUrl(id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      showError(e);
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
    const session = sheetSession.current;
    try {
      const updated =
        verb === "review"
          ? // The submission on screen: one resubmitted since is refused, so a
            // reason typed for it never meets the newer one (outside review).
            await api.reviewActivityRecord(record.id, { seenSubmittedAt: record.submittedAt })
          : verb === "approve"
            ? // The submission the reviewer is looking at (BUG-R2-03): an author
              // may since have recalled, edited and resubmitted it, and then
              // the API refuses with `record_changed` rather than approve a
              // figure nobody here saw.
              await api.approveActivityRecord(record.id, { seenSubmittedAt: record.submittedAt })
            : await api.rejectActivityRecord(record.id, {
                varianceReason: reason.trim(),
                seenSubmittedAt: record.submittedAt,
              });

      const stillPending = (
        PENDING_REVIEW_STATUSES as readonly string[]
      ).includes(updated.status);
      setRows((prev) =>
        stillPending
          ? prev.map((r) => (r.id === updated.id ? updated : r))
          : prev.filter((r) => r.id !== updated.id),
      );
      // Only while the sheet still shows the opening this was sent from: one
      // the reviewer closed, moved on from, or opened again, is not touched by
      // a late answer (Codex P2-2; outside review of b8b0d78b).
      if (sheetSession.current === session && selectedId.current === record.id) {
        sheetRead.current += 1;
        setSheetState("ready");
        setSelected(stillPending ? updated : null);
        if (!stillPending) setReason("");
        // Not the submission the reason and files were for: both start again.
        else if (updated.submittedAt !== record.submittedAt) {
          setReason("");
          setEvidenceRetry((n) => n + 1);
        }
      }
      // The queue moved: its size and its first page are read again — for the
      // selection on screen now — and the cursor chain starts over.
      void loadRef.current({ quiet: true });
      toast.success(
        verb === "review" ? t("toast.reviewed") : verb === "approve" ? t("toast.approved") : t("toast.rejected"),
      );
    } catch (e) {
      // 409 includes locks and concurrent changes; 400 is a state-machine refusal. Both mean the
      // queue this page is showing is stale, so reload rather than leave the
      // reviewer clicking a row that can no longer move.
      showError(e);
      // `not_record_approver`: who decides the record changed since it was read.
      if (e instanceof ApiError && (e.status === 409 || e.status === 400 || e.code === "not_record_approver")) {
        void loadRef.current();
        // The record moved under this opening: read it again, so what is
        // typed and shown belongs to the submission it holds now.
        if (sheetSession.current === session && selectedId.current === record.id) {
          openRecord(record, { startReview: false });
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const subsidiaryName = (id: string) =>
    subsidiaries.find((s) => s.id === id)?.legalName ?? id;

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-[280px]">
        <div className="p-8 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">{t("title")}</h1>
              <p className="text-sm text-muted-foreground">
                {user
                  ? t("subtitleUser", { name: user.fullName ?? user.email, role: tRoles(`roles.${user.role}`) })
                  : t("subtitle")}
              </p>
            </div>
            <SignOutButton onClick={handleLogout} />
          </div>

          {!user ? (
            // The store is in-memory, so `user` is null on every hard load. The
            // old `user && !canReview` rendered the FULL queue to every role —
            // including an auditor — until /me resolved. The API refuses
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
                  <p className="font-medium">{t("gate.title")}</p>
                  <p className="text-sm text-muted-foreground">
                    {/* Visibility is tenant-scoped; the record's approver
                        decides which review actions are offered. */}
                    {t("gate.body", { role: tRoles(`roles.${user.role}`) })}
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Select
                  value={subsidiaryId}
                  onValueChange={(v) => setSubsidiaryId(v)}
                >
                  <SelectTrigger className="w-[260px]">
                    <SelectValue placeholder={t("allSubsidiaries")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>{t("allSubsidiaries")}</SelectItem>
                    {/* Companies that hold records only: a sector group's or an
                        associate's queue is always empty (owner's fourth review of WP7, P3). */}
                    {subsidiaries.filter((s) => holdsRecords(s)).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.legalName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                  <Switch
                    id="review-show-all"
                    checked={showAll}
                    onCheckedChange={setShowAll}
                    data-testid="review-show-all"
                  />
                  <Label htmlFor="review-show-all" className="text-sm font-normal">
                    {t("showAll")}
                  </Label>
                </div>
                <span className="text-sm text-muted-foreground ml-auto" data-testid="review-queue-total">
                  {t("awaitingReview", { count: total === null ? "—" : formatNumber(total, locale) })}
                </span>
              </div>

              <div className="inline-flex rounded-md border p-1" role="tablist">
                {(["records", "batches"] as const).map((tab) => (
                  <Button
                    key={tab}
                    role="tab"
                    aria-selected={queueTab === tab}
                    size="sm"
                    variant={queueTab === tab ? "default" : "ghost"}
                    onClick={() => setQueueTab(tab)}
                    data-testid={`review-tab-${tab}`}
                  >
                    {tab === "records"
                      ? tFuel("review.recordsTab", { count: total === null ? "—" : formatNumber(total, locale) })
                      : tFuel("review.batchesTab", { count: batchTotal === null ? "—" : formatNumber(batchTotal, locale) })}
                  </Button>
                ))}
              </div>

              {queueTab === "batches" ? (
                <ReviewBatches
                  user={user}
                  subsidiaryId={subsidiaryId === ANY ? null : subsidiaryId}
                  showAll={showAll}
                  refreshKey={batchVersion}
                  onChanged={() => setBatchVersion((v) => v + 1)}
                />
              ) : (
              <>
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("columns.subsidiary")}</TableHead>
                        <TableHead>{t("columns.period")}</TableHead>
                        <TableHead>{t("columns.category")}</TableHead>
                        <TableHead className="text-right">{t("columns.activity")}</TableHead>
                        <TableHead className="text-right">{tCommon("tco2e")}</TableHead>
                        <TableHead>{t("columns.status")}</TableHead>
                        {/* The author submits drafts and rejected records; this
                            column identifies that author, while Waiting uses submittedAt. */}
                        <TableHead>{t("columns.enteredBy")}</TableHead>
                        <TableHead>{t("columns.waiting")}</TableHead>
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
                      ) : loadFailed ? (
                        <TableRow>
                          <TableCell
                            colSpan={8}
                            className="text-center py-8 text-muted-foreground"
                            data-testid="review-queue-failed"
                          >
                            {t("loadFailed")}{" "}
                            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void load()}>
                              {t("retry")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ) : rows.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={8}
                            className="text-center py-8 text-muted-foreground"
                          >
                            {/* An empty queue is the good outcome here, not an
                                error — say so, so it does not read as a failed
                                load. */}
                            {showAll ? t("empty") : t("emptyMine")}
                          </TableCell>
                        </TableRow>
                      ) : (
                        rows.map((row) => (
                          <TableRow
                            key={row.id}
                            className="cursor-pointer"
                            onClick={() => openRecord(row)}
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
                              {t("periodYear", { period: recordWords.period(row.periodValue), year: row.reportingYear })}
                            </TableCell>
                            <TableCell className="text-sm">
                              <span className="flex items-center gap-2">
                                {/* With its gas or fuel: one site and year can hold
                                    several records of a category that differ only
                                    by type (uat2-review-shows-gas). */}
                                {categoryWithActivity(recordWords, row)}
                                {row.anomalyFlag && (
                                  <AlertTriangle className="h-4 w-4 text-amber-500" data-testid="anomaly-flag-marker" />
                                )}
                                {/* A first-period record (UAT round 2, K4-3a): nothing to
                                    compare with, so the reviewer checks the evidence and
                                    the unit. Neutral, never the flag's amber. */}
                                {isFirstPeriodRecord(row) && (
                                  <span
                                    role="img"
                                    aria-label={tAnomaly("firstPeriod.headline")}
                                    title={tAnomaly("firstPeriod.headline")}
                                    data-testid="first-period-marker"
                                  >
                                    <Info className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                                  </span>
                                )}
                              </span>
                            </TableCell>
                            <TableCell className="text-right text-sm font-mono">
                              {formatNumber(row.activityValue, locale)}{" "}
                              {unitSymbol(row.activityUnit)}
                            </TableCell>
                            <TableCell className="text-right text-sm font-mono">
                              {formatTCo2e(
                                row.calculation,
                                (v) => formatNumber(v, locale, { maximumFractionDigits: 3 }),
                                tCommon("notCalculated"),
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge
                                className={cn(
                                  "text-xs",
                                  STATUS_COLORS[row.status],
                                )}
                              >
                                {recordWords.status(row.status)}
                              </Badge>
                              {isRevised(row) && (
                                <Badge
                                  className={cn("text-xs ml-1", REVISED_BADGE_CLASS)}
                                  title={t("revised.title", { n: row.submissionCount })}
                                  data-testid="revised-badge"
                                >
                                  {t("revised.label")}
                                </Badge>
                              )}
                              {/* Not this user's decision (the "every pending
                                  record" view): who decides it instead. */}
                              {(() => {
                                const awaits = awaitedApprover(user, row);
                                return awaits ? (
                                  <span
                                    className="block mt-1 text-xs text-muted-foreground whitespace-nowrap"
                                    data-testid="review-row-awaits"
                                  >
                                    {t(`awaits.${awaits}`)}
                                  </span>
                                ) : null;
                              })()}
                            </TableCell>
                            <TableCell className="text-sm whitespace-nowrap">
                              {/* A reviewer decides someone else's number, so
                                  whose it is belongs in the queue rather than
                                  one click into the audit screen. */}
                              {(() => {
                                const actor = recordActorLabel(
                                  row.createdBy,
                                  row.createdByName,
                                  actorWords,
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
                              {waitingLabel(row.submittedAt, { t, locale })}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground" data-testid="review-queue-shown">
                  {loading || rows.length === 0
                    ? ""
                    : total === null
                      ? t("shown", { shown: formatNumber(rows.length, locale) })
                      : t("shownOf", { shown: formatNumber(rows.length, locale), total: formatNumber(total, locale) })}
                </span>
                <LoadMoreButton
                  hasMore={nextCursor !== null && !loading}
                  loading={loadingMore}
                  onClick={() => void loadMore()}
                  label={t("loadMore")}
                  testId="review-queue-load-more"
                />
              </div>
              </>
              )}
            </>
          )}
        </div>
      </main>

      <RecordTrail
        recordId={selected?.id ?? null}
        open={trailOpen && !!selected}
        onOpenChange={setTrailOpen}
      />
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) {
            sheetSession.current += 1;
            setSelected(null);
            setReason("");
          }
        }}
      >
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {selected
                ? t("sheet.title", {
                    category: categoryWithActivity(recordWords, selected),
                    period: recordWords.period(selected.periodValue),
                    year: selected.reportingYear,
                  })
                : ""}
            </SheetTitle>
            {selected && (
              <div className="flex flex-wrap items-center gap-2" data-testid="review-sheet-status">
                <Badge className={cn("text-xs", STATUS_COLORS[selected.status])}>
                  {recordWords.status(selected.status)}
                </Badge>
                {isRevised(selected) && (
                  <Badge
                    className={cn("text-xs", REVISED_BADGE_CLASS)}
                    title={t("revised.title", { n: selected.submissionCount })}
                    data-testid="revised-badge"
                  >
                    {t("revised.label")}
                  </Badge>
                )}
                {/* The record's history (WP5): the only place a difference
                    between submissions is shown; the sheet keeps current values. */}
                {mayReadRecordTrail(user, selected) && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs gap-1"
                    onClick={() => setTrailOpen(true)}
                    aria-label={tTrail("openLabel")}
                    data-testid="review-sheet-history"
                  >
                    <History className="h-3.5 w-3.5" aria-hidden="true" />
                    {tTrail("open")}
                  </Button>
                )}
              </div>
            )}
          </SheetHeader>
          {selected && (
            <div className="space-y-5 mt-4 text-sm">
              <div className="grid grid-cols-3 gap-2">
                <span className="text-muted-foreground">{t("sheet.subsidiary")}</span>
                <span className="col-span-2">
                  {subsidiaryName(selected.subsidiaryId)}
                </span>
                <span className="text-muted-foreground">{t("sheet.entity")}</span>
                <span className="col-span-2">{entityLabel(selected, entityWords)}</span>
                <span className="text-muted-foreground">{t("sheet.activity")}</span>
                <span className="col-span-2 font-mono">
                  {formatNumber(selected.activityValue, locale)}{" "}
                  {unitSymbol(selected.activityUnit)}
                </span>
                {/* A gas bill's stated basis, read-only, to check against the bill (ng-kwh-engine). */}
                {(() => {
                  const basis = reviewCalorificBasis(selected);
                  return basis === null ? null : (
                    <>
                      <span className="text-muted-foreground">{t("sheet.calorificBasis")}</span>
                      <span className="col-span-2" data-testid="review-calorific-basis">{t(`sheet.calorificBasisValue.${basis}`)}</span>
                    </>
                  );
                })()}
                {/* What ties the record to its evidence file, each shown only when held (BUG-16). */}
                {(() => {
                  const { invoiceNo, supplier } = reviewReferences(selected);
                  return (
                    <>
                      {invoiceNo !== null && (
                        <>
                          <span className="text-muted-foreground">{t("sheet.invoiceNo")}</span>
                          <span className="col-span-2 break-words font-mono" data-testid="review-invoice-no">{invoiceNo}</span>
                        </>
                      )}
                      {supplier !== null && (
                        <>
                          <span className="text-muted-foreground">{t("sheet.supplier")}</span>
                          <span className="col-span-2 break-words" data-testid="review-supplier">{supplier}</span>
                        </>
                      )}
                    </>
                  );
                })()}
                {/* The record's own generation behind the meter, read-only (self-gen-form). */}
                {(() => {
                  const own = reviewSelfGeneration(selected);
                  if (own === null) return null;
                  // Stored as typed: every digit, never rounded away (outside review of 833db34c).
                  const kwh = (value: number) => `${formatReadAmount(value, locale)} ${unitSymbol("kWh")}`;
                  return (
                    <>
                      <span className="text-muted-foreground">{t("sheet.selfGeneration.source")}</span>
                      <span className="col-span-2" data-testid="review-self-generation-source">
                        {t(`sheet.selfGeneration.sources.${own.source}`)}
                      </span>
                      <span className="text-muted-foreground">{t("sheet.selfGeneration.generated")}</span>
                      <span className="col-span-2 font-mono" data-testid="review-self-generation-generated">{kwh(own.generatedKwh)}</span>
                      {own.exportedKwh !== null && (
                        <>
                          <span className="text-muted-foreground">{t("sheet.selfGeneration.exported")}</span>
                          <span className="col-span-2 font-mono" data-testid="review-self-generation-exported">{kwh(own.exportedKwh)}</span>
                        </>
                      )}
                      {own.facilityKwh !== null && (
                        <>
                          <span className="text-muted-foreground">{t("sheet.selfGeneration.facility")}</span>
                          <span className="col-span-2 font-mono" data-testid="review-self-generation-facility">{kwh(own.facilityKwh)}</span>
                        </>
                      )}
                    </>
                  );
                })()}
                <span className="text-muted-foreground">{t("sheet.emissions")}</span>
                <span className="col-span-2 font-mono">
                  {isCalculated(selected.calculation) ? (
                    t("tonnes", { value: formatNumber(selected.calculation.tCo2e, locale, { maximumFractionDigits: 3 }) })
                  ) : (
                    <span className="font-sans text-muted-foreground">
                      {tCommon("notCalculated")}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground">{t("sheet.factor")}</span>
                <span className="col-span-2 text-xs">
                  {/* The reviewer is signing off on a number, so the provenance
                      of that number belongs on this screen, not one click away.
                      When there is no number, that is the single most important
                      thing on the screen: an approval here commits an entry to
                      the inventory that carries no emissions figure at all. */}
                  {isCalculated(selected.calculation)
                    ? t("sheet.factorSource", { source: selected.calculation.source, version: selected.calculation.version })
                    : tCommon("noFactor")}
                </span>
                {(() => {
                  const sealedAt = sealDateFor(sealDates, factorReleaseId(selected.calculation));
                  return sealedAt ? (
                    <>
                      <span className="text-muted-foreground">{t("sheet.sealedOn")}</span>
                      <span className="col-span-2 text-xs" data-testid="release-sealed-on">
                        {formatSealDate(sealedAt, locale)}
                      </span>
                    </>
                  ) : null;
                })()}
                {/* Both, because they answer different questions: when the
                    work was started, and when it reached this queue. They are
                    the same date only for a record submitted the day it was
                    drafted. */}
                <span className="text-muted-foreground">{t("sheet.created")}</span>
                <span className="col-span-2">
                  {formatDate(selected.createdAt, locale)}
                </span>
                <span className="text-muted-foreground">{t("sheet.submitted")}</span>
                <span
                  className={cn(
                    "col-span-2",
                    selected.submittedAt === null &&
                      "italic text-muted-foreground",
                  )}
                >
                  {selected.submittedAt === null
                    ? t("sheet.notRecorded")
                    : formatDate(selected.submittedAt, locale)}
                </span>
                {/* Both actors, always — including "not reviewed yet", which is
                    a fact about the record a reviewer needs, and which a field
                    that appeared only once populated would hide. */}
                {(
                  [
                    [t("sheet.enteredBy"), selected.createdBy, selected.createdByName],
                    [t("sheet.reviewedBy"), selected.reviewedBy, selected.reviewedByName],
                  ] as const
                ).map(([label, id, name]) => {
                  const actor = recordActorLabel(id, name, actorWords);
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
                {/* A central reporter's record: the company that reported it,
                    beside its author (inc26-central-reporter-onboarding, C4). */}
                {reviewReportingEntity(selected) !== null && (
                  <>
                    <span className="text-muted-foreground">{t("sheet.reportedBy")}</span>
                    <span className="col-span-2" data-testid="review-reported-by">
                      {reviewReportingEntity(selected)}
                    </span>
                  </>
                )}
              </div>

              {/* Stated as its own block, not a dash in the table: approving
                  this record admits an entry to the inventory with no emissions
                  figure, and the reviewer has to make that call knowingly. */}
              {notCalculatedReason(selected.calculation) && (
                <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 space-y-1">
                  <p className="flex items-center gap-2 font-medium text-sky-900">
                    <AlertTriangle className="h-4 w-4" />
                    {t("sheet.noFigure")}
                  </p>
                  <p className="text-xs text-sky-900/80">
                    {notCalculatedReason(selected.calculation)}
                  </p>
                </div>
              )}

              {/* Self-generation notices (self-gen-form; D5, D6): neither blocks a review action. */}
              {(() => {
                const own = reviewSelfGeneration(selected);
                if (own === null) return null;
                const kwh = (value: number) => formatComputedAmount(value, locale);
                return (
                  <>
                    {own.fuelMissing && (
                      <div
                        className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900"
                        role="status"
                        data-testid="review-self-generation-fuel-missing"
                      >
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                        <span>
                          {t(`sheet.selfGeneration.fuelMissing.${own.fuelMissing}`, {
                            site: selected.locationName ?? t("sheet.selfGeneration.wholeCompany"),
                            year: String(selected.reportingYear),
                          })}
                        </span>
                      </div>
                    )}
                    {own.balance?.warns && (
                      <div
                        className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900"
                        role="status"
                        data-testid="review-self-generation-balance"
                      >
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                        <span>
                          {t("sheet.selfGeneration.balance", {
                            imported: kwh(own.balance.importKwh),
                            expected: kwh(own.balance.expectedImportKwh),
                          })}
                        </span>
                      </div>
                    )}
                  </>
                );
              })()}

              {selected.anomalyFlag && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-1">
                  <p className="flex items-center gap-2 font-medium text-amber-800">
                    <AlertTriangle className="h-4 w-4" />
                    {anomalyStatement(selected, tAnomaly, locale).headline}
                  </p>
                  {/* What the verdict was taken against, so a reviewer deciding
                      on the figure is not asked to trust an average nobody
                      shows them. */}
                  <p className="text-xs text-amber-900/80">
                    {anomalyStatement(selected, tAnomaly, locale).detail}
                  </p>
                  <p className="text-xs text-amber-900/80">
                    {selected.varianceReason
                      ? t("sheet.explanation", { reason: selected.varianceReason })
                      : t("sheet.noExplanation")}
                  </p>
                </div>
              )}

              {/* The absence of a flag is not a verdict when the rule never
                  ran, and a weaker one when it ran on one or two periods. A
                  reviewer approving on the strength of "nothing was flagged"
                  is the exact failure this states out loud. */}
              {!selected.anomalyFlag &&
                anomalyStatement(selected, tAnomaly, locale).qualified && (
                  <div className="rounded-lg border bg-muted/40 p-3 space-y-1">
                    <p className="font-medium">
                      {anomalyStatement(selected, tAnomaly, locale).headline}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {anomalyStatement(selected, tAnomaly, locale).detail}
                    </p>
                  </div>
                )}

              {selected.reviewNote && (
                <div className="rounded-lg border bg-muted/40 p-3 space-y-1">
                  <p className="font-medium">{t("sheet.previousNote")}</p>
                  <p className="text-xs text-muted-foreground">
                    {selected.reviewNote}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-muted-foreground flex items-center gap-2">
                  <Paperclip className="h-4 w-4" />
                  {t("sheet.evidence")}
                </p>
                {evidenceError ? (
                  <p className="text-xs text-red-600">
                    {t("sheet.evidenceFailed")}{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => setEvidenceRetry((n) => n + 1)}
                    >
                      {t("retry")}
                    </button>
                  </p>
                ) : evidence === null ? (
                  <Skeleton className="h-8 w-full" />
                ) : evidence.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("sheet.noFiles")}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {evidence.map((f) => {
                      // One file can back several records (WP8 PR7). The
                      // reviewer is the control on that: whether one
                      // invoice can honestly evidence every record it is
                      // attached to is theirs to judge, so it is said here.
                      const shared = sharedWithNote(f, selected.id, { t: tEvidence, locale, words: recordWords });
                      return (
                        <li key={f.id}>
                          <button
                            type="button"
                            onClick={() => openEvidence(f.id)}
                            className="flex items-center gap-2 text-xs text-primary hover:underline"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            {f.fileName}
                          </button>
                          {shared && (
                            <p
                              className="ml-5 text-xs text-status-incomplete-text"
                              data-testid="review-evidence-shared"
                            >
                              {shared}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <LoadMoreButton
                  hasMore={evidence !== null && evidenceCursor !== null && !evidenceError}
                  loading={false}
                  onClick={() => void loadMoreEvidence()}
                  label={t("sheet.loadMoreFiles")}
                  testId="review-evidence-load-more"
                />
              </div>

              {/* The evidence assistant for a manual fuel record in litres, as a package of one record
                  (inc29-evidence-assistant C6): on its own request, so approve and return never wait for it;
                  asked again when the record is resubmitted or its files change. A batch's record is compared on its batch. */}
              {selected.status !== "voided" &&
                assistantRecordFuel({ fuelBatchId: selected.fuelBatchId, category: selected.category, activityType: selected.activityType ?? null, activityUnit: selected.activityUnit }) !== null && (
                  <EvidenceAssistantPanel
                    source={{ kind: "record", id: selected.id }}
                    // Not `updatedAt`: taking the record into review changes it, and a second
                    // request racing the first would find the one reader busy.
                    version={`${selected.submittedAt ?? ""}|${selected.evidenceCount}`}
                  />
                )}

              {canApprove && (
              <div className="space-y-2 border-t pt-4">
                <label
                  htmlFor="review-reason"
                  className="text-muted-foreground"
                >
                  {t("sheet.reasonLabel")}
                </label>
                <Textarea
                  id="review-reason"
                  disabled={sheetState !== "ready"}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t("sheet.reasonPlaceholder")}
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">
                  {t("sheet.reasonHint")}
                </p>
              </div>
              )}

              {sheetState === "reading" && (
                <p className="text-xs text-muted-foreground" role="status" data-testid="review-sheet-reading">
                  {t("sheet.reading")}
                </p>
              )}
              {sheetState === "failed" && (
                <p className="text-xs text-red-600" role="status" data-testid="review-sheet-read-failed">
                  {t("sheet.readFailed")}{" "}
                  <button type="button" className="underline" onClick={() => openRecord(selected)}>
                    {t("retry")}
                  </button>
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {/* The fallback (WP5): opening the record took it into review,
                    unless that start failed. Never for its author. */}
                {canApprove && selected.status === "submitted" && !startingReview && (
                  <Button
                    variant="outline"
                    data-testid="review-sheet-start-review"
                    disabled={busy || sheetState !== "ready"}
                    onClick={() => act("review", selected)}
                  >
                    {t("sheet.startReview")}
                  </Button>
                )}
                {canApprove && (
                  <Button
                    variant="destructive"
                    disabled={busy || sheetState !== "ready" || !reason.trim()}
                    onClick={() => act("reject", selected)}
                  >
                    {t("sheet.reject")}
                  </Button>
                )}
                {canApprove && (
                  <Button
                    disabled={busy || sheetState !== "ready"}
                    onClick={() => act("approve", selected)}
                  >
                    {t("sheet.approve")}
                  </Button>
                )}
              </div>
              {/* A masterkey's own record: theirs to decide, and the approval
                  is written as a self-approval the auditor sees — said before
                  Approve is pressed. */}
              {isSelfApproval(user, selected) && (
                <p
                  className="flex items-start gap-1.5 text-xs text-[#A21CAF]"
                  role="note"
                  data-testid="review-sheet-self-approval-note"
                >
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{t("sheet.selfApprovalNote")}</span>
                </p>
              )}
              {isOwnRecordForApprover(user, selected) ? (
                <p className="text-xs text-muted-foreground" data-testid="review-sheet-own-record">
                  {t("sheet.selfApproval")}
                </p>
              ) : (
                (() => {
                  const awaits = awaitedApprover(user, selected);
                  return awaits ? (
                    <p className="text-xs text-muted-foreground" data-testid="review-sheet-awaits">
                      {t(`sheet.decidedBy.${awaits}`)}
                    </p>
                  ) : null;
                })()
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
