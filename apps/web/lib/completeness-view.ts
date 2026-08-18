// The WP17 invoice rule, as the screens that show it need to read it.
//
// Pure and shared on purpose. The dashboard cell tooltip, the dashboard
// drill-down and the Data Entry status panel answer different questions about
// the SAME response, and the first version built its explanations inline — so
// each new surface meant another set of sentences, free to describe the rule
// slightly differently from the one the server actually applies. The numbers
// come from one function on the API side; the words come from one module here.
//
// What this module must NEVER do is decide whether a category is complete. That
// verdict is FR §2.2's and it arrives on the wire as `status`, because two of
// the three caps behind it — a draft in the cell, an anomaly flag — correspond
// to no field in this response. A client that recomputed it from
// `covered >= required` would badge green over a cell the dashboard shows
// amber, which is round-1 DE-2's own failure one level up.
import { INVOICE_TRACKED_CATEGORIES } from "@tonyai/shared-types";
import type {
  CategoryCompleteness,
  CellCoverage,
  CompletenessSlot,
  DataStatus,
  SubsidiaryCompletenessDTO,
} from "@/lib/types";

/** "1 entry" / "3 entries" — the count with its noun, but no verb: the four
 *  sentences below do not all take the same one ("are recorded" vs "have no"). */
export function entries(n: number): string {
  return n === 1 ? "1 entry" : `${n} entries`;
}

const isAre = (n: number) => (n === 1 ? "is" : "are");
const haveHas = (n: number) => (n === 1 ? "has" : "have");

/** "a quarterly" / "an annual" — `annual` is a real `ReportingPeriod` value. */
const article = (word: string) =>
  /^[aeiou]/i.test(word) ? `An ${word}` : `A ${word}`;

/** "Electricity, Natural Gas and Water", from the rule rather than from memory. */
export function invoiceTrackedList(): string {
  const names = [...INVOICE_TRACKED_CATEGORIES];
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
    : (names[0] ?? "");
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

/** Three letters is all a twelve-column strip has room for. */
export const SHORT_MONTH = (month: string) => month.slice(0, 3);

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
 * Takes a `CellCoverage`, which `CategoryCompleteness` extends, so the cell
 * tooltip and the drill-down share these sentences instead of keeping two
 * near-identical copies that drifted in wording and in ordering.
 *
 * Each line names a real count from the response. Nothing here is inferred: a
 * shortfall the API cannot explain would be a shortfall the user cannot act on.
 */
export function shortfallReasons(
  coverage: CellCoverage,
  reportingYear: number | null,
): string[] {
  const reasons: string[] = [];
  const n = (c: number) => entries(c);
  if (coverage.unattributedRecords > 0) {
    const c = coverage.unattributedRecords;
    reasons.push(
      `${n(c)} ${isAre(c)} recorded for the whole company rather than a site, so they close no site's month.`,
    );
  }
  if (coverage.outOfScopeRecords > 0) {
    const c = coverage.outOfScopeRecords;
    reasons.push(
      `${n(c)} ${isAre(c)} at a site that did not exist yet at the end of ${reportingYear ?? "the reported year"}, so there is no row for them.`,
    );
  }
  if (coverage.nonMonthlyRecords > 0) {
    const c = coverage.nonMonthlyRecords;
    reasons.push(
      `${n(c)} ${isAre(c)} not reported as a single month, so none of them stands in for a monthly invoice.`,
    );
  }
  if (coverage.missingEvidenceRecords > 0) {
    const c = coverage.missingEvidenceRecords;
    // "entries are with no invoice attached" was the wording this replaced —
    // the helper supplied a verb that did not fit the sentence.
    reasons.push(`${n(c)} ${haveHas(c)} no invoice attached.`);
  }
  return reasons;
}

/**
 * Why a category with every slot closed still is not finished (round-1 DE-2).
 *
 * Without this a cell reads 24/24 and is still amber with nothing on screen
 * accounting for it — the exact "unexplained amber" the shortfall lines above
 * exist to prevent, reintroduced by the review gate.
 */
export function reviewNote(awaitingReviewSlots: number): string | null {
  if (awaitingReviewSlots <= 0) return null;
  return awaitingReviewSlots === 1
    ? "1 invoice is keyed in but still waiting for review, so this category is not finished yet."
    : `${awaitingReviewSlots} invoices are keyed in but still waiting for review, so this category is not finished yet.`;
}

/**
 * Months recorded BOTH at a site and for the whole company.
 *
 * Both rows feed the emissions total and nothing downstream deduplicates, so
 * these months are already double-counted — as opposed to the `company` slot
 * state, which warns about one that *would* be. The distinction matters because
 * the grid stops rendering `company` for such a month the moment the site
 * record lands: the warning would otherwise disappear exactly when the harm
 * has occurred.
 */
export function duplicatedMonths(category: CategoryCompleteness): string[] {
  if (category.companyLevelMonths.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const loc of category.locations) {
    for (const m of loc.months) {
      const key = m.month.toLowerCase();
      if (!m.covered || seen.has(key)) continue;
      if (!category.companyLevelMonths.includes(key)) continue;
      seen.add(key);
      out.push(m.month);
    }
  }
  return out;
}

export function duplicateNote(months: readonly string[]): string | null {
  if (months.length === 0) return null;
  const list =
    months.length > 1
      ? `${months.slice(0, -1).join(", ")} and ${months[months.length - 1]}`
      : months[0];
  return `${list} ${months.length === 1 ? "is" : "are"} recorded both at a site and for the whole company, so ${months.length === 1 ? "that month is" : "those months are"} already counted twice in the emissions total. Removing one of each pair is the only way to resolve it.`;
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
  | { kind: "no_locations"; year: number; reasons: string[] }
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
      /**
       * FR §2.2's verdict, taken **verbatim from the server**. Never recomputed
       * here — see the note at the top of this file.
       */
      status: DataStatus;
      headline: string;
      /** What is true of the data already recorded. */
      reasons: string[];
      /** What is true of the entry being keyed in right now. Empty when there
       *  is no entry in progress. */
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
  /**
   * Whether the form actually holds an entry (valid input, or one being
   * edited).
   *
   * Everything in `warnings` is a claim about "this entry", and none of it is
   * true before the user has typed anything. Ungated, a freshly-loaded screen
   * opened an amber alert reading "This entry is recorded for the whole
   * company" when there was no entry — and showed the same line immediately
   * after a successful submit, because the form resets before the panel
   * refetches.
   */
  hasEntry: boolean;
  /**
   * When an OPEN record's location has been changed but not yet saved, the
   * entity it is moving **from** (`""` for the whole company). `null` when
   * nothing is being moved.
   *
   * Load-bearing for truthfulness, not a refinement. The duplicate warnings
   * below assume the entry being keyed is a NEW row, which was guaranteed while
   * the client abandoned the edit on a location change. WP18 made that a move
   * instead — so without this the panel says "keying a site invoice for it as
   * well would count that month twice" about the very record that is leaving
   * the whole-company slot, i.e. about a duplicate that will not exist. The
   * sentence was true before WP18 and is false after it.
   */
  movingFrom?: string | null;
}

export function deriveEntryCoverage({
  data,
  category,
  locationId,
  reportingPeriod,
  periodValue,
  hasEntry,
  movingFrom = null,
}: EntryCoverageInput): EntryCoverage {
  // The API returns no categories for a subsidiary measured as a whole. That is
  // not zero progress — the rule does not apply to it at all.
  if (data.trackingGranularity !== "location") return { kind: "whole_company" };

  const tracked = data.categories.find((c) => c.category === category);
  if (!tracked) return { kind: "category_not_tracked", category };

  // A location-measured subsidiary whose sites all postdate the reported year.
  // Highly reachable: every seeded location was created in 2026, so every
  // earlier year in the picker lands here. The counters come too — records may
  // well exist, and an earlier cut answered "there are no invoices to track"
  // while silently dropping twelve of them.
  if (tracked.required === 0) {
    return {
      kind: "no_locations",
      year: data.reportingYear,
      reasons: shortfallReasons(tracked, data.reportingYear),
    };
  }

  const accepted = Math.max(0, tracked.covered - tracked.awaitingReviewSlots);

  const reasons = shortfallReasons(tracked, data.reportingYear);
  const note = reviewNote(tracked.awaitingReviewSlots);
  if (note) reasons.push(note);
  // A statement about data that already exists, so it sits with the reasons and
  // is NOT gated on `hasEntry`. Reachable on the seeded database today.
  const dupes = duplicateNote(duplicatedMonths(tracked));
  if (dupes) reasons.push(dupes);

  const site = locationId
    ? tracked.locations.find((l) => l.locationId === locationId)
    : undefined;

  const month = periodValue.trim().toLowerCase();
  const monthly = reportingPeriod === "monthly";
  const atCompanyLevel = tracked.companyLevelMonths.includes(month);
  const siteMonth = site?.months.find(
    (m) => m.month.trim().toLowerCase() === month,
  );
  // A pending move is not a second row. Both warnings below must exclude the
  // record that is moving, or they describe a duplicate that the save is about
  // to REMOVE rather than create.
  const movingOffCompanyLevel = movingFrom === "";
  const sitesHoldingMonth = tracked.locations
    .filter((l) => l.locationId !== movingFrom)
    .filter((l) =>
      l.months.some((m) => m.month.toLowerCase() === month && m.covered),
    )
    .map((l) => l.locationName);

  const warnings: string[] = [];
  if (hasEntry) {
    // Deliberately NOT one else-if chain. The double-count warning used to sit
    // at the end of one, so selecting a site outside the year silently
    // swallowed it — and the duplicate is real whether or not the site is in
    // this year's denominator, because the emissions total counts every
    // committed record regardless.
    if (locationId && !site) {
      // The API builds the denominator from sites that existed at the end of
      // the reported year, so a newer site has no row. Saying nothing would
      // render this identically to a whole-company entry — the one case where
      // the panel legitimately shows no months — and the user would never learn
      // why their invoice is not counted.
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
    } else if (!monthly) {
      warnings.push(
        `${article(reportingPeriod)} entry closes no invoice slot — the rule counts one invoice per month.`,
      );
    }

    // Both directions of the double count, checked independently of the branch
    // above. Keying the site invoice first and the company record second
    // produced no warning at all until this second clause existed.
    if (
      monthly &&
      locationId &&
      atCompanyLevel &&
      !siteMonth?.covered &&
      // ...unless the whole-company row for this month IS the record being
      // moved onto this site. Then the save removes it from company level
      // rather than adding a second row — the opposite of a double count.
      !movingOffCompanyLevel
    ) {
      warnings.push(
        `${periodValue.trim()} ${data.reportingYear} is already recorded for the whole company. Keying a site invoice for it as well would count that month twice — both rows feed the emissions total.`,
      );
    } else if (monthly && !locationId && sitesHoldingMonth.length > 0) {
      warnings.push(
        `${periodValue.trim()} ${data.reportingYear} is already recorded at ${sitesHoldingMonth.join(", ")}. A whole-company entry for the same month would count it twice — both rows feed the emissions total.`,
      );
    }
  }

  return {
    kind: "tracked",
    category,
    year: data.reportingYear,
    required: tracked.required,
    covered: tracked.covered,
    awaitingReview: tracked.awaitingReviewSlots,
    accepted,
    status: tracked.status,
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
