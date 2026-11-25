import type { RecordTrailEventDTO, RecordTrailEventKind, RecordTrailValue } from "@/lib/types";
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
 * A stored value, written for the reader: numbers by the locale (the figure
 * to three decimals, in tCO2e), the record's own vocabulary where the field
 * has one, absent as a dash.
 */
export function formatTrailValue(
  field: string,
  value: RecordTrailValue,
  copy: { t: TrailTranslator; locale: Locale; words?: Pick<RecordWords, "period" | "category"> },
): string {
  const { t, locale, words } = copy;
  if (value === null || value === "") return t("emptyValue");
  if (typeof value === "boolean") return t(value ? "yes" : "no");
  if (typeof value === "number") {
    if (field === "figure") return `${formatNumber(value, locale, { maximumFractionDigits: 3 })} tCO2e`;
    // A year is a label, never grouped.
    if (field === "reportingYear") return String(value);
    return formatNumber(value, locale, { maximumFractionDigits: 6 });
  }
  if (words && field === "periodValue") return words.period(value);
  if (words && field === "category") return words.category(value);
  return value;
}
