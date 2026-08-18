// The WP17 invoice rule, as the two screens that show it need to read it.
//
// Pure and shared on purpose. The dashboard drill-down (PR 3) and the Data Entry
// status panel (PR 4) answer different questions about the SAME response, and
// the first version of the drill-down built its explanations inline — so a
// second surface would have meant a second set of sentences, free to describe
// the rule slightly differently from the one the server actually applies. The
// numbers already come from one function on the API side; the words come from
// one function here.
import type {
  CategoryCompleteness,
  CompletenessSlot,
  SubsidiaryCompletenessDTO,
} from "@/lib/types";

/** "1 entry is" / "3 entries are" — the count needs its noun, and its plural. */
export function entries(n: number): string {
  return `${n} ${n === 1 ? "entry is" : "entries are"}`;
}

/**
 * What one `(location, month)` slot is, for a reader.
 *
 * Four states, from two booleans plus the company-level month list:
 * - `accepted`  — an invoice is in and a reviewer has accepted it
 * - `awaiting`  — an invoice is in and nobody has reviewed it yet (DE-2)
 * - `company`   — the month is recorded for the WHOLE COMPANY, so this site's
 *                 slot is still open, but keying it here would double-count
 * - `open`      — nothing recorded
 *
 * `awaiting` cannot occur where `covered` is false: the API derives it as a
 * subset of the covered set, so the fourth combination is unreachable rather
 * than merely unexpected.
 */
export type SlotState = "accepted" | "awaiting" | "company" | "open";

export function slotState(
  slot: CompletenessSlot,
  companyLevelMonths: readonly string[],
): SlotState {
  if (slot.covered) return slot.awaitingReview ? "awaiting" : "accepted";
  return companyLevelMonths.includes(slot.month.toLowerCase())
    ? "company"
    : "open";
}

/** Never colour alone — at this size the panel must survive greyscale. */
export const SLOT_GLYPH: Record<SlotState, string> = {
  accepted: "✓",
  awaiting: "◐",
  company: "◆",
  open: "·",
};

export const SLOT_DESCRIPTION: Record<SlotState, string> = {
  accepted: "invoice attached and approved",
  awaiting: "invoice attached, waiting for review",
  company:
    "recorded for the whole company — entering a site invoice would count this month twice",
  open: "missing",
};

/**
 * Why `covered` falls short of `required` — the committed records that exist
 * but close no slot.
 *
 * Each line names a real count from the response. Nothing here is inferred: a
 * shortfall the API cannot explain would be a shortfall the user cannot act on.
 */
export function shortfallReasons(
  category: CategoryCompleteness,
  reportingYear: number,
): string[] {
  const reasons: string[] = [];
  if (category.unattributedRecords > 0) {
    reasons.push(
      `${entries(category.unattributedRecords)} recorded for the whole company rather than a site, so they close no site's month.`,
    );
  }
  if (category.outOfScopeRecords > 0) {
    reasons.push(
      `${entries(category.outOfScopeRecords)} at a site that did not exist yet at the end of ${reportingYear}, so there is no row above for them.`,
    );
  }
  if (category.nonMonthlyRecords > 0) {
    reasons.push(
      `${entries(category.nonMonthlyRecords)} not reported as a single month, so none of them stands in for a monthly invoice.`,
    );
  }
  if (category.missingEvidenceRecords > 0) {
    reasons.push(
      `${entries(category.missingEvidenceRecords)} with no invoice attached.`,
    );
  }
  return reasons;
}

/**
 * Why a category with every slot closed still is not finished (round-1 DE-2).
 *
 * Without this the cell can read 24/24 and still be yellow with nothing on
 * screen accounting for it — the exact "unexplained amber" the shortfall lines
 * above exist to prevent, reintroduced by the review gate.
 */
export function reviewNote(awaitingReviewSlots: number): string | null {
  if (awaitingReviewSlots <= 0) return null;
  return awaitingReviewSlots === 1
    ? "1 invoice is keyed in but still waiting for review, so this category is not finished yet."
    : `${awaitingReviewSlots} invoices are keyed in but still waiting for review, so this category is not finished yet.`;
}

// ---------------------------------------------------------------------------
// The Data Entry status panel (round-1 DE-2)
// ---------------------------------------------------------------------------

export interface EntryMonth {
  month: string;
  state: SlotState;
}

/**
 * What the Data Entry panel should say, given the response and what the form is
 * currently pointed at.
 *
 * A discriminated union rather than a bag of optionals: three of these four
 * states are "the invoice rule does not apply here", and each needs a DIFFERENT
 * sentence. Collapsing them into one nullable fraction is how a screen ends up
 * rendering "0 / 0" — a number that reads as failure for a subsidiary that is
 * simply not measured that way.
 */
export type EntryCoverage =
  | { kind: "whole_company" }
  | { kind: "no_locations"; year: number }
  | { kind: "category_not_tracked"; category: string }
  | {
      kind: "tracked";
      category: string;
      year: number;
      /** `locations × 12` for the year. */
      required: number;
      /** Slots closed by a committed monthly invoice, reviewed or not. */
      covered: number;
      /** Of those, still queued for review. */
      awaitingReview: number;
      /** Closed AND accepted — the only ones that count as finished. */
      accepted: number;
      status: "complete" | "awaiting_review" | "in_progress";
      headline: string;
      reasons: string[];
      /** Things that concern what the user is about to key in, as opposed to
       *  what is already recorded. */
      warnings: string[];
      /** The chosen site's own twelve months, or null when the form is pointed
       *  at the whole company (which has no row in this grid). */
      selected: { locationName: string; months: EntryMonth[] } | null;
    };

export interface EntryCoverageInput {
  data: SubsidiaryCompletenessDTO;
  category: string;
  /** The form's location field; `""` means "Whole subsidiary". */
  locationId: string;
  reportingPeriod: string;
  /** The form's period value — a month name when `reportingPeriod` is monthly. */
  periodValue: string;
}

export function deriveEntryCoverage({
  data,
  category,
  locationId,
  reportingPeriod,
  periodValue,
}: EntryCoverageInput): EntryCoverage {
  // The API returns no categories for a subsidiary measured as a whole. That is
  // not zero progress — the rule does not apply to it at all.
  if (data.trackingGranularity !== "location") return { kind: "whole_company" };

  const tracked = data.categories.find((c) => c.category === category);
  if (!tracked) return { kind: "category_not_tracked", category };

  // A location-measured subsidiary whose sites all postdate the reported year.
  // `required` is 0, and "0 of 0" would satisfy every complete-check written the
  // obvious way — a green tick over a year nothing was tracked for.
  if (tracked.required === 0) {
    return { kind: "no_locations", year: data.reportingYear };
  }

  const accepted = tracked.covered - tracked.awaitingReviewSlots;
  const status =
    accepted >= tracked.required
      ? "complete"
      : tracked.covered >= tracked.required
        ? "awaiting_review"
        : "in_progress";

  const reasons = shortfallReasons(tracked, data.reportingYear);
  const note = reviewNote(tracked.awaitingReviewSlots);
  if (note) reasons.push(note);

  const site = locationId
    ? tracked.locations.find((l) => l.locationId === locationId)
    : undefined;

  const warnings: string[] = [];
  const month = periodValue.trim().toLowerCase();
  const atCompanyLevel = tracked.companyLevelMonths.includes(month);

  if (locationId && !site) {
    // The API builds the denominator from sites that existed at the end of the
    // reported year, so a newer site has no row. Saying nothing would render
    // this identically to a whole-company entry — the one case where the panel
    // legitimately shows no months — and the user would never learn why their
    // invoice is not counted.
    warnings.push(
      `This site is not part of ${data.reportingYear}'s ${tracked.required} invoices — it was created after that year ended.`,
    );
  } else if (!locationId) {
    // The honest version of what made a tester read green as "done": an entry
    // for the whole company is a perfectly valid record that closes none of
    // the site invoices this panel is counting.
    warnings.push(
      `This entry is recorded for the whole company, so it closes none of the ${tracked.required} site invoices tracked here.`,
    );
  } else if (reportingPeriod !== "monthly") {
    warnings.push(
      `A ${reportingPeriod} entry closes no invoice slot — the rule counts one invoice per month.`,
    );
  } else if (atCompanyLevel) {
    // The trap PR 3 closed on the dashboard, on the screen where the record is
    // actually written. Nothing deduplicates these downstream and the uniqueness
    // index cannot catch them, so this sentence is the only thing between a
    // tester and a month counted twice.
    warnings.push(
      `${periodValue.trim()} ${data.reportingYear} is already recorded for the whole company. Keying a site invoice for it as well would count that month twice — both rows feed the emissions total.`,
    );
  }

  return {
    kind: "tracked",
    category,
    year: data.reportingYear,
    required: tracked.required,
    covered: tracked.covered,
    awaitingReview: tracked.awaitingReviewSlots,
    accepted,
    status,
    // Leads with what a data-entry user is actually working through. The review
    // state qualifies it rather than replacing it — "12 of 24 keyed in" and "6
    // of those approved" are both true and a panel that showed only the second
    // would look like the app had lost half the work.
    headline: `${tracked.covered} of ${tracked.required} invoices keyed in`,
    reasons,
    warnings,
    selected: site
      ? {
          locationName: site.locationName,
          months: site.months.map((m) => ({
            month: m.month,
            state: slotState(m, tracked.companyLevelMonths),
          })),
        }
      : null,
  };
}
