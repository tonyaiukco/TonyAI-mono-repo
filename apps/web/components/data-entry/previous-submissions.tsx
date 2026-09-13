"use client";

import { Ban, CheckCircle2, Clock, Send, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatTCo2e } from "@/lib/calculation-display";
import { isSubmittable } from "@/lib/types";
import type { ActivityRecordDTO, ActivityRecordStatus } from "@/lib/types";

/**
 * The record list beside the Data Entry form.
 *
 * Lifted out of `page.tsx` unchanged. It is not filtered by author or by
 * status on purpose: it is the surface WP18 left for resolving a
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
}

export function PreviousSubmissions({
  records,
  loading,
  onOpen,
}: PreviousSubmissionsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Previous submissions
        </CardTitle>
      </CardHeader>
      <CardContent>
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
              return (
                <button
                  key={r.id}
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
                        // so a bare `??` would label a site row
                        // "Whole subsidiary" if the include were ever
                        // dropped — a false claim on the one screen
                        // built to tell the two apart.
                        r.locationId
                          ? (r.locationName ?? "A site")
                          : "Whole subsidiary",
                        formatTCo2e(
                          r.calculation,
                          (v) => `${numberFmt.format(v)} tCO₂e`,
                        ),
                      ].join(" · ")}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
