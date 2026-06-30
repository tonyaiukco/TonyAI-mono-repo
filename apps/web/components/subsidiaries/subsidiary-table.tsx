'use client';

import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ChevronDown,
  ChevronRight,
  Search,
  Building2,
  MapPin,
  MoreHorizontal,
  Pencil,
  Trash2,
  Eye,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SubsidiaryCompany, SubsidiaryStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

interface SubsidiaryTableProps {
  subsidiaries: SubsidiaryCompany[];
  onEdit: (subsidiary: SubsidiaryCompany) => void;
  onDelete: (subsidiaryId: string) => void;
  onView: (subsidiary: SubsidiaryCompany) => void;
}

const statusConfig: Record<SubsidiaryStatus, { label: string; className: string }> = {
  active: {
    label: 'Active',
    className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  },
  inactive: {
    label: 'Inactive',
    className: 'bg-red-500/15 text-red-400 border-red-500/30',
  },
  pending: {
    label: 'Pending',
    className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  },
};

export function SubsidiaryTable({ subsidiaries, onEdit, onDelete, onView }: SubsidiaryTableProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [countryFilter, setCountryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [sortField, setSortField] = useState<keyof SubsidiaryCompany>('officialName');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Get unique countries for filter
  const countries = [...new Set(subsidiaries.map(s => s.country))].sort();

  // Filter subsidiaries
  const filteredSubsidiaries = subsidiaries.filter(sub => {
    const matchesSearch =
      sub.officialName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      sub.city.toLowerCase().includes(searchQuery.toLowerCase()) ||
      sub.authorizedRepresentative.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesCountry = countryFilter === 'all' || sub.country === countryFilter;
    const matchesStatus = statusFilter === 'all' || sub.status === statusFilter;

    return matchesSearch && matchesCountry && matchesStatus;
  });

  // Sort subsidiaries
  const sortedSubsidiaries = [...filteredSubsidiaries].sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return 0;
  });

  const toggleRow = (id: string) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedRows(newExpanded);
  };

  const handleSort = (field: keyof SubsidiaryCompany) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by company name, city, or representative..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-secondary/50 border-border"
          />
        </div>

        <Select value={countryFilter} onValueChange={setCountryFilter}>
          <SelectTrigger className="w-[160px] bg-secondary/50 border-border">
            <SelectValue placeholder="Country" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Countries</SelectItem>
            {countries.map(country => (
              <SelectItem key={country} value={country}>{country}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px] bg-secondary/50 border-border">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-[40px]"></TableHead>
              <TableHead
                className="cursor-pointer hover:text-foreground"
                onClick={() => handleSort('officialName')}
              >
                Company Name
              </TableHead>
              <TableHead>Country</TableHead>
              <TableHead>City</TableHead>
              <TableHead>NACE Code</TableHead>
              <TableHead>Authorized Person</TableHead>
              <TableHead className="text-center">Locations</TableHead>
              <TableHead className="text-center">Child Subs</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Updated</TableHead>
              <TableHead className="w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedSubsidiaries.map((subsidiary) => {
              const isExpanded = expandedRows.has(subsidiary.id);
              const status = statusConfig[subsidiary.status];

              return (
                <>
                  <TableRow
                    key={subsidiary.id}
                    className={cn(
                      'border-border cursor-pointer',
                      isExpanded && 'bg-secondary/30'
                    )}
                  >
                    <TableCell className="py-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={() => toggleRow(subsidiary.id)}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </Button>
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        {subsidiary.officialName}
                      </div>
                    </TableCell>
                    <TableCell>{subsidiary.country}</TableCell>
                    <TableCell>{subsidiary.city}</TableCell>
                    <TableCell>
                      <code className="text-xs bg-secondary px-1.5 py-0.5 rounded">
                        {subsidiary.naceCode}
                      </code>
                    </TableCell>
                    <TableCell>{subsidiary.authorizedRepresentative}</TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary" className="font-mono">
                        {subsidiary.locations.length}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary" className="font-mono">
                        {subsidiary.childSubsidiaryCount}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={status.className}>
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(subsidiary.updatedAt).toLocaleDateString('en-GB')}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onView(subsidiary)}>
                            <Eye className="mr-2 h-4 w-4" />
                            View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onEdit(subsidiary)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => onDelete(subsidiary.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>

                  {/* Expanded Locations Preview */}
                  {isExpanded && (
                    <TableRow key={`${subsidiary.id}-locations`} className="bg-secondary/20">
                      <TableCell colSpan={11} className="py-4">
                        <div className="pl-10">
                          <div className="flex items-center gap-2 mb-3">
                            <MapPin className="h-4 w-4 text-primary" />
                            <span className="text-sm font-medium">
                              Locations ({subsidiary.locations.length})
                            </span>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {subsidiary.locations.map(location => (
                              <div
                                key={location.id}
                                className="bg-card border border-border rounded-lg p-3 space-y-1"
                              >
                                <div className="font-medium text-sm">{location.name}</div>
                                <div className="text-xs text-muted-foreground truncate">
                                  {location.address}
                                </div>
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-muted-foreground">
                                    {location.department}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {location.authorizedPerson}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}

            {sortedSubsidiaries.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="h-32 text-center text-muted-foreground">
                  No subsidiaries found matching your criteria.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Summary */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Showing {sortedSubsidiaries.length} of {subsidiaries.length} subsidiaries
        </span>
        <span>
          Total locations: {sortedSubsidiaries.reduce((acc, sub) => acc + sub.locations.length, 0)}
        </span>
      </div>
    </div>
  );
}
