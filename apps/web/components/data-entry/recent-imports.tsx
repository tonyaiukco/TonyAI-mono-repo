"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, FileSpreadsheet, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ImportBatchDTO } from "@/lib/types";
import {
  submitConfirmation,
  submitErrorMessage,
  summariseSubmit,
} from "@/lib/bulk-submit-view";
import {
  BATCH_STATE_LABEL,
  awaitingEvidenceNote,
  batchOutcome,
  batchState,
  batchSubmitLabel,
  importBatchesErrorMessage,
  submitFailureDetail,
  type BatchState,
} from "@/lib/import-batches-view";

const STATE_CLASS: Record<BatchState, string> = {
  completed: "border-status-complete-text/30 bg-status-complete-bg text-status-complete-text",
  processing: "border-status-incomplete-text/30 bg-status-incomplete-bg text-status-incomplete-text",
  interrupted: "border-status-incomplete-text/30 bg-status-incomplete-bg text-status-incomplete-text",
  failed: "border-status-missing-text/30 bg-status-missing-bg text-status-missing-text",
};

/**
 * The caller's recent applied imports — what survives a page refresh. Each
 * names its file and outcome, downloads the file it came from, and sends the
 * caller's remaining drafts from it for review in one request (the server
 * re-checks every record; the batch only names them).
 */
export function RecentImports({
  canSubmit,
  refreshKey,
  onSubmitted,
}: {
  /** Whether this user may send records for review at all (`mayAuthorRecords`). */
  canSubmit: boolean;
  /** Bumped by the page after an import, so a new batch appears. */
  refreshKey: number;
  onSubmitted: () => void;
}) {
  const [batches, setBatches] = useState<ImportBatchDTO[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<ImportBatchDTO | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBatches(await api.listImportBatches(10));
      setFailed(false);
    } catch (e) {
      setFailed(true);
      toast.error(importBatchesErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function download(batch: ImportBatchDTO) {
    try {
      const { url } = await api.getImportBatchSourceUrl(batch.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(importBatchesErrorMessage(e));
    }
  }

  async function submit(batch: ImportBatchDTO) {
    setConfirming(null);
    setBusyId(batch.id);
    try {
      const report = await api.submitImportBatch(batch.id);
      const summary = summariseSubmit(report);
      // The panel's "see below" has no list below it here: say why instead.
      const description = submitFailureDetail(report) ?? undefined;
      if (summary.tone === "clean") toast.success(summary.headline);
      else toast.warning(summary.headline, { description });
    } catch (e) {
      toast.error(submitErrorMessage(e));
    } finally {
      // In `finally`: there is no transaction, so a call that threw may still
      // have moved records.
      setBusyId(null);
      onSubmitted();
      void load();
    }
  }

  const now = Date.now();

  return (
    <Card data-testid="recent-imports">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
          Recent imports
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {batches === null && !failed && (
          <>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </>
        )}
        {failed && batches === null && (
          <p className="text-sm text-muted-foreground">Recent imports could not be loaded.</p>
        )}
        {batches?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No imports yet. A file you import appears here, so you can come back to it.
          </p>
        )}
        {batches?.map((batch) => {
          const state = batchState(batch, now);
          const sendLabel = canSubmit ? batchSubmitLabel(batch.submittableDraftCount) : null;
          const waiting = canSubmit ? awaitingEvidenceNote(batch) : null;
          return (
            <div
              key={batch.id}
              data-testid="recent-import"
              className="rounded-lg border px-3 py-2.5 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="truncate font-mono text-xs" title={batch.fileName}>
                  {batch.fileName}
                </span>
                <Badge variant="outline" className={cn("text-xs", STATE_CLASS[state])}>
                  {BATCH_STATE_LABEL[state]}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {new Date(batch.createdAt).toLocaleString("en-GB", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
                {batch.uploadedByName ? ` · ${batch.uploadedByName}` : ""} · {batchOutcome(batch)}
              </p>
              {waiting && (
                <p className="mt-1 text-xs text-status-incomplete-text">{waiting}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {batch.hasSourceFile && (
                  <Button size="sm" variant="outline" onClick={() => void download(batch)}>
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    Download file
                  </Button>
                )}
                {sendLabel && (
                  <Button
                    size="sm"
                    onClick={() => setConfirming(batch)}
                    disabled={busyId !== null}
                  >
                    {busyId === batch.id ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {sendLabel}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>

      {confirming && (
        <Dialog open onOpenChange={(open) => !open && setConfirming(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Send these for review?</DialogTitle>
              <DialogDescription>
                {submitConfirmation(confirming.submittableDraftCount)}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button onClick={() => void submit(confirming)}>Send for review</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
