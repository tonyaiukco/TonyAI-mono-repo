'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import {
  ChevronDown,
  Building2,
  MapPin,
  User,
  FileText,
  Network,
  Upload,
  X,
  Plus,
  Pencil,
  Trash2,
  Info,
  Check,
  AlertCircle,
} from 'lucide-react';
import {
  SubsidiaryCompany,
  Location,
  NACE_CODES,
  COUNTRIES,
  DEPARTMENTS,
  CapacityReport,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface SubsidiaryFormProps {
  subsidiary?: SubsidiaryCompany | null;
  onSave: (data: Partial<SubsidiaryCompany>) => void;
  onCancel: () => void;
}

interface LocationFormData {
  id: string;
  name: string;
  address: string;
  activityDescription: string;
  generalInfo: string;
  authorizedPerson: string;
  email: string;
  department: string;
}

const emptyLocation: LocationFormData = {
  id: '',
  name: '',
  address: '',
  activityDescription: '',
  generalInfo: '',
  authorizedPerson: '',
  email: '',
  department: '',
};

export function SubsidiaryForm({ subsidiary, onSave, onCancel }: SubsidiaryFormProps) {
  const isEditing = !!subsidiary;

  // Form sections state
  const [openSections, setOpenSections] = useState({
    company: true,
    activity: true,
    contact: true,
    organization: true,
    locations: true,
  });

  // Company Information
  const [officialName, setOfficialName] = useState(subsidiary?.officialName || '');
  const [country, setCountry] = useState(subsidiary?.country || '');
  const [city, setCity] = useState(subsidiary?.city || '');
  const [postalCode, setPostalCode] = useState(subsidiary?.postalCode || '');
  const [address, setAddress] = useState(subsidiary?.address || '');

  // Activity Information
  const [naceCode, setNaceCode] = useState(subsidiary?.naceCode || '');
  const [naceDescription, setNaceDescription] = useState(subsidiary?.naceDescription || '');
  const [capacityReport, setCapacityReport] = useState<CapacityReport | null>(
    subsidiary?.capacityReport || null
  );

  // Contact Information
  const [authorizedRepresentative, setAuthorizedRepresentative] = useState(
    subsidiary?.authorizedRepresentative || ''
  );
  const [representativeContact, setRepresentativeContact] = useState(
    subsidiary?.representativeContact || ''
  );

  // Organizational Structure
  const [hasMultipleLocations, setHasMultipleLocations] = useState(
    subsidiary?.hasMultipleLocations || false
  );
  const [hasChildSubsidiaries, setHasChildSubsidiaries] = useState(
    subsidiary?.hasChildSubsidiaries || false
  );
  const [childSubsidiaryCount, setChildSubsidiaryCount] = useState(
    subsidiary?.childSubsidiaryCount || 0
  );

  // Locations
  const [locations, setLocations] = useState<LocationFormData[]>(
    subsidiary?.locations.map(loc => ({
      id: loc.id,
      name: loc.name,
      address: loc.address,
      activityDescription: loc.activityDescription,
      generalInfo: loc.generalInfo,
      authorizedPerson: loc.authorizedPerson,
      email: loc.email,
      department: loc.department,
    })) || []
  );
  const [editingLocation, setEditingLocation] = useState<LocationFormData | null>(null);
  const [isAddingLocation, setIsAddingLocation] = useState(false);

  // NACE code search
  const [naceSearch, setNaceSearch] = useState('');

  // Calculate form completion
  const calculateCompletion = () => {
    const fields = [
      officialName,
      country,
      city,
      postalCode,
      address,
      naceCode,
      authorizedRepresentative,
      representativeContact,
    ];
    const filledFields = fields.filter(f => f && f.trim() !== '').length;
    return Math.round((filledFields / fields.length) * 100);
  };

  // Handle NACE code selection
  const handleNaceSelect = (code: string) => {
    const nace = NACE_CODES.find(n => n.code === code);
    if (nace) {
      setNaceCode(nace.code);
      setNaceDescription(nace.description);
    }
  };

  // Handle file upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setCapacityReport({
        fileName: file.name,
        fileSize: file.size,
        uploadedAt: new Date().toISOString().split('T')[0],
        uploadedBy: authorizedRepresentative || 'Current User',
      });
      toast.success('File uploaded successfully');
    }
  };

  // Location management
  const handleAddLocation = () => {
    setEditingLocation({ ...emptyLocation, id: `loc-new-${Date.now()}` });
    setIsAddingLocation(true);
  };

  const handleEditLocation = (location: LocationFormData) => {
    setEditingLocation({ ...location });
    setIsAddingLocation(false);
  };

  const handleSaveLocation = () => {
    if (!editingLocation) return;

    if (!editingLocation.name || !editingLocation.address || !editingLocation.authorizedPerson) {
      toast.error('Please fill in required fields: Name, Address, and Authorized Person');
      return;
    }

    if (isAddingLocation) {
      setLocations([...locations, editingLocation]);
    } else {
      setLocations(locations.map(loc => (loc.id === editingLocation.id ? editingLocation : loc)));
    }

    setEditingLocation(null);
    setIsAddingLocation(false);
    toast.success(isAddingLocation ? 'Location added' : 'Location updated');
  };

  const handleDeleteLocation = (locationId: string) => {
    setLocations(locations.filter(loc => loc.id !== locationId));
    toast.success('Location removed');
  };

  const handleCancelLocationEdit = () => {
    setEditingLocation(null);
    setIsAddingLocation(false);
  };

  // Form submission
  const handleSubmit = () => {
    // Validation
    if (!officialName || !country || !city) {
      toast.error('Please fill in required company information');
      return;
    }

    if (!naceCode) {
      toast.error('Please select a NACE code');
      return;
    }

    if (!authorizedRepresentative || !representativeContact) {
      toast.error('Please fill in contact information');
      return;
    }

    if (hasMultipleLocations && locations.length === 0) {
      toast.error('Please add at least one location');
      return;
    }

    const now = new Date().toISOString().split('T')[0];
    
    const data: Partial<SubsidiaryCompany> = {
      id: subsidiary?.id || `sub-${Date.now()}`,
      officialName,
      country,
      city,
      postalCode,
      address,
      naceCode,
      naceDescription,
      capacityReport,
      authorizedRepresentative,
      representativeContact,
      hasMultipleLocations,
      locations: locations.map(loc => ({
        ...loc,
        createdAt: loc.id.startsWith('loc-new') ? now : (subsidiary?.locations.find(l => l.id === loc.id)?.createdAt || now),
        updatedAt: now,
      })),
      hasChildSubsidiaries,
      childSubsidiaryCount: hasChildSubsidiaries ? childSubsidiaryCount : 0,
      status: subsidiary?.status || 'active',
      createdAt: subsidiary?.createdAt || now,
      updatedAt: now,
    };

    onSave(data);
  };

  // Filter NACE codes based on search
  const filteredNaceCodes = NACE_CODES.filter(
    nace =>
      nace.code.toLowerCase().includes(naceSearch.toLowerCase()) ||
      nace.description.toLowerCase().includes(naceSearch.toLowerCase())
  );

  const completion = calculateCompletion();

  return (
    <TooltipProvider>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold">
              {isEditing ? 'Edit Subsidiary' : 'Add New Subsidiary'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {isEditing
                ? `Editing ${subsidiary.officialName}`
                : 'Create a new subsidiary company'}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onCancel}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Progress Bar */}
        <div className="px-4 py-3 border-b border-border bg-secondary/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-muted-foreground">Form Completion</span>
            <span className="text-sm font-medium">{completion}%</span>
          </div>
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full transition-all duration-300',
                completion < 50 ? 'bg-red-500' : completion < 80 ? 'bg-amber-500' : 'bg-emerald-500'
              )}
              style={{ width: `${completion}%` }}
            />
          </div>
        </div>

        {/* Form Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Summary Card */}
          <div className="bg-secondary/30 rounded-lg p-4 space-y-3">
            <div className="text-sm font-medium">Quick Summary</div>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-primary" />
                <span>{locations.length} Locations</span>
              </div>
              <div className="flex items-center gap-2">
                <Network className="h-4 w-4 text-primary" />
                <span>{hasChildSubsidiaries ? `${childSubsidiaryCount} Child Subs` : 'No Child Subs'}</span>
              </div>
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <span>{capacityReport ? 'Report Uploaded' : 'No Report'}</span>
              </div>
            </div>
          </div>

          {/* Section: Company Information */}
          <Collapsible
            open={openSections.company}
            onOpenChange={(open) => setOpenSections({ ...openSections, company: open })}
          >
            <CollapsibleTrigger asChild>
              <div className="flex items-center justify-between p-3 bg-card border border-border rounded-lg cursor-pointer hover:bg-secondary/30 transition-colors">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-primary" />
                  <span className="font-medium">Company Information</span>
                </div>
                <ChevronDown
                  className={cn(
                    'h-4 w-4 transition-transform',
                    openSections.company && 'rotate-180'
                  )}
                />
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <div className="space-y-4 pl-2">
                <div className="space-y-2">
                  <Label htmlFor="officialName">
                    Official Company Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="officialName"
                    value={officialName}
                    onChange={(e) => setOfficialName(e.target.value)}
                    placeholder="e.g., Meridian Energy Solutions GmbH"
                    className="bg-secondary/50"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="country">
                      Country <span className="text-destructive">*</span>
                    </Label>
                    <Select value={country} onValueChange={setCountry}>
                      <SelectTrigger className="bg-secondary/50">
                        <SelectValue placeholder="Select country" />
                      </SelectTrigger>
                      <SelectContent>
                        {COUNTRIES.map(c => (
                          <SelectItem key={c} value={c}>{c}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="city">
                      City <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="city"
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      placeholder="e.g., Munich"
                      className="bg-secondary/50"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="postalCode">Postal Code</Label>
                    <Input
                      id="postalCode"
                      value={postalCode}
                      onChange={(e) => setPostalCode(e.target.value)}
                      placeholder="e.g., 80331"
                      className="bg-secondary/50"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="address">Address</Label>
                    <Input
                      id="address"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="e.g., Maximilianstrasse 42"
                      className="bg-secondary/50"
                    />
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Section: Activity Information */}
          <Collapsible
            open={openSections.activity}
            onOpenChange={(open) => setOpenSections({ ...openSections, activity: open })}
          >
            <CollapsibleTrigger asChild>
              <div className="flex items-center justify-between p-3 bg-card border border-border rounded-lg cursor-pointer hover:bg-secondary/30 transition-colors">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  <span className="font-medium">Activity Information</span>
                </div>
                <ChevronDown
                  className={cn(
                    'h-4 w-4 transition-transform',
                    openSections.activity && 'rotate-180'
                  )}
                />
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <div className="space-y-4 pl-2">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="naceCode">
                      NACE Code <span className="text-destructive">*</span>
                    </Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[300px]">
                        <p>
                          NACE is the European classification of economic activities. It helps
                          categorize the business activity for emissions reporting and benchmarking.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Input
                    placeholder="Search NACE codes..."
                    value={naceSearch}
                    onChange={(e) => setNaceSearch(e.target.value)}
                    className="bg-secondary/50 mb-2"
                  />
                  {naceSearch && (
                    <div className="max-h-[200px] overflow-y-auto border border-border rounded-lg bg-card">
                      {filteredNaceCodes.map(nace => (
                        <div
                          key={nace.code}
                          className={cn(
                            'p-2 cursor-pointer hover:bg-secondary/50 flex items-center gap-2',
                            naceCode === nace.code && 'bg-primary/10'
                          )}
                          onClick={() => {
                            handleNaceSelect(nace.code);
                            setNaceSearch('');
                          }}
                        >
                          <code className="text-xs bg-secondary px-1.5 py-0.5 rounded">
                            {nace.code}
                          </code>
                          <span className="text-sm">{nace.description}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {naceCode && !naceSearch && (
                    <div className="p-3 bg-secondary/30 rounded-lg">
                      <div className="flex items-center gap-2">
                        <code className="text-sm bg-secondary px-2 py-1 rounded font-medium">
                          {naceCode}
                        </code>
                        <span className="text-sm">{naceDescription}</span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label>Company Capacity Report</Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[300px]">
                        <p>
                          Upload the official capacity report document for this subsidiary. This
                          helps define the reporting boundary.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {capacityReport ? (
                    <div className="flex items-center justify-between p-3 bg-secondary/30 rounded-lg">
                      <div className="flex items-center gap-3">
                        <FileText className="h-5 w-5 text-primary" />
                        <div>
                          <div className="text-sm font-medium">{capacityReport.fileName}</div>
                          <div className="text-xs text-muted-foreground">
                            Uploaded on {capacityReport.uploadedAt} by {capacityReport.uploadedBy}
                          </div>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCapacityReport(null)}
                        className="text-destructive hover:text-destructive"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <label className="flex flex-col items-center justify-center p-6 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary/50 transition-colors">
                      <Upload className="h-8 w-8 text-muted-foreground mb-2" />
                      <span className="text-sm text-muted-foreground">
                        Click to upload or drag and drop
                      </span>
                      <span className="text-xs text-muted-foreground">PDF, DOC, DOCX (max 10MB)</span>
                      <input
                        type="file"
                        className="hidden"
                        accept=".pdf,.doc,.docx"
                        onChange={handleFileUpload}
                      />
                    </label>
                  )}
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Section: Contact Information */}
          <Collapsible
            open={openSections.contact}
            onOpenChange={(open) => setOpenSections({ ...openSections, contact: open })}
          >
            <CollapsibleTrigger asChild>
              <div className="flex items-center justify-between p-3 bg-card border border-border rounded-lg cursor-pointer hover:bg-secondary/30 transition-colors">
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 text-primary" />
                  <span className="font-medium">Contact Information</span>
                </div>
                <ChevronDown
                  className={cn(
                    'h-4 w-4 transition-transform',
                    openSections.contact && 'rotate-180'
                  )}
                />
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <div className="space-y-4 pl-2">
                <div className="space-y-2">
                  <Label htmlFor="authorizedRepresentative">
                    Authorized Company Representative <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="authorizedRepresentative"
                    value={authorizedRepresentative}
                    onChange={(e) => setAuthorizedRepresentative(e.target.value)}
                    placeholder="e.g., Hans Mueller"
                    className="bg-secondary/50"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="representativeContact">
                    Representative Contact <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="representativeContact"
                    type="email"
                    value={representativeContact}
                    onChange={(e) => setRepresentativeContact(e.target.value)}
                    placeholder="e.g., h.mueller@company.com"
                    className="bg-secondary/50"
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Section: Organizational Structure */}
          <Collapsible
            open={openSections.organization}
            onOpenChange={(open) => setOpenSections({ ...openSections, organization: open })}
          >
            <CollapsibleTrigger asChild>
              <div className="flex items-center justify-between p-3 bg-card border border-border rounded-lg cursor-pointer hover:bg-secondary/30 transition-colors">
                <div className="flex items-center gap-2">
                  <Network className="h-4 w-4 text-primary" />
                  <span className="font-medium">Organizational Structure</span>
                </div>
                <ChevronDown
                  className={cn(
                    'h-4 w-4 transition-transform',
                    openSections.organization && 'rotate-180'
                  )}
                />
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <div className="space-y-4 pl-2">
                <div className="flex items-center justify-between p-3 bg-secondary/30 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="hasMultipleLocations" className="cursor-pointer">
                      Does the company have multiple locations?
                    </Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[300px]">
                        <p>
                          Locations are separate operational sites within this subsidiary. Each
                          location can have its own emissions data and reporting boundary.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Switch
                    id="hasMultipleLocations"
                    checked={hasMultipleLocations}
                    onCheckedChange={setHasMultipleLocations}
                  />
                </div>

                <div className="flex items-center justify-between p-3 bg-secondary/30 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="hasChildSubsidiaries" className="cursor-pointer">
                      Does the company have child subsidiaries?
                    </Label>
                  </div>
                  <Switch
                    id="hasChildSubsidiaries"
                    checked={hasChildSubsidiaries}
                    onCheckedChange={setHasChildSubsidiaries}
                  />
                </div>

                {hasChildSubsidiaries && (
                  <div className="space-y-2 pl-4">
                    <Label htmlFor="childSubsidiaryCount">Number of Child Subsidiaries</Label>
                    <Input
                      id="childSubsidiaryCount"
                      type="number"
                      min="0"
                      value={childSubsidiaryCount}
                      onChange={(e) => setChildSubsidiaryCount(parseInt(e.target.value) || 0)}
                      className="bg-secondary/50 w-32"
                    />
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Section: Locations */}
          {hasMultipleLocations && (
            <Collapsible
              open={openSections.locations}
              onOpenChange={(open) => setOpenSections({ ...openSections, locations: open })}
            >
              <CollapsibleTrigger asChild>
                <div className="flex items-center justify-between p-3 bg-card border border-border rounded-lg cursor-pointer hover:bg-secondary/30 transition-colors">
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-primary" />
                    <span className="font-medium">Locations</span>
                    <Badge variant="secondary" className="ml-2">
                      {locations.length}
                    </Badge>
                  </div>
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 transition-transform',
                      openSections.locations && 'rotate-180'
                    )}
                  />
                </div>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="space-y-3 pl-2">
                  {/* Location List */}
                  {locations.map(location => (
                    <div
                      key={location.id}
                      className="flex items-start justify-between p-3 bg-card border border-border rounded-lg"
                    >
                      <div className="flex-1">
                        <div className="font-medium text-sm">{location.name}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{location.address}</div>
                        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {location.authorizedPerson}
                          </span>
                          <span className="flex items-center gap-1">
                            <Badge variant="outline" className="text-xs py-0">
                              {location.department || 'No Department'}
                            </Badge>
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEditLocation(location)}
                          className="h-8 w-8 p-0"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteLocation(location.id)}
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}

                  {/* Location Form */}
                  {editingLocation && (
                    <div className="p-4 bg-secondary/30 border border-primary/30 rounded-lg space-y-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium">
                          {isAddingLocation ? 'Add New Location' : 'Edit Location'}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleCancelLocationEdit}
                          className="h-6 w-6 p-0"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">
                            Location Name <span className="text-destructive">*</span>
                          </Label>
                          <Input
                            value={editingLocation.name}
                            onChange={(e) =>
                              setEditingLocation({ ...editingLocation, name: e.target.value })
                            }
                            placeholder="e.g., Munich HQ"
                            className="bg-card h-9"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Department</Label>
                          <Select
                            value={editingLocation.department}
                            onValueChange={(val) =>
                              setEditingLocation({ ...editingLocation, department: val })
                            }
                          >
                            <SelectTrigger className="bg-card h-9">
                              <SelectValue placeholder="Select department" />
                            </SelectTrigger>
                            <SelectContent>
                              {DEPARTMENTS.map(dept => (
                                <SelectItem key={dept} value={dept}>
                                  {dept}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs">
                          Address <span className="text-destructive">*</span>
                        </Label>
                        <Textarea
                          value={editingLocation.address}
                          onChange={(e) =>
                            setEditingLocation({ ...editingLocation, address: e.target.value })
                          }
                          placeholder="Full address"
                          className="bg-card min-h-[60px]"
                        />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs">Activity Description</Label>
                        <Textarea
                          value={editingLocation.activityDescription}
                          onChange={(e) =>
                            setEditingLocation({
                              ...editingLocation,
                              activityDescription: e.target.value,
                            })
                          }
                          placeholder="Describe the main activities at this location"
                          className="bg-card min-h-[60px]"
                        />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs">General Information</Label>
                        <Textarea
                          value={editingLocation.generalInfo}
                          onChange={(e) =>
                            setEditingLocation({ ...editingLocation, generalInfo: e.target.value })
                          }
                          placeholder="Additional information about this location"
                          className="bg-card min-h-[60px]"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">
                            Authorized Person <span className="text-destructive">*</span>
                          </Label>
                          <Input
                            value={editingLocation.authorizedPerson}
                            onChange={(e) =>
                              setEditingLocation({
                                ...editingLocation,
                                authorizedPerson: e.target.value,
                              })
                            }
                            placeholder="Contact name"
                            className="bg-card h-9"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Email Address</Label>
                          <Input
                            type="email"
                            value={editingLocation.email}
                            onChange={(e) =>
                              setEditingLocation({ ...editingLocation, email: e.target.value })
                            }
                            placeholder="email@company.com"
                            className="bg-card h-9"
                          />
                        </div>
                      </div>

                      <div className="flex justify-end gap-2 pt-2">
                        <Button variant="outline" size="sm" onClick={handleCancelLocationEdit}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={handleSaveLocation}>
                          <Check className="h-4 w-4 mr-1" />
                          {isAddingLocation ? 'Add Location' : 'Save Changes'}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Add Location Button */}
                  {!editingLocation && (
                    <Button
                      variant="outline"
                      className="w-full border-dashed"
                      onClick={handleAddLocation}
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add Location
                    </Button>
                  )}

                  {/* Validation Warning */}
                  {hasMultipleLocations && locations.length === 0 && !editingLocation && (
                    <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-400 text-sm">
                      <AlertCircle className="h-4 w-4" />
                      At least one location is required when multiple locations is enabled.
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-border bg-card">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSubmit}>
            {isEditing ? 'Save Changes' : 'Create Subsidiary'}
          </Button>
        </div>
      </div>
    </TooltipProvider>
  );
}
