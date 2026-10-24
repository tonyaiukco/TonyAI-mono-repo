import { entityLabel, isCalculated, VOID_REASON_MAX_LENGTH, VOID_REASON_MIN_LENGTH } from '@/lib/types';
import type { EntityWords } from '@/lib/types';
import type { ActivityRecordDTO } from '@/lib/types';
import { formatNumber } from '@/lib/i18n/number';
import type { ViewCopy } from '@/lib/i18n/view-translator';
import type { RecordWords } from '@/lib/vocabulary';

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
 *
 * Every sentence comes from the Emissions screen's catalogue (`emissions.void.*`,
 * LP4-04 slice 2); the figures are written in the user's language.
 */

/** The `emissions` keys this module words its sentences with. */
export type VoidKey =
  | 'void.reasonRequired'
  | 'void.reasonShort'
  | 'void.reasonLong'
  | 'void.removes'
  | 'void.noFigure'
  | 'void.subject'
  | 'void.stopsCounting'
  | 'void.reopens'
  | 'void.staysOnRecord'
  | 'void.printed'
  | 'void.cannotUndo'
  | 'void.withdrawn'
  | 'void.withdrawnNoFigure';

/** The copy the void path is worded with: the screen's translator, the
 *  record's words (category, period) and the entity words. */
export interface VoidCopy extends ViewCopy<VoidKey> {
  words: RecordWords;
  entity: EntityWords;
}

/** A tonnage as the void path names it: three decimals, the user's separators. */
function tonnes(value: number, copy: ViewCopy<VoidKey>): string {
  return formatNumber(value, copy.locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

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
export function voidReasonError(reason: string, { t, locale }: ViewCopy<VoidKey>): string | null {
  const length = reason.trim().length;
  if (length === 0) {
    return t('void.reasonRequired');
  }
  if (length < VOID_REASON_MIN_LENGTH) {
    return t('void.reasonShort', {
      min: formatNumber(VOID_REASON_MIN_LENGTH, locale),
      count: formatNumber(length, locale),
    });
  }
  if (length > VOID_REASON_MAX_LENGTH) {
    return t('void.reasonLong', {
      max: formatNumber(VOID_REASON_MAX_LENGTH, locale),
      count: formatNumber(length, locale),
    });
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
  copy: VoidCopy,
): VoidConsequence {
  const { t, words } = copy;
  const calculation = record.calculation;
  const entity = entityLabel(record, copy.entity);
  const category = words.category(record.category);
  const period = words.period(record.periodValue);
  const year = String(record.reportingYear);
  const headline = isCalculated(calculation)
    ? t('void.removes', { tonnes: tonnes(calculation.tCo2e, copy) })
    : // No factor, so no tonnes ever entered a total — saying "removes 0 tCO₂e"
      // would read as a reassurance that nothing happens, when the entry is
      // still leaving the completeness counts.
      t('void.noFigure');

  return {
    // Named in full, because the whole reason this control exists is a pair of
    // rows that differ ONLY in the reporting entity — and the first live use of
    // the void endpoint withdrew the wrong half of exactly such a pair. A
    // dialog that says "this entity" gives the reader nothing to check the
    // click against; the four facts below are the record's identity.
    subject: t('void.subject', { category, subsidiary: subsidiaryName, entity, period, year }),
    headline,
    effects: [
      t('void.stopsCounting'),
      t('void.reopens', { period, year, entity, category }),
      t('void.staysOnRecord'),
      // Added with WP20, which is what made it true: until reports disclosed
      // withdrawals, this text stayed inside the product. It is now quoted
      // verbatim into every generated PDF, Excel and CSV — documents that go to
      // auditors and investors — and it cannot be edited afterwards. Someone
      // about to type a colleague's name into it deserves to know that first.
      t('void.printed'),
      t('void.cannotUndo'),
    ],
  };
}

/**
 * The toast after a successful withdrawal.
 *
 * Names the tonnage, because the number on screen is about to change and the
 * user should be told by how much rather than left to diff two screenshots.
 */
export function voidSuccessMessage(record: ActivityRecordDTO, copy: ViewCopy<VoidKey>): string {
  const calculation = record.calculation;
  return isCalculated(calculation)
    ? copy.t('void.withdrawn', { tonnes: tonnes(calculation.tCo2e, copy) })
    : copy.t('void.withdrawnNoFigure');
}
