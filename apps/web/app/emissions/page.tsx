'use client';

import { useState, useMemo } from 'react';
import { Sidebar } from '@/components/dashboard/sidebar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Progress } from '@/components/ui/progress';
import {
  Download,
  Search,
  FileText,
  Image as ImageIcon,
  FileSpreadsheet,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Building2,
  Layers,
  BarChart3,
  History,
  PieChart,
  Target,
  CheckCircle2,
  AlertCircle,
  XCircle,
} from 'lucide-react';
import {
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  AreaChart,
  Area,
  Treemap,
  LineChart,
  Line,
  ComposedChart,
  ReferenceLine,
} from 'recharts';
import {
  emissionsRecords,
  categoryEmissions,
  trendData,
  quarterlyTrendData,
  yearlyTrendData,
  calculateScopeTotals,
  getTopContributors,
  emissionsTargets,
  calculateTargetProgress,
  scope1Subcategories,
  scope2Subcategories,
  scope3Subcategories,
  targetPathwayData,
} from '@/lib/emissions-data';
import { EmissionsRecord, EmissionsScope, DataViewMode, CATEGORIES, INTENSITY_METRICS, EmissionsRecordStatus, TargetStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

// Apple-Style Scope Colors - Vibrant and distinct
const SCOPE_COLORS = {
  scope1: '#34C759', // Apple Green
  scope2: '#007AFF', // Apple Blue
  scope3: '#AF52DE', // Apple Purple
};

// Apple-Style Status Colors
const STATUS_COLORS: Record<EmissionsRecordStatus, string> = {
  draft: 'bg-[#F5F5F7] text-[#6E6E73] font-semibold',
  submitted: 'bg-[#E8F0FE] text-[#0066CC] font-semibold',
  under_review: 'bg-[#FEF3C7] text-[#92400E] font-semibold',
  approved: 'bg-[#D1F2EB] text-[#1D7A5F] font-semibold',
  rejected: 'bg-[#FEE2E2] text-[#B91C1C] font-semibold',
  locked: 'bg-[#F3E8FF] text-[#7C3AED] font-semibold',
};

const TARGET_STATUS_CONFIG: Record<TargetStatus, { color: string; icon: typeof CheckCircle2; label: string }> = {
  on_track: { color: 'text-[#1D7A5F] font-bold', icon: CheckCircle2, label: 'On Track' },
  at_risk: { color: 'text-[#92400E] font-bold', icon: AlertCircle, label: 'At Risk' },
  off_track: { color: 'text-[#B91C1C] font-bold', icon: XCircle, label: 'Off Track' },
};

// Apple-Style Chart Colors - Strong contrast
const CONTRIBUTOR_COLORS = [
  '#007AFF', // Apple Blue
  '#34C759', // Apple Green
  '#AF52DE', // Apple Purple
  '#FF9500', // Apple Orange
  '#5AC8FA', // Apple Teal
];

function formatNumber(value: number, decimals: number = 0): string {
  const fixed = value.toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${formatted}.${decPart}` : formatted;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function EmissionsAnalysisPage() {
  const [activeTab, setActiveTab] = useState('summary');
  const [scopeFilter, setScopeFilter] = useState<EmissionsScope>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [dataView, setDataView] = useState<DataViewMode>('absolute');
  const [intensityMetric, setIntensityMetric] = useState('revenue');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<EmissionsRecord | null>(null);
  const [contributorBasis, setContributorBasis] = useState<'subsidiary' | 'category'>('subsidiary');
  const [trendPeriod, setTrendPeriod] = useState<'monthly' | 'quarterly' | 'yearly'>('monthly');
  const [historyCategory, setHistoryCategory] = useState<string>('all');

  // Filter records based on scope and category
  const filteredRecords = useMemo(() => {
    return emissionsRecords.filter(record => {
      if (scopeFilter !== 'all') {
        const scopeNum = parseInt(scopeFilter.replace('scope', ''));
        if (record.scope !== scopeNum) return false;
      }
      if (categoryFilter !== 'all' && record.category !== categoryFilter) return false;
      if (historyCategory !== 'all' && activeTab === 'history' && record.category !== historyCategory) return false;
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return (
          record.subsidiary.toLowerCase().includes(query) ||
          record.category.toLowerCase().includes(query) ||
          record.enteredBy.toLowerCase().includes(query) ||
          (record.invoiceReference?.toLowerCase().includes(query) || false) ||
          (record.notes?.toLowerCase().includes(query) || false)
        );
      }
      return true;
    });
  }, [scopeFilter, categoryFilter, searchQuery, historyCategory, activeTab]);

  // Calculate totals
  const scopeTotals = useMemo(() => calculateScopeTotals(filteredRecords), [filteredRecords]);
  const topContributors = useMemo(
    () => getTopContributors(filteredRecords, contributorBasis),
    [filteredRecords, contributorBasis]
  );

  // Get intensity divisor
  const intensityDivisor = useMemo(() => {
    const metric = INTENSITY_METRICS.find(m => m.id === intensityMetric);
    return metric?.value || 1;
  }, [intensityMetric]);

  // Apply intensity if needed
  const applyIntensity = (value: number) => {
    return dataView === 'intensity' ? value / intensityDivisor : value;
  };

  // Dynamic pie chart data based on scope selection
  const pieData = useMemo(() => {
    if (scopeFilter === 'all') {
      return [
        { name: 'Scope 1', value: scopeTotals.scope1, color: SCOPE_COLORS.scope1 },
        { name: 'Scope 2', value: scopeTotals.scope2, color: SCOPE_COLORS.scope2 },
        { name: 'Scope 3', value: scopeTotals.scope3, color: SCOPE_COLORS.scope3 },
      ].filter(d => d.value > 0);
    } else if (scopeFilter === 'scope1') {
      return scope1Subcategories;
    } else if (scopeFilter === 'scope2') {
      return scope2Subcategories;
    } else {
      return scope3Subcategories;
    }
  }, [scopeFilter, scopeTotals]);

  // Dynamic chart title based on scope
  const chartTitle = useMemo(() => {
    switch (scopeFilter) {
      case 'scope1': return 'Scope 1 Subcategory Distribution';
      case 'scope2': return 'Scope 2 Subcategory Distribution';
      case 'scope3': return 'Scope 3 Subcategory Distribution';
      default: return 'Emissions by Scope';
    }
  }, [scopeFilter]);

  // Get trend data based on period selection
  const currentTrendData = useMemo(() => {
    switch (trendPeriod) {
      case 'quarterly':
        return quarterlyTrendData;
      case 'yearly':
        return yearlyTrendData;
      default:
        return trendData;
    }
  }, [trendPeriod]);

  // Calculate YTD change
  const ytdChange = useMemo(() => {
    if (currentTrendData.length < 2) return 0;
    const current = currentTrendData[currentTrendData.length - 1].total;
    const baseline = currentTrendData[0].baseline || currentTrendData[0].total;
    return ((current - baseline) / baseline) * 100;
  }, [currentTrendData]);

  // Treemap data for breakdown
  const treemapData = useMemo(() => {
    return categoryEmissions
      .filter(c => c.absoluteEmissions > 0)
      .map(c => ({
        name: c.category,
        size: c.absoluteEmissions,
        scope: c.scope,
        color: c.scope === 1 ? SCOPE_COLORS.scope1 : c.scope === 2 ? SCOPE_COLORS.scope2 : SCOPE_COLORS.scope3,
      }));
  }, []);

  // Target progress calculations
  const targetProgressData = useMemo(() => {
    return emissionsTargets.map(target => {
      let currentEmissions = scopeTotals.total;
      if (target.scope === 'scope1') currentEmissions = scopeTotals.scope1;
      else if (target.scope === 'scope2') currentEmissions = scopeTotals.scope2;
      else if (target.scope === 'scope3') currentEmissions = scopeTotals.scope3;
      
      return {
        target,
        progress: calculateTargetProgress(target, currentEmissions * 4), // Annualize quarterly data
      };
    });
  }, [scopeTotals]);

  const handleExport = () => {
    alert(`Exporting ${activeTab} data as Excel with current filters applied`);
  };

  const handleCategoryClick = (category: string) => {
    setHistoryCategory(category);
    setActiveTab('history');
  };

  const getEvidenceIcon = (type: 'pdf' | 'image' | 'spreadsheet') => {
    switch (type) {
      case 'pdf':
        return <FileText className="h-4 w-4" />;
      case 'image':
        return <ImageIcon className="h-4 w-4" />;
      case 'spreadsheet':
        return <FileSpreadsheet className="h-4 w-4" />;
    }
  };

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <main className="flex-1 ml-[280px] transition-all duration-300">
        <div className="p-6 space-y-6">
          {/* Page Header */}
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Emissions Analytics</h1>
              <p className="text-sm text-muted-foreground">
                Analyze emissions data across scopes, categories, and time periods
              </p>
            </div>

            <div className="flex items-center gap-3">
              {/* Scope Toggle */}
              <Select value={scopeFilter} onValueChange={(v) => setScopeFilter(v as EmissionsScope)}>
                <SelectTrigger className="w-[140px] bg-card border-border">
                  <SelectValue placeholder="All Scopes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Scopes</SelectItem>
                  <SelectItem value="scope1">Scope 1</SelectItem>
                  <SelectItem value="scope2">Scope 2</SelectItem>
                  <SelectItem value="scope3">Scope 3</SelectItem>
                </SelectContent>
              </Select>

              {/* Category Filter */}
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-[180px] bg-card border-border">
                  <SelectValue placeholder="All Categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {CATEGORIES.map(cat => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Data View Toggle */}
              <div className="flex items-center rounded-lg border border-border bg-card p-1">
                <button
                  onClick={() => setDataView('absolute')}
                  className={cn(
                    'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                    dataView === 'absolute'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  Absolute
                </button>
                <button
                  onClick={() => setDataView('intensity')}
                  className={cn(
                    'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                    dataView === 'intensity'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  Intensity
                </button>
              </div>

              {/* Intensity Metric Selector */}
              {dataView === 'intensity' && (
                <Select value={intensityMetric} onValueChange={setIntensityMetric}>
                  <SelectTrigger className="w-[150px] bg-card border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTENSITY_METRICS.map(metric => (
                      <SelectItem key={metric.id} value={metric.id}>
                        per {metric.unit}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {/* Export Button */}
              <Button onClick={handleExport} className="gap-2">
                <Download className="h-4 w-4" />
                Export Data
              </Button>
            </div>
          </div>

          {/* Tab Navigation */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
            <TabsList className="bg-card border border-border">
              <TabsTrigger value="summary" className="gap-2">
                <PieChart className="h-4 w-4" />
                Summary
              </TabsTrigger>
              <TabsTrigger value="breakdown" className="gap-2">
                <Layers className="h-4 w-4" />
                Breakdown
              </TabsTrigger>
              <TabsTrigger value="history" className="gap-2">
                <History className="h-4 w-4" />
                History
              </TabsTrigger>
              <TabsTrigger value="targets" className="gap-2">
                <Target className="h-4 w-4" />
                Targets
              </TabsTrigger>
              <TabsTrigger value="trends" className="gap-2">
                <BarChart3 className="h-4 w-4" />
                Trends
              </TabsTrigger>
            </TabsList>

            {/* Summary Tab */}
            <TabsContent value="summary" className="space-y-6">
              {/* Scope Metric Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card className="border-border bg-card">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total Scope 1</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-bold text-foreground">
                        {formatNumber(applyIntensity(scopeTotals.scope1))}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {dataView === 'intensity' ? `tCO₂e/${INTENSITY_METRICS.find(m => m.id === intensityMetric)?.unit}` : 'tCO₂e'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Direct emissions</p>
                  </CardContent>
                </Card>

                <Card className="border-border bg-card">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total Scope 2</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-bold text-foreground">
                        {formatNumber(applyIntensity(scopeTotals.scope2))}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {dataView === 'intensity' ? `tCO₂e/${INTENSITY_METRICS.find(m => m.id === intensityMetric)?.unit}` : 'tCO₂e'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Purchased energy</p>
                  </CardContent>
                </Card>

                <Card className="border-border bg-card">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total Scope 3</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-bold text-foreground">
                        {formatNumber(applyIntensity(scopeTotals.scope3))}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {dataView === 'intensity' ? `tCO₂e/${INTENSITY_METRICS.find(m => m.id === intensityMetric)?.unit}` : 'tCO₂e'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Value chain emissions</p>
                  </CardContent>
                </Card>
              </div>

              {/* Charts Row */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Donut Chart - Scope-aware */}
                <Card className="border-border bg-card">
                  <CardHeader>
                    <CardTitle className="text-base">{chartTitle}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[300px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <RechartsPieChart>
                          <Pie
                            data={pieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={60}
                            outerRadius={100}
                            paddingAngle={2}
                            dataKey="value"
                            labelLine={false}
                          >
                            {pieData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.color} />
                            ))}
                          </Pie>
                          <RechartsTooltip
                            content={({ active, payload }) => {
                              if (active && payload && payload.length) {
                                const total = pieData.reduce((sum, d) => sum + d.value, 0);
                                const percent = ((payload[0].value as number) / total * 100).toFixed(1);
                                return (
                                  <div className="bg-popover border border-border rounded-lg p-3 shadow-lg">
                                    <p className="font-medium text-foreground">{payload[0].name}</p>
                                    <p className="text-sm text-muted-foreground">
                                      {formatNumber(payload[0].value as number)} tCO₂e
                                    </p>
                                    <p className="text-sm text-muted-foreground">{percent}% share</p>
                                  </div>
                                );
                              }
                              return null;
                            }}
                          />
                        </RechartsPieChart>
                      </ResponsiveContainer>
                    </div>
                    {/* Legend */}
                    <div className="flex flex-wrap justify-center gap-4 mt-4">
                      {pieData.map(entry => (
                        <div key={entry.name} className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
                          <span className="text-sm text-muted-foreground">{entry.name}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* Top Contributors Bar Chart - Improved contrast */}
                <Card className="border-border bg-card">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                      <CardTitle className="text-base">Top 5 Contributors</CardTitle>
                      <p className="text-xs text-muted-foreground mt-1">
                        By {contributorBasis === 'subsidiary' ? 'Company' : 'Category'}
                      </p>
                    </div>
                    <Select
                      value={contributorBasis}
                      onValueChange={(v) => setContributorBasis(v as 'subsidiary' | 'category')}
                    >
                      <SelectTrigger className="w-[140px] h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="subsidiary">By Company</SelectItem>
                        <SelectItem value="category">By Category</SelectItem>
                      </SelectContent>
                    </Select>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[300px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={topContributors} layout="vertical" margin={{ left: 20, right: 20 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={true} vertical={false} />
                          <XAxis 
                            type="number" 
                            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                            tickFormatter={(value) => formatNumber(value)}
                          />
                          <YAxis
                            type="category"
                            dataKey="name"
                            tick={{ fill: 'hsl(var(--foreground))', fontSize: 12, fontWeight: 500 }}
                            width={140}
                          />
                          <RechartsTooltip
                            content={({ active, payload }) => {
                              if (active && payload && payload.length) {
                                return (
                                  <div className="bg-popover border border-border rounded-lg p-3 shadow-lg">
                                    <p className="font-medium text-foreground">{payload[0].payload.name}</p>
                                    <p className="text-sm text-muted-foreground">
                                      {formatNumber(payload[0].value as number)} tCO₂e
                                    </p>
                                  </div>
                                );
                              }
                              return null;
                            }}
                          />
                          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                            {topContributors.map((_, index) => (
                              <Cell key={`cell-${index}`} fill={CONTRIBUTOR_COLORS[index % CONTRIBUTOR_COLORS.length]} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            {/* Breakdown Tab */}
            <TabsContent value="breakdown" className="space-y-6">
              {/* Treemap */}
              <Card className="border-border bg-card">
                <CardHeader>
                  <CardTitle className="text-base">Category Scale Visualization</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <Treemap
                        data={treemapData}
                        dataKey="size"
                        nameKey="name"
                        stroke="hsl(var(--border))"
                        content={(({ x, y, width, height, name, color }: any) => (
                          <g>
                            <rect
                              x={x}
                              y={y}
                              width={width}
                              height={height}
                              fill={color as string}
                              stroke="hsl(var(--background))"
                              strokeWidth={2}
                              rx={4}
                            />
                            {width > 60 && height > 30 && (
                              <text
                                x={x + width / 2}
                                y={y + height / 2}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fill="white"
                                fontSize={12}
                                fontWeight={500}
                              >
                                {name}
                              </text>
                            )}
                          </g>
                        )) as any}
                      />
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* Category Performance Table */}
              <Card className="border-border bg-card">
                <CardHeader>
                  <CardTitle className="text-base">Category Performance</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead>Scope</TableHead>
                        <TableHead className="text-right">Absolute Emissions</TableHead>
                        <TableHead className="text-right">% of Total</TableHead>
                        <TableHead className="text-right">Data Quality Score</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {categoryEmissions
                        .filter(c => c.absoluteEmissions > 0)
                        .sort((a, b) => b.absoluteEmissions - a.absoluteEmissions)
                        .map(category => (
                          <TableRow
                            key={category.category}
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => handleCategoryClick(category.category)}
                          >
                            <TableCell className="font-medium">{category.category}</TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={cn(
                                  'text-xs',
                                  category.scope === 1 && 'border-[#8FB7E8]/60 text-[#24597A]',
                                  category.scope === 2 && 'border-[#8ED1C2]/60 text-[#2F6B45]',
                                  category.scope === 3 && 'border-[#C7B5E8]/60 text-[#6B5B95]'
                                )}
                              >
                                Scope {category.scope}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right font-medium">
                              {formatNumber(category.absoluteEmissions)} tCO₂e
                            </TableCell>
                            <TableCell className="text-right">{category.percentOfTotal.toFixed(1)}%</TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-2">
                                <div className="w-16 bg-muted rounded-full h-2">
                                  <div
                                    className={cn(
                                      'h-2 rounded-full',
                                      category.dataQualityScore >= 80 && 'bg-[#4FAF8F]',
                                      category.dataQualityScore >= 60 && category.dataQualityScore < 80 && 'bg-[#F6DFA1]',
                                      category.dataQualityScore < 60 && 'bg-[#F2B8B5]'
                                    )}
                                    style={{ width: `${category.dataQualityScore}%` }}
                                  />
                                </div>
                                <span className="text-sm text-muted-foreground w-8">{category.dataQualityScore}</span>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                  <p className="text-xs text-muted-foreground mt-4">
                    Click a row to view detailed history for that category
                  </p>
                </CardContent>
              </Card>
            </TabsContent>

            {/* History Tab */}
            <TabsContent value="history" className="space-y-6">
              {/* Search and Filter */}
              <div className="flex items-center gap-4">
                <div className="relative flex-1 max-w-md">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by invoice, user, note, category, or subsidiary..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 bg-card border-border"
                  />
                </div>
                <Select value={historyCategory} onValueChange={setHistoryCategory}>
                  <SelectTrigger className="w-[180px] bg-card border-border">
                    <SelectValue placeholder="All Categories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {CATEGORIES.map(cat => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Audit Ledger Table */}
              <Card className="border-border bg-card">
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Timestamp</TableHead>
                        <TableHead>Subsidiary</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Activity Value</TableHead>
                        <TableHead>Unit</TableHead>
                        <TableHead className="text-right">tCO₂e</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Evidence</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRecords.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                            No emissions records found for this period. Start by adding data in the Data Entry tab.
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredRecords.map(record => (
                          <TableRow
                            key={record.id}
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => setSelectedRecord(record)}
                          >
                            <TableCell className="text-sm">{formatDate(record.timestamp)}</TableCell>
                            <TableCell className="font-medium">{record.subsidiary}</TableCell>
                            <TableCell>{record.category}</TableCell>
                            <TableCell className="text-right font-mono">
                              {formatNumber(record.activityValue)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{record.unit}</TableCell>
                            <TableCell className="text-right font-medium">
                              {formatNumber(record.tCo2e)}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Badge className={cn('text-xs', STATUS_COLORS[record.status])}>
                                  {record.status.replace('_', ' ')}
                                </Badge>
                                {record.anomalyFlagged && (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger>
                                        <AlertTriangle className="h-4 w-4 text-[#8A641C]" />
                                      </TooltipTrigger>
                                      <TooltipContent>Anomaly flagged</TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                {record.evidenceTypes.map((type, i) => (
                                  <TooltipProvider key={i}>
                                    <Tooltip>
                                      <TooltipTrigger className="text-muted-foreground hover:text-foreground">
                                        {getEvidenceIcon(type)}
                                      </TooltipTrigger>
                                      <TooltipContent>{type.toUpperCase()}</TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                ))}
                                {record.evidenceCount > 0 && (
                                  <span className="text-xs text-muted-foreground ml-1">({record.evidenceCount})</span>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Targets Tab */}
            <TabsContent value="targets" className="space-y-6">
              {targetProgressData.length === 0 ? (
                <Card className="border-border bg-card">
                  <CardContent className="py-12 text-center text-muted-foreground">
                    No target data has been configured for the selected filters.
                  </CardContent>
                </Card>
              ) : (
                <>
                  {/* Target Summary Cards */}
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <Card className="border-border bg-card">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">
                          Current Actual Emissions
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl font-bold text-foreground">
                          {formatNumber(targetProgressData[0].progress.currentEmissions)}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">tCO₂e (Annualized)</p>
                      </CardContent>
                    </Card>

                    <Card className="border-border bg-card">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">
                          2024 Target Emissions
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl font-bold text-foreground">
                          {formatNumber(targetProgressData[0].target.targetEmissions)}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">tCO₂e</p>
                      </CardContent>
                    </Card>

                    <Card className="border-border bg-card">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">
                          Variance to Target
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className={cn(
                          'text-2xl font-bold',
                          targetProgressData[0].progress.varianceToTarget > 0 ? 'text-[#8A3D3B]' : 'text-[#2F6B45]'
                        )}>
                          {targetProgressData[0].progress.varianceToTarget > 0 ? '+' : ''}
                          {formatNumber(targetProgressData[0].progress.varianceToTarget)}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          tCO₂e {targetProgressData[0].progress.varianceToTarget > 0 ? 'above' : 'below'} target
                        </p>
                      </CardContent>
                    </Card>

                    <Card className="border-border bg-card">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">
                          Progress to Goal
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="flex items-center gap-2">
                          {(() => {
                            const StatusIcon = TARGET_STATUS_CONFIG[targetProgressData[0].progress.status].icon;
                            return (
                              <StatusIcon className={cn('h-5 w-5', TARGET_STATUS_CONFIG[targetProgressData[0].progress.status].color)} />
                            );
                          })()}
                          <span className="text-2xl font-bold text-foreground">
                            {targetProgressData[0].progress.progressPercent.toFixed(0)}%
                          </span>
                        </div>
                        <p className={cn(
                          'text-xs mt-1',
                          TARGET_STATUS_CONFIG[targetProgressData[0].progress.status].color
                        )}>
                          {TARGET_STATUS_CONFIG[targetProgressData[0].progress.status].label}
                        </p>
                      </CardContent>
                    </Card>
                  </div>

                  {/* Target Pathway Chart */}
                  <Card className="border-border bg-card">
                    <CardHeader>
                      <CardTitle className="text-base">Emissions vs Target Pathway</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="h-[350px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <ComposedChart data={targetPathwayData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                            <XAxis 
                              dataKey="year" 
                              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                            />
                            <YAxis 
                              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                              tickFormatter={(value) => `${(value / 1000).toFixed(0)}k`}
                            />
                            <RechartsTooltip
                              content={({ active, payload, label }) => {
                                if (active && payload && payload.length) {
                                  return (
                                    <div className="bg-popover border border-border rounded-lg p-3 shadow-lg">
                                      <p className="font-medium text-foreground mb-2">{label}</p>
                                      {payload.map((entry, index) => (
                                        entry.value !== null && (
                                          <p key={index} className="text-sm" style={{ color: entry.color }}>
                                            {entry.name}: {formatNumber(entry.value as number)} tCO₂e
                                          </p>
                                        )
                                      ))}
                                    </div>
                                  );
                                }
                                return null;
                              }}
                            />
                            <Legend />
                            <ReferenceLine 
                              y={targetPathwayData[0].baseline} 
                              stroke="hsl(var(--muted-foreground))" 
                              strokeDasharray="5 5"
                              label={{ value: 'Baseline', fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                            />
                            <Line 
                              type="monotone" 
                              dataKey="target" 
                              name="Target Pathway"
                              stroke="#C7B5E8" 
                              strokeWidth={2}
                              strokeDasharray="5 5"
                              dot={{ fill: '#C7B5E8', r: 4 }}
                            />
                            <Line 
                              type="monotone" 
                              dataKey="actual" 
                              name="Actual Emissions"
                              stroke="#4FAF8F" 
                              strokeWidth={3}
                              dot={{ fill: '#4FAF8F', r: 5 }}
                              connectNulls={false}
                            />
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Target Details Table */}
                  <Card className="border-border bg-card">
                    <CardHeader>
                      <CardTitle className="text-base">Configured Targets</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Target Name</TableHead>
                            <TableHead>Basis</TableHead>
                            <TableHead>Scope</TableHead>
                            <TableHead className="text-right">Baseline</TableHead>
                            <TableHead className="text-right">Target</TableHead>
                            <TableHead className="text-right">Reduction</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Progress</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {targetProgressData.map(({ target, progress }) => {
                            const StatusIcon = TARGET_STATUS_CONFIG[progress.status].icon;
                            return (
                              <TableRow key={target.id}>
                                <TableCell className="font-medium">{target.name}</TableCell>
                                <TableCell>
                                  <Badge variant="outline" className="text-xs">
                                    {target.basis.replace('_', ' ')}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      'text-xs',
                                      target.scope === 'scope1' && 'border-[#8FB7E8]/60 text-[#24597A]',
                                      target.scope === 'scope2' && 'border-[#8ED1C2]/60 text-[#2F6B45]',
                                      target.scope === 'scope3' && 'border-[#C7B5E8]/60 text-[#6B5B95]',
                                      target.scope === 'all' && 'border-[#7A9CC6]/60 text-[#24597A]'
                                    )}
                                  >
                                    {target.scope === 'all' ? 'All Scopes' : `Scope ${target.scope.replace('scope', '')}`}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right font-mono">
                                  {formatNumber(target.baselineEmissions)}
                                </TableCell>
                                <TableCell className="text-right font-mono">
                                  {formatNumber(target.targetEmissions)}
                                </TableCell>
                                <TableCell className="text-right text-[#2F6B45]">
                                  -{target.reductionPercent}%
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-2">
                                    <StatusIcon className={cn('h-4 w-4', TARGET_STATUS_CONFIG[progress.status].color)} />
                                    <span className={cn('text-sm', TARGET_STATUS_CONFIG[progress.status].color)}>
                                      {TARGET_STATUS_CONFIG[progress.status].label}
                                    </span>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right">
                                  <div className="flex items-center justify-end gap-2">
                                    <Progress value={progress.progressPercent} className="w-16 h-2" />
                                    <span className="text-sm font-medium">{progress.progressPercent.toFixed(0)}%</span>
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </>
              )}
            </TabsContent>

            {/* Trends Tab */}
            <TabsContent value="trends" className="space-y-6">
              {/* Period Selector */}
              <div className="flex items-center gap-4">
                <div className="flex items-center rounded-lg border border-border bg-card p-1">
                  {(['monthly', 'quarterly', 'yearly'] as const).map(period => (
                    <button
                      key={period}
                      onClick={() => setTrendPeriod(period)}
                      className={cn(
                        'px-4 py-1.5 text-sm font-medium rounded-md transition-colors capitalize',
                        trendPeriod === period
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {period}
                    </button>
                  ))}
                </div>
              </div>

              {/* Stacked Area Chart */}
              <Card className="border-border bg-card">
                <CardHeader>
                  <CardTitle className="text-base">Emissions Trend by Scope</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-[400px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={currentTrendData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis 
                          dataKey="period" 
                          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                        />
                        <YAxis 
                          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                          tickFormatter={(value) => `${(value / 1000).toFixed(0)}k`}
                        />
                        <RechartsTooltip
                          content={({ active, payload, label }) => {
                            if (active && payload && payload.length) {
                              return (
                                <div className="bg-popover border border-border rounded-lg p-3 shadow-lg">
                                  <p className="font-medium text-foreground mb-2">{label}</p>
                                  {payload.map((entry, index) => (
                                    <p key={index} className="text-sm" style={{ color: entry.color }}>
                                      {entry.name}: {formatNumber(entry.value as number)} tCO₂e
                                    </p>
                                  ))}
                                </div>
                              );
                            }
                            return null;
                          }}
                        />
                        <Legend />
                        <Area
                          type="monotone"
                          dataKey="scope3"
                          name="Scope 3"
                          stackId="1"
                          stroke={SCOPE_COLORS.scope3}
                          fill={SCOPE_COLORS.scope3}
                          fillOpacity={0.6}
                        />
                        <Area
                          type="monotone"
                          dataKey="scope2"
                          name="Scope 2"
                          stackId="1"
                          stroke={SCOPE_COLORS.scope2}
                          fill={SCOPE_COLORS.scope2}
                          fillOpacity={0.6}
                        />
                        <Area
                          type="monotone"
                          dataKey="scope1"
                          name="Scope 1"
                          stackId="1"
                          stroke={SCOPE_COLORS.scope1}
                          fill={SCOPE_COLORS.scope1}
                          fillOpacity={0.6}
                        />
                        {currentTrendData.some(d => d.target) && (
                          <Line
                            type="monotone"
                            dataKey="target"
                            name="Target"
                            stroke="#C7B5E8"
                            strokeWidth={2}
                            strokeDasharray="5 5"
                            dot={false}
                          />
                        )}
                        {currentTrendData.some(d => d.baseline) && (
                          <Line
                            type="monotone"
                            dataKey="baseline"
                            name="Baseline"
                            stroke="hsl(var(--muted-foreground))"
                            strokeWidth={1}
                            strokeDasharray="3 3"
                            dot={false}
                          />
                        )}
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* YTD Insight Card */}
              <Card className="border-border bg-card">
                <CardContent className="py-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">Year to Date Change vs Baseline</p>
                      <div className="flex items-center gap-2 mt-1">
                        {ytdChange < 0 ? (
                          <TrendingDown className="h-5 w-5 text-[#2F6B45]" />
                        ) : ytdChange > 0 ? (
                          <TrendingUp className="h-5 w-5 text-[#8A3D3B]" />
                        ) : (
                          <Minus className="h-5 w-5 text-muted-foreground" />
                        )}
                        <span
                          className={cn(
                            'text-2xl font-bold',
                            ytdChange < 0 && 'text-[#2F6B45]',
                            ytdChange > 0 && 'text-[#8A3D3B]',
                            ytdChange === 0 && 'text-muted-foreground'
                          )}
                        >
                          {ytdChange > 0 ? '+' : ''}{ytdChange.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-muted-foreground">
                        {ytdChange < 0 
                          ? 'Emissions have decreased compared to baseline' 
                          : ytdChange > 0 
                            ? 'Emissions have increased compared to baseline'
                            : 'No change from baseline'}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </main>

      {/* Audit Detail Drawer */}
      <Sheet open={!!selectedRecord} onOpenChange={() => setSelectedRecord(null)}>
        <SheetContent className="w-[500px] sm:max-w-[500px] bg-card border-l border-border">
          {selectedRecord && (
            <>
              <SheetHeader>
                <SheetTitle>Audit Detail</SheetTitle>
                <SheetDescription>
                  {selectedRecord.category} - {selectedRecord.subsidiary}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-6">
                {/* Status Badge */}
                <div className="flex items-center gap-3">
                  <Badge className={cn('text-sm', STATUS_COLORS[selectedRecord.status])}>
                    {selectedRecord.status.replace('_', ' ')}
                  </Badge>
                  {selectedRecord.anomalyFlagged && (
                    <Badge className="bg-amber-500/20 text-amber-400 text-sm">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Anomaly Flagged
                    </Badge>
                  )}
                </div>

                {/* Main Details */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Activity Value</p>
                    <p className="font-medium">{formatNumber(selectedRecord.activityValue)} {selectedRecord.unit}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Calculated Emissions</p>
                    <p className="font-medium">{formatNumber(selectedRecord.tCo2e)} tCO₂e</p>
                  </div>
                </div>

                {/* Methodology Section */}
                <div className="border-t border-border pt-4">
                  <h4 className="text-sm font-medium mb-3">Methodology Details</h4>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Emission Factor</span>
                      <span>{selectedRecord.emissionFactor} {selectedRecord.emissionFactorUnit}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Methodology</span>
                      <span>{selectedRecord.methodology}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Geography Code</span>
                      <span>{selectedRecord.geographyCode}</span>
                    </div>
                  </div>
                </div>

                {/* Audit Trail */}
                <div className="border-t border-border pt-4">
                  <h4 className="text-sm font-medium mb-3">Audit Trail</h4>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Entered By</span>
                      <span>{selectedRecord.enteredBy}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Created At</span>
                      <span>{formatDate(selectedRecord.createdAt)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Updated At</span>
                      <span>{formatDate(selectedRecord.updatedAt)}</span>
                    </div>
                    {selectedRecord.invoiceReference && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Invoice Reference</span>
                        <span className="font-mono">{selectedRecord.invoiceReference}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Variance Reason */}
                {selectedRecord.varianceReason && (
                  <div className="border-t border-border pt-4">
                    <h4 className="text-sm font-medium mb-2">Reason for Variance</h4>
                    <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-lg">
                      {selectedRecord.varianceReason}
                    </p>
                  </div>
                )}

                {/* Notes */}
                {selectedRecord.notes && (
                  <div className="border-t border-border pt-4">
                    <h4 className="text-sm font-medium mb-2">Notes</h4>
                    <p className="text-sm text-muted-foreground">{selectedRecord.notes}</p>
                  </div>
                )}

                {/* Evidence Files */}
                {selectedRecord.evidenceCount > 0 && (
                  <div className="border-t border-border pt-4">
                    <h4 className="text-sm font-medium mb-3">Linked Evidence ({selectedRecord.evidenceCount})</h4>
                    <div className="space-y-2">
                      {selectedRecord.evidenceTypes.map((type, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-3 p-2 rounded-lg bg-muted/50 hover:bg-muted cursor-pointer"
                        >
                          {getEvidenceIcon(type)}
                          <span className="text-sm">
                            {type === 'pdf' && 'Document.pdf'}
                            {type === 'image' && 'Image.jpg'}
                            {type === 'spreadsheet' && 'Data.xlsx'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
