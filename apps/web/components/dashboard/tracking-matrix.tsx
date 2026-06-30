'use client';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Subsidiary, CATEGORIES } from '@/lib/types';
import { StatusCell } from './status-cell';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';

interface TrackingMatrixProps {
  subsidiaries: Subsidiary[];
  onSubsidiaryClick: (subsidiary: Subsidiary) => void;
}

const categoryShortNames: Record<string, string> = {
  'Electricity': 'Elec',
  'Natural Gas': 'Gas',
  'Fuel': 'Fuel',
  'Mobile Combustion': 'Mobile',
  'Refrigerants': 'Refrig',
  'Purchased Goods': 'Goods',
  'Waste': 'Waste',
  'Water': 'Water',
  'Business Travel': 'Travel',
  'Commuting': 'Commute',
  'Logistics': 'Logist',
};

function getCompletionColor(rate: number): string {
  if (rate >= 75) return 'text-[#1D7A5F]';
  if (rate >= 50) return 'text-[#92400E]';
  return 'text-[#B91C1C]';
}

export function TrackingMatrix({ subsidiaries, onSubsidiaryClick }: TrackingMatrixProps) {
  return (
    <Card className="border-[#D2D2D7] bg-white rounded-xl shadow-sm overflow-hidden">
      <CardHeader className="pb-0 pt-5 px-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-[#1D1D1F]">
              Data Collection Status
            </h2>
            <p className="text-sm font-medium text-[#6E6E73] mt-1">
              Click any cell for details. Values show calculated emissions in tCO₂e.
            </p>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded-full bg-[#34C759]" />
              <span className="text-sm font-semibold text-[#1D1D1F]">Complete</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded-full bg-[#FF9500]" />
              <span className="text-sm font-semibold text-[#1D1D1F]">Partial</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded-full bg-[#FF3B30]" />
              <span className="text-sm font-semibold text-[#1D1D1F]">Missing</span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 mt-4">
        <ScrollArea className="w-full">
          <div className="min-w-[1000px]">
            {/* Header Row */}
            <div className="grid grid-cols-[200px_repeat(11,1fr)_40px] gap-2 px-6 py-3 bg-[#F5F5F7] border-y border-[#E5E5EA]">
              <div className="text-xs font-bold text-[#6E6E73] uppercase tracking-wider">
                Subsidiary
              </div>
              {CATEGORIES.map((cat) => (
                <div 
                  key={cat} 
                  className="text-center text-xs font-bold text-[#6E6E73] uppercase tracking-wider"
                  title={cat}
                >
                  {categoryShortNames[cat]}
                </div>
              ))}
              <div />
            </div>

            {/* Data Rows */}
            <div className="divide-y divide-[#E5E5EA]">
              {subsidiaries.map((sub) => {
                const completedCount = sub.categories.filter(c => c.status === 'complete').length;
                const totalCount = sub.categories.length;
                
                return (
                  <div
                    key={sub.id}
                    className="grid grid-cols-[200px_repeat(11,1fr)_40px] gap-2 px-6 py-3 transition-colors duration-200 hover:bg-[#F5F5F7] group"
                  >
                    {/* Subsidiary Info */}
                    <button
                      onClick={() => onSubsidiaryClick(sub)}
                      className="flex flex-col items-start text-left pr-3"
                    >
                      <span className="font-bold text-[#1D1D1F] group-hover:text-[#007AFF] transition-colors text-sm">
                        {sub.shortName}
                      </span>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={cn(
                          'text-sm font-bold tabular-nums font-mono',
                          getCompletionColor((completedCount / totalCount) * 100)
                        )}>
                          {completedCount}/{totalCount}
                        </span>
                        <span className="text-xs font-medium text-[#8E8E93]">{sub.sector}</span>
                      </div>
                    </button>

                    {/* Status Cells */}
                    {sub.categories.map((cat) => (
                      <StatusCell
                        key={`${sub.id}-${cat.category}`}
                        data={cat}
                        onClick={() => onSubsidiaryClick(sub)}
                        compact
                      />
                    ))}

                    {/* Row Action */}
                    <button
                      onClick={() => onSubsidiaryClick(sub)}
                      className="flex items-center justify-center text-[#8E8E93] hover:text-[#007AFF] transition-colors"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
