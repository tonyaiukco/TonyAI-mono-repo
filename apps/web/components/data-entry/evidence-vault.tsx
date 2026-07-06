"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import { api, ApiError } from "@/lib/api";
import { EVIDENCE_ALLOWED_MIME_TYPES, isEvidenceRequired } from "@/lib/types";
import type { EvidenceDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.xlsx,.csv";

function iconFor(mime: string) {
  if (mime.startsWith("image/")) return ImageIcon;
  if (mime.includes("spreadsheet") || mime === "text/csv") return FileSpreadsheet;
  return FileText;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
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
  const [files, setFiles] = useState<EvidenceDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const required = isEvidenceRequired(category);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listEvidence(recordId);
      setFiles(list);
      onCountChange?.(list.length);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [recordId, onCountChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function uploadFiles(fileList: FileList | File[]) {
    const chosen = Array.from(fileList);
    if (chosen.length === 0) return;
    setUploading(true);
    try {
      for (const file of chosen) {
        if (!(EVIDENCE_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
          toast.error(`${file.name}: unsupported type (PDF, JPG, PNG, XLSX, CSV only)`);
          continue;
        }
        await api.uploadEvidence(recordId, file);
      }
      toast.success("Evidence uploaded");
      await refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      toast.error(msg);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteEvidence(id);
      toast.success("Evidence removed");
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleDownload(id: string) {
    try {
      const { url } = await api.getEvidenceUrl(id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const needsEvidence = required && !loading && files.length === 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Evidence
          {required && (
            <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
              Required
            </span>
          )}
        </CardTitle>
        <span className="text-xs text-muted-foreground">{files.length} file(s)</span>
      </CardHeader>
      <CardContent className="space-y-3">
        {needsEvidence && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This category requires at least one supporting file (invoice, meter
              record, …) before it can be submitted.
            </span>
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
            onClick={() => inputRef.current?.click()}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
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
            <p className="text-sm font-medium text-foreground">
              {uploading ? "Uploading…" : "Drop files or click to upload"}
            </p>
            <p className="text-xs text-muted-foreground">PDF, JPG, PNG, XLSX, CSV · max 10 MB</p>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
            />
          </div>
        )}

        {loading ? (
          <p className="py-2 text-center text-sm text-muted-foreground">Loading…</p>
        ) : files.length === 0 ? (
          !canManage && (
            <p className="py-2 text-center text-sm text-muted-foreground">
              No evidence attached.
            </p>
          )
        ) : (
          <ul className="space-y-2">
            {files.map((f) => {
              const Icon = iconFor(f.mimeType);
              return (
                <li
                  key={f.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{f.fileName}</p>
                    <p className="text-xs text-muted-foreground">{formatSize(f.sizeBytes)}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => void handleDownload(f.id)}
                    title="Download"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-red-600 hover:text-red-700"
                      onClick={() => void handleDelete(f.id)}
                      title="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
