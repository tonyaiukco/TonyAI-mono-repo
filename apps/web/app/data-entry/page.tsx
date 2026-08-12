"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import {
  CATEGORIES,
  DEFAULT_REPORTING_YEAR,
  REPORTING_YEARS,
} from "@/lib/types";
import type {
  ActivityRecordDTO,
  ActivityRecordStatus,
  CalculationResult,
  Category,
  LocationDTO,
  PeriodLockDTO,
  ReportingPeriod,
  SubsidiaryDTO,
} from "@/lib/types";
import {
  categoryFieldGroups,
  defaultFieldGroups,
} from "@/lib/data-entry-data";

// --- Static option sets -----------------------------------------------------


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

/** Turn a save/submit failure into a message a user can act on.
 *
 * A duplicate reporting entity is a 409 — the API grew a P2002 handler and this
 * still claimed it was "a bare 500", so the one case it existed to explain was
 * the one case it no longer caught. 5xx keeps a generic hint because an
 * unexpected server error tells the user nothing on its own. */
function saveErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) {
    // Three things return 409: a duplicate reporting entity, and two period-lock
    // refusals. Only the first is fixed by opening the existing record, so the
    // advice is attached to the message that earns it — the lock's own sentence
    // already says what to do.
    return /locked/i.test(e.message)
      ? e.message
      : `${e.message} Open it from Previous submissions to continue it.`;
  }
  if (e instanceof ApiError && e.status >= 500) {
    return "Could not save — the server failed to process this record. Try again, and report it if it persists.";
  }
  return (e as Error).message;
}

// The optional "context" fields from the elaborate mock, kept as demo extras
// saved into the record's `input`. The explicit value+unit above are the calc
// driver — these are never fed to the engine.
type ContextValues = Record<string, string | number>;

/**
 * `useSearchParams` opts the route out of static rendering unless it sits under
 * a Suspense boundary — without this wrapper `next build` fails. This is the
 * first deep-linked page in the app, so the boundary is new here.
 */
export default function DataEntryPage() {
  return (
    <Suspense fallback={null}>
      <DataEntryPageInner />
    </Suspense>
  );
}

function DataEntryPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, setUser } = useAuthStore();

  // Controls
  const [subsidiaries, setSubsidiaries] = useState<SubsidiaryDTO[]>([]);
  const [subsidiaryId, setSubsidiaryId] = useState("");
  const [locations, setLocations] = useState<LocationDTO[]>([]);
  // "" = whole subsidiary; otherwise the operational location id.
  const [locationId, setLocationId] = useState("");
  const [reportingYear, setReportingYear] = useState<number>(
    DEFAULT_REPORTING_YEAR,
  );
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
  // Which subsidiary the rows in `records` actually belong to. `records.length`
  // cannot answer that: an empty list means both "not fetched yet" and "fetched,
  // none exist", and the deep-link effect below has to tell those apart.
  const [recordsFetchedFor, setRecordsFetchedFor] = useState<string | null>(null);
  const [locks, setLocks] = useState<PeriodLockDTO[]>([]);
  // The reporting entity the loaded record belongs to. Kept so that moving the
  // form off that tuple can stop targeting it — see the effect below.
  const [editingTuple, setEditingTuple] = useState<{
    category: string;
    reportingYear: number;
    reportingPeriod: ReportingPeriod;
    periodValue: string;
    locationId: string;
  } | null>(null);
  // What the deep link asked for, kept so the records effect below can act on it
  // once they arrive. A ref, not state: it must fire exactly once, and it is not
  // rendered.
  const deepLink = useRef<{ category: string; year: number } | null>(null);
  const deepLinkHandled = useRef(false);
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
      setLocks([]);
      setRecordsFetchedFor(null);
      return;
    }
    setRecordsLoading(true);
    try {
      const [list, lockList] = await Promise.all([
        api.listActivityRecords({ subsidiaryId: subId }),
        // Locks are fetched with the records because a locked period refuses
        // every write: without them the form happily opens a record it cannot
        // save, and the failure only surfaces after the user has typed.
        api.listPeriodLocks({ subsidiaryId: subId }),
      ]);
      setRecords(list);
      setLocks(lockList);
      setRecordsFetchedFor(subId);
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

        // Deep link (tracking matrix → here). Validated against what this user
        // can actually see: an id outside the accessible set would leave the
        // Radix Select bound to a value with no matching item, i.e. a silently
        // blank control rather than an error.
        const wantedSub = searchParams.get("subsidiaryId");
        const wantedCategory = searchParams.get("category");
        const wantedYear = Number(searchParams.get("year"));

        if (wantedSub && !list.some((sub) => sub.id === wantedSub)) {
          toast.error("That subsidiary is not available to you.");
        }
        const resolvedSub =
          wantedSub && list.some((sub) => sub.id === wantedSub)
            ? wantedSub
            : (list[0]?.id ?? "");
        if (resolvedSub) setSubsidiaryId(resolvedSub);

        if (wantedCategory) {
          if ((CATEGORIES as readonly string[]).includes(wantedCategory)) {
            setCategory(wantedCategory as Category);
          } else {
            toast.error(`Unknown category "${wantedCategory}".`);
          }
        }
        if ((REPORTING_YEARS as readonly number[]).includes(wantedYear)) {
          setReportingYear(wantedYear);
        }
        if (wantedCategory && (CATEGORIES as readonly string[]).includes(wantedCategory)) {
          deepLink.current = {
            category: wantedCategory,
            year: (REPORTING_YEARS as readonly number[]).includes(wantedYear)
              ? wantedYear
              : DEFAULT_REPORTING_YEAR,
          };
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

  /**
   * Resolve a deep link against what the subsidiary already has.
   *
   * A matrix cell says "this category, this year" and nothing about the period,
   * so the target is a set. One match is unambiguous and opens. Several is NOT
   * guessable — picking the first would silently open a period the user did not
   * ask for — so it says how many there are and leaves the form alone. None
   * means the cell was empty, which is the ordinary "enter it now" case.
   */
  useEffect(() => {
    const wanted = deepLink.current;
    if (!wanted || deepLinkHandled.current) return;
    // Wait for the rows that belong to THIS subsidiary; acting earlier reads an
    // empty list as "nothing exists" and burns the one shot this effect gets.
    if (recordsLoading || !subsidiaryId || recordsFetchedFor !== subsidiaryId) return;
    deepLinkHandled.current = true;

    const matches = records.filter(
      (r) => r.category === wanted.category && r.reportingYear === wanted.year,
    );
    if (matches.length === 1) {
      loadRecord(matches[0]);
    } else if (matches.length > 1) {
      toast.info(
        `${matches.length} ${wanted.category} records exist for ${wanted.year}. Pick one from Previous submissions, or enter another period.`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, recordsLoading, recordsFetchedFor, subsidiaryId]);

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
          // Name the year that does work. DE-9 opened the list to 2015–2026
          // while the prototype library still covers one year, so without this a
          // tester picking 2018 sees a refusal that reads like a broken app
          // rather than a boundary of the demo data.
          setPreviewError(
            `No emission factor for this selection. This prototype's factor library currently covers ${DEFAULT_REPORTING_YEAR} — try that year, or a different category or geography.`,
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

  /**
   * Pull a saved record back into the form.
   *
   * Until now `editingId` was only ever set immediately after a save, so a draft
   * you navigated away from was unreachable: returning to the same period and
   * category produced a 409 with no way to continue the record. That is also
   * exactly where a tracking-matrix cell lands you.
   *
   * Only `draft` and `rejected` are editable server-side (`EDITABLE_STATUSES`),
   * so anything else is shown, not opened — offering a form that the API will
   * refuse to save is worse than saying why.
   */
  function loadRecord(rec: ActivityRecordDTO) {
    if (rec.status !== "draft" && rec.status !== "rejected") {
      toast.info(
        `This record is ${rec.status.replace(/_/g, " ")} and can no longer be edited.`,
      );
      return;
    }
    // The API allows an author (or a super_admin) to modify a record, so a
    // colleague's draft would open, accept typing, and only then 403. On a deep
    // link this happens with no click at all — the user would be looking at
    // someone else's figures believing they were their own.
    if (user && user.role !== "super_admin" && rec.createdBy !== user.id) {
      toast.info("This record was entered by someone else — only its author can change it.");
      return;
    }
    // A period lock only flips `approved → locked`, so a draft inside a locked
    // period keeps its status and would sail past the check above. Every write
    // to it is refused with a 409.
    if (
      locks.some(
        (l) =>
          l.reportingYear === rec.reportingYear &&
          l.reportingPeriod === rec.reportingPeriod &&
          l.periodValue === rec.periodValue,
      )
    ) {
      toast.info(
        `${rec.periodValue} ${rec.reportingYear} is locked — a super_admin must unlock it before this record can change.`,
      );
      return;
    }
    setEditingId(rec.id);
    setSubsidiaryId(rec.subsidiaryId);
    setLocationId(rec.locationId ?? "");
    setReportingYear(rec.reportingYear);
    setReportingPeriod(rec.reportingPeriod);
    setPeriodValue(rec.periodValue);
    setCategory(rec.category as Category);
    setActivityValue(String(rec.activityValue));
    setActivityUnit(rec.activityUnit);
    setContext((rec.input as ContextValues | null) ?? {});
    setAnomalyFlag(rec.anomalyFlag);
    setVarianceReason(rec.varianceReason ?? "");
    setPreviewError(null);
    setEditingTuple(tupleOf(rec));
  }

  /**
   * Stop targeting the loaded record once the form no longer describes it.
   *
   * `editingId` used to be set only by your own save, so "keep editing what I
   * just saved" was a fair reading. A matrix cell now sets it WITHOUT any user
   * intent, and the reporting-entity selects were unguarded — so opening a Fuel
   * Q3 draft and then switching to Electricity Q1 overwrote the Fuel record
   * with the Electricity numbers and reported "Draft saved". The Fuel record
   * simply ceased to exist. The subsidiary select already had this protection
   * (it calls `resetForm`); the rest of the tuple did not.
   */
  useEffect(() => {
    if (!editingId || !editingTuple) return;
    const movedOff =
      editingTuple.category !== category ||
      editingTuple.reportingYear !== reportingYear ||
      editingTuple.reportingPeriod !== reportingPeriod ||
      editingTuple.periodValue !== periodValue ||
      editingTuple.locationId !== locationId;
    if (!movedOff) return;
    setEditingId(null);
    setEditingTuple(null);
    toast.info("Now entering a new record — the one you opened is untouched.");
  }, [
    editingId,
    editingTuple,
    category,
    reportingYear,
    reportingPeriod,
    periodValue,
    locationId,
  ]);

  function resetForm() {
    setActivityValue("");
    setContext({});
    setPreview(null);
    setPreviewError(null);
    setEditingId(null);
    setEditingTuple(null);
    setLocationId("");
    setAnomalyFlag(false);
    setVarianceReason("");
  }

  function tupleOf(rec: ActivityRecordDTO) {
    return {
      category: rec.category,
      reportingYear: rec.reportingYear,
      reportingPeriod: rec.reportingPeriod,
      periodValue: rec.periodValue,
      locationId: rec.locationId ?? "",
    };
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
      setEditingTuple(tupleOf(rec));
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
      setEditingTuple(tupleOf(rec));
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
                        {REPORTING_YEARS.map((y) => (
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
                  // A consultant is review-only (decision 2026-07-30) and the
                  // evidence API 403s them, so offering upload/delete controls
                  // here only produced a button that always failed.
                  canManage={
                    !!user && ["data_entry", "super_admin"].includes(user.role)
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
                  <span className="mr-auto flex items-center gap-2 text-sm text-muted-foreground">
                    Editing draft {editingId.slice(0, 8)}…
                    {/* The only way out of edit mode used to be a successful
                        submit or a page reload — and a cell click can now put
                        you here without asking. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={resetForm}
                    >
                      Start a new record
                    </Button>
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
                          <button
                            key={r.id}
                            type="button"
                            onClick={() => loadRecord(r)}
                            // Deliberately NOT aria-disabled: a non-editable row
                            // still answers "why can't I edit this?" when
                            // activated, and marking it disabled is what stops
                            // assistive tech (and Playwright) from ever reaching
                            // that answer. The hover affordance below carries the
                            // distinction instead.
                            className={`flex w-full items-center gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-left transition-colors ${
                              r.status === "draft" || r.status === "rejected"
                                ? "hover:border-primary/40 hover:bg-secondary"
                                : "cursor-default"
                            }`}
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
                          </button>
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
