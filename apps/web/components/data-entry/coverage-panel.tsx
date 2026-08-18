'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, ClipboardList, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  deriveEntryCoverage,
  SLOT_DESCRIPTION,
  SLOT_GLYPH,
  type SlotState,
} from '@/lib/completeness-view';
import type { SubsidiaryCompletenessDTO } from '@/lib/types';

interface CoveragePanelProps {
  subsidiaryId: string;
  reportingYear: number;
  category: string;
  /** The form's location field; `""` is "Whole subsidiary". */
  locationId: string;
  reportingPeriod: string;
  periodValue: string;
  /**
   * Bumped by the page after a successful save or submit.
   *
   * Without it the panel keeps showing the fraction from before the entry that
   * was just keyed — the one moment a user is looking straight at it for
   * confirmation, and the one moment it would be wrong.
   */
  refreshKey: number;
}

/** Three letters is all a twelve-column strip has room for. */
const SHORT_MONTH = (month: string) => month.slice(0, 3);

const TONE_CLASS = {
  complete: 'border-status-complete-text/30 bg-status-complete-bg text-status-complete-text',
  incomplete:
    'border-status-incomplete-text/30 bg-status-incomplete-bg text-status-incomplete-text',
  missing: 'border-status-missing-text/30 bg-status-missing-bg text-status-missing-text',
} as const;

const SLOT_CLASS: Record<SlotState, string> = {
  accepted: 'border-status-complete-text/40 bg-status-complete-bg text-status-complete-text',
  awaiting:
    'border-status-incomplete-text/40 bg-status-incomplete-bg text-status-incomplete-text',
  company:
    'border-status-incomplete-text/40 bg-status-incomplete-bg text-status-incomplete-text',
  open: 'border-status-missing-text/40 bg-status-missing-bg text-status-missing-text',
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          Data collection status
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * Whether this subsidiary's year is actually finished — round-1 UAT **DE-2**.
 *
 * The tester's complaint was that submitting for review turned the status green
 * straight away. Two separate things were wrong behind that: the denominator
 * ignored the subsidiary's other sites (fixed in PRs 2–3), and a record nobody
 * had reviewed still counted as a closed invoice (fixed alongside this panel).
 * So the panel deliberately reports THREE numbers rather than a single colour —
 * how many invoices the year needs, how many are keyed in, and how many of
 * those anyone has accepted.
 *
 * It reads the same endpoint as the dashboard drill-down and derives its
 * sentences from the same module, so the two screens cannot tell a user
 * different things about the same subsidiary.
 */
export function CoveragePanel({
  subsidiaryId,
  reportingYear,
  category,
  locationId,
  reportingPeriod,
  periodValue,
  refreshKey,
}: CoveragePanelProps) {
  const [data, setData] = useState<SubsidiaryCompletenessDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!subsidiaryId) return;
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .completeness({ subsidiaryId, year: reportingYear })
      .then((d) => !cancelled && setData(d))
      // A failed fetch and "nothing is missing" must not look alike. Rendered as
      // an empty panel they do, and on this card that is the difference between
      // "you are done" and "we could not check".
      .catch((e) =>
        !cancelled &&
        setError(
          e instanceof ApiError
            ? e.message
            : 'Could not load the collection status.',
        ),
      );
    return () => {
      cancelled = true;
    };
  }, [subsidiaryId, reportingYear, refreshKey]);

  if (!subsidiaryId) return null;

  if (error) {
    return (
      <Shell>
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {error}
        </p>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell>
        <div className="space-y-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-full" />
        </div>
      </Shell>
    );
  }

  const view = deriveEntryCoverage({
    data,
    category,
    locationId,
    reportingPeriod,
    periodValue,
  });

  if (view.kind !== 'tracked') {
    // Each of these is "the invoice rule does not apply here", and each needs
    // its own sentence. A shared "0 of 0" would read as failure on a subsidiary
    // that is simply not measured per site.
    const message =
      view.kind === 'whole_company'
        ? 'This subsidiary is measured as a whole company, so there are no per-site invoice targets to complete.'
        : view.kind === 'no_locations'
          ? `No site of this subsidiary existed at the end of ${view.year}, so there are no invoices to track for that year.`
          : `${view.category} is not tracked by invoice. Only Electricity, Natural Gas and Water are counted one invoice per site per month.`;
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">{message}</p>
      </Shell>
    );
  }

  const tone =
    view.status === 'complete'
      ? 'complete'
      : view.covered === 0
        ? 'missing'
        : 'incomplete';
  const label = {
    complete: 'Complete',
    awaiting_review: 'Awaiting review',
    in_progress: 'In progress',
  }[view.status];

  // Built as a string. Written as JSX text with `{view.covered}` on its own
  // line, the separating space collapses and it renders "12 of 24 invoices
  // arekeyed in" — this exact bug shipped twice in PR 3.
  const acceptedLine = `${view.accepted} of those approved${
    view.awaitingReview > 0 ? `, ${view.awaitingReview} waiting for review` : ''
  }.`;

  return (
    <Shell>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs font-medium',
              TONE_CLASS[tone],
            )}
          >
            {label}
          </span>
          <span className="font-mono text-sm tabular-nums text-foreground">
            {view.covered}/{view.required}
          </span>
        </div>

        <div>
          <p className="text-sm text-foreground">{view.headline}</p>
          <p className="text-xs text-muted-foreground">{acceptedLine}</p>
        </div>

        {view.warnings.map((w) => (
          <p
            key={w}
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-900"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{w}</span>
          </p>
        ))}

        {view.selected && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">
              {view.selected.locationName}
            </p>
            <div className="grid grid-cols-12 gap-0.5">
              {view.selected.months.map((m) => (
                <span
                  key={m.month}
                  title={`${m.month}: ${SLOT_DESCRIPTION[m.state]}`}
                  aria-label={`${m.month}: ${SLOT_DESCRIPTION[m.state]}`}
                  className={cn(
                    'flex h-5 items-center justify-center rounded-[3px] border text-[9px] font-bold leading-none',
                    SLOT_CLASS[m.state],
                  )}
                >
                  {SLOT_GLYPH[m.state]}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-12 gap-0.5">
              {view.selected.months.map((m) => (
                <span
                  key={m.month}
                  aria-hidden
                  className="text-center text-[9px] text-muted-foreground"
                >
                  {SHORT_MONTH(m.month)}
                </span>
              ))}
            </div>
          </div>
        )}

        {view.reasons.length > 0 && (
          <ul className="space-y-1">
            {view.reasons.map((r) => (
              <li key={r} className="flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Shell>
  );
}
