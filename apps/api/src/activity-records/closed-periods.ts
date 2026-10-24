import type { Prisma } from '@tonyai/db';
import type { PeriodKey } from './lifecycle-lock';

/** One period's identity: a lock closes exactly this subsidiary, year, period and value. */
export function lockKey(r: PeriodKey): string {
  return [r.subsidiaryId, r.reportingYear, r.reportingPeriod, r.periodValue].join('|');
}

/**
 * The ids of `records` whose reporting period is closed — one query for all of
 * them, one condition per distinct period rather than per record: a thousand
 * drafts of one import share a handful of periods. Every `records` row is one
 * the caller already read in scope, so the lock lookup reads no other tenant's.
 */
export async function closedRecordIds(
  client: Pick<Prisma.TransactionClient, 'periodLock'>,
  records: readonly (PeriodKey & { id: string })[],
): Promise<Set<string>> {
  if (records.length === 0) return new Set();
  const periods = [...new Map(records.map((r) => [lockKey(r), r])).values()];
  const locks = await client.periodLock.findMany({
    where: {
      OR: periods.map((r) => ({
        subsidiaryId: r.subsidiaryId,
        reportingYear: r.reportingYear,
        reportingPeriod: r.reportingPeriod,
        periodValue: r.periodValue,
      })),
    },
    select: { subsidiaryId: true, reportingYear: true, reportingPeriod: true, periodValue: true },
  });
  const closed = new Set(locks.map(lockKey));
  return new Set(records.filter((r) => closed.has(lockKey(r))).map((r) => r.id));
}
