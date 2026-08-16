'use client';

import type { DataStatus, TrackingMatrixCell } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatDistanceToNow } from 'date-fns';

interface StatusCellProps {
  /**
   * The API's cell, not the mock-era `CategoryData` it used to take.
   *
   * WP17 gave the cell `coverage`, `recordCount` and `uncalculatedRecordCount`,
   * and all three died at `lib/dashboard-view.ts`, which maps the real DTO onto
   * a view model designed before any of this existed. Adding parallel fields to
   * that model would have meant paying the same tax again for every field the
   * rule grows.
   */
  cell: TrackingMatrixCell;
  /** Row-level, so it stays a prop rather than being copied onto every cell. */
  responsible: string;
  onClick?: () => void;
  compact?: boolean;
  /** Identity part of the accessible name (subsidiary + category). The status
   *  and value are appended here, because the button's visible content is a
   *  colour and a number: without this it announces as an unnamed button, and a
   *  label carrying only the identity would still hide the status the cell
   *  exists to convey. */
  label?: string;
}

// Apple-style status colors
const statusConfig: Record<DataStatus, {
  bg: string;
  hoverBg: string;
  text: string;
  label: string;
  dotColor: string;
  badgeBg: string;
  badgeText: string;
}> = {
  complete: {
    bg: 'bg-[#D1F2EB]',
    hoverBg: 'hover:bg-[#B8E9DD]',
    text: 'text-[#1D7A5F]',
    label: 'Complete',
    dotColor: 'bg-[#34C759]',
    badgeBg: 'bg-[#D1F2EB]',
    badgeText: 'text-[#1D7A5F]',
  },
  incomplete: {
    bg: 'bg-[#FEF3C7]',
    hoverBg: 'hover:bg-[#FDE68A]',
    text: 'text-[#92400E]',
    label: 'Partial',
    dotColor: 'bg-[#FF9500]',
    badgeBg: 'bg-[#FEF3C7]',
    badgeText: 'text-[#92400E]',
  },
  missing: {
    bg: 'bg-[#FEE2E2]',
    hoverBg: 'hover:bg-[#FECACA]',
    text: 'text-[#B91C1C]',
    label: 'Missing',
    dotColor: 'bg-[#FF3B30]',
    badgeBg: 'bg-[#FEE2E2]',
    badgeText: 'text-[#B91C1C]',
  },
};

function formatEmission(value: number): string {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return value.toString();
}

/**
 * Why an invoice-tracked cell is short, in the user's terms.
 *
 * Built from the four counters the API returns precisely so this can be said
 * rather than guessed. They exhaust the committed records, so a reader can
 * always reconcile "N records exist" with "M invoices counted" — which is the
 * difference between understanding the shortfall and assuming the app lost
 * data.
 */
function shortfallReasons(cell: TrackingMatrixCell): string[] {
  const c = cell.coverage;
  if (!c) return [];
  const reasons: string[] = [];
  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  if (c.unattributedRecords > 0) {
    reasons.push(
      `${plural(c.unattributedRecords, 'entry is', 'entries are')} recorded for the whole company, not a site`,
    );
  }
  if (c.nonMonthlyRecords > 0) {
    reasons.push(
      `${plural(c.nonMonthlyRecords, 'entry is', 'entries are')} not monthly — one invoice per month is expected`,
    );
  }
  if (c.missingEvidenceRecords > 0) {
    reasons.push(
      `${plural(c.missingEvidenceRecords, 'entry has', 'entries have')} no invoice attached`,
    );
  }
  return reasons;
}

export function StatusCell({
  cell,
  responsible,
  onClick,
  compact = false,
  label,
}: StatusCellProps) {
  const config = statusConfig[cell.status];
  const hasEmission = cell.tCo2e !== null;
  const emission = cell.tCo2e === null ? null : Math.round(cell.tCo2e);
  const coverage = cell.coverage;
  const reasons = shortfallReasons(cell);

  // On an invoice-tracked cell the fraction IS the status, so it takes the
  // cell face and the tonnage moves into the tooltip. A cell showing "818"
  // where the answer is "3 of 24 invoices" answers a question nobody asked.
  const faceText = coverage
    ? `${coverage.covered}/${coverage.required}`
    : hasEmission
      ? formatEmission(emission!)
      : null;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onClick}
            // The identity stays the PREFIX. Three E2E selectors match this by
            // substring (`getByRole('button', {name: 'TonyAI Energy Fuel'})`),
            // so anything appended is safe and anything prepended is not.
            aria-label={
              label
                ? `${label}: ${config.label}${
                    coverage
                      ? `, ${coverage.covered} of ${coverage.required} invoices`
                      : hasEmission
                        ? `, ${formatEmission(emission!)} tCO2e`
                        : ''
                  }`
                : undefined
            }
            className={cn(
              'relative flex items-center justify-center rounded-lg transition-all duration-200',
              'focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40 focus:ring-offset-2',
              config.bg,
              config.hoverBg,
              compact ? 'h-10 w-full min-w-[72px]' : 'h-12 w-full min-w-[84px]'
            )}
          >
            {faceText !== null ? (
              <span className={cn(
                'font-mono font-bold tabular-nums',
                config.text,
                compact ? 'text-sm' : 'text-base'
              )}>
                {faceText}
              </span>
            ) : (
              <div className={cn(
                'rounded-full',
                config.dotColor,
                compact ? 'h-3.5 w-3.5' : 'h-4 w-4'
              )} />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-xs border-[#D2D2D7] bg-white shadow-xl p-0 overflow-hidden rounded-xl"
          sideOffset={8}
        >
          <div className={cn(
            'px-4 py-3 border-b border-[#E5E5EA]',
            config.bg
          )}>
            <div className="flex items-center justify-between gap-4">
              <span className="font-bold text-[#1D1D1F]">{cell.category}</span>
              <span className={cn(
                'text-xs font-bold px-2.5 py-1 rounded-full',
                config.badgeBg,
                config.badgeText
              )}>
                {config.label}
              </span>
            </div>
          </div>

          <div className="p-4 space-y-3 text-sm bg-white">
            {coverage && (
              <div className="flex items-baseline justify-between">
                <span className="font-medium text-[#6E6E73]">Invoices</span>
                <span className="font-bold text-[#1D1D1F] font-mono text-base">
                  {coverage.covered}
                  <span className="text-[#6E6E73] text-xs font-medium">
                    {' '}of {coverage.required}
                  </span>
                </span>
              </div>
            )}

            {hasEmission && (
              <div className="flex items-baseline justify-between">
                <span className="font-medium text-[#6E6E73]">Emissions</span>
                <span className="font-bold text-[#1D1D1F] font-mono text-base">
                  {emission!.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} <span className="text-[#6E6E73] text-xs font-medium">tCO₂e</span>
                </span>
              </div>
            )}

            {/* Stated, not implied. A cell can hold committed records worth real
                tonnes and still be short of its invoices, and without this line
                the two facts look like a contradiction. */}
            {coverage && cell.recordCount > 0 && (
              <div className="flex justify-between">
                <span className="font-medium text-[#6E6E73]">Entries</span>
                <span className="font-semibold text-[#1D1D1F]">{cell.recordCount}</span>
              </div>
            )}

            <div className="flex justify-between">
              <span className="font-medium text-[#6E6E73]">Owner</span>
              <span className="font-semibold text-[#1D1D1F]">{responsible}</span>
            </div>

            {cell.lastUpdate && (
              <div className="flex justify-between">
                <span className="font-medium text-[#6E6E73]">Updated</span>
                <span className="font-semibold text-[#1D1D1F]">
                  {formatDistanceToNow(new Date(cell.lastUpdate), { addSuffix: true })}
                </span>
              </div>
            )}

            {reasons.length > 0 && (
              <div className="pt-3 mt-3 border-t border-[#E5E5EA] space-y-1">
                {reasons.map((reason) => (
                  <p key={reason} className="text-[#92400E] text-xs font-medium">
                    {reason}
                  </p>
                ))}
              </div>
            )}

            {/* An entry with no emission factor is not a gap in the data — it is
                a gap in the factor library, and the two must not read alike. */}
            {cell.uncalculatedRecordCount > 0 && (
              <p className="text-xs text-[#6E6E73]">
                {cell.uncalculatedRecordCount}{' '}
                of these produced no tCO₂e figure — no emission factor is
                available for this category yet.
              </p>
            )}

            <p className="text-sm text-[#007AFF] font-medium pt-1">Click to view details</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
