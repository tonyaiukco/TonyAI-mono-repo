'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { DataStatus, SubmissionStatus, Category, ReportingPeriod } from '@/lib/types';
import { subsidiaries, locations } from '@/lib/data-entry-data';
import { CATEGORIES } from '@/lib/types';
import { Clock, User, ChevronLeft, Save, Send, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';

interface EntryHeaderProps {
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string;
  subsidiaryId: string;
  locationId: string;
  category: Category;
  status: DataStatus;
  submissionStatus: SubmissionStatus;
  responsibleUser: string;
  lastSaved: string;
  onYearChange: (year: number) => void;
  onPeriodChange: (period: ReportingPeriod) => void;
  onPeriodValueChange: (value: string) => void;
  onSubsidiaryChange: (id: string) => void;
  onLocationChange: (id: string) => void;
  onCategoryChange: (category: Category) => void;
  onSaveDraft: () => void;
  onSubmit: () => void;
  isSaving: boolean;
}

const statusConfig: Record<DataStatus, { label: string; color: string }> = {
  complete: { label: 'Complete', color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  incomplete: { label: 'Incomplete', color: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  missing: { label: 'Missing Data', color: 'bg-red-500/15 text-red-400 border-red-500/30' },
};

const submissionStatusConfig: Record<SubmissionStatus, { label: string; color: string }> = {
  draft: { label: 'Draft', color: 'bg-muted text-muted-foreground border-border' },
  submitted: { label: 'Submitted', color: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  in_review: { label: 'In Review', color: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
  approved: { label: 'Approved', color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  revision_requested: { label: 'Revision Requested', color: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
};

const years = [2024, 2023, 2022, 2021];
const periods: { value: ReportingPeriod; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annual', label: 'Annual' },
];

const periodValues: Record<ReportingPeriod, string[]> = {
  monthly: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  quarterly: ['Q1', 'Q2', 'Q3', 'Q4'],
  annual: ['Annual'],
};

export function EntryHeader({
  reportingYear,
  reportingPeriod,
  periodValue,
  subsidiaryId,
  locationId,
  category,
  status,
  submissionStatus,
  responsibleUser,
  lastSaved,
  onYearChange,
  onPeriodChange,
  onPeriodValueChange,
  onSubsidiaryChange,
  onLocationChange,
  onCategoryChange,
  onSaveDraft,
  onSubmit,
  isSaving,
}: EntryHeaderProps) {
  const availableLocations = locations.filter(l => l.subsidiaryId === subsidiaryId);
  const statusInfo = statusConfig[status];
  const submissionInfo = submissionStatusConfig[submissionStatus];

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-30">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border/50">
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ChevronLeft className="h-4 w-4" />
            <span className="text-sm">Back to Dashboard</span>
          </Link>
          <div className="h-4 w-px bg-border" />
          <h1 className="text-lg font-semibold text-foreground">Data Entry</h1>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            <span>Last saved: {formatDate(lastSaved)}</span>
          </div>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <User className="h-4 w-4" />
            <span>{responsibleUser}</span>
          </div>
          <div className="h-4 w-px bg-border" />
          <Badge variant="outline" className={statusInfo.color}>
            {statusInfo.label}
          </Badge>
          <Badge variant="outline" className={submissionInfo.color}>
            {submissionInfo.label}
          </Badge>
        </div>
      </div>

      {/* Selector bar */}
      <div className="flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-3">
          <Select value={reportingYear.toString()} onValueChange={(v) => onYearChange(parseInt(v))}>
            <SelectTrigger className="w-[100px] h-9 bg-secondary border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map(year => (
                <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={reportingPeriod} onValueChange={(v) => onPeriodChange(v as ReportingPeriod)}>
            <SelectTrigger className="w-[120px] h-9 bg-secondary border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {periods.map(p => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={periodValue} onValueChange={onPeriodValueChange}>
            <SelectTrigger className="w-[120px] h-9 bg-secondary border-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {periodValues[reportingPeriod].map(v => (
                <SelectItem key={v} value={v}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="h-6 w-px bg-border mx-1" />

          <Select value={subsidiaryId} onValueChange={onSubsidiaryChange}>
            <SelectTrigger className="w-[200px] h-9 bg-secondary border-border">
              <SelectValue placeholder="Select company" />
            </SelectTrigger>
            <SelectContent>
              {subsidiaries.map(sub => (
                <SelectItem key={sub.id} value={sub.id}>{sub.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={locationId} onValueChange={onLocationChange}>
            <SelectTrigger className="w-[180px] h-9 bg-secondary border-border">
              <SelectValue placeholder="Select location" />
            </SelectTrigger>
            <SelectContent>
              {availableLocations.map(loc => (
                <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="h-6 w-px bg-border mx-1" />

          <Select value={category} onValueChange={(v) => onCategoryChange(v as Category)}>
            <SelectTrigger className="w-[160px] h-9 bg-secondary border-border">
              <SelectValue placeholder="Select category" />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map(cat => (
                <SelectItem key={cat} value={cat}>{cat}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onSaveDraft}
            disabled={isSaving}
            className="gap-2"
          >
            <Save className="h-4 w-4" />
            Save Draft
          </Button>
          <Button
            size="sm"
            onClick={onSubmit}
            disabled={status === 'missing' || isSaving}
            className="gap-2 bg-primary hover:bg-primary/90"
          >
            {submissionStatus === 'draft' ? (
              <>
                <Send className="h-4 w-4" />
                Submit for Review
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" />
                Mark Complete
              </>
            )}
          </Button>
        </div>
      </div>
    </header>
  );
}
