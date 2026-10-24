'use client';

import { useLocale, useTranslations } from 'use-intl';
import { KPIData } from '@/lib/types';
import { cn } from '@/lib/utils';
import { formatNumber } from '@/lib/i18n/number';
import { compactTonnes } from '@/lib/dashboard-view';
import { Building2, MapPin, ArrowUpRight, ArrowDownRight } from 'lucide-react';

interface KPICardsProps {
  data: KPIData;
  /** The year the completeness figures describe. They come from the tracking
   *  matrix, which is scoped to one year — and the matrix card below this strip
   *  carries the same title WITH a year, so leaving this one bare puts two
   *  identically-titled blocks on the page, only one of them dated. */
  reportingYear?: number | null;
  /** How many rows are measured by the WP17 invoice rule. The completion
   *  percentage means something different for those, so the card says so. */
  byLocationCount?: number;
  /** A Scope 3-only selection: Scope 1, 2 and the total read "Not covered",
   *  never a 0 the inventory did not measure (LP4-03 K4; `architect` P2). */
  scope3Only?: boolean;
}

interface EmissionsCardProps {
  label: string;
  /** null = not covered by this selection: a word, not a 0. */
  value: number | null;
  /** null = no prior-period data yet; the trend badge shows "—". */
  trend: number | null;
  description: string;
  highlight?: boolean;
  scopeColor?: string;
}

function EmissionsCard({ label, value, trend, description, highlight = false, scopeColor }: EmissionsCardProps) {
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const locale = useLocale();
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
          {value === null ? (
            <p className="mt-3 text-2xl font-bold tracking-tight text-[#6E6E73]" data-testid="kpi-not-covered">
              {t('notCovered')}
            </p>
          ) : (
            <div className="flex items-baseline gap-2 mt-3">
              <span className={cn(
                'text-4xl font-bold font-mono tabular-nums tracking-tight',
                highlight ? 'text-primary' : 'text-[#1D1D1F]'
              )}>
                {compactTonnes(value, { t, locale })}
              </span>
              <span className="text-sm font-medium text-[#6E6E73]">{tCommon('tco2e')}</span>
            </div>
          )}
          <p className="text-sm text-[#6E6E73] mt-2 font-medium">{description}</p>
        </div>
        {trend === null ? (
          <div
            className="flex items-center gap-1 rounded-full bg-[#F5F5F7] px-3 py-1.5 text-sm font-semibold text-[#8E8E93]"
            title={t('kpi.trendPending')}
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
            <span>{t('percent', { value: formatNumber(Math.abs(trend), locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</span>
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
  /** null while the KPI endpoint hasn't loaded yet. */
  locations: number | null;
  completionRate: number;
  reportingYear?: number | null;
  /** How many rows are measured by the invoice rule — the denominator behind
   *  `completionRate` differs for those, and the card has to say so. */
  byLocationCount: number;
}

function DataStatusCard({ complete, partial, missing, subsidiaries, locations, completionRate, reportingYear, byLocationCount }: DataStatusCardProps) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const count = (n: number) => formatNumber(n, locale);
  const total = complete + partial + missing;
  // `total === 0` happens on a tenant with no subsidiaries yet, and produced a
  // literal `NaN%` bar width. Untested edge, so it survived until the matrix
  // was rebuilt around it.
  const completePercent = total > 0 ? (complete / total) * 100 : 0;
  const partialPercent = total > 0 ? (partial / total) * 100 : 0;
  
  return (
    <div className="rounded-xl border border-border bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <p className="text-base font-semibold text-[#1D1D1F]">
          {t('kpi.collection')}
          {reportingYear ? (
            <span className="ml-2 text-sm font-normal text-[#6E6E73]">
              {reportingYear}
            </span>
          ) : null}
        </p>
        <span className={cn(
          'text-base font-bold font-mono tabular-nums',
          completionRate >= 70 ? 'text-[#1D7A5F]' : completionRate >= 40 ? 'text-[#92400E]' : 'text-[#B91C1C]'
        )}>
          {t('entryProgress', { rate: completionRate })}
        </span>
      </div>
      
      {/* Says what the percentage is a percentage OF. A subsidiary switched to
          location-level tracking replaces one yes/no verdict with a count of
          monthly invoices, so this figure can fall without any data changing —
          and a number that drops on its own reads as a fault unless the screen
          says otherwise. WP19 gave it a second way to move for the same
          reason: the figure now answers "how much has been ACCEPTED", so
          sending a year's data for review no longer completes anything. */}
      <div className="-mt-2 mb-4 space-y-1">
        {/* Entry progress, never coverage (LP4-03 K9): the boundary's coverage card sits below. */}
        <p className="text-xs text-[#6E6E73]">{t('entryNote')}</p>
        {byLocationCount > 0 && (
          <p className="text-xs text-[#6E6E73]">
            {byLocationCount === 1
              ? t('kpi.byLocationOne')
              : t('kpi.byLocationMany', { count: count(byLocationCount) })}
          </p>
        )}
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
            <span className="text-2xl font-bold text-[#1D1D1F] tabular-nums">{count(complete)}</span>
            <p className="text-sm font-medium text-[#6E6E73]">{t('status.complete')}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 rounded-full" style={{ backgroundColor: '#FF9500' }} />
          <div>
            <span className="text-2xl font-bold text-[#1D1D1F] tabular-nums">{count(partial)}</span>
            <p className="text-sm font-medium text-[#6E6E73]">{t('status.incomplete')}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 rounded-full" style={{ backgroundColor: '#FF3B30' }} />
          <div>
            <span className="text-2xl font-bold text-[#1D1D1F] tabular-nums">{count(missing)}</span>
            <p className="text-sm font-medium text-[#6E6E73]">{t('status.missing')}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 pl-5 border-l border-border">
          <Building2 className="h-5 w-5 text-[#6E6E73]" />
          <div>
            <span className="text-2xl font-bold text-[#1D1D1F] tabular-nums">{count(subsidiaries)}</span>
            <p className="text-sm font-medium text-[#6E6E73]">{t('kpi.companies')}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <MapPin className="h-5 w-5 text-[#6E6E73]" />
          <div>
            <span className="text-2xl font-bold text-[#1D1D1F] tabular-nums">{locations === null ? '—' : count(locations)}</span>
            <p className="text-sm font-medium text-[#6E6E73]">{t('kpi.locations')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function KPICards({ data, reportingYear, byLocationCount = 0, scope3Only = false }: KPICardsProps) {
  const t = useTranslations('dashboard');
  return (
    <div className="space-y-5">
      {/* Emissions KPIs - Executive Level */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <EmissionsCard
          label={t('kpi.scope1')}
          value={scope3Only ? null : data.emissions.scope1}
          trend={data.emissions.scope1Trend}
          description={scope3Only ? t('outsideSelection') : t('kpi.scope1Description')}
          scopeColor="#34C759"
        />
        <EmissionsCard
          label={t('kpi.scope2')}
          value={scope3Only ? null : data.emissions.scope2}
          trend={data.emissions.scope2Trend}
          description={scope3Only ? t('outsideSelection') : t('kpi.scope2Description')}
          scopeColor="#007AFF"
        />
        <EmissionsCard
          label={t('kpi.scope3')}
          value={data.emissions.scope3}
          trend={data.emissions.scope3Trend}
          description={t('scope3Description')}
          scopeColor="#AF52DE"
        />
        <EmissionsCard
          label={t('totalLabel')}
          value={scope3Only ? null : data.emissions.total}
          trend={data.emissions.totalTrend}
          description={scope3Only ? t('totalScope3Only') : t('totalDescription')}
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
        reportingYear={reportingYear}
        byLocationCount={byLocationCount}
      />
    </div>
  );
}
