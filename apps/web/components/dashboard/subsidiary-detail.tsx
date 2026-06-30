'use client';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Subsidiary, DataStatus } from '@/lib/types';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Building2,
  Factory,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Clock,
  User,
  FileText,
  MessageSquare,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { useState } from 'react';

interface SubsidiaryDetailProps {
  subsidiary: Subsidiary | null;
  open: boolean;
  onClose: () => void;
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

export function SubsidiaryDetail({ subsidiary, open, onClose }: SubsidiaryDetailProps) {
  const [notes, setNotes] = useState('');

  if (!subsidiary) return null;

  const totalCalculated = subsidiary.categories.filter(c => c.calculationComplete).length;

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
              <SheetTitle className="text-xl text-foreground">{subsidiary.name}</SheetTitle>
              <SheetDescription className="flex items-center gap-2 text-muted-foreground">
                <span>{subsidiary.sector}</span>
                <span>•</span>
                <span>{subsidiary.shortName}</span>
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
                  style={{ color: getCompletionColor(subsidiary.completionRate) }}
                >
                  {subsidiary.completionRate}%
                </span>
              </div>
              <Progress value={subsidiary.completionRate} className="h-2.5" />
            </div>

            {/* Quick Stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border bg-secondary/50 p-4">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Factory className="h-4 w-4" />
                  <span className="text-xs">Total Emissions</span>
                </div>
                <p className="mt-1.5 text-lg font-semibold text-foreground font-mono">
                  {subsidiary.totalEmissions.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
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
                    / {subsidiary.categories.length} categories
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
                {subsidiary.categories.map((cat) => {
                  const config = statusConfig[cat.status];
                  const Icon = config.icon;
                  
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
                            <span>{cat.responsible}</span>
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
                        {cat.emission !== null ? (
                          <div>
                            <p className="text-sm font-semibold text-primary font-mono">
                              {cat.emission.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
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
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <Separator className="bg-border" />

            {/* Missing Data Points */}
            {subsidiary.categories.some(c => c.missingFields && c.missingFields.length > 0) && (
              <div className="space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <AlertCircle className="h-4 w-4" style={{ color: STATUS_COLORS.incomplete.text }} />
                  Missing Data Points
                </h3>
                <div className="rounded-xl border p-4" style={{ 
                  backgroundColor: 'rgba(246, 223, 161, 0.15)',
                  borderColor: 'rgba(246, 223, 161, 0.4)'
                }}>
                  <ul className="space-y-1.5 text-sm text-muted-foreground">
                    {subsidiary.categories
                      .filter(c => c.missingFields && c.missingFields.length > 0)
                      .map((cat) => (
                        <li key={cat.category} className="flex items-start gap-2">
                          <span className="font-medium text-foreground">{cat.category}:</span>
                          <span>{cat.missingFields?.join(', ')}</span>
                        </li>
                      ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Notes */}
            <div className="space-y-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <MessageSquare className="h-4 w-4" />
                Notes & Comments
              </h3>
              {subsidiary.notes && (
                <div className="rounded-xl border border-border bg-secondary/50 p-4 text-sm text-muted-foreground">
                  {subsidiary.notes}
                </div>
              )}
              <Textarea
                placeholder="Add a note..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="min-h-[80px] border-border bg-white text-foreground placeholder:text-[#8A94A6] rounded-xl focus:ring-ring/40"
              />
              <Button size="sm" className="w-full rounded-xl bg-primary hover:bg-primary/90">
                Save Note
              </Button>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
