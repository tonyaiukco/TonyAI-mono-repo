import type { ViewTranslator } from "@/lib/i18n/view-translator";
import {
  GEOGRAPHY_CODES,
  UNSPECIFIED_ACTIVITY_TYPE,
  recordActivityTypesFor,
  type ActivityRecordDTO,
  type GeographyCode,
  type TargetBasis,
  type TargetStatus,
} from "@/lib/types";

/**
 * Canonical values a screen shows by name (LP4-04, M2). The value stays what
 * is stored and sent; only its name comes from the catalogue.
 */

function isGeographyCode(code: string): code is GeographyCode {
  return (GEOGRAPHY_CODES as readonly string[]).includes(code);
}

/** `Türkiye` — a known geography's name, else the code as stored. */
export function geographyName(code: string, t: ViewTranslator<GeographyCode>): string {
  return isGeographyCode(code) ? t(code) : code;
}

/** `Türkiye (TR)` — the name for the reader, the code so it stays greppable
 *  (shared-types' `geographyLabel`, in the user's language). */
export function geographyLabel(code: string, t: ViewTranslator<GeographyCode>): string {
  return isGeographyCode(code) ? `${t(code)} (${code})` : code;
}

/** The words a record's canonical values are shown by — status, period value,
 *  category and activity type — in the user's language (`useRecordWords`). */
export interface RecordWords {
  status: (status: string) => string;
  period: (periodValue: string) => string;
  category: (category: string) => string;
  /**
   * The activity type's name, or `null` when the record names none. A value
   * outside its category's catalogue list is shown as stored, never hidden, so
   * two such records still read differently (uat2-review-shows-gas).
   */
  activity: (category: string, activityType: string | null | undefined) => string | null;
}

/** The slice of a root translator `recordWordsOf` needs. */
export interface RootTranslator {
  (key: string): string;
  has(key: string): boolean;
}

/**
 * Record words from a root translator — the one implementation `useRecordWords`
 * and the specs share. A value the catalogue does not hold as its OWN key is
 * shown as stored: use-intl's lookup walks the prototype chain, so
 * `categories.constructor` would otherwise "exist" and render as a key path.
 */
export function recordWordsOf(t: RootTranslator, messages: Record<string, unknown>): RecordWords {
  const owns = (path: string[]) => {
    let node: unknown = messages;
    for (const part of path) {
      if (typeof node !== "object" || node === null || !Object.prototype.hasOwnProperty.call(node, part)) return false;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === "string";
  };
  const word = (path: string[], fallback: string) => (owns(path) ? t(path.join(".")) : fallback);
  return {
    status: (status) => word(["recordStatus", "inline", status], status.replace(/_/g, " ")),
    period: (value) => word(["periods", "values", value], value),
    category: (category) => word(["categories", category], category),
    activity: (category, activityType) => {
      if (!activityType) return null;
      // A record entered before fuels were tracked: Data Entry's own wording,
      // not the raw `unspecified` inside a Turkish screen.
      if (activityType === UNSPECIFIED_ACTIVITY_TYPE) return word(["dataEntry", "notSpecifiedLegacy"], activityType);
      // The catalogue is one flat map across categories, so a value is named
      // only when it belongs to THIS category's list.
      const listed = recordActivityTypesFor(category).some((type) => type.value === activityType);
      return listed ? word(["dataEntry", "activityTypes", activityType], activityType) : activityType;
    },
  };
}

/**
 * `Refrigerants (R-410A)` — the category with the record's activity type when
 * it names one, else the category alone. One site and period can hold several
 * records that differ only by type (a gas, a fuel), and a reviewer must be
 * able to tell their rows apart (uat2-review-shows-gas, D8).
 */
export function categoryWithActivity(
  words: RecordWords,
  record: Pick<ActivityRecordDTO, "category" | "activityType">,
): string {
  const category = words.category(record.category);
  const activity = words.activity(record.category, record.activityType);
  return activity ? `${category} (${activity})` : category;
}

/** Every `TargetStatus`, in display order — shared-types declares the type
 *  only, so the list lives here and the line below fails the build if the
 *  union grows a value this list (and so the `targetStatus` catalogue the
 *  spec checks against it) does not name. */
export const TARGET_STATUSES = ["on_track", "at_risk", "off_track"] as const satisfies readonly TargetStatus[];
const everyTargetStatus: Exclude<TargetStatus, (typeof TARGET_STATUSES)[number]> extends never ? true : false = true;

/** Every `TargetBasis`, in the order the form offers them (as `TARGET_STATUSES`). */
export const TARGET_BASES = ["science_based", "internal_annual", "baseline_reduction"] as const satisfies readonly TargetBasis[];
const everyTargetBasis: Exclude<TargetBasis, (typeof TARGET_BASES)[number]> extends never ? true : false = true;
void everyTargetStatus;
void everyTargetBasis;
