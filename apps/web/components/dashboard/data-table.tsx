'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Subsidiary, DataStatus } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, formatNumber } from '@/lib/utils';
import { ArrowUpDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

interface DataTableProps {
  subsidiaries: Subsidiary[];
  onSubsidiaryClick: (subsidiary: Subsidiary) => void;
}

type SortKey = 'name' | 'sector' | 'completionRate' | 'totalEmissions';
type SortOrder = 'asc' | 'desc';

// TonyAI Premium Status Colors
const STATUS_COLORS = {
  complete: { dot: '#A9D8B8', text: '#2F6B45' },
  incomplete: { dot: '#F6DFA1', text: '#8A641C' },
  missing: { dot: '#F2B8B5', text: '#8A3D3B' },
};

export function DataTable({ subsidiaries, onSubsidiaryClick }: DataTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('completionRate');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const getStatusSummary = (sub: Subsidiary) => {
    const counts = { complete: 0, incomplete: 0, missing: 0 };
    sub.categories.forEach(cat => counts[cat.status]++);
    return counts;
  };

  const filteredAndSorted = [...subsidiaries]
    .filter(sub => {
      if (statusFilter === 'all') return true;
      const counts = getStatusSummary(sub);
      if (statusFilter === 'has-missing') return counts.missing > 0;
      if (statusFilter === 'has-incomplete') return counts.incomplete > 0;
      if (statusFilter === 'all-complete') return counts.complete === sub.categories.length;
      return true;
    })
    .sort((a, b) => {
      let comparison = 0;
      switch (sortKey) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'sector':
          comparison = a.sector.localeCompare(b.sector);
          break;
        case 'completionRate':
          comparison = a.completionRate - b.completionRate;
          break;
        case 'totalEmissions':
          comparison = a.totalEmissions - b.totalEmissions;
          break;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortOrder('desc');
    }
  };

  const SortButton = ({ column, label }: { column: SortKey; label: string }) => (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => handleSort(column)}
      className="-ml-3 h-8 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg"
    >
      {label}
      <ArrowUpDown className={cn(
        'ml-1 h-3 w-3',
        sortKey === column && 'text-primary'
      )} />
    </Button>
  );

  const getCompletionColor = (rate: number) => {
    if (rate >= 75) return STATUS_COLORS.complete.text;
    if (rate >= 50) return STATUS_COLORS.incomplete.text;
    return STATUS_COLORS.missing.text;
  };

  return (
    <Card className="border-border bg-white rounded-[18px] shadow-sm">
      <CardHeader className="pb-4 px-6 pt-5">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold text-foreground">
            Detailed Overview
          </CardTitle>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px] border-border bg-white text-foreground rounded-xl">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent className="rounded-xl border-border">
              <SelectItem value="all">All Subsidiaries</SelectItem>
              <SelectItem value="has-missing">Has Missing Data</SelectItem>
              <SelectItem value="has-incomplete">Has Incomplete Data</SelectItem>
              <SelectItem value="all-complete">Fully Complete</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent bg-secondary">
              <TableHead className="w-[250px] pl-6">
                <SortButton column="name" label="Subsidiary" />
              </TableHead>
              <TableHead>
                <SortButton column="sector" label="Sector" />
              </TableHead>
              <TableHead className="text-center">Status Summary</TableHead>
              <TableHead className="text-right">
                <SortButton column="completionRate" label="Completion" />
              </TableHead>
              <TableHead className="text-right">
                <SortButton column="totalEmissions" label="Emissions" />
              </TableHead>
              <TableHead className="w-[50px] pr-6"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredAndSorted.map((sub) => {
              const statusSummary = getStatusSummary(sub);
              
              return (
                <TableRow
                  key={sub.id}
                  className="cursor-pointer border-border hover:bg-secondary/50 transition-colors duration-150"
                  onClick={() => onSubsidiaryClick(sub)}
                >
                  <TableCell className="pl-6">
                    <div>
                      <p className="font-medium text-foreground">{sub.name}</p>
                      <p className="text-xs text-muted-foreground">{sub.shortName}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="border-border text-muted-foreground rounded-lg bg-secondary/50">
                      {sub.sector}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-center gap-3">
                      <span className="flex items-center gap-1.5 text-xs">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: STATUS_COLORS.complete.dot }} />
                        <span style={{ color: STATUS_COLORS.complete.text }}>{statusSummary.complete}</span>
                      </span>
                      <span className="flex items-center gap-1.5 text-xs">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: STATUS_COLORS.incomplete.dot }} />
                        <span style={{ color: STATUS_COLORS.incomplete.text }}>{statusSummary.incomplete}</span>
                      </span>
                      <span className="flex items-center gap-1.5 text-xs">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: STATUS_COLORS.missing.dot }} />
                        <span style={{ color: STATUS_COLORS.missing.text }}>{statusSummary.missing}</span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <span 
                      className="font-semibold font-mono"
                      style={{ color: getCompletionColor(sub.completionRate) }}
                    >
                      {sub.completionRate}%
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="font-medium text-foreground font-mono">
                      {formatNumber(sub.totalEmissions)}
                    </span>
                    <span className="ml-1 text-xs text-muted-foreground">tCO₂e</span>
                  </TableCell>
                  <TableCell className="pr-6">
                    <ChevronRight className="h-4 w-4 text-[#8A94A6]" />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
