import { UNSPECIFIED_ACTIVITY_TYPE, type RecordTrailEventDTO, type RecordTrailEventKind, type RecordTrailValue } from "@/lib/types";
import type { Locale } from "@/lib/types";
import { formatNumber } from "@/lib/i18n/number";
import type { RecordWords } from "@/lib/vocabulary";

/**
 * One record's history as a timeline (WP5, `uat4-review-resubmit`, design
 * decision 7): the label, colour and mark of each kind of event, the label of
 * a changed field and how a value is written, in the user's language. Pure, so
 * the rules are pinned without React; `RecordTrail` renders them.
 */

/** The slice of a translator over the `recordTrail` namespace this module needs. */
export interface TrailTranslator {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

/**
 * The lucide icon each kind is marked with, by name, and its colours. Recalled,
 * returned, edited and resubmitted — the steps a reviewer of a revised record
 * looks for — each have a colour no other kind uses.
 */
export const TRAIL_KIND_STYLE: Readonly<
  Record<RecordTrailEventKind, { mark: string; dot: string; text: string }>
> = {
  created: { mark: "plus", dot: "bg-[#64748B]", text: "text-[#334155]" },
  edited: { mark: "pencil", dot: "bg-[#2563EB]", text: "text-[#1D4ED8]" },
  submitted: { mark: "send", dot: "bg-[#0891B2]", text: "text-[#0E7490]" },
  resubmitted: { mark: "repeat", dot: "bg-[#7C3AED]", text: "text-[#5B21B6]" },
  recalled: { mark: "undo", dot: "bg-[#EA580C]", text: "text-[#C2410C]" },
  review_started: { mark: "eye", dot: "bg-[#D97706]", text: "text-[#92400E]" },
  returned: { mark: "corner-up-left", dot: "bg-[#DC2626]", text: "text-[#B91C1C]" },
  approved: { mark: "check", dot: "bg-[#059669]", text: "text-[#047857]" },
  // A masterkey's approval of their own record (inc26-roles-approval-chain,
  // Decision 8): fuchsia, a colour no other kind uses, so an auditor reading
  // the timeline never takes it for an ordinary approval.
  self_approved: { mark: "user-check", dot: "bg-[#C026D3]", text: "text-[#A21CAF]" },
  voided: { mark: "ban", dot: "bg-[#374151]", text: "text-[#111827]" },
  other: { mark: "dot", dot: "bg-[#9CA3AF]", text: "text-[#4B5563]" },
};

/** An event's headline: its kind, or for `other` the action's own label. */
export function trailKindLabel(event: Pick<RecordTrailEventDTO, "kind" | "action">, t: TrailTranslator): string {
  if (event.kind !== "other") return t(`kinds.${event.kind}`);
  const known = `actions.${event.action}`;
  return t.has(known) ? t(known) : t("kinds.other", { action: event.action });
}

/**
 * A changed field's label. A structured input's leaf is named by its part
 * (`parameters.equipment.1.refillKg` → "Equipment line 2: refilled (kg)"); a
 * path the catalogue has no label for is shown as stored.
 */
export function trailFieldLabel(field: string, t: TrailTranslator): string {
  const line = /^parameters\.equipment\.(\d+)\.(\w+)$/.exec(field);
  if (line) {
    const part = `fields.equipment.${line[2]}`;
    if (!(line[2] in Object.prototype) && t.has(part)) {
      return t("fields.equipmentLine", { n: Number(line[1]) + 1, part: t(part) });
    }
    return field;
  }
  // `input.*` and `parameters.*` keys are catalogued under their own prefix.
  // use-intl's lookup walks the prototype chain, so a segment such as
  // `constructor` would "exist": refused before the catalogue is asked.
  const key = `fields.${field}`;
  const plain = /^[\w.]+$/.test(field) && field.split(".").every((part) => !(part in Object.prototype));
  return plain && t.has(key) ? t(key) : field;
}

/**
 * The catalogue key (from the root of the catalogue) a stored code is shown
 * by, or null for a value shown as stored. A code that is not a plain word,
 * or names a prototype member, is never looked up.
 */
export function trailValueKey(field: string, value: string): string | null {
  if (!/^[\w-]+$/.test(value) || value in Object.prototype) return null;
  if (field === "reportingPeriod") return `periods.granularity.${value}`;
  // A record entered before fuels were tracked: the wording the other screens use.
  if (field === "activityType" && value === UNSPECIFIED_ACTIVITY_TYPE) return "dataEntry.notSpecifiedLegacy";
  if (field === "activityType") return `dataEntry.activityTypes.${value}`;
  if (field === "activityUnit") return `units.label.${value}`;
  if (field === "parameters.cvBasis") return `dataEntry.inputs.cvBasis.${value}`;
  if (field === "parameters.selfGenerationSource") return `dataEntry.inputs.selfGeneration.sources.${value}`;
  if (/^parameters\.equipment\.\d+\.equipmentType$/.test(field)) return `dataEntry.equipmentTypes.${value}`;
  if (/^parameters\.equipment\.\d+\.leakRateChoice$/.test(field)) return `dataEntry.inputs.choice.${value}`;
  return null;
}

/** What formatting a value needs from the screen. `root` words a stored code
 *  through `trailValueKey`; `words` names a period and a category. */
export interface TrailValueCopy {
  t: TrailTranslator;
  locale: Locale;
  words?: Pick<RecordWords, "period" | "category">;
  root?: TrailTranslator;
}

const MAX_FRACTION_DIGITS = 12;

/** `digits` up to `MAX_FRACTION_DIGITS` are decimals; past it, significant
 *  digits (1 → 21), so a value of 1e-13 still reads as itself. */
function numberAt(field: string, value: number, locale: Locale, digits: number): string {
  const options: Intl.NumberFormatOptions =
    digits <= MAX_FRACTION_DIGITS
      ? { maximumFractionDigits: digits }
      : { maximumSignificantDigits: Math.min(digits - MAX_FRACTION_DIGITS, 21) };
  const text = formatNumber(value, locale, options);
  return field === "figure" ? `${text} tCO2e` : text;
}

/** The last precision tried: 21 significant digits tells any two doubles apart. */
const LAST_DIGITS = MAX_FRACTION_DIGITS + 21;

/** The figure to three decimals and any other number to six — more where that
 *  would write a non-zero value as zero (0.00024 t is not "0"). */
function numberText(field: string, value: number, locale: Locale): { text: string; digits: number } {
  let digits = field === "figure" ? 3 : 6;
  const zero = numberAt(field, 0, locale, digits);
  while (value !== 0 && digits < LAST_DIGITS && numberAt(field, value, locale, digits) === zero) digits += 1;
  return { text: numberAt(field, value, locale, digits), digits };
}

/**
 * A stored value, written for the reader: numbers by the locale (the figure
 * to three decimals, in tCO2e), the record's own vocabulary where the field
 * has one, absent as a dash.
 */
export function formatTrailValue(field: string, value: RecordTrailValue, copy: TrailValueCopy): string {
  const { t, locale, words, root } = copy;
  if (value === null || value === "") return t("emptyValue");
  if (typeof value === "boolean") return t(value ? "yes" : "no");
  if (typeof value === "number") {
    // A year is a label, never grouped.
    if (field === "reportingYear") return String(value);
    return numberText(field, value, locale).text;
  }
  if (words && field === "periodValue") return words.period(value);
  if (words && field === "category") return words.category(value);
  const key = root ? trailValueKey(field, value) : null;
  return key && root!.has(key) ? root!(key) : value;
}

/**
 * One change's two sides. Two different numbers never read alike: when the
 * usual precision writes them the same (0.00024 → 0.00048 t), both are
 * written with more digits until they differ.
 */
export function formatTrailChange(
  field: string,
  before: RecordTrailValue,
  after: RecordTrailValue,
  copy: TrailValueCopy,
): { before: string; after: string } {
  let b = formatTrailValue(field, before, copy);
  let a = formatTrailValue(field, after, copy);
  if (typeof before === "number" && typeof after === "number" && before !== after && field !== "reportingYear") {
    let digits = Math.max(numberText(field, before, copy.locale).digits, numberText(field, after, copy.locale).digits);
    while (a === b && digits < LAST_DIGITS) {
      digits += 1;
      b = numberAt(field, before, copy.locale, digits);
      a = numberAt(field, after, copy.locale, digits);
    }
  }
  return { before: b, after: a };
}
