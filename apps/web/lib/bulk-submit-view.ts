import {
  BULK_SUBMIT_MAX_IDS,
  isBulkSubmittable,
  isEvidenceRequired,
  isSubmittable,
} from '@/lib/types';
import type {
  BulkSubmitIssue,
  BulkSubmitIssueCode,
  BulkSubmitReportDTO,
  BulkUploadAcceptedRow,
} from '@/lib/types';
import { ApiError } from '@/lib/api';
import { formatNumber } from '@/lib/utils';

/**
 * The client half of bulk submit: which imported rows can even be sent, what
 * the outcome means, and what the screen says about it.
 *
 * Here rather than in the panel for the reason `bulk-upload-view.ts` gives:
 * `vitest.config.ts` collects only `lib/**`, so a sentence decided in a
 * component has no coverage in either direction.
 */

export { BULK_SUBMIT_MAX_IDS } from '@/lib/types';

/** What each refusal is called on screen. Exhaustive, so a new code is a
 *  compile error here rather than a blank label in front of a user. */
export const SUBMIT_ISSUE_LABEL: Record<BulkSubmitIssueCode, string> = {
  not_found: 'No longer available',
  not_submittable: 'Already moved on',
  not_author: 'Someone else’s record',
  period_locked: 'Period closed',
  evidence_required: 'Needs an evidence file',
  variance_reason_required: 'Needs a variance reason',
  unexpected: 'Could not be submitted',
};

export interface SubmitEligibility {
  /** Record ids worth sending. */
  recordIds: string[];
  /** How many were held back because their category needs an evidence file. */
  needingEvidence: number;
  /**
   * How many eligible records did NOT fit in one request.
   *
   * Unreachable while the import's row cap and the submit's id cap are the
   * same number — but they are deliberately not aliases and may be raised
   * independently, and the day the import's goes first, silently dropping the
   * overflow would show "Send 1,000 records for review" after a 1,010-row
   * import and leave ten as drafts with nothing said.
   */
  overCap: number;
  /** Why the button is not offered, when it is not. `null` when it is. */
  blockedReason: string | null;
}

/**
 * Which of the rows just imported can be sent for review.
 *
 * Evidence-required categories are held back rather than sent and refused: the
 * server would reject every one of them, and a report that is entirely
 * `evidence_required` teaches a user nothing they were not already warned
 * about during the import. **On the seeded demo data this holds back
 * everything** — the factor library covers only Electricity, Natural Gas and
 * Fuel, all three of which require evidence, so the set of rows that can be
 * imported and the set that can be bulk-submitted are disjoint. That is a
 * property of the seeded factor library, not of this code, and the copy says
 * so rather than presenting an empty result as a failure.
 *
 * The anomaly cases are NOT pre-excluded: the row type carries `anomalous` but
 * not `varianceReason`, so a row flagged at import may well have an
 * explanation. Those go to the server and come back per record — which is what
 * the failure report is for.
 */
export function eligibleForSubmit(
  rows: BulkUploadAcceptedRow[],
): SubmitEligibility {
  const withIds = rows.filter(
    (r): r is BulkUploadAcceptedRow & { recordId: string } => r.recordId !== null,
  );
  // `evidenceCount: 0` is not an assumption — an import cannot attach a file,
  // so a row this function has just been handed provably has none. Stated as a
  // literal rather than left implicit in a category-only check, because the
  // rule now has a second caller whose rows may carry files.
  const needsEvidence = (r: BulkUploadAcceptedRow) =>
    needsEvidenceBeforeSubmit({ category: r.category, evidenceCount: 0 });
  const needingEvidence = withIds.filter(needsEvidence).length;
  const submittable = withIds
    .filter((r) => !needsEvidence(r))
    .map((r) => r.recordId);
  // From the FRONT: the caller's order is the import's order, and a tail slice
  // would silently prefer the end of the file.
  const recordIds = submittable.slice(0, BULK_SUBMIT_MAX_IDS);
  const overCap = submittable.length - recordIds.length;

  let blockedReason: string | null = null;
  if (withIds.length === 0) {
    blockedReason = null;
  } else if (recordIds.length === 0) {
    blockedReason = `All ${formatNumber(needingEvidence)} imported ${
      needingEvidence === 1 ? 'record needs' : 'records need'
    } an evidence file before ${
      needingEvidence === 1 ? 'it' : 'they'
    } can be submitted, and an import cannot attach one. Open each record below to add its invoice.`;
  }

  return { recordIds, needingEvidence, overCap, blockedReason };
}

/**
 * How many of the failures the panel shows before folding the rest away.
 *
 * The same number the import's issue groups use, and for the same reason: a
 * list of several hundred is not something a user scrolls.
 */
export const MAX_FAILURES_SHOWN = 50;

/** The failures to render, and how many were left out. */
export function failuresToShow(failed: BulkSubmitIssue[]): {
  shown: BulkSubmitIssue[];
  remainder: number;
} {
  return {
    shown: failed.slice(0, MAX_FAILURES_SHOWN),
    // The list used to truncate at fifty with no remainder, under a verdict
    // reading "900 records were not — see below". The screen contradicted
    // itself and 850 records vanished from the user's work list.
    remainder: Math.max(0, failed.length - MAX_FAILURES_SHOWN),
  };
}

/** What the confirm step says. */
export function submitConfirmation(recordIds: string[]): string {
  const n = recordIds.length;
  return (
    `Send ${formatNumber(n)} ${n === 1 ? 'record' : 'records'} for review. ` +
    `Only a reviewer can send them back — there is no way to un-submit them yourself.`
  );
}

export interface SubmitSummary {
  tone: 'clean' | 'partial' | 'refused';
  headline: string;
  detail: string | null;
}

/** The verdict after a bulk submit. */
export function summariseSubmit(report: BulkSubmitReportDTO): SubmitSummary {
  const moved = report.submitted.length;
  const failed = report.failed.length;

  if (moved === 0) {
    return {
      tone: 'refused',
      headline: 'No records were submitted.',
      detail:
        failed > 0
          ? `All ${formatNumber(failed)} need attention first — see below.`
          : 'There was nothing to submit.',
    };
  }
  if (failed === 0) {
    return {
      tone: 'clean',
      headline: `${formatNumber(moved)} ${
        moved === 1 ? 'record is' : 'records are'
      } now in the review queue.`,
      detail: null,
    };
  }
  return {
    tone: 'partial',
    headline: `${formatNumber(moved)} of ${formatNumber(
      report.requested,
    )} submitted.`,
    // "were not submitted", not "are still drafts": that was false for three
    // of the six codes — `not_submittable` means the record's status is by
    // definition NOT draft (commonly `approved`), `not_found` means it is not
    // there at all, and `not_author` means it is someone else's.
    detail: `${formatNumber(failed)} ${
      failed === 1 ? 'record was' : 'records were'
    } not — see below.`,
  };
}

/** The sentence for a failure that refused the whole request. */
export function submitErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return 'Too many submissions in a short time. Wait a minute and try again.';
    }
    if (error.status === 403) {
      return 'Your role cannot submit activity records.';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'The submission failed.';
}

// ---------------------------------------------------------------------------
// Drafts that did not come from an import (WP8 PR 2c).
//
// The same endpoint, a different source list: the records already on screen
// under "Previous submissions" rather than the ones an import just wrote. That
// makes three things the import surface never had to decide — a record here may
// be someone else's, may already have moved on, and may carry evidence — so the
// client mirrors the gates the server applies and offers a checkbox only where
// all of them pass.
// ---------------------------------------------------------------------------

/**
 * Does this record still need an evidence file before it can be submitted?
 *
 * The one rule, shared by both submit surfaces. Category ALONE is not the rule
 * and never was — it only looked like it on the import surface, where every row
 * is new and therefore has no files. A draft that has been sitting on the
 * Previous-submissions list with its invoice attached is submittable, and a
 * category-only check would refuse it forever.
 */
export function needsEvidenceBeforeSubmit(row: {
  category: string;
  evidenceCount: number;
}): boolean {
  return isEvidenceRequired(row.category) && row.evidenceCount === 0;
}

/** The fields of a record this module actually reads. Structural, so the page
 *  passes `ActivityRecordDTO`s straight through and the spec needs no fixture
 *  of the whole contract. */
export interface SubmittableRow {
  id: string;
  status: string;
  category: string;
  evidenceCount: number;
  createdBy: string;
  reportingYear: number;
  reportingPeriod: string;
  periodValue: string;
}

/** Who is asking. `null` while `api.me()` is still in flight. */
export interface SubmittingUser {
  id: string;
  role: string;
}

/** The fields of a period lock this module reads. */
export interface LockedPeriod {
  reportingYear: number;
  reportingPeriod: string;
  periodValue: string;
}

/** Is this record's own reporting period closed? */
export function isPeriodLockedFor(
  row: Pick<SubmittableRow, 'reportingYear' | 'reportingPeriod' | 'periodValue'>,
  locks: LockedPeriod[],
): boolean {
  return locks.some(
    (l) =>
      l.reportingYear === row.reportingYear &&
      l.reportingPeriod === row.reportingPeriod &&
      l.periodValue === row.periodValue,
  );
}

/**
 * Why this record has no checkbox, or `null` when it has one.
 *
 * The order is `preflight`'s order, so the sentence a user reads is the refusal
 * they would have been handed had the checkbox been offered anyway — status,
 * then authorship, then the two gates `submit` itself applies. Mirroring rather
 * than inventing is the whole point: a client rule the server does not share is
 * how a checkbox starts promising something that comes back refused.
 *
 * What is deliberately NOT mirrored is the anomaly gate. `anomalyFlag` on the
 * record is the verdict from when it was written, `submit` recomputes it, and
 * a bulk submit shifts its own baseline as it goes — `submitted` counts, so
 * record N entering review changes the baseline record N+1 is measured
 * against. A client gate built on the stored flag would hide records that are
 * perfectly submittable and still let `variance_reason_required` through. That
 * one belongs in the failure report, where the server's own sentence explains
 * it.
 */
export function submitBlockReason(
  row: SubmittableRow,
  user: SubmittingUser | null,
  locks: LockedPeriod[],
): string | null {
  if (!user) return 'Loading your account…';
  if (!isBulkSubmittable(row.status)) {
    // `rejected` is the one worth a sentence rather than a status echo: the
    // list presents it as editable, so a missing checkbox looks like a bug
    // instead of the deliberate exclusion it is.
    return row.status === 'rejected'
      ? 'Sent back by a reviewer — open it on its own, so the note gets read.'
      : `Already ${row.status.replace(/_/g, ' ')}.`;
  }
  if (user.role !== 'super_admin' && row.createdBy !== user.id) {
    return 'Entered by someone else.';
  }
  if (isPeriodLockedFor(row, locks)) {
    return `${row.periodValue} ${row.reportingYear} is locked.`;
  }
  if (needsEvidenceBeforeSubmit(row)) return 'Needs an evidence file.';
  return null;
}

export interface DraftSelection {
  /** Ids that may be ticked, in the order they were given. */
  selectableIds: string[];
  /**
   * Why a row has no checkbox — but only for the rows that LOOK selectable.
   *
   * The list already shows a status badge, so spelling out "Already approved."
   * beside an Approved badge is noise on every row of a long list. The rows
   * that owe an explanation are the ones the list itself presents as editable
   * (`SUBMITTABLE_STATUSES`, which is `draft` and `rejected`) and yet cannot be
   * ticked. Everything else is already answered on screen.
   */
  reasonById: Record<string, string>;
}

/** Which of these records this user may send, and why not for the rest. */
export function selectableDrafts(
  rows: SubmittableRow[],
  user: SubmittingUser | null,
  locks: LockedPeriod[],
): DraftSelection {
  // No user, no checkboxes. `loadRecord` is deliberately permissive while
  // `api.me()` is in flight — it would rather open a record than block one —
  // but offering a checkbox and then retracting it is the opposite trade, so
  // this one waits.
  if (!user) return { selectableIds: [], reasonById: {} };

  const selectableIds: string[] = [];
  const reasonById: Record<string, string> = {};
  for (const row of rows) {
    const reason = submitBlockReason(row, user, locks);
    if (reason === null) {
      selectableIds.push(row.id);
    } else if (isSubmittable(row.status)) {
      reasonById[row.id] = reason;
    }
  }
  return { selectableIds, reasonById };
}

/**
 * Tick or untick one id.
 *
 * Refuses to grow past the cap rather than letting the request 400: the id list
 * is validated by `@ArrayMaxSize` server-side, and a silent rejection of the
 * whole batch is a worse answer than a checkbox that will not tick.
 */
export function toggleSelected(
  selected: string[],
  id: string,
): { selected: string[]; refusedByCap: boolean } {
  if (selected.includes(id)) {
    return { selected: selected.filter((s) => s !== id), refusedByCap: false };
  }
  if (selected.length >= BULK_SUBMIT_MAX_IDS) {
    return { selected, refusedByCap: true };
  }
  return { selected: [...selected, id], refusedByCap: false };
}

/**
 * "Select all" — the first `BULK_SUBMIT_MAX_IDS`, and how many were left.
 *
 * From the FRONT, and the leftover is reported rather than dropped, for the
 * same reason the import surface reports `overCap`: a screen that says
 * "Send 1,000 records" after ticking 1,010 has silently abandoned ten.
 */
export function selectAllEligible(selectableIds: string[]): {
  selected: string[];
  overCap: number;
} {
  return {
    selected: selectableIds.slice(0, BULK_SUBMIT_MAX_IDS),
    overCap: Math.max(0, selectableIds.length - BULK_SUBMIT_MAX_IDS),
  };
}

/** The label on the bulk bar's button. */
export function draftsSubmitLabel(selectedCount: number): string {
  return `Send ${formatNumber(selectedCount)} ${
    selectedCount === 1 ? 'record' : 'records'
  } for review`;
}
