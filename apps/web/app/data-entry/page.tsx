"use client";

import { canSubmitEntry, saveErrorDescription } from "@/lib/record-lifecycle-view";

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
import { useLocale, useTranslations } from "use-intl";
import { api, ApiError } from "@/lib/api";
import { useDescribeError } from "@/lib/i18n/hooks";
import type { ErrorDescription } from "@/lib/i18n/errors";
import { checkDecimal, formatNumber } from "@/lib/i18n/number";
import { useDecimalInput } from "@/lib/i18n/use-decimal-input";
import { DecimalNote } from "@/components/i18n/decimal-note";
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
import { RecentImports } from "@/components/data-entry/recent-imports";
import { PreviousSubmissions } from "@/components/data-entry/previous-submissions";
import {
  ACTIVITY_UNITS,
  appliesUnitConversion,
  CATEGORY_ACTIVITY_TYPES,
  CATEGORIES,
  GEOGRAPHY_LABELS,
  DEFAULT_REPORTING_YEAR,
  isAuthoritativeSnapshot,
  isCalculated,
  isProvenanceSnapshot,
  canonicalPeriodValue,
  isInvoiceTracked,
  mayAuthorRecords,
  PERIOD_VALUES,
  recordActivityTypesFor,
  REPORTING_YEARS,
  unitSymbol,
  unitsForCategory,
  UNSPECIFIED_ACTIVITY_TYPE,
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


/** In the order the select lists them; labelled by the catalogue's `periods.granularity`. */
const PERIODS: readonly ReportingPeriod[] = ["quarterly", "monthly", "annual"];

// The canonical vocabulary, from the contract rather than a local copy: this
// dropdown decides what a user can send, and the server now stores exactly
// these spellings. A copy that drifted would offer a value the API rejects.

/** The preview's figures, in the user's locale (LP3-01). */
const PREVIEW_DIGITS = { maximumFractionDigits: 3 } as const;
/** A factor shows every digit it has, ungrouped — only the decimal separator follows the locale. */
const FACTOR_DIGITS = { maximumFractionDigits: 20, useGrouping: false } as const;

/** A record's reporting entity, in PROSE — it appears mid-sentence ("Moved to
 *  the whole company, draft saved"), which is why it is not `entityLabel`: that
 *  one is a standalone label and is now exported from `@tonyai/shared-types`,
 *  so two functions of one name would sit in one bundle. Same `locationId`
 *  degradation, which is where the shared helper's rule came from. */
function entityPhrase(rec: ActivityRecordDTO, t: (key: "aSite" | "theWholeCompany") => string): string {
  return rec.locationId ? (rec.locationName ?? t("aSite")) : t("theWholeCompany");
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
  const t = useTranslations("dataEntry");
  const tCategories = useTranslations("categories");
  const tPeriods = useTranslations("periods");
  const tCommon = useTranslations("common");
  const describeError = useDescribeError();

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
  // The fuel or gas of a typed category (Fuel, Mobile Combustion,
  // Refrigerants — LP3-03); "" = none chosen. Never defaulted: a silently
  // pre-selected diesel would price petrol as diesel.
  const [activityType, setActivityType] = useState("");
  const activityTypes = useMemo(() => recordActivityTypesFor(category), [category]);
  const isTypedCategory = activityTypes.length > 0;

  // Primary calc inputs
  // Typed in the user's locale; a language switch keeps the number it meant
  // (`useDecimalInput`, D15 — its spec covers the switch).
  const activity = useDecimalInput();
  const activityValue = activity.text;
  const [activityUnit, setActivityUnit] = useState("kWh");

  // Optional context (demo extras)
  const [context, setContext] = useState<ContextValues>({});

  // Preview
  const [preview, setPreview] = useState<ActivityCalculationSnapshot | null>(null);
  // The failed call itself, not its sentence: the sentence is chosen at render,
  // so a language switch re-words a refusal already on screen (independent
  // review P3-3).
  const [previewError, setPreviewError] = useState<{ error: unknown; year: number } | null>(null);
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
  // Bumped after an import, so Recent imports shows the new batch.
  const [importsKey, setImportsKey] = useState(0);
  const [locks, setLocks] = useState<PeriodLockDTO[]>([]);
  // The reporting entity the loaded record belongs to. Kept so that moving the
  // form off that tuple can stop targeting it — see the effect below.
  const [editingTuple, setEditingTuple] = useState<{
    category: string;
    reportingYear: number;
    reportingPeriod: ReportingPeriod;
    periodValue: string;
    locationId: string;
    /** The opened record's own activity type, null when it names none. */
    activityType: string | null;
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
  const [editingCreatedBy, setEditingCreatedBy] = useState<string | null>(null);
  const canSubmit = canSubmitEntry(user, editingId, editingCreatedBy);
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

  // Sent as a JSON number (D15). Zero and below are not activity: the form has
  // always asked for a value above zero.
  const valueCheck = checkDecimal(activity.parsed, "positive");
  const numericValue = valueCheck.ok ? valueCheck.value : NaN;
  // Mirrors the API's `activity_type_required`: a typed category's record
  // names its activity type — unless it is a record written before LP3-03,
  // opened for editing and left untyped in its own category, the one untyped
  // record such a category may hold.
  const keepsLegacyUntyped =
    !!editingId &&
    editingTuple?.activityType === null &&
    editingTuple.category === category &&
    activityType === "";
  const activityTypeChosen = !isTypedCategory || activityType !== "" || keepsLegacyUntyped;
  const hasValidInput =
    !!selectedSubsidiary &&
    !!category &&
    !!activityUnit &&
    activityTypeChosen &&
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
  // Bumped when one file was attached to several records from the list, so the
  // open record's vault — keyed on it — refetches the file it may just have
  // gained.
  const [evidenceVersion, setEvidenceVersion] = useState(0);

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
          wantedPeriod && (PERIODS as readonly string[]).includes(wantedPeriod)
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
          ...(isTypedCategory && activityType ? { activityType } : {}),
          geographyCode: effectiveGeography ?? selectedSubsidiary.geographyCode,
          reportingYear,
          value: numericValue,
          unit: activityUnit,
        });
        setPreview(result);
        setPreviewError(null);
      } catch (e) {
        setPreview(null);
        setPreviewError({ error: e, year: reportingYear });
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
    activityType,
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
    setEditingCreatedBy(rec.createdBy);
    setSubsidiaryId(rec.subsidiaryId);
    setLocationId(rec.locationId ?? "");
    setReportingYear(rec.reportingYear);
    setReportingPeriod(rec.reportingPeriod);
    setPeriodValue(rec.periodValue);
    setCategory(rec.category as Category);
    setActivityType(rec.activityType ?? "");
    activity.setValue(rec.activityValue);
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
    setEditingCreatedBy(null);
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
    activity.setValue(null);
    setContext({});
    setPreview(null);
    setPreviewError(null);
    setEditingId(null);
    setEditingCreatedBy(null);
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
      // Not part of "moved off": changing the fuel edits the record in place.
      activityType: rec.activityType ?? null,
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
      toast.error(t("pickRequired"));
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
        // An implicit category clears any type (a Fuel draft re-filed as
        // Electricity must not carry "diesel"); a typed one sends its choice,
        // or nothing for a legacy untyped record left as it is.
        ...(isTypedCategory ? (activityType ? { activityType } : {}) : { activityType: null }),
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
      activityType: isTypedCategory ? activityType : null,
      activityValue: numericValue,
      activityUnit,
      varianceReason: variance,
      input: inputPayload,
    });
  }

  function showSaveError(e: unknown, moving: boolean) {
    const { title, description } = saveErrorDescription(e, moving, describeError, t);
    toast.error(title, description ? { description } : undefined);
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
      setEditingCreatedBy(rec.createdBy);
      setEditingTuple(tupleOf(rec));
      setVerdict(verdictOf(rec));
      // Composed, not branched. A move is the operation most likely to RAISE
      // the anomaly flag — the baseline is keyed on the reporting entity, so
      // the value is re-scored against a different pool of periods — and an
      // either/or toast would announce the move and swallow the flag, leaving
      // the user to meet it later as a blocked Submit. The location comes from
      // the server's response, so it states what was actually written.
      const entity = entityPhrase(rec, t);
      toast.success(
        wasMoving
          ? t(rec.anomalyFlag ? "movedDraftSavedAnomalous" : "movedDraftSaved", { entity })
          : t(rec.anomalyFlag ? "draftSavedAnomalous" : "draftSaved"),
      );
      await refreshRecords(subsidiaryId);
    } catch (e) {
      showSaveError(e, wasMoving);
    } finally {
      setSaving(null);
    }
  }

  async function handleSubmit() {
    // Check before persist: an admin may save another author's edits but not submit them.
    if (!canSubmit) return;
    setSaving("submit");
    const wasMoving = movingTo !== null;
    try {
      const rec = await persist();
      if (!rec) return;
      // Keep the saved record "current" so that if submit is blocked (evidence
      // or anomaly gate), the vault + variance field stay visible to fix + retry.
      setEditingId(rec.id);
      setEditingCreatedBy(rec.createdBy);
      setEditingTuple(tupleOf(rec));
      setVerdict(verdictOf(rec));
      // Mirror the server anomaly gate (VAR §2.2 / §4.3): a flagged value needs
      // a variance comment before it can be submitted.
      if (rec.anomalyFlag && !varianceReason.trim()) {
        toast.error(t("anomalousBeforeSubmit"));
        return;
      }
      await api.submitActivityRecord(rec.id);
      // Announced here too. Submitting a moved record re-attributes it just as
      // a draft save does, and saying nothing made the two paths disagree about
      // an action with the same consequence.
      toast.success(
        wasMoving ? t("movedSubmitted", { entity: entityPhrase(rec, t) }) : t("submitted"),
      );
      resetForm();
      await refreshRecords(subsidiaryId);
    } catch (e) {
      showSaveError(e, wasMoving);
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

  // The refusal's code says WHICH gap it is — no factor, a placeholder
  // refused, a conversion not loaded (LP3-03) — and is worded here, in the
  // current language. Outside the one year the prototype library covers, a 404
  // also names the year that does work (DE-9 opened the list to 2015–2026), so
  // a tester picking 2018 sees a boundary of the demo data, not a broken app.
  const previewErrorShown: ErrorDescription | null = (() => {
    if (!previewError) return null;
    const { title, description } = describeError(previewError.error);
    // A server sentence may end without a stop; the hint is a sentence of its own.
    const hint =
      previewError.error instanceof ApiError &&
      previewError.error.status === 404 &&
      previewError.year !== DEFAULT_REPORTING_YEAR
        ? `${/[.!?]$/.test(title) ? "" : "."} ${t("previewYearHint", { year: String(DEFAULT_REPORTING_YEAR) })}`
        : "";
    return { title: `${title}${hint}`, ...(description ? { description } : {}) };
  })();

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
                {t("title")}
              </h1>
              <p className="mt-1 text-muted-foreground">
                {t("subtitle")}
                {user ? ` · ${user.fullName} (${user.role})` : ""}
              </p>
            </div>
            <Button variant="outline" onClick={handleLogout} className="gap-2">
              <LogOut className="h-4 w-4" />
              {tCommon("signOut")}
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Left / center: form */}
            <div className="space-y-6 lg:col-span-2">
              {/* Scope selectors */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("reportingScope")}</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label={t("subsidiary")}>
                    {subsLoading ? (
                      <Skeleton className="h-9 w-full" />
                    ) : subsidiaries.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t("noSubsidiaries")}
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
                          <SelectValue placeholder={t("selectSubsidiary")} />
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
                  <Field label={t("location")}>
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
                        <SelectItem value="__whole__">{t("wholeCompany")}</SelectItem>
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

                  <Field label={t("category")}>
                    <Select
                      value={category}
                      onValueChange={(v) => {
                        const next = v as Category;
                        setCategory(next);
                        setContext({});
                        // Each typed category has its own list; a type chosen
                        // for Fuel means nothing for Refrigerants.
                        setActivityType("");
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
                            {tCategories(c)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>

                  {isTypedCategory && (
                    // Labelled "Fuel or gas", never with the word "category":
                    // the e2e suite finds the Category field by that text.
                    <Field label={t("fuelOrGas")}>
                      <Select value={activityType} onValueChange={setActivityType}>
                        <SelectTrigger aria-label={t("fuelOrGas")}>
                          <SelectValue
                            placeholder={
                              keepsLegacyUntyped
                                ? t("notSpecifiedLegacy")
                                : t("chooseOne")
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {activityTypes.map((t) => (
                            <SelectItem key={t.value} value={t.value}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}

                  <Field label={t("reportingYear")}>
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
                    <Field label={t("period")}>
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
                            <SelectItem key={p} value={p}>
                              {tPeriods(`granularity.${p}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label={t("periodValue")}>
                      <Select value={periodValue} onValueChange={setPeriodValue}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PERIOD_VALUES[reportingPeriod].map((v) => (
                            <SelectItem key={v} value={v}>
                              {tPeriods(`values.${v}`)}
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
                      {t("factorGeography")}{" "}
                      <span className="font-mono">{effectiveGeography}</span> —{" "}
                      {t("factorGeographySource", {
                        geography:
                          GEOGRAPHY_LABELS[effectiveGeography as keyof typeof GEOGRAPHY_LABELS] ??
                          effectiveGeography,
                        source: selectedLocation
                          ? t("locationSource", { name: selectedLocation.name })
                          : t("subsidiarySource", {
                              name:
                                selectedSubsidiary?.tradingName ??
                                selectedSubsidiary?.legalName ??
                                t("thisSubsidiary"),
                            }),
                      })}
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
                  setImportsKey((k) => k + 1);
                }}
              />

              <RecentImports
                canSubmit={mayAuthorRecords(user)}
                refreshKey={importsKey}
                onSubmitted={() => {
                  if (subsidiaryId) void refreshRecords(subsidiaryId);
                }}
              />

              {/* Activity value — the calc driver */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("activityData")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_220px]">
                    <Field label={t("activityValue")}>
                      {/* Text, not type="number": a number input reads and
                          writes the browser's convention, not the user's, and
                          silently drops what it cannot parse. The value is read
                          here by the user's locale (D15, lib/i18n/number.ts). */}
                      <Input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder={t("activityValuePlaceholder")}
                        value={activityValue}
                        onChange={(e) => activity.setText(e.target.value)}
                        aria-invalid={activityValue.trim() !== "" && !valueCheck.ok}
                        aria-describedby="activity-value-note"
                      />
                      {/* What the other convention would have read is named, so a
                          1000× misreading is visible before saving. */}
                      <DecimalNote
                        id="activity-value-note"
                        check={valueCheck}
                        otherReading={activity.otherReading}
                        locale={activity.locale}
                      />
                    </Field>
                    <Field label={t("unit")}>
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
                  <p className="text-xs text-muted-foreground">{t("unitHelp")}</p>
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
                      // The 11.36 in calculation_logic.md §2.1 has no citation
                      // and no stated reference conditions. Since LP3-03 it is a
                      // labelled placeholder conversion row of the seed's
                      // release (K4), not code; on a compliance product the user
                      // is still entitled to know the number rests on an
                      // assumption.
                      return (
                        <p className="mt-2 text-xs text-muted-foreground">
                          m³ is converted to kWh by the factor library&rsquo;s
                          placeholder conversion, &times;11.36 — a prototype
                          assumption with no cited source, no stated calorific basis
                          (gross is reconstructed, not stated) and no stated
                          reference conditions, refused wherever placeholder
                          factors are. A
                          sourced conversion replaces it with the authoritative
                          factor library.
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
                  key={`${editingId}:${evidenceVersion}`}
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
                    {t("editingDraft", { id: editingId.slice(0, 8) })}
                    {/* The only way out of edit mode used to be a successful
                        submit or a page reload — and a cell click can now put
                        you here without asking. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={resetForm}
                    >
                      {t("startNewRecord")}
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
                  {saving === "draft" ? t("saving") : t("saveDraft")}
                </Button>
                {canSubmit && <Button
                  className="gap-2"
                  onClick={handleSubmit}
                  disabled={isBusy || !hasValidInput}
                >
                  <Send className="h-4 w-4" />
                  {saving === "submit" ? t("submitting") : t("submit")}
                </Button>}
              </div>
            </div>

            {/* Right: preview + previous submissions */}
            <div className="space-y-6">
              <PreviewCard
                previewing={previewing}
                preview={preview}
                error={previewErrorShown}
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
                onEvidenceAttached={() => {
                  void refreshRecords(subsidiaryId);
                  setEvidenceVersion((v) => v + 1);
                }}
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
  error: ErrorDescription | null;
  hasValidInput: boolean;
  geographyCode: string | null;
}) {
  const t = useTranslations("dataEntry");
  const locale = useLocale();
  const numberFmt = { format: (n: number) => formatNumber(n, locale, PREVIEW_DIGITS) };
  return (
    <Card className="border-primary/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Calculator className="h-4 w-4 text-primary" />
          {t("previewTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!hasValidInput ? (
          <div className="flex items-start gap-2 py-4 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("previewPrompt")}</span>
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="space-y-1">
              <span className="block">{error.title}</span>
              {error.description && <span className="block text-xs text-amber-700/80">{error.description}</span>}
            </span>
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
                value={`${formatNumber(preview.factorValue, locale, FACTOR_DIGITS)} ${preview.factorUnit}`}
              />
              <Row
                label="Normalised input"
                value={`${numberFmt.format(preview.normalizedValue)} ${unitSymbol(preview.normalizedUnit)}`}
              />
              {isProvenanceSnapshot(preview) && (
                <Row label="Activity" value={activityLabel(preview.category, preview.activityType)} />
              )}
              <Row label="Methodology" value={preview.methodology} />
              <Row
                label="Source"
                value={`${preview.source} (${preview.version})`}
              />
              {/* Asked of the whole path, never the factor's status alone: a
                  figure is only as authoritative as its weakest link — the
                  conversion's release included (LP3-03). */}
              <Row
                label="Factor status"
                value={
                  isAuthoritativeSnapshot(preview)
                    ? "Authoritative"
                    : "Placeholder — not authoritative (factor or conversion)"
                }
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

/**
 * An activity type as people read it ("Diesel", "Grid electricity"), from the
 * category's own list; `unspecified` is the lookup of a record entered before
 * fuels were tracked.
 */
function activityLabel(category: string, activityType: string): string {
  if (activityType === UNSPECIFIED_ACTIVITY_TYPE) return "Not specified (entered before fuels were tracked)";
  return (
    CATEGORY_ACTIVITY_TYPES[category as Category]?.types.find((t) => t.value === activityType)?.label ??
    activityType
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
