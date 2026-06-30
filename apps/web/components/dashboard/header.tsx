'use client';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Download, Search, Bell, User, Filter } from 'lucide-react';
import { reportingYears, subsidiaries } from '@/lib/data';
import { Badge } from '@/components/ui/badge';

interface HeaderProps {
  selectedYear: string;
  onYearChange: (year: string) => void;
  selectedCompany: string;
  onCompanyChange: (company: string) => void;
  selectedPeriod: string;
  onPeriodChange: (period: string) => void;
  selectedStatus: string;
  onStatusChange: (status: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

const periods = [
  { value: 'all', label: 'All Periods' },
  { value: 'q1', label: 'Q1' },
  { value: 'q2', label: 'Q2' },
  { value: 'q3', label: 'Q3' },
  { value: 'q4', label: 'Q4' },
];

const statuses = [
  { value: 'all', label: 'All Status' },
  { value: 'complete', label: 'Complete', color: '#34C759' },
  { value: 'incomplete', label: 'Partial', color: '#FF9500' },
  { value: 'missing', label: 'Missing', color: '#FF3B30' },
];

export function Header({
  selectedYear,
  onYearChange,
  selectedCompany,
  onCompanyChange,
  selectedPeriod,
  onPeriodChange,
  selectedStatus,
  onStatusChange,
  searchQuery,
  onSearchChange,
}: HeaderProps) {
  const activeFilters = [
    selectedYear !== '2024' && selectedYear,
    selectedCompany !== 'all' && subsidiaries.find(s => s.id === selectedCompany)?.shortName,
    selectedPeriod !== 'all' && periods.find(p => p.value === selectedPeriod)?.label,
    selectedStatus !== 'all' && statuses.find(s => s.value === selectedStatus)?.label,
  ].filter(Boolean);

  return (
    <header className="sticky top-0 z-30 h-16 border-b border-[#D8D8DC] bg-[#EBEBF0]">
      <div className="flex h-16 items-center justify-between px-6">
        <div className="flex items-center gap-6">
          <h1 className="text-xl font-bold text-[#1D1D1F]">Carbon Dashboard</h1>
          
          <div className="flex items-center gap-2">
            <Select value={selectedYear} onValueChange={onYearChange}>
              <SelectTrigger className="w-[100px] border-[#D8D8DC] bg-[#EBEBF0] text-[#1D1D1F] font-semibold text-sm h-9 rounded-lg focus:ring-[#1B5E3B]/40">
                <SelectValue placeholder="Year" />
              </SelectTrigger>
              <SelectContent className="rounded-xl border-[#D8D8DC] bg-[#EBEBF0]">
                {reportingYears.map((year) => (
                  <SelectItem key={year} value={year} className="font-medium hover:bg-[#E0E0E5]">
                    {year}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedPeriod} onValueChange={onPeriodChange}>
              <SelectTrigger className="w-[110px] border-[#D8D8DC] bg-[#EBEBF0] text-[#1D1D1F] font-semibold text-sm h-9 rounded-lg focus:ring-[#1B5E3B]/40">
                <SelectValue placeholder="Period" />
              </SelectTrigger>
              <SelectContent className="rounded-xl border-[#D8D8DC] bg-[#EBEBF0]">
                {periods.map((period) => (
                  <SelectItem key={period.value} value={period.value} className="font-medium hover:bg-[#E0E0E5]">
                    {period.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedCompany} onValueChange={onCompanyChange}>
              <SelectTrigger className="w-[180px] border-[#D8D8DC] bg-[#EBEBF0] text-[#1D1D1F] font-semibold text-sm h-9 rounded-lg focus:ring-[#1B5E3B]/40">
                <SelectValue placeholder="All Subsidiaries" />
              </SelectTrigger>
              <SelectContent className="rounded-xl border-[#D8D8DC] bg-[#EBEBF0]">
                <SelectItem value="all" className="font-medium hover:bg-[#E0E0E5]">All Subsidiaries</SelectItem>
                {subsidiaries.map((sub) => (
                  <SelectItem key={sub.id} value={sub.id} className="font-medium hover:bg-[#E0E0E5]">
                    {sub.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={selectedStatus} onValueChange={onStatusChange}>
              <SelectTrigger className="w-[130px] border-[#D8D8DC] bg-[#EBEBF0] text-[#1D1D1F] font-semibold text-sm h-9 rounded-lg focus:ring-[#1B5E3B]/40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent className="rounded-xl border-[#D8D8DC] bg-[#EBEBF0]">
                {statuses.map((status) => (
                  <SelectItem key={status.value} value={status.value} className="font-medium hover:bg-[#E0E0E5]">
                    <div className="flex items-center gap-2">
                      {status.color && <div className="h-3 w-3 rounded-full" style={{ backgroundColor: status.color }} />}
                      {status.label}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6E6E73]" />
            <Input
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-52 border-[#D8D8DC] bg-[#EBEBF0] pl-9 text-[#1D1D1F] placeholder:text-[#8E8E93] h-9 text-sm font-medium rounded-lg focus:ring-[#1B5E3B]/40"
            />
          </div>

          <Button variant="outline" size="sm" className="gap-2 border-[#D8D8DC] bg-[#EBEBF0] hover:bg-[#E0E0E5] h-9 rounded-lg text-[#1D1D1F] font-semibold">
            <Download className="h-4 w-4" />
            Export
          </Button>

          <Button variant="ghost" size="icon" className="relative text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-[#E0E0E5] h-9 w-9 rounded-lg">
            <Bell className="h-5 w-5" />
            <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white bg-[#FF3B30]">
              3
            </span>
          </Button>

          <Button variant="ghost" size="icon" className="text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-[#E0E0E5] h-9 w-9 rounded-lg">
            <User className="h-5 w-5" />
          </Button>
        </div>
      </div>
      
      {/* Active filters bar */}
      {activeFilters.length > 0 && (
        <div className="flex items-center gap-2 px-6 pb-3 pt-0 bg-[#EBEBF0] border-b border-[#D8D8DC]">
          <Filter className="h-4 w-4 text-[#6E6E73]" />
          <span className="text-sm font-medium text-[#6E6E73]">Filters:</span>
          {activeFilters.map((filter, i) => (
            <Badge key={i} variant="secondary" className="text-sm font-semibold rounded-lg bg-[#E0E0E5] text-[#1D1D1F]">
              {filter}
            </Badge>
          ))}
          <button 
            onClick={() => {
              onYearChange('2024');
              onCompanyChange('all');
              onPeriodChange('all');
              onStatusChange('all');
            }}
            className="text-sm font-medium text-[#1B5E3B] hover:text-[#145030] ml-1 transition-colors"
          >
            Clear all
          </button>
        </div>
      )}
    </header>
  );
}
