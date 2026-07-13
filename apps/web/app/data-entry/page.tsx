"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  Calculator,
  CheckCircle2,
  Clock,
  Info,
  Leaf,
  LogOut,
  Save,
  Send,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";
import { EvidenceVault } from "@/components/data-entry/evidence-vault";
import { CATEGORIES } from "@/lib/types";
import type {
  ActivityRecordDTO,
  ActivityRecordStatus,
  CalculationResult,
  Category,
  LocationDTO,
  ReportingPeriod,
  SubsidiaryDTO,
} from "@/lib/types";
import {
  categoryFieldGroups,
  defaultFieldGroups,
} from "@/lib/data-entry-data";

// --- Static option sets -----------------------------------------------------

const YEARS = [2024, 2023] as const;

const PERIODS: { value: ReportingPeriod; label: string }[] = [
  { value: "quarterly", label: "Quarterly" },
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Annual" },
];

const PERIOD_VALUES: Record<ReportingPeriod, string[]> = {
  quarterly: ["Q1", "Q2", "Q3", "Q4"],
  monthly: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  annual: ["Annual"],
};

// Unit tokens the calculation engine understands (apps/api normalization.ts).
const UNITS: { value: string; label: string }[] = [
  { value: "kWh", label: "kWh (electricity / gas)" },
  { value: "MWh", label: "MWh (electricity)" },
  { value: "cubic_metres", label: "Cubic metres (natural gas)" },
  { value: "therms", label: "Therms (natural gas)" },
  { value: "litres", label: "Litres (liquid fuel)" },
  { value: "uk_gallons", label: "UK gallons (liquid fuel)" },
  { value: "us_gallons", label: "US gallons (liquid fuel)" },
  { value: "kilometres", label: "Kilometres" },
  { value: "passenger_kilometres", label: "Passenger-km" },
  { value: "tonnes", label: "Tonnes" },
];

// --- Status badge styling (matches subsidiaries page emerald/amber palette) --

const statusBadge: Record<
  ActivityRecordStatus,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  draft: {
    label: "Draft",
    className: "bg-muted text-muted-foreground border-border",
    icon: Clock,
  },
  submitted: {
    label: "Submitted",
    className: "bg-blue-500/15 text-blue-600 border-blue-500/30",
    icon: Send,
  },
  under_review: {
    label: "Under review",
    className: "bg-purple-500/15 text-purple-600 border-purple-500/30",
    icon: Clock,
  },
  approved: {
    label: "Approved",
    className: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
    icon: CheckCircle2,
  },
  rejected: {
    label: "Rejected",
    className: "bg-red-500/15 text-red-600 border-red-500/30",
    icon: XCircle,
  },
  locked: {
    label: "Locked",
    className: "bg-slate-500/15 text-slate-600 border-slate-500/30",
    icon: CheckCircle2,
  },
};

const numberFmt = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 3,
});

/** Turn a save/submit failure into a message a user can act on. The API returns
 * a bare 500 when a record for the same subsidiary+year+period+category already
 * exists, so we hint at that rather than surfacing "Internal server error". */
function saveErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status >= 500) {
    return "Could not save. A record for this subsidiary, period and category may already exist — change the period or category and try again.";
  }
  return (e as Error).message;
}

// The optional "context" fields from the elaborate mock, kept as demo extras
// saved into the record's `input`. The explicit value+unit above are the calc
// driver — these are never fed to the engine.
type ContextValues = Record<string, string | number>;

export default function DataEntryPage() {
  const router = useRouter();
  const { user, setUser } = useAuthStore();

  // Controls
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [subsidiaryId, setSubsidiaryId] = useState("");
  const [locations, setLocations] = useState<LocationDTO[]>([]);
  // "" = whole subsidiary; otherwise the operational location id.
  const [locationId, setLocationId] = useState("");
  const [reportingYear, setReportingYear] = useState<number>(2024);
  const [reportingPeriod, setReportingPeriod] =
    useState<ReportingPeriod>("quarterly");
  const [periodValue, setPeriodValue] = useState("Q1");
  const [category, setCategory] = useState<Category>("Electricity");

  // Primary calc inputs
  const [activityValue, setActivityValue] = useState("");
  const [activityUnit, setActivityUnit] = useState("kWh");

  // Optional context (demo extras)
  const [context, setContext] = useState<ContextValues>({});

  // Preview
  const [preview, setPreview] = useState<CalculationResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // Anomaly (VAR §4): server flags a value that deviates >±50% from the
  // baseline; a variance comment is then mandatory before submit.
  const [anomalyFlag, setAnomalyFlag] = useState(false);
  const [varianceReason, setVarianceReason] = useState("");

  // Records + saving
  const [records, setRecords] = useState<ActivityRecordDTO[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [subsLoading, setSubsLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState<null | "draft" | "submit">(null);

  const selectedSubsidiary = useMemo(
    () => subsidiaries.find((s) => s.id === subsidiaryId) ?? null,
    [subsidiaries, subsidiaryId],
  );

  const availableLocations = useMemo(
    () => locations.filter((l) => l.subsidiaryId === subsidiaryId),
    [locations, subsidiaryId],
  );
  const selectedLocation = useMemo(
    () => availableLocations.find((l) => l.id === locationId) ?? null,
    [availableLocations, locationId],
  );
  // The location (when chosen) drives the factor geography; else the subsidiary.
  const effectiveGeography =
    selectedLocation?.geographyCode ?? selectedSubsidiary?.geographyCode ?? null;

  const numericValue = activityValue.trim() === "" ? NaN : Number(activityValue);
  const hasValidInput =
    !!selectedSubsidiary &&
    !!category &&
    !!activityUnit &&
    Number.isFinite(numericValue) &&
    numericValue > 0;

  const contextFieldGroups = useMemo(
    () => categoryFieldGroups[category] ?? defaultFieldGroups,
    [category],
  );

  // --- Data loading ---------------------------------------------------------

  const refreshRecords = useCallback(async (subId: string) => {
    if (!subId) {
      setRecords([]);
      return;
    }
    setRecordsLoading(true);
    try {
      const list = await api.listActivityRecords({ subsidiaryId: subId });
      setRecords(list);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch((e) => toast.error((e as Error).message));

    (async () => {
      setSubsLoading(true);
      try {
        const [list, locs] = await Promise.all([
          api.listSubsidiaries(),
          api.listLocations(),
        ]);
        setSubsidiaries(list);
        setLocations(locs);
        if (list.length > 0) {
          setSubsidiaryId(list[0].id);
        }
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setSubsLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refreshRecords(subsidiaryId);
  }, [subsidiaryId, refreshRecords]);

  // --- Live preview (debounced) --------------------------------------------

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!hasValidInput || !selectedSubsidiary) {
      setPreview(null);
      setPreviewError(null);
      setPreviewing(false);
      return;
    }

    setPreviewing(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await api.previewCalculation({
          category,
          geographyCode: effectiveGeography ?? selectedSubsidiary.geographyCode,
          reportingYear,
          value: numericValue,
          unit: activityUnit,
        });
        setPreview(result);
        setPreviewError(null);
      } catch (e) {
        setPreview(null);
        if (e instanceof ApiError && e.status === 404) {
          setPreviewError(
            "No emission factor for this selection. Try a different category, geography or year.",
          );
        } else {
          // 400 (unit mismatch / unsupported unit) and anything else: show the
          // API's own message.
          setPreviewError((e as Error).message);
        }
      } finally {
        setPreviewing(false);
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hasValidInput,
    category,
    reportingYear,
    numericValue,
    activityUnit,
    subsidiaryId,
    effectiveGeography,
  ]);

  // --- Handlers -------------------------------------------------------------

  function handlePeriodChange(next: ReportingPeriod) {
    setReportingPeriod(next);
    setPeriodValue(PERIOD_VALUES[next][0]);
  }

  function resetForm() {
    setActivityValue("");
    setContext({});
    setPreview(null);
    setPreviewError(null);
    setEditingId(null);
    setLocationId("");
    setAnomalyFlag(false);
    setVarianceReason("");
  }

  function buildInputPayload(): Record<string, unknown> | null {
    const entries = Object.entries(context).filter(
      ([, v]) => v !== "" && v !== null && v !== undefined,
    );
    if (entries.length === 0) return null;
    return Object.fromEntries(entries);
  }

  async function persist(): Promise<ActivityRecordDTO | null> {
    if (!hasValidInput || !selectedSubsidiary) {
      toast.error("Pick a subsidiary, category, and enter an activity value.");
      return null;
    }
    const inputPayload = buildInputPayload();
    // "" means "whole subsidiary" → null; otherwise the chosen location id.
    const effectiveLocationId = locationId || null;
    const variance = varianceReason.trim() || null;
    if (editingId) {
      return api.updateActivityRecord(editingId, {
        locationId: effectiveLocationId,
        reportingYear,
        reportingPeriod,
        periodValue,
        category,
        activityValue: numericValue,
        activityUnit,
        varianceReason: variance,
        input: inputPayload,
      });
    }
    return api.createActivityRecord({
      subsidiaryId: selectedSubsidiary.id,
      locationId: effectiveLocationId,
      reportingYear,
      reportingPeriod,
      periodValue,
      category,
      activityValue: numericValue,
      activityUnit,
      varianceReason: variance,
      input: inputPayload,
    });
  }

  async function handleSaveDraft() {
    setSaving("draft");
    try {
      const rec = await persist();
      if (!rec) return;
      setEditingId(rec.id);
      setAnomalyFlag(rec.anomalyFlag);
      toast.success(
        rec.anomalyFlag
          ? "Draft saved — value flagged as anomalous, add a variance comment"
          : "Draft saved",
      );
      await refreshRecords(subsidiaryId);
    } catch (e) {
      toast.error(saveErrorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  async function handleSubmit() {
    setSaving("submit");
    try {
      const rec = await persist();
      if (!rec) return;
      // Keep the saved record "current" so that if submit is blocked (evidence
      // or anomaly gate), the vault + variance field stay visible to fix + retry.
      setEditingId(rec.id);
      setAnomalyFlag(rec.anomalyFlag);
      // Mirror the server anomaly gate (VAR §2.2 / §4.3): a flagged value needs
      // a variance comment before it can be submitted.
      if (rec.anomalyFlag && !varianceReason.trim()) {
        toast.error(
          "This value looks anomalous — add a variance comment before submitting.",
        );
        return;
      }
      await api.submitActivityRecord(rec.id);
      toast.success("Submitted for review");
      resetForm();
      await refreshRecords(subsidiaryId);
    } catch (e) {
      toast.error(saveErrorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  async function handleLogout() {
    await getSupabaseBrowserClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const isBusy = saving !== null;

  // --- Render ---------------------------------------------------------------

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="pl-[280px] transition-all duration-300">
        <div className="space-y-6 p-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">
                Data Entry
              </h1>
              <p className="mt-1 text-muted-foreground">
                Enter activity data and preview emissions from the TonyAI
                calculation engine
                {user ? ` · ${user.fullName} (${user.role})` : ""}
              </p>
            </div>
            <Button variant="outline" onClick={handleLogout} className="gap-2">
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Left / center: form */}
            <div className="space-y-6 lg:col-span-2">
              {/* Scope selectors */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Reporting scope</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Subsidiary">
                    {subsLoading ? (
                      <Skeleton className="h-9 w-full" />
                    ) : subsidiaries.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No subsidiaries accessible to your account.
                      </p>
                    ) : (
                      <Select
                        value={subsidiaryId}
                        onValueChange={(v) => {
                          setSubsidiaryId(v);
                          setLocationId("");
                          resetForm();
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select subsidiary" />
                        </SelectTrigger>
                        <SelectContent>
                          {subsidiaries.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.tradingName ?? s.legalName} ({s.geographyCode})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </Field>

                  {/* Reporting entity: whole subsidiary or one of its locations.
                      The chosen entity drives the factor geography (FR §5.2). */}
                  <Field label="Location">
                    <Select
                      value={locationId || "__whole__"}
                      onValueChange={(v) => setLocationId(v === "__whole__" ? "" : v)}
                      disabled={subsLoading || !subsidiaryId}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__whole__">Whole subsidiary</SelectItem>
                        {availableLocations.map((l) => (
                          <SelectItem key={l.id} value={l.id}>
                            {l.name} ({l.geographyCode})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field label="Category">
                    <Select
                      value={category}
                      onValueChange={(v) => {
                        setCategory(v as Category);
                        setContext({});
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>

                  <Field label="Reporting year">
                    <Select
                      value={String(reportingYear)}
                      onValueChange={(v) => setReportingYear(Number(v))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {YEARS.map((y) => (
                          <SelectItem key={y} value={String(y)}>
                            {y}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>

                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Period">
                      <Select
                        value={reportingPeriod}
                        onValueChange={(v) =>
                          handlePeriodChange(v as ReportingPeriod)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PERIODS.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              {p.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Value">
                      <Select value={periodValue} onValueChange={setPeriodValue}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PERIOD_VALUES[reportingPeriod].map((v) => (
                            <SelectItem key={v} value={v}>
                              {v}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                </CardContent>
              </Card>

              {/* Activity value — the calc driver */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Activity data</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_220px]">
                    <Field label="Activity value">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="any"
                        placeholder="e.g. 45000"
                        value={activityValue}
                        onChange={(e) => setActivityValue(e.target.value)}
                      />
                    </Field>
                    <Field label="Unit">
                      <Select value={activityUnit} onValueChange={setActivityUnit}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {UNITS.map((u) => (
                            <SelectItem key={u.value} value={u.value}>
                              {u.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    This value and unit drive the emissions calculation. The
                    engine normalises the unit (e.g. MWh &rarr; kWh) before
                    applying the factor.
                  </p>
                </CardContent>
              </Card>

              {/* Optional context — demo extras stored into `input` */}
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="text-base">
                    Additional context
                  </CardTitle>
                  <Badge
                    variant="outline"
                    className="border-amber-500/30 bg-amber-500/10 text-amber-600"
                  >
                    Optional · saved as metadata
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-4">
                  {contextFieldGroups
                    .flatMap((g) => g.fields)
                    .filter((f) => f.type !== "file")
                    .map((f) => (
                      <Field key={f.id} label={f.label}>
                        {f.type === "select" ? (
                          <Select
                            value={String(context[f.id] ?? "")}
                            onValueChange={(v) =>
                              setContext((prev) => ({ ...prev, [f.id]: v }))
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select…" />
                            </SelectTrigger>
                            <SelectContent>
                              {(f.options ?? []).map((opt) => (
                                <SelectItem key={opt} value={opt}>
                                  {opt}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : f.type === "textarea" ? (
                          <Textarea
                            placeholder={f.placeholder}
                            value={String(context[f.id] ?? "")}
                            onChange={(e) =>
                              setContext((prev) => ({
                                ...prev,
                                [f.id]: e.target.value,
                              }))
                            }
                          />
                        ) : (
                          <Input
                            type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                            placeholder={f.placeholder}
                            value={String(context[f.id] ?? "")}
                            onChange={(e) =>
                              setContext((prev) => ({
                                ...prev,
                                [f.id]: e.target.value,
                              }))
                            }
                          />
                        )}
                      </Field>
                    ))}
                </CardContent>
              </Card>

              {/* Evidence vault — appears once the record is saved (needs an id).
                  For evidence-required categories, a file must be attached here
                  before the record can be submitted (FR §4.1). */}
              {editingId && (
                <EvidenceVault
                  key={editingId}
                  recordId={editingId}
                  category={category}
                  canManage={
                    !!user &&
                    ["data_entry", "consultant", "super_admin"].includes(user.role)
                  }
                />
              )}

              {/* Anomaly warning + mandatory variance comment (VAR §4.3). Shown
                  once a save flags the value as deviating >±50% from history. */}
              {anomalyFlag && (
                <Card className="border-amber-300 bg-amber-50/60">
                  <CardContent className="space-y-3 pt-5">
                    <div className="flex items-start gap-2 text-sm text-amber-800">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        This value deviates significantly from the historical
                        average for this reporting entity. Please verify it and
                        explain the variance before submitting.
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="variance-reason">Reason for variance *</Label>
                      <Textarea
                        id="variance-reason"
                        value={varianceReason}
                        onChange={(e) => setVarianceReason(e.target.value)}
                        placeholder="e.g. new production line commissioned this period"
                        rows={2}
                      />
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-2">
                {editingId && (
                  <span className="mr-auto text-sm text-muted-foreground">
                    Editing draft {editingId.slice(0, 8)}…
                  </span>
                )}
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={handleSaveDraft}
                  disabled={isBusy || !hasValidInput}
                >
                  <Save className="h-4 w-4" />
                  {saving === "draft" ? "Saving…" : "Save draft"}
                </Button>
                <Button
                  className="gap-2"
                  onClick={handleSubmit}
                  disabled={isBusy || !hasValidInput}
                >
                  <Send className="h-4 w-4" />
                  {saving === "submit" ? "Submitting…" : "Submit for review"}
                </Button>
              </div>
            </div>

            {/* Right: preview + previous submissions */}
            <div className="space-y-6">
              <PreviewCard
                previewing={previewing}
                preview={preview}
                error={previewError}
                hasValidInput={hasValidInput}
                geographyCode={effectiveGeography}
              />

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    Previous submissions
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {recordsLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-14 w-full" />
                      <Skeleton className="h-14 w-full" />
                    </div>
                  ) : records.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      No submissions yet for this subsidiary.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {records.map((r) => {
                        const badge = statusBadge[r.status];
                        const Icon = badge.icon;
                        return (
                          <div
                            key={r.id}
                            className="flex items-center gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2.5"
                          >
                            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {r.periodValue} {r.reportingYear}
                                </span>
                                <Badge
                                  variant="outline"
                                  className={`px-1.5 py-0 text-[10px] ${badge.className}`}
                                >
                                  {badge.label}
                                </Badge>
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {r.category} ·{" "}
                                {numberFmt.format(r.calculation.tCo2e)} tCO₂e
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// --- Preview card -----------------------------------------------------------

function PreviewCard({
  previewing,
  preview,
  error,
  hasValidInput,
  geographyCode,
}: {
  previewing: boolean;
  preview: CalculationResult | null;
  error: string | null;
  hasValidInput: boolean;
  geographyCode: string | null;
}) {
  return (
    <Card className="border-primary/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Calculator className="h-4 w-4 text-primary" />
          Live emissions preview
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!hasValidInput ? (
          <div className="flex items-start gap-2 py-4 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Pick a subsidiary and category, then enter an activity value to see
              a live tCO₂e estimate.
            </span>
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : previewing || !preview ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-foreground">
                  {numberFmt.format(preview.tCo2e)}
                </span>
                <span className="flex items-center gap-1 text-sm font-medium text-primary">
                  <Leaf className="h-4 w-4" />
                  tCO₂e
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Scope {preview.scope} ·{" "}
                {numberFmt.format(preview.kgCo2e)} kgCO₂e
              </p>
            </div>

            <Separator />

            <dl className="space-y-2 text-sm">
              <Row
                label="Emission factor"
                value={`${preview.factorValue} ${preview.factorUnit}`}
              />
              <Row
                label="Normalised input"
                value={`${numberFmt.format(preview.normalizedValue)} ${preview.normalizedUnit}`}
              />
              <Row label="Methodology" value={preview.methodology} />
              <Row
                label="Source"
                value={`${preview.source} (${preview.version})`}
              />
              {geographyCode && (
                <Row label="Geography" value={geographyCode} />
              )}
            </dl>

            {preview.conversionApplied && (
              <div className="flex items-start gap-2 rounded-lg bg-secondary/60 p-2.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Unit converted from {preview.inputUnit} to{" "}
                  {preview.normalizedUnit} before applying the factor.
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
