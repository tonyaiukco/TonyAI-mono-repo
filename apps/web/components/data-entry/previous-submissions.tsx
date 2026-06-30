'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { previousSubmissions } from '@/lib/data-entry-data';
import { cn } from '@/lib/utils';
import { CheckCircle2, Clock, AlertCircle, XCircle, ChevronRight } from 'lucide-react';
import type { DataStatus, SubmissionStatus } from '@/lib/types';

const statusIcons: Record<DataStatus, typeof CheckCircle2> = {
  complete: CheckCircle2,
  incomplete: AlertCircle,
  missing: XCircle,
};

const statusColors: Record<DataStatus, string> = {
  complete: 'text-emerald-400',
  incomplete: 'text-amber-400',
  missing: 'text-red-400',
};

const submissionColors: Record<SubmissionStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  submitted: 'bg-blue-500/15 text-blue-400',
  in_review: 'bg-purple-500/15 text-purple-400',
  approved: 'bg-emerald-500/15 text-emerald-400',
  revision_requested: 'bg-amber-500/15 text-amber-400',
};

export function PreviousSubmissions() {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Previous Submissions
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {previousSubmissions.map((sub) => {
            const Icon = statusIcons[sub.status];
            return (
              <button
                key={sub.id}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-secondary/50 hover:bg-secondary transition-colors group"
              >
                <Icon className={cn('h-4 w-4 shrink-0', statusColors[sub.status])} />
                <div className="flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{sub.period}</span>
                    <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', submissionColors[sub.submissionStatus])}>
                      {sub.submissionStatus}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {sub.emissions !== null ? `${sub.emissions} tCO₂e` : 'No emissions calculated'}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
