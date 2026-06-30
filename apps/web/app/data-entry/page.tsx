'use client';

import { useState, useCallback } from 'react';
import { EntryHeader } from '@/components/data-entry/entry-header';
import { CategoryNav } from '@/components/data-entry/category-nav';
import { DataForm } from '@/components/data-entry/data-form';
import { StatusSidebar } from '@/components/data-entry/status-sidebar';
import { PreviousSubmissions } from '@/components/data-entry/previous-submissions';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  sampleSubmission,
  categoryFieldGroups,
  defaultFieldGroups,
  locations,
} from '@/lib/data-entry-data';
import type { Category, ReportingPeriod, DataStatus, FieldGroup } from '@/lib/types';
import { CATEGORIES } from '@/lib/types';
import { toast } from 'sonner';

// Mock category statuses
const initialCategoryStatuses: Record<Category, DataStatus> = {
  'Electricity': 'incomplete',
  'Natural Gas': 'missing',
  'Fuel': 'complete',
  'Mobile Combustion': 'missing',
  'Refrigerants': 'missing',
  'Purchased Goods': 'incomplete',
  'Waste': 'complete',
  'Water': 'incomplete',
  'Business Travel': 'missing',
  'Commuting': 'missing',
  'Logistics': 'complete',
};

export default function DataEntryPage() {
  const [reportingYear, setReportingYear] = useState(sampleSubmission.reportingYear);
  const [reportingPeriod, setReportingPeriod] = useState<ReportingPeriod>(sampleSubmission.reportingPeriod);
  const [periodValue, setPeriodValue] = useState(sampleSubmission.periodValue);
  const [subsidiaryId, setSubsidiaryId] = useState(sampleSubmission.subsidiaryId);
  const [locationId, setLocationId] = useState(sampleSubmission.locationId);
  const [category, setCategory] = useState<Category>(sampleSubmission.category);
  const [fieldGroups, setFieldGroups] = useState<FieldGroup[]>(sampleSubmission.fieldGroups);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(sampleSubmission.lastSaved);
  const [categoryStatuses, setCategoryStatuses] = useState(initialCategoryStatuses);

  // Calculate current status based on field completion
  const calculateStatus = useCallback((groups: FieldGroup[]): DataStatus => {
    const requiredFields = groups.flatMap(g => g.fields.filter(f => f.required));
    const filledRequired = requiredFields.filter(f => f.value !== null && f.value !== undefined && f.value !== '');
    
    if (requiredFields.length === 0) return 'complete';
    if (filledRequired.length === requiredFields.length) return 'complete';
    if (filledRequired.length > 0) return 'incomplete';
    return 'missing';
  }, []);

  const currentStatus = calculateStatus(fieldGroups);

  const handleCategoryChange = (newCategory: Category) => {
    setCategory(newCategory);
    // Load field groups for the new category
    const newFieldGroups = categoryFieldGroups[newCategory] || defaultFieldGroups;
    setFieldGroups(newFieldGroups);
  };

  const handleSubsidiaryChange = (newSubsidiaryId: string) => {
    setSubsidiaryId(newSubsidiaryId);
    // Reset location to first available for new subsidiary
    const availableLocations = locations.filter(l => l.subsidiaryId === newSubsidiaryId);
    if (availableLocations.length > 0) {
      setLocationId(availableLocations[0].id);
    }
  };

  const handleFieldChange = (fieldId: string, value: string | number | null) => {
    setFieldGroups(prev =>
      prev.map(group => ({
        ...group,
        fields: group.fields.map(field =>
          field.id === fieldId ? { ...field, value } : field
        ),
      }))
    );

    // Update category status
    const updatedGroups = fieldGroups.map(group => ({
      ...group,
      fields: group.fields.map(field =>
        field.id === fieldId ? { ...field, value } : field
      ),
    }));
    const newStatus = calculateStatus(updatedGroups);
    setCategoryStatuses(prev => ({ ...prev, [category]: newStatus }));
  };

  const handleSaveDraft = async () => {
    setIsSaving(true);
    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 800));
    setLastSaved(new Date().toISOString());
    setIsSaving(false);
    toast.success('Draft saved successfully');
  };

  const handleSubmit = async () => {
    setIsSaving(true);
    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 1000));
    setIsSaving(false);
    toast.success('Submission sent for review');
  };

  return (
    <div className="flex flex-col h-screen bg-background">
      <EntryHeader
        reportingYear={reportingYear}
        reportingPeriod={reportingPeriod}
        periodValue={periodValue}
        subsidiaryId={subsidiaryId}
        locationId={locationId}
        category={category}
        status={currentStatus}
        submissionStatus={sampleSubmission.submissionStatus}
        responsibleUser={sampleSubmission.responsibleUser}
        lastSaved={lastSaved}
        onYearChange={setReportingYear}
        onPeriodChange={setReportingPeriod}
        onPeriodValueChange={setPeriodValue}
        onSubsidiaryChange={handleSubsidiaryChange}
        onLocationChange={setLocationId}
        onCategoryChange={handleCategoryChange}
        onSaveDraft={handleSaveDraft}
        onSubmit={handleSubmit}
        isSaving={isSaving}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Left: Category Navigation */}
        <CategoryNav
          selectedCategory={category}
          onCategoryChange={handleCategoryChange}
          categoryStatuses={categoryStatuses}
        />

        {/* Center: Main Form */}
        <main className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-6 max-w-4xl mx-auto space-y-6">
              {/* Category header */}
              <div>
                <h2 className="text-xl font-semibold text-foreground">{category}</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Enter the {category.toLowerCase()} data for the selected reporting period
                </p>
              </div>

              {/* Dynamic form */}
              <DataForm
                fieldGroups={fieldGroups}
                onFieldChange={handleFieldChange}
              />

              {/* Previous submissions */}
              <PreviousSubmissions />
            </div>
          </ScrollArea>
        </main>

        {/* Right: Status Sidebar */}
        <StatusSidebar
          status={currentStatus}
          fieldGroups={fieldGroups}
          calculationPreview={sampleSubmission.calculationPreview}
          comments={sampleSubmission.comments}
          versionHistory={sampleSubmission.versionHistory}
          attachments={sampleSubmission.attachments}
        />
      </div>
    </div>
  );
}
