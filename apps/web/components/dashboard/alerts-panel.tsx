'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/lib/types';
import { AlertTriangle, AlertCircle, Info, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';

interface AlertsPanelProps {
  alerts: Alert[];
}

const alertConfig = {
  error: {
    icon: AlertCircle,
    bg: 'bg-[#F2B8B5]/30',
    border: 'border-[#F2B8B5]/50',
    iconColor: 'text-[#8A3D3B]',
    badgeBg: 'bg-[#F2B8B5]/40',
    badgeText: 'text-[#8A3D3B]',
  },
  warning: {
    icon: AlertTriangle,
    bg: 'bg-[#F6DFA1]/30',
    border: 'border-[#F6DFA1]/50',
    iconColor: 'text-[#8A641C]',
    badgeBg: 'bg-[#F6DFA1]/40',
    badgeText: 'text-[#8A641C]',
  },
  info: {
    icon: Info,
    bg: 'bg-[#DCEEF7]',
    border: 'border-[#5AA9E6]/30',
    iconColor: 'text-[#24597A]',
    badgeBg: 'bg-[#DCEEF7]',
    badgeText: 'text-[#24597A]',
  },
};

export function AlertsPanel({ alerts }: AlertsPanelProps) {
  const errorCount = alerts.filter(a => a.type === 'error').length;
  const warningCount = alerts.filter(a => a.type === 'warning').length;

  return (
    <Card className="border-border bg-white rounded-[18px] shadow-sm h-full">
      <CardHeader className="pb-3 px-5 pt-5">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            Action Items
            {(errorCount > 0 || warningCount > 0) && (
              <span className="flex items-center gap-1.5 ml-2">
                {errorCount > 0 && (
                  <span className={cn(
                    'flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-lg',
                    alertConfig.error.badgeBg,
                    alertConfig.error.badgeText
                  )}>
                    {errorCount} critical
                  </span>
                )}
                {warningCount > 0 && (
                  <span className={cn(
                    'flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-lg',
                    alertConfig.warning.badgeBg,
                    alertConfig.warning.badgeText
                  )}>
                    {warningCount} warnings
                  </span>
                )}
              </span>
            )}
          </CardTitle>
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-foreground hover:bg-secondary h-7 px-2 rounded-lg">
            View All
            <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 px-5 pb-5">
        {alerts.slice(0, 5).map((alert) => {
          const config = alertConfig[alert.type];
          const Icon = config.icon;
          
          return (
            <div
              key={alert.id}
              className={cn(
                'flex items-start gap-3 rounded-xl border p-3 transition-all duration-150 cursor-pointer hover:shadow-sm',
                config.bg,
                config.border
              )}
            >
              <div className={cn('mt-0.5 shrink-0', config.iconColor)}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground line-clamp-2">{alert.message}</p>
                <div className="flex items-center gap-2 mt-1.5 text-xs text-muted-foreground">
                  <span className="font-medium truncate">{alert.subsidiary}</span>
                  {alert.category && (
                    <>
                      <span className="text-border">|</span>
                      <span className="truncate">{alert.category}</span>
                    </>
                  )}
                </div>
              </div>
              <span className="text-[10px] text-[#8A94A6] whitespace-nowrap">
                {formatDistanceToNow(new Date(alert.timestamp), { addSuffix: false })}
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
