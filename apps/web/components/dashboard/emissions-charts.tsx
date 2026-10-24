'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLocale, useTranslations } from 'use-intl';
import { formatNumber } from '@/lib/i18n/number';
import { axisThousands } from '@/lib/dashboard-view';
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
  /** A Scope 3 selection: Scope 1 + 2 is not covered, so no bar is drawn —
   *  a row of 0 bars would read as measured zeros (Codex B9 P2-2 on PR B). */
  notCovered?: boolean;
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

export function EmissionsCharts({ subsidiaries, notCovered = false }: EmissionsChartsProps) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
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
    { key: 'complete', name: t('status.complete'), value: statusCounts.complete, color: COLORS.complete, percent: total > 0 ? Math.round((statusCounts.complete / total) * 100) : 0 },
    { key: 'incomplete', name: t('status.incomplete'), value: statusCounts.incomplete, color: COLORS.incomplete, percent: total > 0 ? Math.round((statusCounts.incomplete / total) * 100) : 0 },
    { key: 'missing', name: t('status.missing'), value: statusCounts.missing, color: COLORS.missing, percent: total > 0 ? Math.round((statusCounts.missing / total) * 100) : 0 },
  ];

  // Recharts passes its tooltip render prop an internal payload shape that
  // its published types do not export in a usable form.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="rounded-xl border border-border bg-white p-3 shadow-lg">
          <p className="text-sm font-medium text-foreground">{label || payload[0].payload.fullName || payload[0].payload.name}</p>
          <p className="text-sm text-muted-foreground font-mono">
            {t('tonnes', { value: formatNumber(payload[0].value, locale, { maximumFractionDigits: 0 }) })}
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
          {t('overview.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <div className="grid gap-6 lg:grid-cols-5">
          {/* Emissions by Subsidiary - Bar Chart */}
          <div className="lg:col-span-3">
            <p className="text-xs text-muted-foreground mb-3">{t('charts.bySubsidiary')}</p>
            <div className="h-[200px]">
              {notCovered ? (
                <p className="flex h-full items-center justify-center rounded-lg bg-muted/40 px-4 text-center text-sm text-muted-foreground" data-testid="chart-not-covered">
                  {t('totalScope3Only')}
                </p>
              ) : (
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
                    tickFormatter={(value) => axisThousands(value, { t, locale })}
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
              )}
            </div>
          </div>

          {/* Status Distribution - Donut */}
          <div className="lg:col-span-2">
            <p className="text-xs text-muted-foreground mb-3">{t('charts.dataStatus')}</p>
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
                  <span className="text-2xl font-bold text-foreground font-mono">{formatNumber(total, locale)}</span>
                  <span className="block text-xs text-muted-foreground">{t('charts.categories')}</span>
                </div>
              </div>
            </div>
            {/* Legend */}
            <div className="flex justify-center gap-4 mt-2">
              {statusDistribution.map((item) => (
                <div key={item.key} className="flex items-center gap-1.5">
                  <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="text-xs text-muted-foreground">
                    {item.name} <span className="font-medium text-foreground font-mono">{t('percent', { value: item.percent })}</span>
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
