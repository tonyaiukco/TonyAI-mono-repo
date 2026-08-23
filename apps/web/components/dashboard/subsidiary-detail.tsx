'use client';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import type { Category, DataStatus, TrackingMatrixRow } from '@/lib/types';
import { InvoiceCoverageGrid } from './invoice-coverage-grid';
import { reviewBadge } from '@/lib/completeness-view';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Building2,
  Factory,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Clock,
  User,
  FileText,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';

interface SubsidiaryDetailProps {
  /** The matrix row, not the mock view model — the invoice grid needs
   *  `trackingGranularity` and the per-cell `coverage`, both of which
   *  `matrixToSubsidiaries` drops. */
  row: TrackingMatrixRow | null;
  /** Null when the matrix was fetched without a year; the invoice rule is
   *  per-year, so the grid is not offered in that case. */
  reportingYear: number | null;
  open: boolean;
  onClose: () => void;
  /** Whether this seat may create activity records at all. */
  canEnter?: boolean;
  /** Route to Data Entry for one open slot (location + month + category). */
  onSlotClick?: (params: {
    subsidiaryId: string;
    category: Category;
    locationId: string;
    month: string;
  }) => void;
}

// TonyAI Premium Status Colors
const STATUS_COLORS = {
  complete: { 
    bg: '#A9D8B8', 
    text: '#2F6B45',
    bgLight: 'bg-[#A9D8B8]/20',
  },
  incomplete: { 
    bg: '#F6DFA1', 
    text: '#8A641C',
    bgLight: 'bg-[#F6DFA1]/20',
  },
  missing: { 
    bg: '#F2B8B5', 
    text: '#8A3D3B',
    bgLight: 'bg-[#F2B8B5]/20',
  },
};

const statusConfig: Record<DataStatus, { 
  icon: React.ElementType; 
  color: string;
  label: string;
  bgClass: string;
}> = {
  complete: { 
    icon: CheckCircle2, 
    color: STATUS_COLORS.complete.text, 
    label: 'Complete',
    bgClass: STATUS_COLORS.complete.bgLight,
  },
  incomplete: { 
    icon: AlertCircle, 
    color: STATUS_COLORS.incomplete.text, 
    label: 'Incomplete',
    bgClass: STATUS_COLORS.incomplete.bgLight,
  },
  missing: { 
    icon: XCircle, 
    color: STATUS_COLORS.missing.text, 
    label: 'Missing',
    bgClass: STATUS_COLORS.missing.bgLight,
  },
};

export function SubsidiaryDetail({ row, reportingYear, open, onClose, canEnter = false, onSlotClick }: SubsidiaryDetailProps) {
  if (!row) return null;

  const completionRate = Math.round((row.completeCount / row.categoryCount) * 100);
  const totalCalculated = row.cells.filter((c) => c.tCo2e !== null).length;
  const byLocation = row.trackingGranularity === 'location';

  const getCompletionColor = (rate: number) => {
    if (rate >= 75) return STATUS_COLORS.complete.text;
    if (rate >= 50) return STATUS_COLORS.incomplete.text;
    return STATUS_COLORS.missing.text;
  };

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="w-full border-border bg-white sm:max-w-[450px]">
        <SheetHeader className="space-y-4">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <Building2 className="h-6 w-6 text-primary" />
            </div>
            <div className="flex-1">
              <SheetTitle className="text-xl text-foreground">{row.subsidiaryName}</SheetTitle>
              <SheetDescription className="flex items-center gap-2 text-muted-foreground">
                <span>{row.sector ?? '—'}</span>
                <span>•</span>
                <span>
                  {byLocation
                    ? `Measured per location · ${row.locationCount} ${row.locationCount === 1 ? 'site' : 'sites'}`
                    : 'Measured as a whole company'}
                </span>
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <ScrollArea className="mt-6 h-[calc(100vh-180px)] pr-4">
          <div className="space-y-6">
            {/* Overall Progress */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">Overall Completion</span>
                <span 
                  className="text-sm font-semibold font-mono"
                  style={{ color: getCompletionColor(completionRate) }}
                >
                  {completionRate}%
                </span>
              </div>
              <Progress value={completionRate} className="h-2.5" />
            </div>

            {/* Quick Stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border bg-secondary/50 p-4">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Factory className="h-4 w-4" />
                  <span className="text-xs">Total Emissions</span>
                </div>
                <p className="mt-1.5 text-lg font-semibold text-foreground font-mono">
                  {row.totalTCo2e.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                  <span className="ml-1 text-xs font-normal text-muted-foreground font-sans">tCO₂e</span>
                </p>
              </div>
              <div className="rounded-xl border border-border bg-secondary/50 p-4">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4" />
                  <span className="text-xs">Calculated</span>
                </div>
                <p className="mt-1.5 text-lg font-semibold text-foreground font-mono">
                  {totalCalculated}
                  <span className="ml-1 text-xs font-normal text-muted-foreground font-sans">
                    / {row.categoryCount} categories
                  </span>
                </p>
              </div>
            </div>

            <Separator className="bg-border" />

            {/* Category Breakdown */}
            <div className="space-y-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <FileText className="h-4 w-4" />
                Category Status
              </h3>
              <div className="space-y-2">
                {row.cells.map((cat) => {
                  const config = statusConfig[cat.status];
                  const Icon = config.icon;
                  // Same unit the cell tooltip and the drill-down chose.
                  const awaiting = reviewBadge({
                    awaitingReviewSlots: cat.coverage?.awaitingReviewSlots,
                    awaitingReviewRecords: cat.awaitingReviewRecords,
                  });
                  
                  return (
                    <div
                      key={cat.category}
                      className="flex items-center justify-between rounded-xl border border-border bg-white p-3.5 hover:bg-secondary/30 transition-colors duration-150"
                    >
                      <div className="flex items-center gap-3">
                        <Icon className="h-4 w-4" style={{ color: config.color }} />
                        <div>
                          <p className="text-sm font-medium text-foreground">{cat.category}</p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <User className="h-3 w-3" />
                            <span>{row.designatedPerson ?? '—'}</span>
                            {cat.lastUpdate && (
                              <>
                                <span>•</span>
                                <Clock className="h-3 w-3" />
                                <span>
                                  {formatDistanceToNow(new Date(cat.lastUpdate), { addSuffix: true })}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        {cat.coverage ? (
                          <div>
                            <p className="text-sm font-semibold text-foreground font-mono tabular-nums">
                              {cat.coverage.covered}/{cat.coverage.required}
                            </p>
                            <p className="text-[10px] text-muted-foreground">invoices</p>
                          </div>
                        ) : cat.tCo2e !== null ? (
                          <div>
                            <p className="text-sm font-semibold text-primary font-mono">
                              {Math.round(cat.tCo2e).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                            </p>
                            <p className="text-[10px] text-muted-foreground">tCO₂e</p>
                          </div>
                        ) : (
                          <Badge 
                            variant="outline" 
                            className={cn('text-[10px] rounded-lg border-0', config.bgClass)}
                            style={{ color: config.color }}
                          >
                            {config.label}
                          </Badge>
                        )}
                        {/* The verdict beside it may read Partial for a
                            category whose data is entirely keyed in — WP19 —
                            and this is the only place in the drawer that can
                            say which of the two it is. */}
                        {awaiting && (
                          <p className="mt-1 text-[10px] font-medium text-[#92400E]">
                            {awaiting}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <Separator className="bg-border" />

            {/* Which invoices are in, and which are missing (round-1 DASH-3).
                Only offered for a location-measured subsidiary on a year-scoped
                matrix — the rule is `locations × 12 months` for ONE year, and
                offering a grid the numbers cannot support would be worse than
                offering none. */}
            {byLocation && reportingYear !== null && (
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <AlertCircle
                    className="h-4 w-4"
                    style={{ color: STATUS_COLORS.incomplete.text }}
                  />
                  Invoices by site and month
                </h3>
                <InvoiceCoverageGrid
                  subsidiaryId={row.subsidiaryId}
                  subsidiaryName={row.subsidiaryName}
                  reportingYear={reportingYear}
                  canEnter={canEnter}
                  onSlotClick={({ category, locationId, month }) =>
                    onSlotClick?.({
                      subsidiaryId: row.subsidiaryId,
                      category,
                      locationId,
                      month,
                    })
                  }
                />
              </div>
            )}

          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
