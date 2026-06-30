import type { DataSubmission, FieldGroup, UserRole } from './types';

export const currentUser = {
  id: 'user-1',
  name: 'Sarah Chen',
  email: 'sarah.chen@greentech.com',
  role: 'consultant' as UserRole,
  assignedSubsidiaries: ['sub-1', 'sub-2', 'sub-3'],
};

export const subsidiaries = [
  { id: 'sub-1', name: 'GreenTech Manufacturing', shortName: 'GTM' },
  { id: 'sub-2', name: 'EcoLogistics Corp', shortName: 'ELC' },
  { id: 'sub-3', name: 'SolarPower Industries', shortName: 'SPI' },
  { id: 'sub-4', name: 'CleanWater Solutions', shortName: 'CWS' },
  { id: 'sub-5', name: 'WindEnergy Systems', shortName: 'WES' },
];

export const locations = [
  { id: 'loc-1', subsidiaryId: 'sub-1', name: 'Berlin Headquarters', country: 'Germany' },
  { id: 'loc-2', subsidiaryId: 'sub-1', name: 'Munich Plant', country: 'Germany' },
  { id: 'loc-3', subsidiaryId: 'sub-2', name: 'Hamburg Warehouse', country: 'Germany' },
  { id: 'loc-4', subsidiaryId: 'sub-3', name: 'Frankfurt Office', country: 'Germany' },
  { id: 'loc-5', subsidiaryId: 'sub-4', name: 'Stuttgart Facility', country: 'Germany' },
];

export const categoryFieldGroups: Record<string, FieldGroup[]> = {
  'Electricity': [
    {
      id: 'consumption',
      name: 'Electricity Consumption',
      description: 'Enter your electricity consumption data from utility bills',
      fields: [
        { id: 'total_kwh', name: 'total_kwh', type: 'number', label: 'Total Consumption', placeholder: 'Enter total kWh', required: true, unit: 'kWh', helperText: 'Total electricity consumed during the reporting period' },
        { id: 'renewable_kwh', name: 'renewable_kwh', type: 'number', label: 'Renewable Energy', placeholder: 'Enter renewable kWh', required: false, unit: 'kWh', helperText: 'Portion from certified renewable sources' },
        { id: 'grid_region', name: 'grid_region', type: 'select', label: 'Grid Region', required: true, options: ['Germany - National Grid', 'Germany - Regional (North)', 'Germany - Regional (South)', 'EU Average'], helperText: 'Select the electricity grid region for emission factor' },
      ],
    },
    {
      id: 'billing',
      name: 'Billing Information',
      fields: [
        { id: 'billing_period_start', name: 'billing_period_start', type: 'date', label: 'Billing Period Start', required: true },
        { id: 'billing_period_end', name: 'billing_period_end', type: 'date', label: 'Billing Period End', required: true },
        { id: 'utility_provider', name: 'utility_provider', type: 'text', label: 'Utility Provider', placeholder: 'e.g., E.ON, Vattenfall', required: false },
      ],
    },
    {
      id: 'documentation',
      name: 'Supporting Documentation',
      fields: [
        { id: 'utility_bills', name: 'utility_bills', type: 'file', label: 'Upload Utility Bills', required: false, helperText: 'PDF or image files of electricity bills' },
        { id: 'notes', name: 'notes', type: 'textarea', label: 'Additional Notes', placeholder: 'Any relevant comments or explanations...', required: false },
      ],
    },
  ],
  'Fuel': [
    {
      id: 'stationary_combustion',
      name: 'Stationary Combustion',
      description: 'Fuel used for heating, generators, and other stationary equipment',
      fields: [
        { id: 'fuel_type', name: 'fuel_type', type: 'select', label: 'Fuel Type', required: true, options: ['Natural Gas', 'Diesel', 'Heating Oil', 'LPG', 'Coal', 'Biomass'] },
        { id: 'quantity', name: 'quantity', type: 'number', label: 'Quantity', placeholder: 'Enter amount', required: true },
        { id: 'quantity_unit', name: 'quantity_unit', type: 'select', label: 'Unit', required: true, options: ['Liters', 'Cubic Meters', 'Tonnes', 'kWh'] },
        { id: 'purpose', name: 'purpose', type: 'select', label: 'Purpose', required: true, options: ['Heating', 'Power Generation', 'Industrial Process', 'Other'] },
      ],
    },
    {
      id: 'fuel_documentation',
      name: 'Documentation',
      fields: [
        { id: 'fuel_receipts', name: 'fuel_receipts', type: 'file', label: 'Upload Fuel Receipts', required: false },
        { id: 'fuel_notes', name: 'fuel_notes', type: 'textarea', label: 'Notes', placeholder: 'Additional context...', required: false },
      ],
    },
  ],
  'Business Travel': [
    {
      id: 'air_travel',
      name: 'Air Travel',
      description: 'Flights taken for business purposes',
      fields: [
        { id: 'short_haul_km', name: 'short_haul_km', type: 'number', label: 'Short-haul Flights (<1500km)', placeholder: 'Total kilometers', required: false, unit: 'km' },
        { id: 'medium_haul_km', name: 'medium_haul_km', type: 'number', label: 'Medium-haul Flights (1500-4000km)', placeholder: 'Total kilometers', required: false, unit: 'km' },
        { id: 'long_haul_km', name: 'long_haul_km', type: 'number', label: 'Long-haul Flights (>4000km)', placeholder: 'Total kilometers', required: false, unit: 'km' },
        { id: 'travel_class', name: 'travel_class', type: 'select', label: 'Predominant Travel Class', required: true, options: ['Economy', 'Business', 'First Class', 'Mixed'] },
      ],
    },
    {
      id: 'ground_travel',
      name: 'Ground Transportation',
      fields: [
        { id: 'rental_car_km', name: 'rental_car_km', type: 'number', label: 'Rental Car Distance', placeholder: 'Total kilometers', required: false, unit: 'km' },
        { id: 'train_km', name: 'train_km', type: 'number', label: 'Train Distance', placeholder: 'Total kilometers', required: false, unit: 'km' },
        { id: 'taxi_km', name: 'taxi_km', type: 'number', label: 'Taxi/Ride-share Distance', placeholder: 'Total kilometers', required: false, unit: 'km' },
      ],
    },
    {
      id: 'travel_documentation',
      name: 'Documentation',
      fields: [
        { id: 'travel_reports', name: 'travel_reports', type: 'file', label: 'Upload Travel Reports', required: false },
        { id: 'expense_reports', name: 'expense_reports', type: 'file', label: 'Upload Expense Reports', required: false },
      ],
    },
  ],
  'Waste': [
    {
      id: 'waste_volumes',
      name: 'Waste Volumes',
      description: 'Waste generated and disposal methods',
      fields: [
        { id: 'general_waste_tonnes', name: 'general_waste_tonnes', type: 'number', label: 'General Waste', placeholder: 'Enter tonnes', required: true, unit: 'tonnes' },
        { id: 'recycled_waste_tonnes', name: 'recycled_waste_tonnes', type: 'number', label: 'Recycled Waste', placeholder: 'Enter tonnes', required: true, unit: 'tonnes' },
        { id: 'hazardous_waste_tonnes', name: 'hazardous_waste_tonnes', type: 'number', label: 'Hazardous Waste', placeholder: 'Enter tonnes', required: false, unit: 'tonnes' },
        { id: 'disposal_method', name: 'disposal_method', type: 'select', label: 'Primary Disposal Method', required: true, options: ['Landfill', 'Incineration', 'Recycling', 'Composting', 'Mixed'] },
      ],
    },
    {
      id: 'waste_documentation',
      name: 'Documentation',
      fields: [
        { id: 'waste_manifests', name: 'waste_manifests', type: 'file', label: 'Upload Waste Manifests', required: false },
        { id: 'waste_notes', name: 'waste_notes', type: 'textarea', label: 'Notes', placeholder: 'Waste management details...', required: false },
      ],
    },
  ],
  'Water': [
    {
      id: 'water_consumption',
      name: 'Water Consumption',
      description: 'Water usage from all sources',
      fields: [
        { id: 'municipal_water_m3', name: 'municipal_water_m3', type: 'number', label: 'Municipal Water', placeholder: 'Enter cubic meters', required: true, unit: 'm³' },
        { id: 'groundwater_m3', name: 'groundwater_m3', type: 'number', label: 'Groundwater', placeholder: 'Enter cubic meters', required: false, unit: 'm³' },
        { id: 'recycled_water_m3', name: 'recycled_water_m3', type: 'number', label: 'Recycled Water', placeholder: 'Enter cubic meters', required: false, unit: 'm³' },
      ],
    },
    {
      id: 'water_documentation',
      name: 'Documentation',
      fields: [
        { id: 'water_bills', name: 'water_bills', type: 'file', label: 'Upload Water Bills', required: false },
      ],
    },
  ],
  'Logistics': [
    {
      id: 'freight',
      name: 'Freight Transport',
      description: 'Goods transportation by various modes',
      fields: [
        { id: 'road_freight_tkm', name: 'road_freight_tkm', type: 'number', label: 'Road Freight', placeholder: 'Enter tonne-kilometers', required: true, unit: 'tkm', helperText: 'Weight in tonnes × distance in km' },
        { id: 'rail_freight_tkm', name: 'rail_freight_tkm', type: 'number', label: 'Rail Freight', placeholder: 'Enter tonne-kilometers', required: false, unit: 'tkm' },
        { id: 'sea_freight_tkm', name: 'sea_freight_tkm', type: 'number', label: 'Sea Freight', placeholder: 'Enter tonne-kilometers', required: false, unit: 'tkm' },
        { id: 'air_freight_tkm', name: 'air_freight_tkm', type: 'number', label: 'Air Freight', placeholder: 'Enter tonne-kilometers', required: false, unit: 'tkm' },
      ],
    },
    {
      id: 'logistics_documentation',
      name: 'Documentation',
      fields: [
        { id: 'shipping_records', name: 'shipping_records', type: 'file', label: 'Upload Shipping Records', required: false },
        { id: 'logistics_notes', name: 'logistics_notes', type: 'textarea', label: 'Notes', placeholder: 'Logistics details...', required: false },
      ],
    },
  ],
};

// Default field groups for categories not explicitly defined
export const defaultFieldGroups: FieldGroup[] = [
  {
    id: 'activity_data',
    name: 'Activity Data',
    description: 'Enter the primary activity data for this category',
    fields: [
      { id: 'activity_value', name: 'activity_value', type: 'number', label: 'Activity Value', placeholder: 'Enter value', required: true },
      { id: 'activity_unit', name: 'activity_unit', type: 'select', label: 'Unit', required: true, options: ['kWh', 'MWh', 'Liters', 'Tonnes', 'km', 'm³'] },
    ],
  },
  {
    id: 'documentation',
    name: 'Documentation',
    fields: [
      { id: 'supporting_docs', name: 'supporting_docs', type: 'file', label: 'Upload Supporting Documents', required: false },
      { id: 'notes', name: 'notes', type: 'textarea', label: 'Notes', placeholder: 'Additional notes...', required: false },
    ],
  },
];

export const sampleSubmission: DataSubmission = {
  id: 'submission-1',
  reportingYear: 2024,
  reportingPeriod: 'quarterly',
  periodValue: 'Q1',
  subsidiaryId: 'sub-1',
  subsidiaryName: 'GreenTech Manufacturing',
  locationId: 'loc-1',
  locationName: 'Berlin Headquarters',
  category: 'Electricity',
  status: 'incomplete',
  submissionStatus: 'draft',
  responsibleUser: 'Sarah Chen',
  lastSaved: '2024-03-15T14:30:00Z',
  fieldGroups: categoryFieldGroups['Electricity'].map(group => ({
    ...group,
    fields: group.fields.map(field => ({
      ...field,
      value: field.id === 'total_kwh' ? 45000 : field.id === 'grid_region' ? 'Germany - National Grid' : null,
    })),
  })),
  calculationPreview: {
    activityData: 45000,
    activityUnit: 'kWh',
    emissionFactor: 0.366,
    emissionFactorUnit: 'kg CO₂e/kWh',
    estimatedEmissions: 16.47,
    emissionsUnit: 'tCO₂e',
    methodology: 'GHG Protocol Scope 2 (Location-based)',
  },
  comments: [
    {
      id: 'comment-1',
      author: 'Michael Weber',
      role: 'super_admin',
      content: 'Please verify the renewable energy portion with the utility provider certificate.',
      timestamp: '2024-03-14T09:15:00Z',
    },
    {
      id: 'comment-2',
      author: 'Sarah Chen',
      role: 'consultant',
      content: 'Waiting for Q1 utility bill from facilities team. Expected by end of week.',
      timestamp: '2024-03-15T11:30:00Z',
    },
  ],
  versionHistory: [
    {
      id: 'version-3',
      version: 3,
      author: 'Sarah Chen',
      timestamp: '2024-03-15T14:30:00Z',
      changes: 'Updated total consumption based on February bill',
      status: 'draft',
    },
    {
      id: 'version-2',
      version: 2,
      author: 'Sarah Chen',
      timestamp: '2024-03-10T10:00:00Z',
      changes: 'Added January consumption data',
      status: 'draft',
    },
    {
      id: 'version-1',
      version: 1,
      author: 'Sarah Chen',
      timestamp: '2024-03-01T09:00:00Z',
      changes: 'Initial submission created',
      status: 'draft',
    },
  ],
  attachments: ['january_bill.pdf', 'february_bill.pdf'],
};

export const previousSubmissions: Array<{
  id: string;
  period: string;
  category: string;
  status: DataSubmission['status'];
  submissionStatus: DataSubmission['submissionStatus'];
  emissions: number | null;
  lastUpdated: string;
}> = [
  { id: 'prev-1', period: 'Q4 2023', category: 'Electricity', status: 'complete', submissionStatus: 'approved', emissions: 18.2, lastUpdated: '2024-01-15' },
  { id: 'prev-2', period: 'Q3 2023', category: 'Electricity', status: 'complete', submissionStatus: 'approved', emissions: 15.8, lastUpdated: '2023-10-12' },
  { id: 'prev-3', period: 'Q2 2023', category: 'Electricity', status: 'complete', submissionStatus: 'approved', emissions: 14.5, lastUpdated: '2023-07-10' },
  { id: 'prev-4', period: 'Q1 2023', category: 'Electricity', status: 'complete', submissionStatus: 'approved', emissions: 17.1, lastUpdated: '2023-04-08' },
];
