'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Subsidiary } from '@/lib/types';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

interface EmissionsChartsProps {
  subsidiaries: Subsidiary[];
}

// TonyAI Premium Color Palette
const COLORS = {
  complete: '#A9D8B8',
  incomplete: '#F6DFA1',
  missing: '#F2B8B5',
  primary: '#4FAF8F',
  bars: '#5AA9E6',
  chartHighlight: '#7A9CC6',
};

export function EmissionsCharts({ subsidiaries }: EmissionsChartsProps) {
  // Emissions by subsidiary data
  const emissionsBySubsidiary = subsidiaries.map((sub) => ({
    name: sub.shortName,
    emissions: sub.totalEmissions,
    fullName: sub.name,
  }));

  // Status distribution data
  const statusCounts = subsidiaries.reduce(
    (acc, sub) => {
      sub.categories.forEach((cat) => {
        acc[cat.status]++;
      });
      return acc;
    },
    { complete: 0, incomplete: 0, missing: 0 }
  );

  const total = statusCounts.complete + statusCounts.incomplete + statusCounts.missing;

  const statusDistribution = [
    { name: 'Complete', value: statusCounts.complete, color: COLORS.complete, percent: Math.round((statusCounts.complete / total) * 100) },
    { name: 'Partial', value: statusCounts.incomplete, color: COLORS.incomplete, percent: Math.round((statusCounts.incomplete / total) * 100) },
    { name: 'Missing', value: statusCounts.missing, color: COLORS.missing, percent: Math.round((statusCounts.missing / total) * 100) },
  ];

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="rounded-xl border border-border bg-white p-3 shadow-lg">
          <p className="text-sm font-medium text-foreground">{label || payload[0].payload.fullName || payload[0].payload.name}</p>
          <p className="text-sm text-muted-foreground font-mono">
            {payload[0].value.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} tCO₂e
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <Card className="border-border bg-white rounded-[18px] shadow-sm h-full">
      <CardHeader className="pb-3 px-5 pt-5">
        <CardTitle className="text-base font-semibold text-foreground">
          Emissions Overview
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className="grid gap-6 lg:grid-cols-5">
          {/* Emissions by Subsidiary - Bar Chart */}
          <div className="lg:col-span-3">
            <p className="text-xs text-muted-foreground mb-3">By Subsidiary (tCO₂e)</p>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={emissionsBySubsidiary} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#DCE3EA" strokeOpacity={0.5} vertical={false} />
                  <XAxis 
                    dataKey="name" 
                    tick={{ fill: '#5B6675', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis 
                    tick={{ fill: '#5B6675', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(value) => `${(value / 1000).toFixed(0)}k`}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: '#EEF2F6', opacity: 0.5 }} />
                  <Bar 
                    dataKey="emissions" 
                    fill={COLORS.bars}
                    radius={[6, 6, 0, 0]}
                    maxBarSize={40}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Status Distribution - Donut */}
          <div className="lg:col-span-2">
            <p className="text-xs text-muted-foreground mb-3">Data Status</p>
            <div className="h-[200px] relative">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusDistribution}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={75}
                    paddingAngle={3}
                    dataKey="value"
                    strokeWidth={0}
                  >
                    {statusDistribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              {/* Center label */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center">
                  <span className="text-2xl font-bold text-foreground font-mono">{total}</span>
                  <span className="block text-xs text-muted-foreground">categories</span>
                </div>
              </div>
            </div>
            {/* Legend */}
            <div className="flex justify-center gap-4 mt-2">
              {statusDistribution.map((item) => (
                <div key={item.name} className="flex items-center gap-1.5">
                  <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="text-xs text-muted-foreground">
                    {item.name} <span className="font-medium text-foreground font-mono">{item.percent}%</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
