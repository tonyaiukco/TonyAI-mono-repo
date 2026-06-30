'use client';

import { useState, useCallback } from 'react';
import { Sidebar } from '@/components/dashboard/sidebar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  FileText,
  Download,
  FileSpreadsheet,
  Share2,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  FileWarning,
  Building2,
  Calendar,
  BarChart3,
  TrendingDown,
  TrendingUp,
  Leaf,
  Copy,
  Mail,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ReportTemplate,
  ReportStatus,
  ReportConfig,
  ReportGenerationLog,
  REPORT_TEMPLATES,
  METHODOLOGY_SOURCES,
  CategoryEmissions,
} from '@/lib/types';
import { categoryEmissions, calculateScopeTotals, emissionsRecords } from '@/lib/emissions-data';
import { subsidiaries } from '@/lib/data';
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

// Helper function for deterministic number formatting
function formatNumber(value: number, decimals: number = 0): string {
  const fixed = value.toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${formatted}.${decPart}` : formatted;
}

type PageState = 'empty' | 'processing' | 'preview';

// Apple-Style Scope Colors
const SCOPE_COLORS = {
  scope1: '#34C759',
  scope2: '#007AFF',
  scope3: '#AF52DE',
};

// Mock generation log
const generationLog: ReportGenerationLog[] = [
  {
    id: 'log-001',
    generatedBy: 'John Smith',
    generatedAt: '2024-03-15T14:30:00Z',
    organisationScope: ['Energy Company A', 'Gas Distribution Company B'],
    reportingPeriod: 'Q1 2024',
    template: 'executive_summary',
    includeScope3: true,
    includeMethodologyNotes: true,
    includeEvidenceLinks: false,
    exportType: 'pdf',
    status: 'approved',
  },
  {
    id: 'log-002',
    generatedBy: 'Sarah Johnson',
    generatedAt: '2024-03-10T09:15:00Z',
    organisationScope: ['Total Portfolio'],
    reportingPeriod: '2023',
    template: 'ghg_protocol_detail',
    includeScope3: true,
    includeMethodologyNotes: true,
    includeEvidenceLinks: true,
    exportType: 'excel',
    status: 'approved',
  },
  {
    id: 'log-003',
    generatedBy: 'Mike Brown',
    generatedAt: '2024-03-05T16:45:00Z',
    organisationScope: ['Manufacturing Company C'],
    reportingPeriod: 'Q4 2023',
    template: 'subsidiary_comparison',
    includeScope3: false,
    includeMethodologyNotes: false,
    includeEvidenceLinks: false,
    exportType: 'preview',
    status: 'contains_incomplete_data',
  },
];

export default function ReportsPage() {
  const [pageState, setPageState] = useState<PageState>('empty');
  const [config, setConfig] = useState<ReportConfig>({
    template: 'executive_summary',
    organisationScope: [],
    timeframe: 'Q1 2024',
    includeScope3: true,
    includeMethodologyNotes: true,
    includeEvidenceLinks: false,
  });
  const [shareEmail, setShareEmail] = useState('');

  // Calculate scope totals
  const scopeTotals = calculateScopeTotals(emissionsRecords);

  // Calculate incomplete data percentage
  const incompleteRecords = emissionsRecords.filter(
    r => r.status === 'draft' || r.status === 'submitted' || r.status === 'under_review'
  );
  const incompletePercentage = (incompleteRecords.length / emissionsRecords.length) * 100;
  const hasIncompleteDataWarning = incompletePercentage > 15;

  // Get report status based on data quality
  const getReportStatus = (): ReportStatus => {
    if (incompletePercentage > 15) return 'contains_incomplete_data';
    if (incompletePercentage > 0) return 'draft';
    return 'approved';
  };

  const reportStatus = getReportStatus();

  // Scope distribution for donut chart
  const scopeDistribution = [
    { name: 'Scope 1', value: scopeTotals.scope1, fill: SCOPE_COLORS.scope1 },
    { name: 'Scope 2', value: scopeTotals.scope2, fill: SCOPE_COLORS.scope2 },
    { name: 'Scope 3', value: scopeTotals.scope3, fill: SCOPE_COLORS.scope3 },
  ];

  // Top contributors for bar chart
  const topContributors = categoryEmissions
    .filter(c => c.absoluteEmissions > 0)
    .sort((a, b) => b.absoluteEmissions - a.absoluteEmissions)
    .slice(0, 5)
    .map(c => ({
      name: c.category,
      emissions: c.absoluteEmissions,
      scope: c.scope,
    }));

  // Handle generate report
  const handleGenerate = useCallback(() => {
    setPageState('processing');
    // Simulate report generation
    setTimeout(() => {
      setPageState('preview');
    }, 2000);
  }, []);

  // Handle export actions
  const handleDownloadPDF = useCallback(() => {
    // In production, this would trigger PDF generation
    console.log('Downloading PDF...');
  }, []);

  const handleExportExcel = useCallback(() => {
    // In production, this would trigger Excel export
    console.log('Exporting Excel...');
  }, []);

  const handleShare = useCallback(() => {
    // In production, this would send share link/email
    console.log('Sharing report to:', shareEmail);
    setShareEmail('');
  }, [shareEmail]);

  // Status badge component (TonyAI Premium Colors)
  const StatusBadge = ({ status }: { status: ReportStatus }) => {
    const config = {
      approved: { label: 'Approved', className: 'bg-[#A9D8B8]/40 text-[#2F6B45] border-[#A9D8B8]/60' },
      draft: { label: 'Draft', className: 'bg-[#F6DFA1]/40 text-[#8A641C] border-[#F6DFA1]/60' },
      contains_incomplete_data: { label: 'Contains Incomplete Data', className: 'bg-[#F2B8B5]/40 text-[#8A3D3B] border-[#F2B8B5]/60' },
    };
    return (
      <Badge variant="outline" className={cn('text-xs', config[status].className)}>
        {config[status].label}
      </Badge>
    );
  };

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      
      <main className="flex-1 pl-[280px]">
        <div className="p-6 space-y-6">
          {/* Page Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">Reports & Disclosures</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Generate branded, review-ready PDF and Excel disclosures
              </p>
            </div>
          </div>

          {/* Report Configuration Bar */}
          <Card className="border-border bg-card">
            <CardContent className="p-4">
              <div className="flex flex-wrap items-end gap-4">
                {/* Report Template */}
                <div className="flex-1 min-w-[200px]">
                  <Label className="text-xs text-muted-foreground mb-1.5 block">Report Template</Label>
                  <Select
                    value={config.template}
                    onValueChange={(value: ReportTemplate) => setConfig({ ...config, template: value })}
                  >
                    <SelectTrigger className="bg-secondary border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REPORT_TEMPLATES.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          <div className="flex flex-col">
                            <span>{t.name}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Organisation Scope */}
                <div className="flex-1 min-w-[200px]">
                  <Label className="text-xs text-muted-foreground mb-1.5 block">Organisation Scope</Label>
                  <Select
                    value={config.organisationScope.length === 0 ? 'all' : config.organisationScope[0]}
                    onValueChange={(value) => setConfig({ ...config, organisationScope: value === 'all' ? [] : [value] })}
                  >
                    <SelectTrigger className="bg-secondary border-border">
                      <SelectValue placeholder="Select scope" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Total Portfolio</SelectItem>
                      {subsidiaries.map((sub) => (
                        <SelectItem key={sub.id} value={sub.name}>{sub.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Timeframe */}
                <div className="flex-1 min-w-[150px]">
                  <Label className="text-xs text-muted-foreground mb-1.5 block">Timeframe</Label>
                  <Select
                    value={config.timeframe}
                    onValueChange={(value) => setConfig({ ...config, timeframe: value })}
                  >
                    <SelectTrigger className="bg-secondary border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Q1 2024">Q1 2024</SelectItem>
                      <SelectItem value="Q4 2023">Q4 2023</SelectItem>
                      <SelectItem value="Q3 2023">Q3 2023</SelectItem>
                      <SelectItem value="2023">Full Year 2023</SelectItem>
                      <SelectItem value="2022">Full Year 2022</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Inclusion Options */}
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="includeScope3"
                      checked={config.includeScope3}
                      onCheckedChange={(checked) => setConfig({ ...config, includeScope3: !!checked })}
                    />
                    <Label htmlFor="includeScope3" className="text-xs text-muted-foreground cursor-pointer">
                      Include Scope 3
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="includeMethodology"
                      checked={config.includeMethodologyNotes}
                      onCheckedChange={(checked) => setConfig({ ...config, includeMethodologyNotes: !!checked })}
                    />
                    <Label htmlFor="includeMethodology" className="text-xs text-muted-foreground cursor-pointer">
                      Methodology Notes
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="includeEvidence"
                      checked={config.includeEvidenceLinks}
                      onCheckedChange={(checked) => setConfig({ ...config, includeEvidenceLinks: !!checked })}
                    />
                    <Label htmlFor="includeEvidence" className="text-xs text-muted-foreground cursor-pointer">
                      Evidence Links
                    </Label>
                  </div>
                </div>

                {/* Generate Button */}
                <Button onClick={handleGenerate} className="bg-primary hover:bg-primary/90">
                  <FileText className="h-4 w-4 mr-2" />
                  Generate
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Incomplete Data Warning */}
          {hasIncompleteDataWarning && pageState === 'preview' && (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-[#F6DFA1]/20 border border-[#F6DFA1]/40">
              <AlertTriangle className="h-5 w-5 text-[#8A641C] shrink-0" />
              <p className="text-sm text-[#8A641C]">
                Warning: This report contains incomplete data ({incompletePercentage.toFixed(0)}% of records are in draft, submitted, or under review status) and is not suitable for final reporting use.
              </p>
            </div>
          )}

          {/* Main Content Area */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Report Preview Canvas - 3/4 width */}
            <div className="lg:col-span-3">
              <Card className="border-border bg-card min-h-[800px]">
                <CardContent className="p-0">
                  {/* Empty State */}
                  {pageState === 'empty' && (
                    <div className="flex flex-col items-center justify-center h-[800px] text-center p-8">
                      <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4">
                        <FileText className="h-8 w-8 text-muted-foreground" />
                      </div>
                      <h3 className="text-lg font-medium text-foreground mb-2">No Report Generated</h3>
                      <p className="text-sm text-muted-foreground max-w-md">
                        Configure your report parameters above and click Generate to preview your disclosure.
                      </p>
                    </div>
                  )}

                  {/* Processing State */}
                  {pageState === 'processing' && (
                    <div className="flex flex-col items-center justify-center h-[800px] text-center p-8">
                      <Loader2 className="h-12 w-12 text-primary animate-spin mb-4" />
                      <h3 className="text-lg font-medium text-foreground mb-2">Generating Report</h3>
                      <p className="text-sm text-muted-foreground">
                        Aggregating selected categories and subsidiaries...
                      </p>
                    </div>
                  )}

                  {/* Preview State */}
                  {pageState === 'preview' && (
                    <div className="bg-white text-slate-900 shadow-xl mx-auto my-6 max-w-[800px] rounded-lg overflow-hidden">
                      {/* Report Header */}
                      <div className="bg-emerald-700 text-white p-6">
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-lg bg-white/20 flex items-center justify-center">
                              <Leaf className="h-6 w-6 text-white" />
                            </div>
                            <div>
                              <h2 className="text-xl font-semibold">TonyAI</h2>
                              <p className="text-emerald-200 text-sm">Sustainability Platform</p>
                            </div>
                          </div>
                          <StatusBadge status={reportStatus} />
                        </div>
                        <div className="mt-6">
                          <h1 className="text-2xl font-bold">
                            {REPORT_TEMPLATES.find(t => t.id === config.template)?.name}
                          </h1>
                          <div className="flex items-center gap-4 mt-2 text-emerald-200 text-sm">
                            <span className="flex items-center gap-1">
                              <Calendar className="h-4 w-4" />
                              {config.timeframe}
                            </span>
                            <span className="flex items-center gap-1">
                              <Building2 className="h-4 w-4" />
                              {config.organisationScope.length === 0 ? 'Total Portfolio' : config.organisationScope.join(', ')}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Executive Summary Section */}
                      <div className="p-6">
                        <h3 className="text-lg font-semibold text-slate-900 mb-4">Executive Summary</h3>
                        
                        {/* Main Metrics */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                          <div className="p-4 bg-slate-50 rounded-lg">
                            <p className="text-xs text-slate-500 uppercase tracking-wide">Total Emissions</p>
                            <p className="text-2xl font-bold text-slate-900 mt-1">{formatNumber(scopeTotals.total)}</p>
                            <p className="text-xs text-slate-500">tCO2e</p>
                          </div>
                          <div className="p-4 bg-emerald-50 rounded-lg">
                            <p className="text-xs text-slate-500 uppercase tracking-wide">Scope 1</p>
                            <p className="text-2xl font-bold text-emerald-700 mt-1">{formatNumber(scopeTotals.scope1)}</p>
                            <p className="text-xs text-slate-500">tCO2e</p>
                          </div>
                          <div className="p-4 bg-blue-50 rounded-lg">
                            <p className="text-xs text-slate-500 uppercase tracking-wide">Scope 2</p>
                            <p className="text-2xl font-bold text-blue-700 mt-1">{formatNumber(scopeTotals.scope2)}</p>
                            <p className="text-xs text-slate-500">tCO2e</p>
                          </div>
                          {config.includeScope3 && (
                            <div className="p-4 bg-amber-50 rounded-lg">
                              <p className="text-xs text-slate-500 uppercase tracking-wide">Scope 3</p>
                              <p className="text-2xl font-bold text-amber-700 mt-1">{formatNumber(scopeTotals.scope3)}</p>
                              <p className="text-xs text-slate-500">tCO2e</p>
                            </div>
                          )}
                        </div>

                        {/* YoY Comparison */}
                        <div className="flex items-center gap-2 p-3 bg-emerald-50 rounded-lg mb-6">
                          <TrendingDown className="h-5 w-5 text-emerald-600" />
                          <span className="text-sm text-slate-700">
                            <span className="font-semibold text-emerald-600">-8.2%</span> compared to baseline
                          </span>
                        </div>

                        {/* Charts */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                          {/* Scope Distribution Donut */}
                          <div>
                            <h4 className="text-sm font-medium text-slate-700 mb-3">Scope Distribution</h4>
                            <div className="h-[200px]">
                              <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                  <Pie
                                    data={scopeDistribution}
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={50}
                                    outerRadius={80}
                                    paddingAngle={2}
                                    dataKey="value"
                                  >
                                    {scopeDistribution.map((entry, index) => (
                                      <Cell key={`cell-${index}`} fill={entry.fill} />
                                    ))}
                                  </Pie>
                                  <Tooltip
                                    formatter={(value: number) => [`${formatNumber(value)} tCO2e`, '']}
                                    contentStyle={{
                                      backgroundColor: '#1e293b',
                                      border: 'none',
                                      borderRadius: '8px',
                                      color: '#f8fafc',
                                    }}
                                  />
                                  <Legend />
                                </PieChart>
                              </ResponsiveContainer>
                            </div>
                          </div>

                          {/* Top Contributors Bar */}
                          <div>
                            <h4 className="text-sm font-medium text-slate-700 mb-3">Top Contributors</h4>
                            <div className="h-[200px]">
                              <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={topContributors} layout="vertical">
                                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                                  <XAxis type="number" tick={{ fontSize: 10, fill: '#64748b' }} />
                                  <YAxis
                                    dataKey="name"
                                    type="category"
                                    width={100}
                                    tick={{ fontSize: 10, fill: '#64748b' }}
                                  />
                                  <Tooltip
                                    formatter={(value: number) => [`${formatNumber(value)} tCO2e`, 'Emissions']}
                                    contentStyle={{
                                      backgroundColor: '#1e293b',
                                      border: 'none',
                                      borderRadius: '8px',
                                      color: '#f8fafc',
                                    }}
                                  />
                                  <Bar dataKey="emissions" fill="#4FAF8F" radius={[0, 4, 4, 0]} />
                                </BarChart>
                              </ResponsiveContainer>
                            </div>
                          </div>
                        </div>

                        <Separator className="my-6" />

                        {/* Detailed Breakdown Section */}
                        <h3 className="text-lg font-semibold text-slate-900 mb-4">Category Breakdown</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-slate-200">
                                <th className="text-left py-2 px-3 font-medium text-slate-600">Category</th>
                                <th className="text-left py-2 px-3 font-medium text-slate-600">Scope</th>
                                <th className="text-right py-2 px-3 font-medium text-slate-600">Emissions (tCO2e)</th>
                                <th className="text-right py-2 px-3 font-medium text-slate-600">% of Total</th>
                                <th className="text-right py-2 px-3 font-medium text-slate-600">Data Quality</th>
                              </tr>
                            </thead>
                            <tbody>
                              {categoryEmissions
                                .filter(c => c.absoluteEmissions > 0)
                                .sort((a, b) => b.absoluteEmissions - a.absoluteEmissions)
                                .map((cat) => (
                                  <tr key={cat.category} className="border-b border-slate-100">
                                    <td className="py-2 px-3 text-slate-900">{cat.category}</td>
                                    <td className="py-2 px-3">
                                      <Badge variant="outline" className={cn(
                                        'text-xs',
                                        cat.scope === 1 && 'border-[#8FB7E8]/60 text-[#24597A] bg-[#DCEEF7]',
                                        cat.scope === 2 && 'border-[#8ED1C2]/60 text-[#2F6B45] bg-[#8ED1C2]/20',
                                        cat.scope === 3 && 'border-[#C7B5E8]/60 text-[#6B5B95] bg-[#C7B5E8]/20'
                                      )}>
                                        Scope {cat.scope}
                                      </Badge>
                                    </td>
                                    <td className="py-2 px-3 text-right font-medium text-slate-900">
                                      {formatNumber(cat.absoluteEmissions)}
                                    </td>
                                    <td className="py-2 px-3 text-right text-slate-600">
                                      {cat.percentOfTotal.toFixed(1)}%
                                    </td>
                                    <td className="py-2 px-3 text-right">
                                      <div className="flex items-center justify-end gap-2">
                                        <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                          <div
                                            className={cn(
                                              'h-full rounded-full',
                                              cat.dataQualityScore >= 80 && 'bg-[#4FAF8F]',
                                              cat.dataQualityScore >= 50 && cat.dataQualityScore < 80 && 'bg-[#F6DFA1]',
                                              cat.dataQualityScore < 50 && 'bg-[#F2B8B5]'
                                            )}
                                            style={{ width: `${cat.dataQualityScore}%` }}
                                          />
                                        </div>
                                        <span className="text-xs text-slate-500">{cat.dataQualityScore}%</span>
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>

                        <Separator className="my-6" />

                        {/* Subsidiary Performance */}
                        <h3 className="text-lg font-semibold text-slate-900 mb-4">Subsidiary Performance</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-slate-200">
                                <th className="text-left py-2 px-3 font-medium text-slate-600">Subsidiary</th>
                                <th className="text-right py-2 px-3 font-medium text-slate-600">Total tCO2e</th>
                                <th className="text-right py-2 px-3 font-medium text-slate-600">Completion</th>
                                <th className="text-center py-2 px-3 font-medium text-slate-600">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {subsidiaries
                                .sort((a, b) => b.totalEmissions - a.totalEmissions)
                                .map((sub) => (
                                  <tr key={sub.id} className="border-b border-slate-100">
                                    <td className="py-2 px-3 text-slate-900">{sub.name}</td>
                                    <td className="py-2 px-3 text-right font-medium text-slate-900">
                                      {formatNumber(sub.totalEmissions)}
                                    </td>
                                    <td className="py-2 px-3 text-right">
                                      <div className="flex items-center justify-end gap-2">
                                        <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                          <div
                                            className="h-full bg-[#4FAF8F] rounded-full"
                                            style={{ width: `${sub.completionRate}%` }}
                                          />
                                        </div>
                                        <span className="text-xs text-slate-500">{sub.completionRate}%</span>
                                      </div>
                                    </td>
                                    <td className="py-2 px-3 text-center">
                                      {sub.completionRate === 100 ? (
                                        <CheckCircle2 className="h-4 w-4 text-[#4FAF8F] inline" />
                                      ) : (
                                        <FileWarning className="h-4 w-4 text-[#8A641C] inline" />
                                      )}
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Methodology Appendix */}
                        {config.includeMethodologyNotes && (
                          <>
                            <Separator className="my-6" />
                            <h3 className="text-lg font-semibold text-slate-900 mb-4">Methodology Appendix</h3>
                            <div className="bg-slate-50 rounded-lg p-4 space-y-3">
                              <div>
                                <p className="text-xs text-slate-500 uppercase tracking-wide">Factor Sources Used</p>
                                <div className="flex flex-wrap gap-2 mt-1">
                                  {METHODOLOGY_SOURCES.slice(0, 3).map((source) => (
                                    <Badge key={source.id} variant="outline" className="text-xs bg-white">
                                      {source.name} ({source.version})
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <p className="text-xs text-slate-500 uppercase tracking-wide">Applied Methodology</p>
                                <p className="text-sm text-slate-700 mt-1">GHG Protocol Corporate Standard</p>
                              </div>
                              <div>
                                <p className="text-xs text-slate-500 uppercase tracking-wide">Reporting Boundary</p>
                                <p className="text-sm text-slate-700 mt-1">Operational control approach</p>
                              </div>
                              <div className="pt-2 border-t border-slate-200">
                                <p className="text-xs text-slate-500 italic">
                                  This report has been generated for internal review purposes. Data quality indicators are based on record approval status and evidence completeness.
                                </p>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Right Side Actions - 1/4 width */}
            <div className="space-y-4">
              {/* Export Actions */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Export & Actions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    disabled={pageState !== 'preview'}
                    onClick={handleDownloadPDF}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download PDF
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    disabled={pageState !== 'preview'}
                    onClick={handleExportExcel}
                  >
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                    Export Excel
                  </Button>
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button
                        variant="outline"
                        className="w-full justify-start"
                        disabled={pageState !== 'preview'}
                      >
                        <Share2 className="h-4 w-4 mr-2" />
                        Share Report
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="bg-card border-border">
                      <DialogHeader>
                        <DialogTitle>Share Report</DialogTitle>
                        <DialogDescription>
                          Share this report with stakeholders or auditors
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label>Report Link</Label>
                          <div className="flex gap-2">
                            <Input
                              value="https://tonyai.app/reports/rpt-2024-q1-exec..."
                              readOnly
                              className="bg-secondary"
                            />
                            <Button variant="outline" size="icon">
                              <Copy className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>Send via Email</Label>
                          <div className="flex gap-2">
                            <Input
                              type="email"
                              placeholder="email@example.com"
                              value={shareEmail}
                              onChange={(e) => setShareEmail(e.target.value)}
                              className="bg-secondary"
                            />
                            <Button onClick={handleShare}>
                              <Mail className="h-4 w-4 mr-2" />
                              Send
                            </Button>
                          </div>
                        </div>
                      </div>
                    </DialogContent>
                  </Dialog>
                </CardContent>
              </Card>

              {/* Generation History */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Recent Reports</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {generationLog.map((log) => (
                    <div
                      key={log.id}
                      className="p-3 rounded-lg bg-secondary/50 border border-border space-y-2"
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-sm font-medium text-foreground">
                            {REPORT_TEMPLATES.find(t => t.id === log.template)?.name}
                          </p>
                          <p className="text-xs text-muted-foreground">{log.reportingPeriod}</p>
                        </div>
                        <StatusBadge status={log.status} />
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{log.generatedBy}</span>
                        <span>{new Date(log.generatedAt).toLocaleDateString()}</span>
                      </div>
                      {log.exportType && (
                        <Badge variant="outline" className="text-xs">
                          {log.exportType.toUpperCase()}
                        </Badge>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
