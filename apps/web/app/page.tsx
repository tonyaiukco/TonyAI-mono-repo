'use client';

import { useState, useMemo } from 'react';
import { Sidebar } from '@/components/dashboard/sidebar';
import { Header } from '@/components/dashboard/header';
import { KPICards } from '@/components/dashboard/kpi-cards';
import { TrackingMatrix } from '@/components/dashboard/tracking-matrix';
import { AlertsPanel } from '@/components/dashboard/alerts-panel';
import { EmissionsCharts } from '@/components/dashboard/emissions-charts';
import { DataTable } from '@/components/dashboard/data-table';
import { SubsidiaryDetail } from '@/components/dashboard/subsidiary-detail';
import { subsidiaries, calculateKPIs, alerts } from '@/lib/data';
import { Subsidiary, DataStatus } from '@/lib/types';

export default function CarbonDashboard() {
  const [selectedYear, setSelectedYear] = useState('2024');
  const [selectedCompany, setSelectedCompany] = useState('all');
  const [selectedPeriod, setSelectedPeriod] = useState('all');
  const [selectedStatus, setSelectedStatus] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSubsidiary, setSelectedSubsidiary] = useState<Subsidiary | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const filteredSubsidiaries = useMemo(() => {
    return subsidiaries.filter((sub) => {
      const matchesSearch = sub.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        sub.shortName.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesCompany = selectedCompany === 'all' || sub.id === selectedCompany;
      
      // Filter by status - check if subsidiary has any categories matching the status
      const matchesStatus = selectedStatus === 'all' || 
        sub.categories.some(cat => cat.status === selectedStatus as DataStatus);
      
      return matchesSearch && matchesCompany && matchesStatus;
    });
  }, [searchQuery, selectedCompany, selectedStatus]);

  const kpiData = useMemo(() => calculateKPIs(filteredSubsidiaries), [filteredSubsidiaries]);

  const handleSubsidiaryClick = (subsidiary: Subsidiary) => {
    setSelectedSubsidiary(subsidiary);
    setDetailOpen(true);
  };

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      
      <main className="ml-[280px] transition-all duration-300">
        <Header
          selectedYear={selectedYear}
          onYearChange={setSelectedYear}
          selectedCompany={selectedCompany}
          onCompanyChange={setSelectedCompany}
          selectedPeriod={selectedPeriod}
          onPeriodChange={setSelectedPeriod}
          selectedStatus={selectedStatus}
          onStatusChange={setSelectedStatus}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />

        <div className="p-6 space-y-6">
          {/* Executive KPI Section - Emissions + Data Status */}
          <KPICards data={kpiData} />

          {/* Hero Section: Tracking Matrix */}
          <TrackingMatrix
            subsidiaries={filteredSubsidiaries}
            onSubsidiaryClick={handleSubsidiaryClick}
          />

          {/* Secondary Content: Alerts + Charts */}
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-1">
              <AlertsPanel alerts={alerts} />
            </div>
            <div className="lg:col-span-2">
              <EmissionsCharts subsidiaries={filteredSubsidiaries} />
            </div>
          </div>

          {/* Detailed Table */}
          <DataTable
            subsidiaries={filteredSubsidiaries}
            onSubsidiaryClick={handleSubsidiaryClick}
          />
        </div>
      </main>

      {/* Subsidiary Detail Sheet */}
      <SubsidiaryDetail
        subsidiary={selectedSubsidiary}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
    </div>
  );
}
