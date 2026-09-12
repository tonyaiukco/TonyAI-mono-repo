"use client";

import { useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { BulkUploadReportDTO, BulkUploadRowIssue } from "@/lib/types";
import {
  applyConfirmation,
  applySuccessMessage,
  BULK_UPLOAD_MAX_ROWS,
  COLUMN_LABEL,
  fileAcceptAttribute,
  groupIssues,
  MAX_ISSUE_ROWS_PER_GROUP,
  preflightFile,
  rowCount,
  sizeCapLabel,
  summarise,
  tonnesLabel,
  uploadErrorMessage,
  type IssueGroup,
} from "@/lib/bulk-upload-view";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * Import a file of historical records.
 *
 * A renderer: the sentences it shows and the "is this file worth sending"
 * question both come from `lib/bulk-upload-view.ts`, because
 * `vitest.config.ts` collects only `lib/**` and anything decided here has no
 * coverage in either direction. What is left here — the state machine, the
 * drag handlers, the markup — is what only a browser can exercise, and PR 4's
 * e2e is where it gets exercised.
 *
 * Dry-run-first, and the dry run starts on pick: it writes nothing, the file
 * is already chosen, and a second click buys nothing. Applying is behind a
 * confirm dialog, because it writes up to a thousand individually audited
 * records that cannot be undone in bulk.
 */
type Busy = "none" | "checking" | "importing";

export function BulkUploadPanel({
  canManage,
  onImported,
}: {
  canManage: boolean;
  /** Fires after any ATTEMPTED apply, so the page can refresh what is stale. */
  onImported: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const verdictRef = useRef<HTMLDivElement>(null);
  /**
   * Which dry run the screen is allowed to believe.
   *
   * Two can be in flight — pick a file, then pick another — and the responses
   * can land in either order. Without this the older response overwrites the
   * newer report while `file` holds the newer file, and Import then posts a
   * file the user never previewed, which is the one outcome dry-run-first
   * exists to prevent.
   */
  const requestSeq = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<Busy>("none");
  /** Its own flag: the template download must not clear the import's. */
  const [templateBusy, setTemplateBusy] = useState(false);
  const [report, setReport] = useState<BulkUploadReportDTO | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const working = busy !== "none";

  function reset() {
    requestSeq.current += 1;
    setFile(null);
    setReport(null);
    setRefusal(null);
    setDragOver(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function downloadTemplate() {
    setTemplateBusy(true);
    try {
      await api.downloadBulkUploadTemplate();
      toast.success("Template downloaded");
    } catch (e) {
      toast.error(uploadErrorMessage(e));
    } finally {
      setTemplateBusy(false);
    }
  }

  async function dryRun(picked: File) {
    if (working) return;
    const problem = preflightFile(picked);
    if (problem) {
      // Refused here so it costs no request: the budget is five a minute per
      // user, and a dry run plus an apply already spends two of them.
      toast.error(problem);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    const seq = ++requestSeq.current;
    setFile(picked);
    setReport(null);
    setRefusal(null);
    setBusy("checking");
    try {
      const checked = await api.bulkUploadActivityRecords(picked, true);
      if (seq !== requestSeq.current) return;
      setReport(checked);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      // Rendered in the card, not only as a toast: a whole-file refusal names
      // the column or up to ten offending rows, which is not something anyone
      // reads in four seconds.
      setRefusal(uploadErrorMessage(e) || "The import failed.");
    } finally {
      if (seq === requestSeq.current) setBusy("none");
    }
  }

  async function apply() {
    if (!file || working) return;
    setConfirming(false);
    setBusy("importing");
    try {
      const applied = await api.bulkUploadActivityRecords(file, false);
      // NOT cleared: the error list is the user's work list, and a partial
      // import is real — no transaction spans the batch.
      setReport(applied);
      toast.success(applySuccessMessage(applied));
      verdictRef.current?.focus();
    } catch (e) {
      toast.error(uploadErrorMessage(e));
    } finally {
      setBusy("none");
      // In `finally`, because an apply that FAILED may still have written
      // hundreds of rows — there is no transaction. Refreshing only on
      // success would leave the screen insisting nothing happened.
      onImported();
    }
  }

  // Nothing to show and nothing to offer: a card explaining an absence is
  // still a card the reader has to parse.
  if (!canManage) return null;

  const summary = report ? summarise(report) : null;
  const errorGroups = report ? groupIssues(report.errors) : [];
  const warningGroups = report ? groupIssues(report.warnings) : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground" /> Bulk
          upload
        </CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void downloadTemplate()}
          disabled={templateBusy}
        >
          {templateBusy ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="mr-2 h-3.5 w-3.5" />
          )}
          Download template
        </Button>
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Rows name reporting entities by id, so start from the template — it
          arrives pre-filled with the entities you can reach, and its second
          sheet lists which id is which.
        </p>

        {!report && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) void dryRun(dropped);
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
              dragOver
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40",
            )}
          >
            {busy === "checking" ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <Upload className="h-5 w-5 text-muted-foreground" />
            )}
            {busy === "checking" ? (
              <p className="text-sm font-medium text-foreground" role="status">
                Checking {file?.name ?? "your file"}… nothing is being written.
              </p>
            ) : (
              <>
                {/* A real button, not a clickable div: the input is
                    `display:none` and therefore unfocusable, so without this
                    there is no keyboard path to the feature at all. The div
                    stays the drop SURFACE. */}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => inputRef.current?.click()}
                >
                  Choose a file
                </Button>
                <p className="text-xs text-muted-foreground">
                  …or drop one here
                </p>
              </>
            )}
            <p className="text-xs text-muted-foreground">
              CSV or XLSX · up to {rowCount(BULK_UPLOAD_MAX_ROWS)} · max{" "}
              {sizeCapLabel()}
            </p>
            <input
              ref={inputRef}
              type="file"
              data-testid="bulk-upload-input"
              accept={fileAcceptAttribute()}
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (picked) void dryRun(picked);
              }}
            />
          </div>
        )}

        {refusal && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-900"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p>{refusal}</p>
              <p className="mt-1 font-medium">Nothing was imported.</p>
            </div>
          </div>
        )}

        {report && summary && (
          <div className="space-y-3">
            <div
              ref={verdictRef}
              tabIndex={-1}
              role="status"
              className={cn(
                "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm outline-none",
                summary.tone === "clean" &&
                  "border-status-complete-text/30 bg-status-complete-bg text-status-complete-text",
                summary.tone === "partial" &&
                  "border-status-incomplete-text/30 bg-status-incomplete-bg text-status-incomplete-text",
                summary.tone === "refused" &&
                  "border-status-missing-text/30 bg-status-missing-bg text-status-missing-text",
              )}
            >
              {summary.tone === "clean" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <div className="flex-1 space-y-0.5">
                <p className="font-medium">{summary.headline}</p>
                {summary.detail && <p>{summary.detail}</p>}
                {summary.acceptedCount > 0 && (
                  <p className="font-mono text-xs">
                    {tonnesLabel(report.accepted)}
                  </p>
                )}
                <p className="text-xs opacity-80">{report.fileName}</p>
              </div>
            </div>

            {errorGroups.length > 0 && (
              <IssueList groups={errorGroups} tone="error" />
            )}

            {warningGroups.length > 0 && (
              <>
                <Separator />
                <IssueList groups={warningGroups} tone="warning" />
              </>
            )}

            <div className="flex flex-wrap gap-2">
              {report.dryRun && summary.acceptedCount > 0 && (
                <Button
                  size="sm"
                  onClick={() => setConfirming(true)}
                  disabled={working}
                >
                  {busy === "importing" ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Import {rowCount(summary.acceptedCount)}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={reset}
                disabled={working}
              >
                {report.dryRun
                  ? "Choose a different file"
                  : "Upload another file"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import these rows?</DialogTitle>
            <DialogDescription>
              {report ? applyConfirmation(report) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={() => void apply()} disabled={working}>
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * One disclosure per problem, with the rows it affects.
 *
 * Native `<details>`: the summary is focusable, Enter and Space toggle it, and
 * a screen reader announces the expanded state — better behaviour per line
 * than anything hand-rolled, and no JavaScript. Only the largest group opens,
 * because every group open at fifty rows each would push the entry form the
 * user actually came for off the screen.
 */
function IssueList({
  groups,
  tone,
}: {
  groups: IssueGroup[];
  tone: "error" | "warning";
}) {
  const widest = groups.reduce(
    (max, g) => (g.count > max ? g.count : max),
    0,
  );
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {tone === "error" ? "Problems to fix" : "Worth knowing"}
      </p>
      {groups.map((group) => (
        <details
          key={group.code}
          open={group.count === widest}
          className={cn(
            "group rounded-lg border px-3 py-2 text-sm",
            tone === "error"
              ? "border-status-missing-text/30 bg-status-missing-bg/60"
              : "border-status-incomplete-text/30 bg-status-incomplete-bg/60",
          )}
        >
          <summary className="flex cursor-pointer items-center gap-1.5 rounded font-medium outline-none [&::-webkit-details-marker]:hidden focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
            {group.label} · {rowCount(group.count)}
          </summary>
          {/* A list, not a table: without headers a `<table>` is announced as
              "table, 50 rows, 3 columns" with nothing to orient by, and the
              word "Row" is read out fifty times as data. */}
          <ul className="mt-2 space-y-1">
            {group.rows.slice(0, MAX_ISSUE_ROWS_PER_GROUP).map((issue, i) => (
              <IssueItem key={`${issue.row}-${i}`} issue={issue} />
            ))}
          </ul>
          {group.count > MAX_ISSUE_ROWS_PER_GROUP && (
            <p className="mt-1.5 text-xs opacity-80">
              +{group.count - MAX_ISSUE_ROWS_PER_GROUP} more with the same
              problem.
            </p>
          )}
        </details>
      ))}
    </div>
  );
}

function IssueItem({ issue }: { issue: BulkUploadRowIssue }) {
  return (
    <li className="text-xs">
      <span className="font-mono opacity-70">Row {issue.row}</span>
      {issue.column && (
        <span className="opacity-70"> · {COLUMN_LABEL[issue.column]}</span>
      )}
      <span className="block">{issue.message}</span>
    </li>
  );
}
