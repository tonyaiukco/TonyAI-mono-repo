'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { CalculationPreview, Comment, VersionHistoryEntry, DataStatus, FieldGroup } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  Calculator,
  MessageSquare,
  History,
  CheckCircle2,
  AlertCircle,
  XCircle,
  ChevronRight,
  Paperclip,
  Leaf,
} from 'lucide-react';
import { useState } from 'react';

interface StatusSidebarProps {
  status: DataStatus;
  fieldGroups: FieldGroup[];
  calculationPreview?: CalculationPreview;
  comments: Comment[];
  versionHistory: VersionHistoryEntry[];
  attachments: string[];
}

type Tab = 'status' | 'comments' | 'history';

function getCompletionStats(fieldGroups: FieldGroup[]) {
  const allFields = fieldGroups.flatMap(g => g.fields);
  const requiredFields = allFields.filter(f => f.required);
  const filledRequired = requiredFields.filter(f => f.value !== null && f.value !== undefined && f.value !== '');
  const filledOptional = allFields.filter(f => !f.required && f.value !== null && f.value !== undefined && f.value !== '');

  return {
    total: allFields.length,
    required: requiredFields.length,
    filledRequired: filledRequired.length,
    filledOptional: filledOptional.length,
    percentage: requiredFields.length > 0 ? Math.round((filledRequired.length / requiredFields.length) * 100) : 100,
  };
}

function getMissingFields(fieldGroups: FieldGroup[]) {
  return fieldGroups.flatMap(g =>
    g.fields.filter(f => f.required && (f.value === null || f.value === undefined || f.value === ''))
      .map(f => ({ groupName: g.name, fieldLabel: f.label }))
  );
}

export function StatusSidebar({
  status,
  fieldGroups,
  calculationPreview,
  comments,
  versionHistory,
  attachments,
}: StatusSidebarProps) {
  const [activeTab, setActiveTab] = useState<Tab>('status');
  const stats = getCompletionStats(fieldGroups);
  const missingFields = getMissingFields(fieldGroups);

  const tabs: { id: Tab; label: string; icon: typeof Calculator }[] = [
    { id: 'status', label: 'Status', icon: Calculator },
    { id: 'comments', label: 'Comments', icon: MessageSquare },
    { id: 'history', label: 'History', icon: History },
  ];

  return (
    <aside className="w-80 shrink-0 border-l border-border bg-card/30 flex flex-col overflow-hidden">
      {/* Tab navigation */}
      <div className="flex border-b border-border">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 px-3 py-3 text-sm font-medium transition-colors',
                activeTab === tab.id
                  ? 'text-primary border-b-2 border-primary bg-primary/5'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
              {tab.id === 'comments' && comments.length > 0 && (
                <span className="h-5 w-5 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center">
                  {comments.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {activeTab === 'status' && (
            <>
              {/* Completion meter */}
              <Card className="bg-secondary/50 border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-foreground flex items-center justify-between">
                    <span>Completion Status</span>
                    <span
                      className={cn(
                        'text-lg font-semibold',
                        stats.percentage === 100 ? 'text-emerald-400' :
                        stats.percentage >= 50 ? 'text-amber-400' : 'text-red-400'
                      )}
                    >
                      {stats.percentage}%
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Progress
                    value={stats.percentage}
                    className={cn(
                      'h-2',
                      stats.percentage === 100 ? '[&>div]:bg-emerald-500' :
                      stats.percentage >= 50 ? '[&>div]:bg-amber-500' : '[&>div]:bg-red-500'
                    )}
                  />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{stats.filledRequired} of {stats.required} required fields</span>
                    <span>+{stats.filledOptional} optional</span>
                  </div>
                </CardContent>
              </Card>

              {/* Missing fields */}
              {missingFields.length > 0 && (
                <Card className="bg-red-500/5 border-red-500/20">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-red-400 flex items-center gap-2">
                      <AlertCircle className="h-4 w-4" />
                      Missing Required Fields
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-1.5">
                      {missingFields.map((field, i) => (
                        <li key={i} className="flex items-center gap-2 text-xs">
                          <XCircle className="h-3 w-3 text-red-400 shrink-0" />
                          <span className="text-muted-foreground">{field.groupName}:</span>
                          <span className="text-foreground">{field.fieldLabel}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {/* Calculation preview */}
              {calculationPreview && (
                <Card className="bg-primary/5 border-primary/20">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-primary flex items-center gap-2">
                      <Leaf className="h-4 w-4" />
                      Emissions Preview
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="text-center py-2">
                      <div className="text-3xl font-bold text-foreground">
                        {calculationPreview.estimatedEmissions.toFixed(2)}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {calculationPreview.emissionsUnit}
                      </div>
                    </div>
                    <Separator className="bg-border" />
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Activity Data</span>
                        <span className="text-foreground font-medium">
                          {calculationPreview.activityData.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} {calculationPreview.activityUnit}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Emission Factor</span>
                        <span className="text-foreground font-medium">
                          {calculationPreview.emissionFactor} {calculationPreview.emissionFactorUnit}
                        </span>
                      </div>
                      {calculationPreview.methodology && (
                        <div className="pt-2 border-t border-border">
                          <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
                            Methodology
                          </span>
                          <p className="text-foreground mt-0.5">{calculationPreview.methodology}</p>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Attachments */}
              {attachments.length > 0 && (
                <Card className="bg-secondary/50 border-border">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
                      <Paperclip className="h-4 w-4" />
                      Attachments ({attachments.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-1.5">
                      {attachments.map((file, i) => (
                        <li key={i} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer">
                          <ChevronRight className="h-3 w-3" />
                          {file}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </>
          )}

          {activeTab === 'comments' && (
            <div className="space-y-3">
              {comments.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No comments yet
                </div>
              ) : (
                comments.map((comment) => (
                  <Card key={comment.id} className="bg-secondary/50 border-border">
                    <CardContent className="p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm font-medium text-foreground">{comment.author}</span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          {comment.role === 'super_admin' ? 'Admin' : comment.role === 'consultant' ? 'Consultant' : 'User'}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{comment.content}</p>
                      <p className="text-xs text-muted-foreground/70 mt-2">
                        {new Date(comment.timestamp).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </CardContent>
                  </Card>
                ))
              )}
              <Button variant="outline" size="sm" className="w-full gap-2">
                <MessageSquare className="h-4 w-4" />
                Add Comment
              </Button>
            </div>
          )}

          {activeTab === 'history' && (
            <div className="space-y-3">
              {versionHistory.map((entry, i) => (
                <div
                  key={entry.id}
                  className={cn(
                    'relative pl-4 pb-4',
                    i < versionHistory.length - 1 && 'border-l border-border ml-1'
                  )}
                >
                  <div className="absolute -left-1 top-0 h-2 w-2 rounded-full bg-primary" />
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-foreground">v{entry.version}</span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {entry.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{entry.changes}</p>
                    <p className="text-xs text-muted-foreground/70">
                      {entry.author} &middot; {new Date(entry.timestamp).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
