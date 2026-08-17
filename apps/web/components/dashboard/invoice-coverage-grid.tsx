'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
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

/** "1 entry" / "3 entries" — the count needs its noun, and its plural. */
const entries = (n: number) => `${n} ${n === 1 ? 'entry is' : 'entries are'}`;

/** Three letters is enough to read a twelve-column header at this width. */
const SHORT_MONTH = (month: string) => month.slice(0, 3);

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
  const slots = category?.locations.flatMap((l) => l.months) ?? [];
  const openSlots = slots.filter(
    (m) =>
      !m.covered &&
      !category?.companyLevelMonths.includes(m.month.toLowerCase()),
  ).length;
  const hasCompanyLevel = (category?.companyLevelMonths.length ?? 0) > 0;
  const reasons: string[] = [];
  if (category) {
    if (category.unattributedRecords > 0) {
      reasons.push(
        `${entries(category.unattributedRecords)} recorded for the whole company rather than a site, so they close no site's month.`,
      );
    }
    if (category.outOfScopeRecords > 0) {
      reasons.push(
        `${entries(category.outOfScopeRecords)} at a site that did not exist yet at the end of ${data.reportingYear}, so there is no row above for them.`,
      );
    }
    if (category.nonMonthlyRecords > 0) {
      reasons.push(
        `${entries(category.nonMonthlyRecords)} not reported as a single month, so none of them stands in for a monthly invoice.`,
      );
    }
    if (category.missingEvidenceRecords > 0) {
      reasons.push(`${entries(category.missingEvidenceRecords)} with no invoice attached.`);
    }
  }

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
                    // Three states, not two. A month already recorded for the
                    // WHOLE COMPANY closes no site slot — but inviting the user
                    // to key a site invoice for it produces a second row for
                    // that month, and BOTH feed the emissions total. The
                    // uniqueness index cannot stop it (different location id)
                    // and nothing downstream deduplicates, so the only thing
                    // standing between a tester and a double-counted month is
                    // this screen saying so.
                    const atCompanyLevel =
                      !m.covered &&
                      category.companyLevelMonths.includes(m.month.toLowerCase());
                    const state = m.covered
                      ? 'covered'
                      : atCompanyLevel
                        ? 'company'
                        : 'open';
                    const description = {
                      covered: 'invoice attached',
                      company: 'recorded for the whole company — entering a site invoice would count this month twice',
                      open: 'missing',
                    }[state];
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
                          state === 'covered' &&
                            'cursor-default border-status-complete-text/40 bg-status-complete-bg text-status-complete-text',
                          state === 'company' &&
                            'cursor-default border-status-incomplete-text/40 bg-status-incomplete-bg text-status-incomplete-text',
                          state === 'open' &&
                            'border-status-missing-text/40 bg-status-missing-bg text-status-missing-text hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                        )}
                      >
                        {/* Never colour alone: at 20px with no text this panel
                            is unreadable in greyscale or with low vision, and
                            the palette's own tints sit near 1.2:1 on white. */}
                        {state === 'covered' ? '✓' : state === 'company' ? '◆' : '·'}
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
                ✓
              </span>
              invoice attached
            </span>
            <span className="flex items-center gap-1">
              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border border-status-missing-text/40 bg-status-missing-bg text-[8px] font-bold text-status-missing-text">
                ·
              </span>
              missing
            </span>
            {hasCompanyLevel && (
              <span className="flex items-center gap-1">
                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border border-status-incomplete-text/40 bg-status-incomplete-bg text-[8px] font-bold text-status-incomplete-text">
                  ◆
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
