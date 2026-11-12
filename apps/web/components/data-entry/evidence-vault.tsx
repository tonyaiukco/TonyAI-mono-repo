"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
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
  RotateCw,
  X,
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
import { addHeldFiles } from "@/lib/held-evidence";
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
  /** The saved record, or null for a record not saved yet (BUG-R2-05). */
  recordId: string | null;
  category: string;
  canManage: boolean;
  onCountChange?: (count: number) => void;
  /** No record yet: the files chosen for it, held until the save that creates it. */
  heldFiles?: readonly File[];
  onHeldFilesChange?: (files: File[]) => void;
  /** A record: files its creating save could not upload, offered with Retry. */
  failedFiles?: readonly File[];
  /** One failed file is done with (uploaded on Retry, or removed). Names the
   *  record, so a late answer for another record is ignored. */
  onFailedFileDone?: (recordId: string, file: File) => void;
  /** A save is running: held files must not change under it. */
  busy?: boolean;
  /** A saved refrigerant record whose year holds other gas records the user may
   *  attach to (UAT round 2, K5): opens the records table's attach step. */
  onShareWithYear?: (() => void) | null;
}

/**
 * The Evidence document section of Data Entry. On a saved record it lists,
 * uploads and removes the record's files through the API. On a record not
 * saved yet there is no id to upload to, so it holds the chosen files in the
 * browser (BUG-R2-05); the page uploads them to the record its save creates.
 */
export function EvidenceVault(props: EvidenceVaultProps) {
  return props.recordId === null ? (
    <HeldVault {...props} />
  ) : (
    <RecordVault {...props} recordId={props.recordId} />
  );
}

function VaultTitle({ required, count }: { required: boolean; count: string | null }) {
  const t = useTranslations("evidence");
  return (
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
      {count !== null && <span className="text-xs text-muted-foreground">{count}</span>}
    </CardHeader>
  );
}

function RequiredNote({ category }: { category: string }) {
  const t = useTranslations("evidence");
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      data-testid="evidence-required-note"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      {category === "Refrigerants" ? (
        // An installed-capacity record has no fuel receipt: the documents that
        // stand in for one are named (UAT round 2, K5).
        <div>
          <p>{t("refrigerantNote.intro")}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>{t("refrigerantNote.inventory")}</li>
            <li>{t("refrigerantNote.serviceForm")}</li>
            <li>{t("refrigerantNote.nameplate")}</li>
            <li>{t("refrigerantNote.invoice")}</li>
          </ul>
        </div>
      ) : (
        <span>{t("requiredNote")}</span>
      )}
    </div>
  );
}

/** One document for the year's other gas records (UAT round 2, K5 option A). */
function ShareWithYear({ onStart }: { onStart: () => void }) {
  const t = useTranslations("evidence");
  return (
    <div className="space-y-1 rounded-lg border border-border px-3 py-2">
      <Button type="button" variant="outline" size="sm" onClick={onStart} data-testid="evidence-share-with-year">
        {t("shareShortcut.button")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("shareShortcut.hint")}</p>
    </div>
  );
}

/**
 * The drop surface and its "Choose files" button. Named input for E2E: Data
 * Entry carries two hidden file inputs (the other imports a whole file of
 * records), and Playwright's strict mode fails on a bare `input[type="file"]`
 * the moment there is more than one. Disambiguating with `.first()` would pin
 * DOM order, which is not a contract.
 */
function DropZone({
  working,
  disabled,
  onFiles,
  onRefused,
  inputRef,
}: {
  working: boolean;
  disabled: boolean;
  onFiles: (files: File[]) => void;
  /** Files arrived while disabled and were not taken. */
  onRefused?: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const t = useTranslations("evidence");
  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (disabled) onRefused?.();
        else onFiles(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
        dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-muted/40",
      )}
    >
      {working ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : (
        <Upload className="h-5 w-5 text-muted-foreground" />
      )}
      {working ? (
        <p className="text-sm font-medium text-foreground" role="status">
          {t("uploading")}
        </p>
      ) : (
        /* A real button, not a clickable div: the input is `display:none` and
           therefore unfocusable, so without this there was no keyboard path to
           attaching evidence at all. The div stays the drop SURFACE. */
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          {t("chooseFiles")}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{t("accepted")}</p>
      <input
        ref={inputRef}
        type="file"
        data-testid="evidence-vault-input"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          const chosen = e.target.files ? Array.from(e.target.files) : [];
          // Cleared at once, so choosing the same file again fires a change.
          e.target.value = "";
          // Not while disabled: a file held during a save would arrive after
          // the save read the held list, and be lost when the record opens.
          if (disabled) {
            if (chosen.length > 0) onRefused?.();
            return;
          }
          if (chosen.length > 0) onFiles(chosen);
        }}
      />
    </div>
  );
}

/** A file listed by name and size with one or two actions, not yet on the record. */
function PendingFileRow({
  file,
  note,
  children,
}: {
  file: File;
  note: string;
  children: ReactNode;
}) {
  const t = useTranslations("evidence");
  const locale = useLocale();
  const Icon = iconFor(file.type);
  return (
    <li className="flex items-center gap-3 rounded-lg border border-dashed border-border bg-card px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
        <p className="text-xs text-muted-foreground">
          {formatSize(file.size, locale, t)} · {note}
        </p>
      </div>
      {children}
    </li>
  );
}

function HeldVault({
  category,
  canManage,
  heldFiles = [],
  onHeldFilesChange,
  busy = false,
}: EvidenceVaultProps) {
  const t = useTranslations("evidence");
  const inputRef = useRef<HTMLInputElement>(null);
  const required = isEvidenceRequired(category);

  function hold(chosen: File[]) {
    const { held, refused } = addHeldFiles(heldFiles, chosen);
    for (const { file, reason } of refused) {
      toast.error(t(reason === "too_large" ? "tooLarge" : "unsupportedType", { fileName: file.name }));
    }
    onHeldFilesChange?.(held);
  }

  return (
    <Card data-testid="evidence-vault" data-mode="held">
      <VaultTitle required={required} count={null} />
      <CardContent className="space-y-3">
        {required && heldFiles.length === 0 && <RequiredNote category={category} />}
        {canManage ? (
          <>
            <DropZone
              working={false}
              disabled={busy}
              onFiles={hold}
              onRefused={() => toast.info(t("held.wait"))}
              inputRef={inputRef}
            />
            {heldFiles.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("held.hint")}</p>
            ) : (
              <ul className="space-y-2" aria-label={t("held.listLabel")}>
                {heldFiles.map((f) => (
                  <PendingFileRow key={`${f.name}:${f.size}:${f.lastModified}`} file={f} note={t("held.waiting")}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      disabled={busy}
                      onClick={() => onHeldFilesChange?.(heldFiles.filter((h) => h !== f))}
                      aria-label={t("held.removeAria", { fileName: f.name })}
                      title={t("remove")}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </PendingFileRow>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="py-2 text-center text-sm text-muted-foreground">{t("none")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function RecordVault({
  recordId,
  category,
  canManage,
  onCountChange,
  failedFiles = [],
  onFailedFileDone,
  onShareWithYear = null,
}: EvidenceVaultProps & { recordId: string }) {
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
  const [retrying, setRetrying] = useState<File | null>(null);
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

  async function uploadFiles(chosen: File[]) {
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
    }
  }

  // A file the creating save could not upload (BUG-R2-05): try it again on
  // this record, the one that save created.
  async function retryFailed(file: File) {
    setRetrying(file);
    try {
      await api.uploadEvidence(recordId, file);
      onFailedFileDone?.(recordId, file);
      toast.success(t("uploaded"));
      await refresh();
    } catch (e) {
      errorToast(e);
    } finally {
      setRetrying(null);
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
    <Card data-testid="evidence-vault" data-mode="record">
      <VaultTitle required={required} count={t("filesCount", { count: formatNumber(count, locale) })} />
      <CardContent className="space-y-3">
        {needsEvidence && <RequiredNote category={category} />}

        {onShareWithYear && <ShareWithYear onStart={onShareWithYear} />}

        {canManage && (
          <DropZone working={uploading} disabled={uploading} onFiles={(f) => void uploadFiles(f)} inputRef={inputRef} />
        )}

        {failedFiles.length > 0 && (
          <div className="space-y-2" data-testid="evidence-failed-uploads">
            <p className="text-sm font-medium text-status-incomplete-text">{t("failed.title")}</p>
            <ul className="space-y-2">
              {failedFiles.map((f) => (
                <PendingFileRow key={`${f.name}:${f.size}:${f.lastModified}`} file={f} note={t("failed.note")}>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1"
                      disabled={retrying !== null}
                      onClick={() => void retryFailed(f)}
                      aria-label={t("failed.retryAria", { fileName: f.name })}
                    >
                      {retrying === f ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                      {t("failed.retry")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={retrying === f}
                    onClick={() => onFailedFileDone?.(recordId, f)}
                    aria-label={t("failed.removeAria", { fileName: f.name })}
                    title={t("remove")}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </PendingFileRow>
              ))}
            </ul>
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
