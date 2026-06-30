'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DataEntryField } from '@/lib/types';
import { Upload, X, FileText, AlertCircle, HelpCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useState } from 'react';

interface FormFieldProps {
  field: DataEntryField;
  value: string | number | null | undefined;
  onChange: (fieldId: string, value: string | number | null) => void;
  error?: string;
}

export function FormField({ field, value, onChange, error }: FormFieldProps) {
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  const hasValue = value !== null && value !== undefined && value !== '';
  const showError = field.required && !hasValue;

  const handleFileUpload = () => {
    // Simulate file upload
    const mockFile = `document_${Date.now()}.pdf`;
    setUploadedFiles(prev => [...prev, mockFile]);
  };

  const removeFile = (fileName: string) => {
    setUploadedFiles(prev => prev.filter(f => f !== fileName));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label
          htmlFor={field.id}
          className={cn(
            'text-sm font-medium',
            showError ? 'text-red-400' : 'text-foreground'
          )}
        >
          {field.label}
          {field.required && <span className="text-red-400 ml-1">*</span>}
        </Label>
        {field.helperText && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p className="text-sm">{field.helperText}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      {field.type === 'number' && (
        <div className="relative">
          <Input
            id={field.id}
            type="number"
            placeholder={field.placeholder}
            value={value ?? ''}
            onChange={(e) => onChange(field.id, e.target.value ? parseFloat(e.target.value) : null)}
            className={cn(
              'bg-secondary border-border pr-16',
              showError && 'border-red-500/50 focus-visible:ring-red-500/30',
              hasValue && !showError && 'border-emerald-500/30'
            )}
          />
          {field.unit && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
              {field.unit}
            </span>
          )}
        </div>
      )}

      {field.type === 'text' && (
        <Input
          id={field.id}
          type="text"
          placeholder={field.placeholder}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(field.id, e.target.value || null)}
          className={cn(
            'bg-secondary border-border',
            showError && 'border-red-500/50 focus-visible:ring-red-500/30',
            hasValue && !showError && 'border-emerald-500/30'
          )}
        />
      )}

      {field.type === 'select' && (
        <Select
          value={(value as string) ?? ''}
          onValueChange={(v) => onChange(field.id, v || null)}
        >
          <SelectTrigger
            className={cn(
              'bg-secondary border-border',
              showError && 'border-red-500/50',
              hasValue && !showError && 'border-emerald-500/30'
            )}
          >
            <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {field.type === 'date' && (
        <Input
          id={field.id}
          type="date"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(field.id, e.target.value || null)}
          className={cn(
            'bg-secondary border-border',
            showError && 'border-red-500/50 focus-visible:ring-red-500/30',
            hasValue && !showError && 'border-emerald-500/30'
          )}
        />
      )}

      {field.type === 'textarea' && (
        <Textarea
          id={field.id}
          placeholder={field.placeholder}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(field.id, e.target.value || null)}
          rows={3}
          className={cn(
            'bg-secondary border-border resize-none',
            showError && 'border-red-500/50 focus-visible:ring-red-500/30',
            hasValue && !showError && 'border-emerald-500/30'
          )}
        />
      )}

      {field.type === 'file' && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleFileUpload}
            className="gap-2"
          >
            <Upload className="h-4 w-4" />
            Upload File
          </Button>
          {uploadedFiles.length > 0 && (
            <div className="space-y-1.5">
              {uploadedFiles.map((file) => (
                <div
                  key={file}
                  className="flex items-center gap-2 px-3 py-2 bg-secondary/50 rounded-md text-sm"
                >
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1 truncate text-foreground">{file}</span>
                  <button
                    onClick={() => removeFile(file)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-xs text-red-400">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      )}
    </div>
  );
}
