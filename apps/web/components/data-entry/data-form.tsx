'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from './form-field';
import type { FieldGroup, DataEntryField } from '@/lib/types';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DataFormProps {
  fieldGroups: FieldGroup[];
  onFieldChange: (fieldId: string, value: string | number | null) => void;
}

function getGroupCompletionStatus(fields: DataEntryField[]): 'complete' | 'partial' | 'empty' {
  const requiredFields = fields.filter(f => f.required);
  const filledRequired = requiredFields.filter(f => f.value !== null && f.value !== undefined && f.value !== '');
  
  if (requiredFields.length === 0) return 'complete';
  if (filledRequired.length === requiredFields.length) return 'complete';
  if (filledRequired.length > 0) return 'partial';
  return 'empty';
}

export function DataForm({ fieldGroups, onFieldChange }: DataFormProps) {
  return (
    <div className="space-y-6">
      {fieldGroups.map((group) => {
        const status = getGroupCompletionStatus(group.fields);
        const requiredCount = group.fields.filter(f => f.required).length;
        const filledCount = group.fields.filter(f => f.required && f.value !== null && f.value !== undefined && f.value !== '').length;

        return (
          <Card key={group.id} className="bg-card border-border">
            <CardHeader className="pb-4">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                    {group.name}
                    {status === 'complete' && (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    )}
                    {status === 'partial' && (
                      <AlertCircle className="h-4 w-4 text-amber-400" />
                    )}
                  </CardTitle>
                  {group.description && (
                    <CardDescription className="mt-1 text-muted-foreground">
                      {group.description}
                    </CardDescription>
                  )}
                </div>
                {requiredCount > 0 && (
                  <span
                    className={cn(
                      'text-xs font-medium px-2 py-1 rounded',
                      status === 'complete'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : status === 'partial'
                        ? 'bg-amber-500/10 text-amber-400'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {filledCount}/{requiredCount} required
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {group.fields.map((field) => (
                  <div
                    key={field.id}
                    className={cn(
                      field.type === 'textarea' || field.type === 'file' ? 'md:col-span-2' : ''
                    )}
                  >
                    <FormField
                      field={field}
                      value={field.value}
                      onChange={onFieldChange}
                    />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
