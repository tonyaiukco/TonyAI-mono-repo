import {
  isCalculated,
  VOID_REASON_MAX_LENGTH,
  VOID_REASON_MIN_LENGTH,
} from '@/lib/types';
import type { ActivityRecordDTO } from '@/lib/types';
import { formatNumber } from '@/lib/utils';

/**
 * The client half of the void path: who may be offered it, whether the reason
 * they typed will pass, and what the withdrawal is about to do.
 *
 * All of it is pure, because none of it is decoration — the sentence shown in
 * the confirmation is the only warning the user gets before an irreversible
 * change to committed inventory, and a sentence that lives in JSX is a sentence
 * no test can hold to account.
 *
 * The server remains the authority on every rule mirrored here (see
 * `void-activity-record.dto.ts` and `ActivityRecordsService.void`). These
 * functions decide what to *render*; they decide nothing about what is allowed.
 */

/**
 * The same two numbers `VoidActivityRecordDto` validates with — not a copy of
 * them. A minimum length is new territory on this client (reject and the
 * variance comment are both "non-empty"), and a mutation test showed the copy
 * was worse than useless: raising the client's maximum broke no test, because
 * the spec pinned the constant against itself.
 */
export { VOID_REASON_MIN_LENGTH, VOID_REASON_MAX_LENGTH } from '@/lib/types';

/**
 * Why the typed reason will not be accepted, or null when it will.
 *
 * Trims first, exactly as the DTO's `@Transform` does: ten spaces is not ten
 * characters of explanation on either side of the wire, and a client that
 * disagreed with the server about that would let the user watch a request fail
 * for a rule the form said they had met.
 */
export function voidReasonError(reason: string): string | null {
  const length = reason.trim().length;
  if (length === 0) {
    return 'A reason is required — a withdrawal has to say why.';
  }
  if (length < VOID_REASON_MIN_LENGTH) {
    return `Say why this figure is being withdrawn — at least ${VOID_REASON_MIN_LENGTH} characters (${length} so far).`;
  }
  if (length > VOID_REASON_MAX_LENGTH) {
    return `A reason cannot run past ${formatNumber(VOID_REASON_MAX_LENGTH)} characters (${formatNumber(length)} entered).`;
  }
  return null;
}

/**
 * Whether to render the withdrawal control at all.
 *
 * Two conditions, both also enforced server-side: the seat, and the status.
 * `approved` is the only status with a route out — a draft is edited, a
 * submitted record is reviewed, a locked period is unlocked first, and a voided
 * record has already left.
 *
 * What this cannot see is a period lock — the DTO carries none and this page
 * fetches none. That turns out not to matter for the steady state: locking a
 * period flips its approved records to `locked` in the same transaction
 * (`period-locks.service.ts`), on the identical four-tuple the void path's own
 * lock check uses, so an approved record never sits inside a locked period and
 * the `locked` clause above already hides the control. What remains is a
 * staleness race — the lock commits between page load and click — which the
 * API refuses with a message naming the remedy, after which the re-read turns
 * the row `locked` and the control disappears. Every other way to be offered
 * something the server will refuse (voided in another tab, role changed
 * mid-session) is that same race, and all of them fail closed.
 */
export function canOfferVoid(
  record: Pick<ActivityRecordDTO, 'status'>,
  isSuperAdmin: boolean,
): boolean {
  return isSuperAdmin && record.status === 'approved';
}

export interface VoidConsequence {
  /** WHICH record is about to be withdrawn, named in full. */
  subject: string;
  /** What leaves the inventory, named in tonnes where there are tonnes. */
  headline: string;
  /** Everything else the withdrawal does, in the order the reader needs it. */
  effects: string[];
}

/**
 * The reporting entity in one phrase — the site's name, or the whole company.
 *
 * `locationName` is null both for a genuinely company-level row and for a row
 * whose location has since been removed; the contract documents that, and the
 * second case is one WP16's delete guards made unreachable.
 */
export function entityLabel(record: Pick<ActivityRecordDTO, 'locationName'>): string {
  return record.locationName?.trim() || 'Whole company';
}

/**
 * What voiding this record is about to do, in the reader's terms.
 *
 * Written from the behaviour that actually shipped rather than from intent:
 * `voided` is absent from `COUNTED_STATUSES`, so the figure leaves every total
 * and every coverage count by construction; the uniqueness index excludes
 * voided rows, so the slot genuinely reopens; and `audit_log` is append-only,
 * so the withdrawal is permanent in both directions — the record cannot be
 * restored and the act cannot be erased.
 */
export function voidConsequence(
  record: ActivityRecordDTO,
  subsidiaryName: string,
): VoidConsequence {
  const calculation = record.calculation;
  const entity = entityLabel(record);
  const headline = isCalculated(calculation)
    ? `This removes ${formatNumber(calculation.tCo2e, 3)} tCO₂e from the inventory.`
    : // No factor, so no tonnes ever entered a total — saying "removes 0 tCO₂e"
      // would read as a reassurance that nothing happens, when the entry is
      // still leaving the completeness counts.
      'This entry produced no tCO₂e figure, so no emissions total changes.';

  return {
    // Named in full, because the whole reason this control exists is a pair of
    // rows that differ ONLY in the reporting entity — and the first live use of
    // the void endpoint withdrew the wrong half of exactly such a pair. A
    // dialog that says "this entity" gives the reader nothing to check the
    // click against; the four facts below are the record's identity.
    subject: `${record.category} · ${subsidiaryName} · ${entity} · ${record.periodValue} ${record.reportingYear}`,
    headline,
    effects: [
      'It stops counting towards totals, reports and invoice coverage.',
      `${record.periodValue} ${record.reportingYear} then reopens for ${entity}, so a corrected ${record.category} figure can be entered in its place.`,
      'The entry stays on record with your reason, and the withdrawal is written to the audit log.',
      'It cannot be undone.',
    ],
  };
}

/**
 * The toast after a successful withdrawal.
 *
 * Names the tonnage, because the number on screen is about to change and the
 * user should be told by how much rather than left to diff two screenshots.
 */
export function voidSuccessMessage(record: ActivityRecordDTO): string {
  const calculation = record.calculation;
  return isCalculated(calculation)
    ? `Withdrawn — ${formatNumber(calculation.tCo2e, 3)} tCO₂e left the inventory.`
    : 'Withdrawn — the entry no longer counts towards any total.';
}
