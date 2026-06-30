import { Subsidiary, KPIData, Alert, DataStatus, CATEGORIES, CATEGORY_SCOPE_MAP, Category } from './types';

// Fully static subsidiary data to prevent hydration mismatches
export const subsidiaries: Subsidiary[] = [
  {
    id: 'sub-001',
    name: 'Energy Company A',
    shortName: 'ECA',
    sector: 'Energy',
    totalEmissions: 85420,
    completionRate: 78,
    categories: [
      { category: 'Electricity', status: 'complete', lastUpdate: '2024-03-26T10:30:00Z', responsible: 'Operations', calculationComplete: true, emission: 12750 },
      { category: 'Natural Gas', status: 'complete', lastUpdate: '2024-03-23T10:30:00Z', responsible: 'Finance', calculationComplete: true, emission: 9775 },
      { category: 'Fuel', status: 'complete', lastUpdate: '2024-03-20T10:30:00Z', responsible: 'Sustainability', calculationComplete: false, emission: null },
      { category: 'Mobile Combustion', status: 'complete', lastUpdate: '2024-03-16T10:30:00Z', responsible: 'HR', calculationComplete: true, emission: 7040 },
      { category: 'Refrigerants', status: 'complete', lastUpdate: '2024-03-13T10:30:00Z', responsible: 'Logistics', calculationComplete: true, emission: 2090 },
      { category: 'Purchased Goods', status: 'complete', lastUpdate: '2024-03-10T10:30:00Z', responsible: 'Procurement', calculationComplete: false, emission: null },
      { category: 'Waste', status: 'incomplete', lastUpdate: '2024-03-06T10:30:00Z', responsible: 'Operations', calculationComplete: false, emission: null, missingFields: ['Meter readings'] },
      { category: 'Water', status: 'incomplete', lastUpdate: '2024-03-03T10:30:00Z', responsible: 'Finance', calculationComplete: false, emission: null, missingFields: ['Meter readings', 'Invoice copies'] },
      { category: 'Business Travel', status: 'incomplete', lastUpdate: '2024-03-25T10:30:00Z', responsible: 'Sustainability', calculationComplete: false, emission: null, missingFields: ['Meter readings'] },
      { category: 'Commuting', status: 'missing', lastUpdate: null, responsible: 'HR', calculationComplete: false, emission: null },
      { category: 'Logistics', status: 'missing', lastUpdate: null, responsible: 'Logistics', calculationComplete: false, emission: null },
    ],
    notes: 'Primary energy generation subsidiary. Q4 data submission pending review.',
  },
  {
    id: 'sub-002',
    name: 'Gas Distribution Company B',
    shortName: 'GDCB',
    sector: 'Utilities',
    totalEmissions: 62150,
    completionRate: 65,
    categories: [
      { category: 'Electricity', status: 'complete', lastUpdate: '2024-03-23T10:30:00Z', responsible: 'Operations', calculationComplete: true, emission: 17250 },
      { category: 'Natural Gas', status: 'complete', lastUpdate: '2024-03-20T10:30:00Z', responsible: 'Finance', calculationComplete: false, emission: null },
      { category: 'Fuel', status: 'complete', lastUpdate: '2024-03-16T10:30:00Z', responsible: 'Sustainability', calculationComplete: true, emission: 15360 },
      { category: 'Mobile Combustion', status: 'complete', lastUpdate: '2024-03-13T10:30:00Z', responsible: 'HR', calculationComplete: true, emission: 5225 },
      { category: 'Refrigerants', status: 'complete', lastUpdate: '2024-03-10T10:30:00Z', responsible: 'Logistics', calculationComplete: false, emission: null },
      { category: 'Purchased Goods', status: 'incomplete', lastUpdate: '2024-03-06T10:30:00Z', responsible: 'Procurement', calculationComplete: false, emission: null, missingFields: ['Meter readings'] },
      { category: 'Waste', status: 'incomplete', lastUpdate: '2024-03-03T10:30:00Z', responsible: 'Operations', calculationComplete: false, emission: null, missingFields: ['Meter readings', 'Invoice copies'] },
      { category: 'Water', status: 'incomplete', lastUpdate: '2024-03-25T10:30:00Z', responsible: 'Finance', calculationComplete: false, emission: null, missingFields: ['Meter readings'] },
      { category: 'Business Travel', status: 'missing', lastUpdate: null, responsible: 'Sustainability', calculationComplete: false, emission: null },
      { category: 'Commuting', status: 'missing', lastUpdate: null, responsible: 'HR', calculationComplete: false, emission: null },
      { category: 'Logistics', status: 'missing', lastUpdate: null, responsible: 'Logistics', calculationComplete: false, emission: null },
    ],
    notes: 'Natural gas distribution network. Scope 3 calculations in progress.',
  },
  {
    id: 'sub-003',
    name: 'Manufacturing Company C',
    shortName: 'MCC',
    sector: 'Manufacturing',
    totalEmissions: 124800,
    completionRate: 82,
    categories: [
      { category: 'Electricity', status: 'complete', lastUpdate: '2024-03-20T10:30:00Z', responsible: 'Operations', calculationComplete: false, emission: null },
      { category: 'Natural Gas', status: 'complete', lastUpdate: '2024-03-16T10:30:00Z', responsible: 'Finance', calculationComplete: true, emission: 10880 },
      { category: 'Fuel', status: 'complete', lastUpdate: '2024-03-13T10:30:00Z', responsible: 'Sustainability', calculationComplete: true, emission: 11400 },
      { category: 'Mobile Combustion', status: 'complete', lastUpdate: '2024-03-10T10:30:00Z', responsible: 'HR', calculationComplete: false, emission: null },
      { category: 'Refrigerants', status: 'complete', lastUpdate: '2024-03-06T10:30:00Z', responsible: 'Logistics', calculationComplete: true, emission: 2904 },
      { category: 'Purchased Goods', status: 'incomplete', lastUpdate: '2024-03-03T10:30:00Z', responsible: 'Procurement', calculationComplete: false, emission: null, missingFields: ['Meter readings'] },
      { category: 'Waste', status: 'incomplete', lastUpdate: '2024-03-25T10:30:00Z', responsible: 'Operations', calculationComplete: false, emission: null, missingFields: ['Meter readings', 'Invoice copies'] },
      { category: 'Water', status: 'incomplete', lastUpdate: '2024-03-21T10:30:00Z', responsible: 'Finance', calculationComplete: false, emission: null, missingFields: ['Meter readings'] },
      { category: 'Business Travel', status: 'missing', lastUpdate: null, responsible: 'Sustainability', calculationComplete: false, emission: null },
      { category: 'Commuting', status: 'missing', lastUpdate: null, responsible: 'HR', calculationComplete: false, emission: null },
      { category: 'Logistics', status: 'missing', lastUpdate: null, responsible: 'Logistics', calculationComplete: false, emission: null },
    ],
    notes: 'Heavy manufacturing operations. High emission intensity noted.',
  },
  {
    id: 'sub-004',
    name: 'Logistics Company D',
    shortName: 'LCD',
    sector: 'Logistics',
    totalEmissions: 48920,
    completionRate: 45,
    categories: [
      { category: 'Electricity', status: 'complete', lastUpdate: '2024-03-16T10:30:00Z', responsible: 'Operations', calculationComplete: true, emission: 19200 },
      { category: 'Natural Gas', status: 'incomplete', lastUpdate: '2024-03-13T10:30:00Z', responsible: 'Finance', calculationComplete: false, emission: null, missingFields: ['Meter readings'] },
      { category: 'Fuel', status: 'incomplete', lastUpdate: '2024-03-10T10:30:00Z', responsible: 'Sustainability', calculationComplete: false, emission: null, missingFields: ['Meter readings', 'Invoice copies'] },
      { category: 'Mobile Combustion', status: 'complete', lastUpdate: '2024-03-06T10:30:00Z', responsible: 'HR', calculationComplete: true, emission: 6600 },
      { category: 'Refrigerants', status: 'incomplete', lastUpdate: '2024-03-03T10:30:00Z', responsible: 'Logistics', calculationComplete: false, emission: null, missingFields: ['Meter readings'] },
      { category: 'Purchased Goods', status: 'incomplete', lastUpdate: '2024-03-25T10:30:00Z', responsible: 'Procurement', calculationComplete: false, emission: null, missingFields: ['Meter readings', 'Invoice copies'] },
      { category: 'Waste', status: 'incomplete', lastUpdate: '2024-03-21T10:30:00Z', responsible: 'Operations', calculationComplete: false, emission: null, missingFields: ['Meter readings'] },
      { category: 'Water', status: 'missing', lastUpdate: null, responsible: 'Finance', calculationComplete: false, emission: null },
      { category: 'Business Travel', status: 'missing', lastUpdate: null, responsible: 'Sustainability', calculationComplete: false, emission: null },
      { category: 'Commuting', status: 'missing', lastUpdate: null, responsible: 'HR', calculationComplete: false, emission: null },
      { category: 'Logistics', status: 'complete', lastUpdate: '2024-03-18T10:30:00Z', responsible: 'Logistics', calculationComplete: true, emission: 23760 },
    ],
    notes: 'Fleet management data partially submitted. Mobile combustion review needed.',
  },
  {
    id: 'sub-005',
    name: 'Trading Company E',
    shortName: 'TCE',
    sector: 'Trading',
    totalEmissions: 12340,
    completionRate: 55,
    categories: [
      { category: 'Electricity', status: 'complete', lastUpdate: '2024-03-13T10:30:00Z', responsible: 'Operations', calculationComplete: true, emission: 14250 },
      { category: 'Natural Gas', status: 'complete', lastUpdate: '2024-03-10T10:30:00Z', responsible: 'Finance', calculationComplete: true, emission: 6120 },
      { category: 'Fuel', status: 'complete', lastUpdate: '2024-03-06T10:30:00Z', responsible: 'Sustainability', calculationComplete: false, emission: null },
      { category: 'Mobile Combustion', status: 'incomplete', lastUpdate: '2024-03-03T10:30:00Z', responsible: 'HR', calculationComplete: false, emission: null, missingFields: ['Meter readings'] },
      { category: 'Refrigerants', status: 'incomplete', lastUpdate: '2024-03-25T10:30:00Z', responsible: 'Logistics', calculationComplete: false, emission: null, missingFields: ['Meter readings', 'Invoice copies'] },
      { category: 'Purchased Goods', status: 'incomplete', lastUpdate: '2024-03-21T10:30:00Z', responsible: 'Procurement', calculationComplete: false, emission: null, missingFields: ['Meter readings'] },
      { category: 'Waste', status: 'missing', lastUpdate: null, responsible: 'Operations', calculationComplete: false, emission: null },
      { category: 'Water', status: 'missing', lastUpdate: null, responsible: 'Finance', calculationComplete: false, emission: null },
      { category: 'Business Travel', status: 'missing', lastUpdate: null, responsible: 'Sustainability', calculationComplete: false, emission: null },
      { category: 'Commuting', status: 'missing', lastUpdate: null, responsible: 'HR', calculationComplete: false, emission: null },
      { category: 'Logistics', status: 'missing', lastUpdate: null, responsible: 'Logistics', calculationComplete: false, emission: null },
    ],
    notes: 'Office-based operations. Low direct emissions footprint.',
  },
];

export function calculateKPIs(subs: Subsidiary[]): KPIData {
  let completedCategories = 0;
  let incompleteCategories = 0;
  let missingCategories = 0;
  let totalEmissions = 0;
  let calculationsComplete = 0;
  let totalCategories = 0;
  
  // Scope-level emissions
  let scope1 = 0;
  let scope2 = 0;
  let scope3 = 0;

  subs.forEach(sub => {
    totalEmissions += sub.totalEmissions;
    sub.categories.forEach(cat => {
      totalCategories++;
      if (cat.status === 'complete') completedCategories++;
      else if (cat.status === 'incomplete') incompleteCategories++;
      else missingCategories++;
      
      if (cat.calculationComplete) calculationsComplete++;
      
      // Calculate scope emissions from category emissions
      if (cat.emission !== null) {
        const scope = CATEGORY_SCOPE_MAP[cat.category as Category];
        if (scope === 1) scope1 += cat.emission;
        else if (scope === 2) scope2 += cat.emission;
        else scope3 += cat.emission;
      }
    });
  });

  const total = scope1 + scope2 + scope3;

  return {
    totalSubsidiaries: subs.length,
    totalLocations: subs.length * 2, // Simulated: avg 2 locations per subsidiary
    completedCategories,
    incompleteCategories,
    missingCategories,
    totalEmissions,
    calculationCompletionRate: Math.round((calculationsComplete / totalCategories) * 100),
    emissions: {
      scope1,
      scope2,
      scope3,
      total,
      scope1Trend: -4.2, // Simulated trends
      scope2Trend: -8.5,
      scope3Trend: 2.1,
      totalTrend: -3.8,
    },
  };
}

export const alerts: Alert[] = [
  {
    id: 'alert-001',
    type: 'error',
    message: 'Missing electricity consumption data for Q4 2024',
    subsidiary: 'Logistics Company D',
    category: 'Electricity',
    timestamp: '2024-03-10T09:15:00Z',
  },
  {
    id: 'alert-002',
    type: 'warning',
    message: 'Incomplete fuel records - missing invoice documentation',
    subsidiary: 'Manufacturing Company C',
    category: 'Fuel',
    timestamp: '2024-03-11T14:30:00Z',
  },
  {
    id: 'alert-003',
    type: 'warning',
    message: 'Business travel data requires validation',
    subsidiary: 'Trading Company E',
    category: 'Business Travel',
    timestamp: '2024-03-09T11:45:00Z',
  },
  {
    id: 'alert-004',
    type: 'info',
    message: 'Annual emissions report ready for review',
    subsidiary: 'Energy Company A',
    timestamp: '2024-03-12T08:00:00Z',
  },
  {
    id: 'alert-005',
    type: 'error',
    message: 'Refrigerant leakage data not submitted',
    subsidiary: 'Gas Distribution Company B',
    category: 'Refrigerants',
    timestamp: '2024-03-08T16:20:00Z',
  },
];

export const reportingYears = ['2024', '2023', '2022', '2021'];
