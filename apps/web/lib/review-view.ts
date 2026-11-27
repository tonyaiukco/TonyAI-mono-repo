import { formatNumber } from '@/lib/i18n/number';
import type { ViewCopy } from '@/lib/i18n/view-translator';
import {
  isCvBasis,
  isSelfGenerationSource,
  normalizeRecordParameters,
  recordInvoiceNo,
  recordParameterShape,
  recordSupplier,
  selfGenerationBalance,
  type ActivityRecordDTO,
  type ActivityRecordPageFilters,
  type ActivityRecordStatus,
  type CvBasis,
  type FuelBatchFilters,
  type ElectricityRecordParameters,
  type SelfGenerationBalance,
  type SelfGenerationSource,
} from '@/lib/types';

/**
 * The calorific basis a TR natural gas bill states (ng-kwh-engine), for the
 * review sheet, so the reviewer can compare it with the bill: the record's
 * stored `cvBasis`, or null for any record that carries none.
 */
export function reviewCalorificBasis(record: Pick<ActivityRecordDTO, 'category' | 'parameters'>): CvBasis | null {
  if (recordParameterShape(record.category) !== 'natural_gas' || record.parameters === null) return null;
  const basis = (record.parameters as { cvBasis?: unknown }).cvBasis;
  return isCvBasis(basis) ? basis : null;
}

/**
 * A record's invoice number and supplier (UAT round 4, BUG-16), for the review
 * sheet, so the reviewer can match the record to its evidence file: each one
 * the record holds, null for one it does not. An Electricity record's supplier
 * is its utility provider (`recordSupplier`).
 */
export function reviewReferences(record: Pick<ActivityRecordDTO, 'category' | 'input'>): {
  invoiceNo: string | null;
  supplier: string | null;
} {
  return { invoiceNo: recordInvoiceNo(record.input), supplier: recordSupplier(record.category, record.input) };
}

/** An Electricity record's self-generation block as the review sheet shows it (self-gen-form, design 7). */
export interface ReviewSelfGeneration {
  source: SelfGenerationSource;
  generatedKwh: number;
  exportedKwh: number | null;
  facilityKwh: number | null;
  /** The energy balance (D6), or null when the block states no facility consumption. */
  balance: SelfGenerationBalance | null;
  /** The fuel record a fuel source needs and the read found none of (D5), or null. */
  fuelMissing: 'natural_gas_chp' | 'diesel_generator' | null;
}

/**
 * The self-generation block an Electricity record carries, read-only, for the
 * review sheet: read from the record's `parameters`, where the source lives
 * and the commit freeze protects it, never from its snapshot. Null for any
 * other record, a plain grid record and a block of nulls.
 */
export function reviewSelfGeneration(
  record: Pick<ActivityRecordDTO, 'category' | 'parameters' | 'activityValue' | 'activityUnit' | 'generationFuelRecord'>,
): ReviewSelfGeneration | null {
  if (recordParameterShape(record.category) !== 'electricity') return null;
  const block = normalizeRecordParameters(record.parameters) as ElectricityRecordParameters | null;
  if (block === null) return null;
  const source = block.selfGenerationSource;
  if (!isSelfGenerationSource(source) || typeof block.selfGeneratedKwh !== 'number') return null;
  const balance = selfGenerationBalance(record.activityValue, record.activityUnit, block);
  return {
    source,
    generatedKwh: block.selfGeneratedKwh,
    exportedKwh: block.exportedToGridKwh ?? null,
    facilityKwh: block.facilityConsumptionKwh ?? null,
    balance,
    fuelMissing:
      record.generationFuelRecord === 'missing' && (source === 'natural_gas_chp' || source === 'diesel_generator')
        ? source
        : null,
  };
}

/**
 * How long a record has been sitting, in whole days — the number the review
 * queue puts in front of a reviewer.
 *
 * Extracted out of `app/review/page.tsx` because it was a page-private
 * function and `vitest.config.ts` only collects `lib/**`, so this arithmetic
 * had no coverage in either direction: nothing would have caught it being
 * wrong, and nothing would catch it changing.
 *
 * The instant is a parameter rather than a field read off a record. The queue
 * feeds it `submittedAt` — the column is "Waiting" now, and means it. It used
 * to feed `createdAt` and be headed "Age", because nothing recorded when a
 * record was submitted; that changed with the `submitted_at` column, and the
 * caller moved rather than this function.
 *
 * Accepts null, because `submittedAt` is null on every record that was never
 * submitted — which on a freshly seeded database is all of them. The one thing
 * this must NOT do is fall back to `createdAt`: that fallback is precisely the
 * misstatement the new column exists to end, and it would be invisible.
 *
 * `now` is injectable so the arithmetic can be pinned at a fixed instant
 * instead of racing the wall clock.
 */
/**
 * The reporting company the review sheet names beside the author
 * (inc26-central-reporter-onboarding, C4): a central reporter's record — its
 * reporting entity differs from its company — answers that company's name
 * ("—" when the name is gone); any other record answers null, and the sheet
 * shows no such line.
 */
export function reviewReportingEntity(
  record: Pick<ActivityRecordDTO, 'subsidiaryId' | 'reportedBySubsidiaryId' | 'reportedBySubsidiaryName'>,
): string | null {
  if (!record.reportedBySubsidiaryId || record.reportedBySubsidiaryId === record.subsidiaryId) return null;
  return record.reportedBySubsidiaryName ?? '—';
}

export function daysSince(
  iso: string | null,
  now: number = Date.now(),
): number | null {
  if (iso === null) return null;
  const then = new Date(iso).getTime();
  // `Math.max(0, NaN)` is `NaN`, so an unparseable instant used to render as
  // "NaNd" in the queue. The API contract makes that unreachable — `createdAt`
  // is a serialised Prisma `DateTime` — but a total function costs one line
  // and the alternative is a defect that only ever shows up in production.
  if (Number.isNaN(then)) return null;
  // Floored, not rounded: a record entered 47 hours ago has been waiting one
  // whole day, not two. Clamped at 0 because a client clock running behind the
  // server would otherwise report a record as negative days old.
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/**
 * The waiting cell exactly as the review queue renders it.
 *
 * The rendered string lives here rather than in the page for the same reason
 * the arithmetic does: a formatter inside a component is a formatter no test
 * can hold to account, and this one has to decide what an unknown wait looks
 * like. An em dash, not "0d" — claiming a record arrived today when nobody
 * knows when it arrived is the one wrong answer a reviewer would act on, and
 * it is the answer every seeded record would get.
 */
export function waitingLabel(
  iso: string | null,
  { t, locale }: ViewCopy<'waitingDays'>,
  now: number = Date.now(),
): string {
  const days = daysSince(iso, now);
  return days === null ? '—' : t('waitingDays', { days: formatNumber(days, locale) });
}

/**
 * The review queue's Records list and its count (inc28-fuel-bulk D10): the
 * pending statuses, the company picked, whose decision — and never a fuel
 * batch's record, which is decided with its batch in the Batches list.
 */
export function reviewRecordFilters(options: {
  statuses: readonly ActivityRecordStatus[];
  subsidiaryId: string | null;
  showAll: boolean;
}): ActivityRecordPageFilters {
  return {
    status: [...options.statuses],
    ...(options.subsidiaryId === null ? {} : { subsidiaryId: options.subsidiaryId }),
    ...(options.showAll ? {} : { awaitingMyDecision: true }),
    inBatch: false,
  };
}

/**
 * The review queue's Batches list and its count, as one request per status:
 * by default the batches awaiting the viewer's decision; "show all" every
 * submitted and every under-review batch the viewer reads.
 */
export function reviewBatchFilters(options: { subsidiaryId: string | null; showAll: boolean }): FuelBatchFilters[] {
  const company = options.subsidiaryId === null ? {} : { subsidiaryId: options.subsidiaryId };
  if (!options.showAll) return [{ ...company, awaitingMyDecision: true }];
  return [{ ...company, status: 'submitted' }, { ...company, status: 'under_review' }];
}
