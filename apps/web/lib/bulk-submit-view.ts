import { BULK_SUBMIT_MAX_IDS, isEvidenceRequired } from '@/lib/types';
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
  const needingEvidence = withIds.filter((r) =>
    isEvidenceRequired(r.category),
  ).length;
  const submittable = withIds
    .filter((r) => !isEvidenceRequired(r.category))
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
