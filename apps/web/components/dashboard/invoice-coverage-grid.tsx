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
  /** Called when an OPEN slot is clicked, so the caller can route to Data Entry
   *  with the location and month already chosen. */
  onSlotClick: (params: {
    category: Category;
    locationId: string;
    month: string;
  }) => void;
}

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

  // A subsidiary measured as a whole has no per-location slots — say which of
  // the two it is, rather than rendering an empty table that reads as "nothing
  // is missing".
  if (data.categories.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {subsidiaryName} is measured as a whole company, so there is no
        per-location invoice breakdown. A super_admin can switch it to
        location-level tracking once its data is keyed in by site.
      </p>
    );
  }

  const category = data.categories.find((c) => c.category === selected);

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
            <div className="min-w-[560px] space-y-1">
              <div className="grid grid-cols-[120px_repeat(12,1fr)] gap-1">
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
                  {loc.months.map((m) => (
                    <button
                      key={m.month}
                      disabled={m.covered}
                      onClick={() =>
                        onSlotClick({
                          category: category.category,
                          locationId: loc.locationId,
                          month: m.month,
                        })
                      }
                      // The covered ones are a record of what is done, not a
                      // control: there is nothing to go and do about them.
                      aria-label={`${loc.locationName} ${m.month}: ${
                        m.covered ? 'invoice attached' : 'missing'
                      }`}
                      className={cn(
                        'h-5 rounded-sm transition-colors',
                        m.covered
                          ? 'cursor-default bg-[#34C759]/70'
                          : 'bg-[#FEE2E2] hover:bg-[#FECACA] focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40',
                      )}
                    />
                  ))}
                </div>
              ))}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>

          <p className="text-[11px] text-muted-foreground">
            One invoice per site per month. Click a missing month to enter it.
          </p>

          {/* The counters, in words. Without them a user reading "0 of 24"
              beside twelve existing entries has every reason to think the app
              lost their data. */}
          {(category.unattributedRecords > 0 ||
            category.nonMonthlyRecords > 0 ||
            category.missingEvidenceRecords > 0) && (
            <ul className="space-y-1 border-t border-border pt-2 text-[11px] text-muted-foreground">
              {category.unattributedRecords > 0 && (
                <li>
                  {category.unattributedRecords}{' '}
                  recorded for the whole company rather than a site — those cannot count towards a site&apos;s
                  months.
                </li>
              )}
              {category.nonMonthlyRecords > 0 && (
                <li>
                  {category.nonMonthlyRecords}{' '}
                  not reported monthly — a quarterly entry cannot stand in for
                  three monthly invoices.
                </li>
              )}
              {category.missingEvidenceRecords > 0 && (
                <li>
                  {category.missingEvidenceRecords}{' '}
                  with no invoice attached.
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
