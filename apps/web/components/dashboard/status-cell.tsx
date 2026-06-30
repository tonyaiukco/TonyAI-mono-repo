'use client';

import { CategoryData, DataStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatDistanceToNow } from 'date-fns';

interface StatusCellProps {
  data: CategoryData;
  onClick?: () => void;
  compact?: boolean;
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

export function StatusCell({ data, onClick, compact = false }: StatusCellProps) {
  const config = statusConfig[data.status];
  const hasEmission = data.calculationComplete && data.emission !== null;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onClick}
            className={cn(
              'relative flex items-center justify-center rounded-lg transition-all duration-200',
              'focus:outline-none focus:ring-2 focus:ring-[#007AFF]/40 focus:ring-offset-2',
              config.bg,
              config.hoverBg,
              compact ? 'h-10 w-full min-w-[72px]' : 'h-12 w-full min-w-[84px]'
            )}
          >
            {hasEmission ? (
              <span className={cn(
                'font-mono font-bold tabular-nums',
                config.text,
                compact ? 'text-sm' : 'text-base'
              )}>
                {formatEmission(data.emission!)}
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
              <span className="font-bold text-[#1D1D1F]">{data.category}</span>
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
            {hasEmission && (
              <div className="flex items-baseline justify-between">
                <span className="font-medium text-[#6E6E73]">Emissions</span>
                <span className="font-bold text-[#1D1D1F] font-mono text-base">
                  {data.emission!.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} <span className="text-[#6E6E73] text-xs font-medium">tCO₂e</span>
                </span>
              </div>
            )}
            
            <div className="flex justify-between">
              <span className="font-medium text-[#6E6E73]">Owner</span>
              <span className="font-semibold text-[#1D1D1F]">{data.responsible}</span>
            </div>
            
            {data.lastUpdate && (
              <div className="flex justify-between">
                <span className="font-medium text-[#6E6E73]">Updated</span>
                <span className="font-semibold text-[#1D1D1F]">
                  {formatDistanceToNow(new Date(data.lastUpdate), { addSuffix: true })}
                </span>
              </div>
            )}
            
            {data.missingFields && data.missingFields.length > 0 && (
              <div className="pt-3 mt-3 border-t border-[#E5E5EA]">
                <span className="text-[#92400E] text-sm font-semibold">
                  Missing: {data.missingFields.join(', ')}
                </span>
              </div>
            )}
            
            <p className="text-sm text-[#007AFF] font-medium pt-1">Click to view details</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
