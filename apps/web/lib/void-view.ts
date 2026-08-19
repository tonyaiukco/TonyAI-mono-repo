import { isCalculated } from '@/lib/types';
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
 * Mirrors `@MinLength(10)` / `@MaxLength(2000)` on `VoidActivityRecordDto`.
 *
 * A minimum length is new territory on this client — reject and the variance
 * comment are both "non-empty" — so the number lives here rather than as a
 * literal inside a disabled-button expression, and the DTO's spec pins the same
 * boundary on the server side.
 */
export const VOID_REASON_MIN_LENGTH = 10;
export const VOID_REASON_MAX_LENGTH = 2000;

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
 * What this CANNOT see is the period lock, because the record DTO does not
 * carry one and this page does not fetch locks. So a super_admin looking at an
 * approved record inside a locked period is offered the control and is refused
 * by the API, whose message names the remedy ("A locked period must be unlocked
 * first"). Offering-then-refusing is the honest failure here; the alternative
 * is a hidden control with no explanation.
 */
export function canOfferVoid(
  record: Pick<ActivityRecordDTO, 'status'>,
  isSuperAdmin: boolean,
): boolean {
  return isSuperAdmin && record.status === 'approved';
}

export interface VoidConsequence {
  /** What leaves the inventory, named in tonnes where there are tonnes. */
  headline: string;
  /** Everything else the withdrawal does, in the order the reader needs it. */
  effects: string[];
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
export function voidConsequence(record: ActivityRecordDTO): VoidConsequence {
  const calculation = record.calculation;
  const headline = isCalculated(calculation)
    ? `This removes ${formatNumber(calculation.tCo2e, 3)} tCO₂e from the inventory.`
    : // No factor, so no tonnes ever entered a total — saying "removes 0 tCO₂e"
      // would read as a reassurance that nothing happens, when the entry is
      // still leaving the completeness counts.
      'This entry produced no tCO₂e figure, so no emissions total changes.';

  return {
    headline,
    effects: [
      'It stops counting towards totals, reports and invoice coverage.',
      `It frees ${record.periodValue} ${record.reportingYear} for this entity and category, so a corrected figure can be entered.`,
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
