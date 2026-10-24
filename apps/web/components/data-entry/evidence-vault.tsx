"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "use-intl";
import {
  FileText,
  FileSpreadsheet,
  Image as ImageIcon,
  Upload,
  Trash2,
  Download,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadMoreButton } from "@/components/ui/load-more-button";
import { appendById, isStaleCursor } from "@/lib/cursor-pages";
import { api, ApiError } from "@/lib/api";
import { EVIDENCE_ALLOWED_MIME_TYPES, isEvidenceRequired } from "@/lib/types";
import type { EvidenceDTO } from "@/lib/types";
import {
  detachSuccessMessage,
  readEvidencePage,
  removeFileLabel,
  sharedWithNote,
} from "@/lib/evidence-view";
import { cn } from "@/lib/utils";
import { useErrorToast, useRecordWords, useStableErrorToast } from "@/lib/i18n/hooks";
import { formatNumber } from "@/lib/i18n/number";
import type { Locale } from "@/lib/types";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.xlsx,.csv";

function iconFor(mime: string) {
  if (mime.startsWith("image/")) return ImageIcon;
  if (mime.includes("spreadsheet") || mime === "text/csv") return FileSpreadsheet;
  return FileText;
}

function formatSize(bytes: number, locale: Locale, t: (key: "size.mb" | "size.kb" | "size.bytes", values: { value: string }) => string): string {
  const plain = { useGrouping: false } as const;
  if (bytes >= 1024 * 1024) {
    return t("size.mb", { value: formatNumber(bytes / 1024 / 1024, locale, { ...plain, minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
  }
  if (bytes >= 1024) return t("size.kb", { value: formatNumber(Math.round(bytes / 1024), locale, plain) });
  return t("size.bytes", { value: formatNumber(bytes, locale, plain) });
}

interface EvidenceVaultProps {
  recordId: string;
  category: string;
  canManage: boolean;
  onCountChange?: (count: number) => void;
}

export function EvidenceVault({
  recordId,
  category,
  canManage,
  onCountChange,
}: EvidenceVaultProps) {
  const t = useTranslations("evidence");
  const locale = useLocale();
  const words = useRecordWords();
  const copy = { t, locale, words };
  const errorToast = useErrorToast();
  // Stable: `refresh` is a dependency of the effect that loads the files.
  const stableErrorToast = useStableErrorToast();
  const [files, setFiles] = useState<EvidenceDTO[]>([]);
  // The loaded pages of files (LP4-05 PR C) and the record's whole count.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const required = isEvidenceRequired(category);

  // A refresh (an upload, a removal) starts a new chain; a "load more" still
  // in flight from the old one must not append its page to the new first page.
  const loadSeq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++loadSeq.current;
    setLoading(true);
    try {
      const page = await readEvidencePage(recordId);
      // One page is the whole set only when it says so; past it, the count is
      // the record's own, never the loaded rows'.
      const total =
        page.nextCursor === null
          ? page.items.length
          : (await api.getActivityRecord(recordId)).evidenceCount;
      if (mine !== loadSeq.current) return;
      setFiles(page.items);
      setNextCursor(page.nextCursor);
      setCount(total);
      onCountChange?.(total);
    } catch (e) {
      if (mine === loadSeq.current) stableErrorToast(e);
    } finally {
      if (mine === loadSeq.current) setLoading(false);
    }
  }, [recordId, onCountChange, stableErrorToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function loadMore() {
    if (!nextCursor) return;
    const mine = loadSeq.current;
    setLoadingMore(true);
    try {
      const page = await readEvidencePage(recordId, nextCursor);
      if (mine !== loadSeq.current) return;
      setFiles((list) => appendById(list, page.items));
      setNextCursor(page.nextCursor);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      errorToast(e);
      if (isStaleCursor(e)) void refresh();
    } finally {
      setLoadingMore(false);
    }
  }

  async function uploadFiles(fileList: FileList | File[]) {
    const chosen = Array.from(fileList);
    if (chosen.length === 0) return;
    setUploading(true);
    try {
      for (const file of chosen) {
        if (!(EVIDENCE_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
          toast.error(t("unsupportedType", { fileName: file.name }));
          continue;
        }
        await api.uploadEvidence(recordId, file);
      }
      toast.success(t("uploaded"));
      await refresh();
    } catch (e) {
      errorToast(e);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  // Takes the file off THIS record. A file can back several records (WP8
  // PR7); the API deletes it only when this was its last one, so a draft's
  // vault can never pull an invoice out from under an approved record.
  async function handleRemove(file: EvidenceDTO) {
    try {
      const result = await api.detachEvidence(recordId, file.id);
      toast.success(detachSuccessMessage(result, file, copy));
      await refresh();
    } catch (e) {
      errorToast(e);
      if (e instanceof ApiError && e.status === 409) await refresh();
    }
  }

  async function handleDownload(id: string) {
    try {
      const { url } = await api.getEvidenceUrl(id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      errorToast(e);
    }
  }

  const needsEvidence = required && !loading && files.length === 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4 text-muted-foreground" />
          {t("title")}
          {required && (
            <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
              {t("required")}
            </span>
          )}
        </CardTitle>
        <span className="text-xs text-muted-foreground">{t("filesCount", { count: formatNumber(count, locale) })}</span>
      </CardHeader>
      <CardContent className="space-y-3">
        {needsEvidence && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("requiredNote")}</span>
          </div>
        )}

        {canManage && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void uploadFiles(e.dataTransfer.files);
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
              dragOver
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40 hover:bg-muted/40",
            )}
          >
            {uploading ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <Upload className="h-5 w-5 text-muted-foreground" />
            )}
            {uploading ? (
              <p className="text-sm font-medium text-foreground" role="status">
                {t("uploading")}
              </p>
            ) : (
              /* A real button, not a clickable div: the input is
                 `display:none` and therefore unfocusable, so without this
                 there was no keyboard path to attaching evidence at all. The
                 div stays the drop SURFACE. */
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => inputRef.current?.click()}
              >
                {t("chooseFiles")}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">{t("accepted")}</p>
            <input
              ref={inputRef}
              type="file"
              // Named so E2E can reach THIS input. Data Entry now carries two
              // hidden file inputs (the other imports a whole file of
              // records), and Playwright's strict mode fails on a bare
              // `input[type="file"]` the moment there is more than one.
              // Disambiguating with `.first()` would pin DOM order, which is
              // not a contract.
              data-testid="evidence-vault-input"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
            />
          </div>
        )}

        {loading ? (
          <p className="py-2 text-center text-sm text-muted-foreground">{t("loading")}</p>
        ) : files.length === 0 ? (
          !canManage && (
            <p className="py-2 text-center text-sm text-muted-foreground">{t("none")}</p>
          )
        ) : (
          <ul className="space-y-2">
            {files.map((f) => {
              const Icon = iconFor(f.mimeType);
              const shared = sharedWithNote(f, recordId, copy);
              const removeLabel = removeFileLabel(f, copy);
              return (
                <li
                  key={f.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{f.fileName}</p>
                    <p className="text-xs text-muted-foreground">{formatSize(f.sizeBytes, locale, t)}</p>
                    {shared && (
                      <p className="text-xs text-muted-foreground" data-testid="evidence-shared-note">
                        {shared}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => void handleDownload(f.id)}
                    title={t("download")}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-red-600 hover:text-red-700"
                      onClick={() => void handleRemove(f)}
                      title={removeLabel}
                      aria-label={t("removeAria", { label: removeLabel, fileName: f.fileName })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <LoadMoreButton
          hasMore={!loading && nextCursor !== null}
          loading={loadingMore}
          onClick={() => void loadMore()}
          label={t("loadMore")}
          testId="evidence-vault-load-more"
        />
      </CardContent>
    </Card>
  );
}
