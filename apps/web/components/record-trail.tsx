"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import {
  Ban,
  Check,
  CornerUpLeft,
  Dot,
  Eye,
  Pencil,
  Plus,
  Repeat,
  Send,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { useRecordWords } from "@/lib/i18n/hooks";
import { cn } from "@/lib/utils";
import {
  formatTrailChange,
  trailFieldLabel,
  trailKindLabel,
  TRAIL_KIND_STYLE,
  type TrailTranslator,
} from "@/lib/record-trail-view";
import { LOCALE_FORMAT_TAGS, type Locale, type RecordAuditTrailDTO } from "@/lib/types";

const MARKS: Record<string, LucideIcon> = {
  plus: Plus,
  pencil: Pencil,
  send: Send,
  repeat: Repeat,
  undo: Undo2,
  eye: Eye,
  "corner-up-left": CornerUpLeft,
  check: Check,
  ban: Ban,
  dot: Dot,
};

type TrailState =
  | { kind: "loading" }
  | { kind: "ready"; trail: RecordAuditTrailDTO }
  | { kind: "refused" }
  | { kind: "error" };

function formatWhen(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_FORMAT_TAGS[locale], { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/**
 * One record's history as a timeline, in a dialog over whatever screen asked
 * for it (WP5, design decision 7): the review sheet, a Data Entry row, the
 * audit page. Its own loading, empty, error and refused states — a refused
 * read is said in the panel, not in a toast. `markedEventId` highlights the
 * audit row the reader chose; `onNotFound` lets the audit page fall back to
 * the row's stored content for a record that no longer exists.
 */
export function RecordTrail({
  recordId,
  open,
  onOpenChange,
  markedEventId = null,
  onNotFound,
  onShowStored,
}: {
  recordId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  markedEventId?: string | null;
  onNotFound?: () => void;
  /** The audit page's way back to the chosen row's stored entry (a reprice's,
   *  a void's snapshot, a creation's values), which the timeline summarises. */
  onShowStored?: () => void;
}) {
  const t = useTranslations("recordTrail");
  const tRoles = useTranslations("users");
  const tRoot = useTranslations();
  const locale = useLocale() as Locale;
  const words = useRecordWords();
  const [state, setState] = useState<TrailState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  // A late answer for an earlier record or opening is dropped.
  const seq = useRef(0);
  const notFound = useRef(onNotFound);
  notFound.current = onNotFound;

  useEffect(() => {
    if (!open || !recordId) return;
    const mine = ++seq.current;
    // Closed, or opened on another record, before this read answered: its
    // answer — a late 404 included — no longer speaks for the screen.
    const cleanup = () => {
      if (seq.current === mine) seq.current += 1;
    };
    setState({ kind: "loading" });
    api
      .getRecordAuditTrail(recordId)
      .then((trail) => {
        if (seq.current === mine) setState({ kind: "ready", trail });
      })
      .catch((err) => {
        if (seq.current !== mine) return;
        if (err instanceof ApiError && err.status === 404 && notFound.current) {
          notFound.current();
          return;
        }
        setState({ kind: err instanceof ApiError && err.status === 403 ? "refused" : "error" });
      });
    return cleanup;
  }, [open, recordId, attempt]);

  const tt = t as unknown as TrailTranslator;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="record-trail">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
          {onShowStored && (
            <Button
              variant="link"
              className="h-auto self-start p-0 text-xs"
              onClick={onShowStored}
              data-testid="record-trail-stored"
            >
              {t("storedEntry")}
            </Button>
          )}
        </DialogHeader>

        {state.kind === "loading" && (
          <div className="space-y-3" role="status" aria-label={t("loading")} data-testid="record-trail-loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        )}

        {state.kind === "refused" && (
          <p className="text-sm text-muted-foreground" role="alert" data-testid="record-trail-refused">
            {t("refused")}
          </p>
        )}

        {state.kind === "error" && (
          <p className="text-sm text-red-600" role="alert" data-testid="record-trail-error">
            {t("error")}{" "}
            <Button variant="link" className="h-auto p-0 align-baseline" onClick={() => setAttempt((n) => n + 1)}>
              {t("retry")}
            </Button>
          </p>
        )}

        {state.kind === "ready" && state.trail.events.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="record-trail-empty">
            {t("empty")}
          </p>
        )}

        {state.kind === "ready" && state.trail.events.length > 0 && (
          <div className="space-y-3">
            {state.trail.truncated && (
              <p className="text-xs text-muted-foreground" data-testid="record-trail-truncated">
                {t("truncated", { count: state.trail.events.length })}
              </p>
            )}
            <ol className="relative border-l border-border ml-3 space-y-4">
              {state.trail.events.map((event) => {
                const style = TRAIL_KIND_STYLE[event.kind];
                const Mark = MARKS[style.mark] ?? Dot;
                const marked = event.id === markedEventId;
                return (
                  <li
                    key={event.id}
                    className={cn("ml-5 rounded-md p-2", marked && "ring-2 ring-primary/60 bg-primary/5")}
                    data-testid="record-trail-event"
                    data-kind={event.kind}
                    data-marked={marked ? "true" : undefined}
                  >
                    <span
                      className={cn(
                        "absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full text-white",
                        style.dot,
                      )}
                      aria-hidden="true"
                    >
                      <Mark className="h-3.5 w-3.5" />
                    </span>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className={cn("text-sm font-semibold", style.text)}>{trailKindLabel(event, tt)}</span>
                      {event.submission !== null && (
                        <span className="text-xs text-muted-foreground">{t("submission", { n: event.submission })}</span>
                      )}
                      <time className="text-xs text-muted-foreground" dateTime={event.at}>
                        {formatWhen(event.at, locale)}
                      </time>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {event.actor === null
                        ? t("system")
                        : [event.actor.name ?? t("removedUser"), event.actor.role ? tRoles(`roles.${event.actor.role}`) : null]
                            .filter(Boolean)
                            .join(" · ")}
                    </p>
                    {marked && <p className="text-xs font-medium text-primary">{t("marked")}</p>}
                    {event.reason && (
                      <p className="mt-1 text-sm" data-testid="record-trail-reason">
                        {t("reason", { reason: event.reason })}
                      </p>
                    )}
                    {event.kind === "edited" && event.changes.length === 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">{t("noChanges")}</p>
                    )}
                    {event.changes.length > 0 && (
                      <table className="mt-2 w-full text-xs" data-testid="record-trail-changes">
                        <thead>
                          <tr className="text-left text-muted-foreground">
                            <th className="font-normal pr-2" scope="col">
                              <span className="sr-only">{t("subtitle")}</span>
                            </th>
                            <th className="font-normal pr-2" scope="col">{t("before")}</th>
                            <th className="font-normal" scope="col">{t("after")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {event.changes.map((change) => {
                            const shown = formatTrailChange(change.field, change.before, change.after, {
                              t: tt,
                              locale,
                              words,
                              root: tRoot as unknown as TrailTranslator,
                            });
                            return (
                              <tr key={change.field} data-testid="record-trail-change" data-field={change.field}>
                                <th scope="row" className="pr-2 text-left font-medium align-top">
                                  {trailFieldLabel(change.field, tt)}
                                </th>
                                <td className="pr-2 font-mono align-top line-through decoration-muted-foreground/50">
                                  {shown.before}
                                </td>
                                <td className="font-mono align-top">{shown.after}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
