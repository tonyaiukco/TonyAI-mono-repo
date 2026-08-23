'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  duplicateNote,
  duplicatedMonths,
  reviewSentence,
  shortfallReasons,
  slotState,
  SHORT_MONTH,
  SLOT_DESCRIPTION,
  SLOT_GLYPH,
  type SlotState,
} from '@/lib/completeness-view';
import type { Category, SubsidiaryCompletenessDTO } from '@/lib/types';

interface InvoiceCoverageGridProps {
  subsidiaryId: string;
  subsidiaryName: string;
  reportingYear: number;
  /** False for a seat the API refuses writes from (`consultant`,
   *  `executive_viewer`). The grid still SHOWS what is missing — that is the
   *  point of the panel for a reviewer — but it stops inviting a click that
   *  ends in a 403 two screens later. */
  canEnter: boolean;
  /** Called when an OPEN slot is clicked, so the caller can route to Data Entry
   *  with the location and month already chosen. */
  onSlotClick: (params: {
    category: Category;
    locationId: string;
    month: string;
  }) => void;
}

/**
 * Which invoices are in and which are missing, per location and month
 * (round-1 UAT DASH-3: "reveal what is keyed in, what is missing").
 *
 * One category at a time, chosen with the chips above the grid. Three
 * categories at once would be 3 × locations × 12 cells in a 450px drawer —
 * everything visible and nothing readable. Switching a chip is free: the whole
 * year for all three categories arrives in one response.
 */
export function InvoiceCoverageGrid({
  subsidiaryId,
  subsidiaryName,
  reportingYear,
  canEnter,
  onSlotClick,
}: InvoiceCoverageGridProps) {
  const [data, setData] = useState<SubsidiaryCompletenessDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Category | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .completeness({ subsidiaryId, year: reportingYear })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setSelected(d.categories[0]?.category ?? null);
      })
      // Not an empty grid. A failed fetch and "nothing is missing" look
      // identical rendered as zero rows, and on this panel that is the
      // difference between "you are done" and "we could not check".
      .catch((e) =>
        !cancelled &&
        setError(
          e instanceof ApiError
            ? e.message
            : 'Could not load the invoice breakdown.',
        ),
      );
    return () => {
      cancelled = true;
    };
  }, [subsidiaryId, reportingYear]);

  if (error) {
    return (
      <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        {error}
      </p>
    );
  }

  if (!data) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  // Defensive, and deliberately terse: `SubsidiaryDetail` only mounts this for
  // a location-measured subsidiary, so this branch is unreachable through the
  // UI. An earlier version filled it with advice about switching granularity —
  // naming a control that does not exist in the app and a precondition the API
  // does not have. A dead branch that lies is worse than a dead branch.
  if (data.categories.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {subsidiaryName} is measured as a whole company, so there is no
        per-location invoice breakdown.
      </p>
    );
  }

  const category = data.categories.find((c) => c.category === selected);
  const states: SlotState[] = category
    ? category.locations.flatMap((l) =>
        l.months.map((m) => slotState(m, category.companyLevelMonths)),
      )
    : [];
  const openSlots = states.filter((s) => s === 'open').length;
  const hasCompanyLevel = states.includes('company');
  const hasAwaiting = states.includes('awaiting');
  // Both surfaces build these sentences from one module, so the drill-down and
  // the Data Entry panel cannot describe the same rule differently.
  const reasons = category ? shortfallReasons(category, data.reportingYear) : [];
  // Why a category can read 24 of 24 and still not be finished. Without it the
  // grid explains every kind of shortfall except the one the review gate
  // introduced, and that cell's amber has no account anywhere on screen.
  // Slots when months are waiting, records otherwise. The second arm is the one
  // a slot count cannot reach: every month closed and accepted, with a
  // whole-company record behind them still unreviewed.
  const note = category ? reviewSentence(category) : null;
  if (note) reasons.push(note);
  // A month held BOTH at a site and company-wide renders as a plain ✓ — the
  // slot is closed — so `hasCompanyLevel` goes false and the "would count this
  // month twice" line below disappears. That is precisely backwards: the
  // warning vanished at the moment the double count actually happened. This
  // says so in the present tense instead.
  const dupes = category ? duplicateNote(duplicatedMonths(category)) : null;
  if (dupes) reasons.push(dupes);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {data.categories.map((c) => {
          const active = c.category === selected;
          return (
            <button
              key={c.category}
              onClick={() => setSelected(c.category)}
              aria-pressed={active}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-secondary/60',
              )}
            >
              {c.category}{' '}
              <span className="font-mono tabular-nums">
                {c.covered}/{c.required}
              </span>
            </button>
          );
        })}
      </div>

      {category && (
        <>
          <ScrollArea className="w-full">
            <div className="min-w-[420px] space-y-1">
              <div className="grid grid-cols-[96px_repeat(12,1fr)] gap-0.5">
                <span />
                {category.locations[0]?.months.map((m) => (
                  <span
                    key={m.month}
                    className="text-center text-[10px] font-medium text-muted-foreground"
                  >
                    {SHORT_MONTH(m.month)}
                  </span>
                ))}
              </div>

              {category.locations.map((loc) => (
                <div
                  key={loc.locationId}
                  className="grid grid-cols-[120px_repeat(12,1fr)] items-center gap-1"
                >
                  <span
                    className="truncate pr-1 text-xs font-medium text-foreground"
                    title={loc.locationName}
                  >
                    {loc.locationName}
                  </span>
                  {loc.months.map((m) => {
                    // Four states, not two. A month already recorded for the
                    // WHOLE COMPANY closes no site slot — but inviting the user
                    // to key a site invoice for it produces a second row for
                    // that month, and BOTH feed the emissions total. The
                    // uniqueness index cannot stop it (different location id)
                    // and nothing downstream deduplicates, so the only thing
                    // standing between a tester and a double-counted month is
                    // this screen saying so. The fourth is round-1 DE-2: an
                    // invoice sitting in a review queue is in, but not accepted,
                    // and must not render identically to one that is.
                    const state = slotState(m, category.companyLevelMonths);
                    const description = SLOT_DESCRIPTION[state];
                    return (
                      <button
                        key={m.month}
                        disabled={state !== 'open' || !canEnter}
                        onClick={() =>
                          onSlotClick({
                            category: category.category,
                            locationId: loc.locationId,
                            month: m.month,
                          })
                        }
                        aria-label={`${loc.locationName} ${m.month}: ${description}`}
                        title={description}
                        className={cn(
                          'flex h-5 items-center justify-center rounded-[3px] border text-[9px] font-bold leading-none transition-colors',
                          state === 'accepted' &&
                            'cursor-default border-status-complete-text/40 bg-status-complete-bg text-status-complete-text',
                          (state === 'company' || state === 'awaiting') &&
                            'cursor-default border-status-incomplete-text/40 bg-status-incomplete-bg text-status-incomplete-text',
                          state === 'open' &&
                            'border-status-missing-text/40 bg-status-missing-bg text-status-missing-text hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                        )}
                      >
                        {/* Never colour alone: at 20px with no text this panel
                            is unreadable in greyscale or with low vision, and
                            the palette's own tints sit near 1.2:1 on white.
                            `awaiting` and `company` share the amber tokens but
                            never the glyph — they mean different work. */}
                        {SLOT_GLYPH[state]}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border border-status-complete-text/40 bg-status-complete-bg text-[8px] font-bold text-status-complete-text">
                {SLOT_GLYPH.accepted}
              </span>
              invoice attached and approved
            </span>
            <span className="flex items-center gap-1">
              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border border-status-missing-text/40 bg-status-missing-bg text-[8px] font-bold text-status-missing-text">
                {SLOT_GLYPH.open}
              </span>
              missing
            </span>
            {hasAwaiting && (
              <span className="flex items-center gap-1">
                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border border-status-incomplete-text/40 bg-status-incomplete-bg text-[8px] font-bold text-status-incomplete-text">
                  {SLOT_GLYPH.awaiting}
                </span>
                waiting for review
              </span>
            )}
            {hasCompanyLevel && (
              <span className="flex items-center gap-1">
                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border border-status-incomplete-text/40 bg-status-incomplete-bg text-[8px] font-bold text-status-incomplete-text">
                  {SLOT_GLYPH.company}
                </span>
                already recorded company-wide
              </span>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground">
            One invoice per site per month.
            {canEnter && openSlots > 0 && ' Click a missing month to enter it.'}
            {hasCompanyLevel &&
              ' Months marked ◆ are already recorded for the whole company — entering them again per site would count that month twice.'}
          </p>

          {/* The counters, in words.
              Built as STRINGS, not as JSX text: `{expr}` followed by a newline
              loses the separator, and this exact list shipped reading
              "12 entries arerecorded" twice — once before review caught it and
              once after I rewrote the lines. Strings have no whitespace rules. */}
          {reasons.length > 0 && (
            <ul className="space-y-1 border-t border-border pt-2 text-[11px] text-muted-foreground">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
