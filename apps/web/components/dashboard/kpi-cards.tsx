'use client';

import { KPIData } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Building2, MapPin, ArrowUpRight, ArrowDownRight } from 'lucide-react';

interface KPICardsProps {
  data: KPIData;
}

function formatEmissions(value: number): string {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return value.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

interface EmissionsCardProps {
  label: string;
  value: number;
  /** null = no prior-period data yet; the trend badge shows "—". */
  trend: number | null;
  description: string;
  highlight?: boolean;
  scopeColor?: string;
}

function EmissionsCard({ label, value, trend, description, highlight = false, scopeColor }: EmissionsCardProps) {
  const isPositiveTrend = (trend ?? 0) > 0;
  const TrendIcon = isPositiveTrend ? ArrowUpRight : ArrowDownRight;

  return (
    <div className={cn(
      'rounded-xl border p-5 transition-all duration-200',
      highlight 
        ? 'bg-white border-primary/40 shadow-md' 
        : 'bg-white border-border hover:border-primary/30 hover:shadow-sm'
    )}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            {scopeColor && (
              <div className="h-3 w-3 rounded-full" style={{ backgroundColor: scopeColor }} />
            )}
            <p className="text-sm font-semibold text-[#1D1D1F]">{label}</p>
          </div>
          <div className="flex items-baseline gap-2 mt-3">
            <span className={cn(
              'text-4xl font-bold font-mono tabular-nums tracking-tight',
              highlight ? 'text-primary' : 'text-[#1D1D1F]'
            )}>
              {formatEmissions(value)}
            </span>
            <span className="text-sm font-medium text-[#6E6E73]">tCO₂e</span>
          </div>
          <p className="text-sm text-[#6E6E73] mt-2 font-medium">{description}</p>
        </div>
        {trend === null ? (
          <div
            className="flex items-center gap-1 rounded-full bg-[#F5F5F7] px-3 py-1.5 text-sm font-semibold text-[#8E8E93]"
            title="Year-over-year trend needs prior-year data"
          >
            <span>—</span>
          </div>
        ) : (
          <div className={cn(
            'flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-semibold',
            isPositiveTrend
              ? 'bg-[#FEE2E2] text-[#B91C1C]'
              : 'bg-[#D1F2EB] text-[#1D7A5F]'
          )}>
            <TrendIcon className="h-4 w-4" />
            <span>{Math.abs(trend).toFixed(1)}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface DataStatusCardProps {
  complete: number;
  partial: number;
  missing: number;
  subsidiaries: number;
  /** null until the locations backend ships (Phase 1). */
  locations: number | null;
  completionRate: number;
}

function DataStatusCard({ complete, partial, missing, subsidiaries, locations, completionRate }: DataStatusCardProps) {
  const total = complete + partial + missing;
  const completePercent = (complete / total) * 100;
  const partialPercent = (partial / total) * 100;
  
  return (
    <div className="rounded-xl border border-border bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <p className="text-base font-semibold text-[#1D1D1F]">Data Collection Status</p>
        <span className={cn(
          'text-base font-bold font-mono tabular-nums',
          completionRate >= 70 ? 'text-[#1D7A5F]' : completionRate >= 40 ? 'text-[#92400E]' : 'text-[#B91C1C]'
        )}>
          {completionRate}% Complete
        </span>
      </div>
      
      {/* Progress bar */}
      <div className="h-4 rounded-full bg-[#F5F5F7] overflow-hidden mb-5">
        <div className="h-full flex">
          <div 
            className="transition-all duration-500" 
            style={{ width: `${completePercent}%`, backgroundColor: '#34C759' }} 
          />
          <div 
            className="transition-all duration-500" 
            style={{ width: `${partialPercent}%`, backgroundColor: '#FF9500' }} 
          />
        </div>
      </div>
      
      {/* Stats grid */}
      <div className="grid grid-cols-5 gap-5">
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 rounded-full" style={{ backgroundColor: '#34C759' }} />
          <div>
            <span className="text-2xl font-bold text-[#1D1D1F] tabular-nums">{complete}</span>
            <p className="text-sm font-medium text-[#6E6E73]">Complete</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 rounded-full" style={{ backgroundColor: '#FF9500' }} />
          <div>
            <span className="text-2xl font-bold text-[#1D1D1F] tabular-nums">{partial}</span>
            <p className="text-sm font-medium text-[#6E6E73]">Partial</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 rounded-full" style={{ backgroundColor: '#FF3B30' }} />
          <div>
            <span className="text-2xl font-bold text-[#1D1D1F] tabular-nums">{missing}</span>
            <p className="text-sm font-medium text-[#6E6E73]">Missing</p>
          </div>
        </div>
        <div className="flex items-center gap-3 pl-5 border-l border-border">
          <Building2 className="h-5 w-5 text-[#6E6E73]" />
          <div>
            <span className="text-2xl font-bold text-[#1D1D1F] tabular-nums">{subsidiaries}</span>
            <p className="text-sm font-medium text-[#6E6E73]">Companies</p>
          </div>
        </div>
        <div className="flex items-center gap-3" title={locations === null ? 'Locations arrive in an upcoming Phase 1 step' : undefined}>
          <MapPin className="h-5 w-5 text-[#6E6E73]" />
          <div>
            <span className="text-2xl font-bold text-[#1D1D1F] tabular-nums">{locations ?? '—'}</span>
            <p className="text-sm font-medium text-[#6E6E73]">Locations</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function KPICards({ data }: KPICardsProps) {
  return (
    <div className="space-y-5">
      {/* Emissions KPIs - Executive Level */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <EmissionsCard
          label="Scope 1 Emissions"
          value={data.emissions.scope1}
          trend={data.emissions.scope1Trend}
          description="Direct emissions"
          scopeColor="#34C759"
        />
        <EmissionsCard
          label="Scope 2 Emissions"
          value={data.emissions.scope2}
          trend={data.emissions.scope2Trend}
          description="Purchased energy"
          scopeColor="#007AFF"
        />
        <EmissionsCard
          label="Scope 3 Emissions"
          value={data.emissions.scope3}
          trend={data.emissions.scope3Trend}
          description="Value chain"
          scopeColor="#AF52DE"
        />
        <EmissionsCard
          label="Total Emissions"
          value={data.emissions.total}
          trend={data.emissions.totalTrend}
          description="Combined footprint"
          highlight
        />
      </div>
      
      {/* Data Status Bar */}
      <DataStatusCard
        complete={data.completedCategories}
        partial={data.incompleteCategories}
        missing={data.missingCategories}
        subsidiaries={data.totalSubsidiaries}
        locations={data.totalLocations}
        completionRate={data.calculationCompletionRate}
      />
    </div>
  );
}
