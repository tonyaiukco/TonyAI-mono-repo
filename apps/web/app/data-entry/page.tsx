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
  Info,
  Leaf,
  LogOut,
  MoveRight,
  Save,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import {
  anomalyStatement,
  type AnomalyVerdictFields,
} from "@/lib/anomaly-view";

/** The three fields that make up a VAR §4 verdict, off a record DTO. Picked
 *  rather than spread so a future DTO field cannot quietly join the state. */
const verdictOf = (rec: {
  anomalyFlag: boolean;
  anomalyBaselinePriorCount: number | null;
  anomalyBaselineTCo2e: number | null;
}): AnomalyVerdictFields => ({
  anomalyFlag: rec.anomalyFlag,
  anomalyBaselinePriorCount: rec.anomalyBaselinePriorCount,
  anomalyBaselineTCo2e: rec.anomalyBaselineTCo2e,
});
import { cn } from "@/lib/utils";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";
import { EvidenceVault } from "@/components/data-entry/evidence-vault";
import { CoveragePanel } from "@/components/data-entry/coverage-panel";
import { BulkUploadPanel } from "@/components/data-entry/bulk-upload-panel";
import { PreviousSubmissions } from "@/components/data-entry/previous-submissions";
import {
  ACTIVITY_UNITS,
  appliesUnitConversion,
  CATEGORIES,
  GEOGRAPHY_LABELS,
  DEFAULT_REPORTING_YEAR,
  isCalculated,
  canonicalPeriodValue,
  isInvoiceTracked,
  mayAuthorRecords,
  PERIOD_VALUES,
  REPORTING_YEARS,
  unitSymbol,
  unitsForCategory,
  WHOLE_COMPANY_ENTITY_LABEL,
} from "@/lib/types";
import { isPeriodLockedFor } from "@/lib/bulk-submit-view";
import {
  NOT_CALCULATED_LABEL,
  NO_FACTOR_LABEL,
} from "@/lib/calculation-display";
import type {
  ActivityCalculationSnapshot,
  ActivityRecordDTO,
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
import { describeMove, hasMovedOffRecord } from "@/lib/record-identity";

// --- Static option sets -----------------------------------------------------


const PERIODS: { value: ReportingPeriod; label: string }[] = [
  { value: "quarterly", label: "Quarterly" },
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Annual" },
];

// The canonical vocabulary, from the contract rather than a local copy: this
// dropdown decides what a user can send, and the server now stores exactly
// these spellings. A copy that drifted would offer a value the API rejects.

const numberFmt = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 3,
});

/** Turn a save/submit failure into a message a user can act on.
 *
 * A duplicate reporting entity is a 409 — the API grew a P2002 handler and this
 * still claimed it was "a bare 500", so the one case it existed to explain was
 * the one case it no longer caught. 5xx keeps a generic hint because an
 * unexpected server error tells the user nothing on its own. */
/** A record's reporting entity, in PROSE — it appears mid-sentence ("Moved to
 *  the whole company, draft saved"), which is why it is not `entityLabel`: that
 *  one is a standalone label and is now exported from `@tonyai/shared-types`,
 *  so two functions of one name would sit in one bundle. Same `locationId`
 *  degradation, which is where the shared helper's rule came from. */
function entityPhrase(rec: ActivityRecordDTO): string {
  return rec.locationId
    ? (rec.locationName ?? "a site")
    : `the ${WHOLE_COMPANY_ENTITY_LABEL.toLowerCase()}`;
}

function saveErrorMessage(e: unknown, moving = false): string {
  if (e instanceof ApiError && e.status === 409) {
    // Three things return 409: a duplicate reporting entity, and two period-lock
    // refusals. Only the first is fixed by opening the existing record, so the
    // advice is attached to the message that earns it — the lock's own sentence
    // already says what to do.
    if (/locked/i.test(e.message)) return e.message;
    // A MOVE that collides is a different situation from a create that
    // collides, and the create's advice is wrong for it: there is nothing to
    // "continue" — the record the user is holding still exists where it was.
    // Saying only what is true, because the honest remedy (removing one of the
    // two) is not something this screen can currently offer for committed data.
    return moving
      ? `${e.message} The record has not been moved, and stays where it is.`
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
  const [preview, setPreview] = useState<ActivityCalculationSnapshot | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // Anomaly (VAR §4): server flags a value that deviates >±50% from the
  // baseline; a variance comment is then mandatory before submit.
  // The whole verdict, not just its flag: a screen holding only the boolean
  // cannot tell "checked and clean" from "never checked", which is the entire
  // point of WP21. `anomalyFlag` stays derived so the submit gate and the save
  // toast below read exactly as they did.
  const [verdict, setVerdict] = useState<AnomalyVerdictFields>({
    anomalyFlag: false,
    anomalyBaselinePriorCount: null,
    anomalyBaselineTCo2e: null,
  });
  const anomalyFlag = verdict.anomalyFlag;
  const [varianceReason, setVarianceReason] = useState("");

  // Records + saving
  const [records, setRecords] = useState<ActivityRecordDTO[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  // Which subsidiary the rows in `records` actually belong to. `records.length`
  // cannot answer that: an empty list means both "not fetched yet" and "fetched,
  // none exist", and the deep-link effect below has to tell those apart.
  const [recordsFetchedFor, setRecordsFetchedFor] = useState<string | null>(null);
  /** Bumped whenever records are refetched, so `CoveragePanel` re-reads the
   *  completeness endpoint after a save, a submit or a subsidiary switch. */
  const [coverageKey, setCoverageKey] = useState(0);
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
  /**
   * A deep link from the dashboard. The matrix cell can only say "this category,
   * this year"; the WP17 invoice grid also names the SITE and the MONTH, which
   * is exactly the ambiguity the resolver below has to give up on otherwise.
   */
  const deepLink = useRef<{
    category: string;
    year: number;
    locationId?: string;
    period?: ReportingPeriod;
    periodValue?: string;
  } | null>(null);
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

  /**
   * Set while an OPEN record's location has been changed but not yet saved —
   * i.e. the next save re-attributes it rather than creating anything (WP18).
   *
   * Built as one finished sentence rather than as JSX with `{expr}` on its own
   * line, which drops the separating space (that bug shipped twice in WP17).
   */
  const movingTo = useMemo(() => {
    // The open record's OWN snapshot decides whether a factor is being
    // recalculated — not its category, which only says one is permitted to be
    // absent. `records` is the list this page already holds.
    const open = editingId ? records.find((r) => r.id === editingId) : undefined;
    return describeMove(
      editingId ? editingTuple : null,
      { locationId },
      new Map(availableLocations.map((l) => [l.id, l.name])),
      open ? isCalculated(open.calculation) : true,
    );
  }, [editingId, editingTuple, locationId, availableLocations, records]);

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

  /**
   * Keep the record list's evidence count in step with the vault.
   *
   * `evidenceCount` is a read-time snapshot from the list endpoint, and the
   * checkbox on Previous submissions reads it — so without this, attaching the
   * invoice an Electricity draft is waiting for leaves the row still saying
   * "Needs an evidence file", with no checkbox, until something else happens to
   * refetch. That is the one category the feature most needs to work on.
   *
   * `useCallback`, and not an inline arrow: `EvidenceVault.refresh` lists this
   * among its dependencies and an effect calls it, so a handler with a new
   * identity every render would refetch the vault forever. Patching the one row
   * rather than refetching the list keeps it to no requests at all.
   */
  const handleEvidenceCountChange = useCallback(
    (count: number) => {
      setRecords((rows) =>
        rows.map((r) => (r.id === editingId ? { ...r, evidenceCount: count } : r)),
      );
    },
    [editingId],
  );

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
      // Every write path already funnels through here, so the collection-status
      // panel refetches with the record list rather than needing its own hook on
      // each of them. A panel that kept the pre-save fraction would be wrong at
      // the one moment a user looks straight at it for confirmation.
      setCoverageKey((n) => n + 1);
    } catch (e) {
      // Cleared, not kept. Leaving the previous subsidiary's rows on screen
      // under the new subsidiary's header is bad enough while they are only
      // openable; with checkboxes beside them it is an irreversible action
      // offered against records the screen no longer claims to be showing.
      setRecords([]);
      setLocks([]);
      setRecordsFetchedFor(null);
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
        // The invoice grid's extra coordinates, validated the same way as the
        // rest: an unknown location or a non-canonical month is dropped rather
        // than trusted, so a hand-edited URL cannot put the form somewhere it
        // could not otherwise reach.
        const wantedLocation = searchParams.get("locationId");
        const wantedPeriod = searchParams.get("period");
        const wantedPeriodValue = searchParams.get("periodValue");
        const validPeriod =
          wantedPeriod && (PERIODS as { value: ReportingPeriod }[]).some((p) => p.value === wantedPeriod)
            ? (wantedPeriod as ReportingPeriod)
            : undefined;
        // Canonicalised rather than matched exactly. A link carrying
        // `?periodValue=january` used to fail the membership test and drop the
        // period silently, landing the user on the wrong month with nothing
        // said; the server accepts and stores that spelling as `January`, so
        // the form should arrive there too.
        const validPeriodValue =
          validPeriod && wantedPeriodValue
            ? (canonicalPeriodValue(validPeriod, wantedPeriodValue) ?? undefined)
            : undefined;

        if (validPeriod) setReportingPeriod(validPeriod);
        if (validPeriodValue) setPeriodValue(validPeriodValue);
        // Validated against the locations this user can actually see, and
        // against the resolved subsidiary — the same reason the subsidiary id
        // is checked above: a Select bound to a value with no matching item
        // renders as a silently blank control rather than an error. Applied
        // here, with `locs` in hand, so the form is already pointed at the site
        // whose month the user clicked.
        const validLocation =
          wantedLocation &&
          locs.some((l) => l.id === wantedLocation && l.subsidiaryId === resolvedSub)
            ? wantedLocation
            : undefined;
        if (validLocation) setLocationId(validLocation);

        if (wantedCategory && (CATEGORIES as readonly string[]).includes(wantedCategory)) {
          deepLink.current = {
            category: wantedCategory,
            year: (REPORTING_YEARS as readonly number[]).includes(wantedYear)
              ? wantedYear
              : DEFAULT_REPORTING_YEAR,
            // The VALIDATED value, not the raw one. They diverged: the form
            // control used the checked value while the matcher below narrowed
            // on whatever the URL said, so a rejected foreign location silently
            // suppressed the "records already exist" notice and served a blank
            // form instead.
            ...(validLocation ? { locationId: validLocation } : {}),
            ...(validPeriod ? { period: validPeriod } : {}),
            ...(validPeriodValue ? { periodValue: validPeriodValue } : {}),
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

    // Compared case-insensitively, like the coverage rule: the grid keys slots
    // on a normalised month while this matched exactly, so a record stored as
    // "july" left the slot looking open AND gave a blank form on the click —
    // two rows for one month.
    //
    // Narrowed by whatever the link actually named. A grid slot names all four,
    // so "several records exist" — the answer a matrix cell has to settle for —
    // stops being the outcome for the one caller that knows precisely which
    // record it means.
    const matches = records.filter(
      (r) =>
        r.category === wanted.category &&
        r.reportingYear === wanted.year &&
        (wanted.locationId === undefined || r.locationId === wanted.locationId) &&
        (wanted.period === undefined || r.reportingPeriod === wanted.period) &&
        (wanted.periodValue === undefined ||
          r.periodValue.trim().toLowerCase() === wanted.periodValue.toLowerCase()),
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
    if (isPeriodLockedFor(rec, locks)) {
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
    setVerdict(verdictOf(rec));
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
   *
   * **`locationId` is deliberately NOT in this list** (WP18). It was swept in
   * with the rest, and the consequence was the opposite of the bug above: the
   * API has accepted a location change on update since 2026-07-07 — it
   * re-targets the record and recomputes the snapshot from the new entity's
   * geography — but the client abandoned the edit first, so the save became a
   * POST and *created a second row*. Since the uniqueness index counts
   * `location_id`, both rows survive and BOTH feed the emissions total. The one
   * control a user would reach for to fix a mis-attributed record was the
   * control that manufactured the duplicate. Moving a record is now an edit,
   * and `movingTo` below makes it visible before it is saved.
   */
  useEffect(() => {
    if (!editingId || !editingTuple) return;
    const movedOff = hasMovedOffRecord(editingTuple, {
      category,
      reportingYear,
      reportingPeriod,
      periodValue,
      locationId,
    });
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
    setVerdict({
      anomalyFlag: false,
      anomalyBaselinePriorCount: null,
      anomalyBaselineTCo2e: null,
    });
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
    // Read once, for use after the awaits. `movingTo` is a per-render const so
    // it could not change mid-handler either way; naming it here is what keeps
    // the success and failure branches describing the SAME attempt.
    const wasMoving = movingTo !== null;
    try {
      const rec = await persist();
      if (!rec) return;
      setEditingId(rec.id);
      setEditingTuple(tupleOf(rec));
      setVerdict(verdictOf(rec));
      // Composed, not branched. A move is the operation most likely to RAISE
      // the anomaly flag — the baseline is keyed on the reporting entity, so
      // the value is re-scored against a different pool of periods — and an
      // either/or toast would announce the move and swallow the flag, leaving
      // the user to meet it later as a blocked Submit. The location comes from
      // the server's response, so it states what was actually written.
      const anomalyNote = rec.anomalyFlag
        ? " — value flagged as anomalous, add a variance comment"
        : "";
      toast.success(
        wasMoving
          ? `Moved to ${entityPhrase(rec)}, draft saved${anomalyNote}`
          : `Draft saved${anomalyNote}`,
      );
      await refreshRecords(subsidiaryId);
    } catch (e) {
      toast.error(saveErrorMessage(e, wasMoving));
    } finally {
      setSaving(null);
    }
  }

  async function handleSubmit() {
    setSaving("submit");
    const wasMoving = movingTo !== null;
    try {
      const rec = await persist();
      if (!rec) return;
      // Keep the saved record "current" so that if submit is blocked (evidence
      // or anomaly gate), the vault + variance field stay visible to fix + retry.
      setEditingId(rec.id);
      setEditingTuple(tupleOf(rec));
      setVerdict(verdictOf(rec));
      // Mirror the server anomaly gate (VAR §2.2 / §4.3): a flagged value needs
      // a variance comment before it can be submitted.
      if (rec.anomalyFlag && !varianceReason.trim()) {
        toast.error(
          "This value looks anomalous — add a variance comment before submitting.",
        );
        return;
      }
      await api.submitActivityRecord(rec.id);
      // Announced here too. Submitting a moved record re-attributes it just as
      // a draft save does, and saying nothing made the two paths disagree about
      // an action with the same consequence.
      toast.success(
        wasMoving
          ? `Moved to ${entityPhrase(rec)}, submitted for review`
          : "Submitted for review",
      );
      resetForm();
      await refreshRecords(subsidiaryId);
    } catch (e) {
      toast.error(saveErrorMessage(e, wasMoving));
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
                      The chosen entity drives the factor geography (data_entry_page.md §5.2). */}
                  <Field label="Location">
                    <Select
                      value={locationId || "__whole__"}
                      onValueChange={(v) => setLocationId(v === "__whole__" ? "" : v)}
                      disabled={subsLoading || !subsidiaryId}
                    >
                      <SelectTrigger
                        aria-describedby={
                          movingTo ? "location-move-notice" : undefined
                        }
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__whole__">{WHOLE_COMPANY_ENTITY_LABEL}</SelectItem>
                        {availableLocations.map((l) => (
                          <SelectItem key={l.id} value={l.id}>
                            {l.name} ({l.geographyCode})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* Changing this on an open record MOVES it. Every other
                        field in this card starts a fresh record instead, so the
                        one that behaves differently has to say so — silently
                        re-attributing committed data on the next Save would be
                        worse than the duplicate this replaced. */}
                    {/* Mounted unconditionally, and never `display: none`.
                        A live region announces nothing if it is absent from the
                        accessibility tree when its text arrives — and `hidden`
                        removes it, so toggling that class made the region inert
                        while looking correct. Only the CHILDREN and the margin
                        toggle; an empty <p> occupies no space. This is the one
                        consequence warning on the page a keyboard user would
                        otherwise never hear, while the far less consequential
                        abandon path already announces itself via a toast. */}
                    <p
                      id="location-move-notice"
                      role="status"
                      className={cn(
                        "flex items-start gap-1.5 text-xs text-amber-700",
                        movingTo && "mt-1.5",
                      )}
                    >
                      {movingTo && (
                        <>
                          <MoveRight className="mt-0.5 h-3 w-3 shrink-0" />
                          <span>{movingTo}</span>
                        </>
                      )}
                    </p>
                  </Field>

                  <Field label="Category">
                    <Select
                      value={category}
                      onValueChange={(v) => {
                        const next = v as Category;
                        setCategory(next);
                        setContext({});
                        // The unit list is category-scoped, so a unit that is
                        // not offered for the new category would otherwise stay
                        // selected and bind the Select to a value with no item —
                        // a silently blank control, and a request the API now
                        // rejects.
                        const allowed = unitsForCategory(next);
                        if (!allowed.some((u) => u.value === activityUnit)) {
                          setActivityUnit(allowed[0]?.value ?? "kWh");
                        }
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

                  {/* What actually decides the emission factor.
                      Round-1 DE-6 asked for Türkiye as a selectable "grid
                      region"; the field they were looking at was metadata that
                      never reached the engine. The geography is not a per-record
                      choice — it comes from the reporting entity (data_entry_page.md §5.2) — so
                      the honest fix is to show it, and to say where it came
                      from, rather than offer a control that changes nothing. */}
                  {effectiveGeography && (
                    <p className="text-xs text-muted-foreground">
                      Factor geography:{" "}
                      <span className="font-mono">{effectiveGeography}</span> —{" "}
                      {GEOGRAPHY_LABELS[
                        effectiveGeography as keyof typeof GEOGRAPHY_LABELS
                      ] ?? effectiveGeography}
                      , from{" "}
                      {selectedLocation
                        ? `${selectedLocation.name} (location)`
                        : `${selectedSubsidiary?.tradingName ?? selectedSubsidiary?.legalName ?? "this subsidiary"} (subsidiary)`}
                      . Change it on the Subsidiaries page.
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Many records at once — the alternative to the form below.
                  Above the record fields and NOT inside the `editingId` gate:
                  an importer has no open record, and this is the only thing on
                  the page a user reaches before having one. */}
              <BulkUploadPanel
                canManage={mayAuthorRecords(user)}
                onImported={() => {
                  // Both the previous-submissions list and CoveragePanel are
                  // looking at pre-import numbers at the exact moment the user
                  // checks them for confirmation. `refreshRecords` bumps
                  // `coverageKey` itself, so one call is the whole refresh.
                  //
                  // Scoped to the SELECTED subsidiary, while an import can
                  // span every entity the caller can reach — so importing for
                  // one entity while looking at another correctly changes
                  // nothing on screen. The panel's own verdict is what reports
                  // the outcome; widening this would mean refetching every
                  // accessible subsidiary on every import.
                  if (subsidiaryId) void refreshRecords(subsidiaryId);
                }}
              />

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
                          {/* Scoped to the category: offering therms for
                              Electricity used to produce a plausible number
                              rather than an error. */}
                          {unitsForCategory(category).map((u) => (
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
                  {(() => {
                    const spec = ACTIVITY_UNITS.find(
                      (u) => u.value === activityUnit,
                    );
                    if (spec?.blocked) {
                      return (
                        <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900">
                          {spec.blocked}
                        </p>
                      );
                    }
                    // Keyed on the unit AND the category. On the unit alone this
                    // note was correct only while m³ meant natural gas: for a
                    // category with no factor nothing is converted at all, and
                    // the note was telling the user their water meter had been
                    // multiplied by the natural-gas calorific value.
                    if (
                      activityUnit === "cubic_metres" &&
                      appliesUnitConversion(activityUnit, category)
                    ) {
                      // The 11.36 in calculation_logic.md §2.1 has no citation,
                      // no calorific basis and no stated reference conditions.
                      // It has been converting silently; on a compliance product
                      // the user is entitled to know the number rests on an
                      // assumption.
                      return (
                        <p className="mt-2 text-xs text-muted-foreground">
                          m³ is converted to kWh at &times;11.36 — a prototype
                          assumption with no cited source, and no stated calorific
                          basis or reference conditions. It will be replaced by a
                          sourced factor in the Phase-4 factor library.
                        </p>
                      );
                    }
                    if (activityUnit === "cubic_metres") {
                      return (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Recorded exactly as entered, in m³. No conversion is
                          applied, because {category} has no emission factor to
                          convert towards.
                        </p>
                      );
                    }
                    return null;
                  })()}
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
                  onCountChange={handleEvidenceCountChange}
                  // A consultant is review-only (decision 2026-07-30) and the
                  // evidence API 403s them, so offering upload/delete controls
                  // here only produced a button that always failed.
                  canManage={mayAuthorRecords(user)}
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
                        {anomalyStatement(verdict).detail} Please verify it and
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

              {/* The other half of VAR §4, and the half that was invisible: a
                  saved record the rule could NOT run on. Rendering nothing here
                  told the author "fine" about a value nobody checked. Neutral,
                  not amber — a short window is the normal state of a new
                  series' first months and is not something to act on. */}
              {editingId !== null &&
                !anomalyFlag &&
                anomalyStatement(verdict).tone === "not_evaluated" && (
                  <Card className="border-slate-200 bg-slate-50/60">
                    <CardContent className="flex items-start gap-2 pt-5 text-sm text-slate-600">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        <span className="font-medium">
                          {anomalyStatement(verdict).headline}.
                        </span>{" "}
                        {anomalyStatement(verdict).detail}
                      </span>
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

              {/* Round-1 DE-2: whether this subsidiary's year is actually
                  finished, as opposed to whether this one record saved. */}
              <CoveragePanel
                subsidiaryId={subsidiaryId}
                reportingYear={reportingYear}
                category={category}
                locationId={locationId}
                reportingPeriod={reportingPeriod}
                periodValue={periodValue}
                // The panel's warnings all say "this entry"; none of them is
                // true before one exists. `resetForm()` runs before the refetch
                // after a submit, so an ungated panel announced "this entry is
                // recorded for the whole company" at the exact confirmation
                // moment for a site invoice that had just been filed.
                hasEntry={hasValidInput || editingId !== null}
                // A pending move is not a second row: without this the panel
                // warns that the record about to LEAVE the whole-company slot
                // would double-count the month it is leaving.
                movingFrom={movingTo ? (editingTuple?.locationId ?? null) : null}
                refreshKey={coverageKey}
              />

              <PreviousSubmissions
                // Remounted per subsidiary, so a selection cannot survive a
                // switch. Without it, A -> B -> A resurrects ticks the user
                // made minutes ago, and a failed refetch leaves A's rows —
                // still tickable — under B's header.
                key={subsidiaryId}
                records={records}
                loading={recordsLoading}
                onOpen={loadRecord}
                user={user}
                locks={locks}
                onSubmitted={() => void refreshRecords(subsidiaryId)}
              />
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
  preview: ActivityCalculationSnapshot | null;
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
        ) : !isCalculated(preview) ? (
          // The moment that has to be unambiguous: the user typed a valid
          // reading and no number came back. Saying so plainly — with the API's
          // own reason and what WILL still happen — is the difference between
          // "the app is broken" and "this category is tracked by invoice".
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-sky-900">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">{NOT_CALCULATED_LABEL}</p>
                <p className="text-xs text-sky-900/80">{preview.reason}</p>
              </div>
            </div>
            <dl className="space-y-2 text-sm">
              <Row label="Emission factor" value={NO_FACTOR_LABEL} />
              <Row
                label="Recorded as"
                value={`${numberFmt.format(preview.inputValue)} ${unitSymbol(preview.inputUnit)}`}
              />
              {geographyCode && <Row label="Geography" value={geographyCode} />}
            </dl>
            {/* "It counts towards data completeness" was the first wording, cut
                because the completeness engine had not shipped. It has now — and
                the claim is true only under the whole rule, not merely because
                the category is invoice-tracked. A slot closes on a MONTHLY entry
                for a SITE of a location-measured subsidiary, so gating on the
                category alone put this card's promise directly above the status
                panel's "closes none of the 24 site invoices" for the screen's
                own default form state. Two adjacent cards, opposite claims.
                Stated conditionally instead, which is true in every case. */}
            <p className="text-xs text-muted-foreground">
              You can still save and submit this entry. An invoice is required
              before it can be submitted, since without an emission factor the
              invoice is the only record of what was consumed.
              {isInvoiceTracked(preview.category)
                ? " Recorded against a site for a single month, it also counts towards that site's invoice completeness — which is measured from the invoice, not from the calculated figure."
                : ""}
            </p>
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
                value={`${numberFmt.format(preview.normalizedValue)} ${unitSymbol(preview.normalizedUnit)}`}
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
                  Unit converted from {unitSymbol(preview.inputUnit)} to{" "}
                  {unitSymbol(preview.normalizedUnit)} before applying the factor.
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
