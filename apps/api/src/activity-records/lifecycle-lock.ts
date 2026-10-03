import { createHash } from 'node:crypto';
import { Prisma } from '@tonyai/db';
import { PeriodLockedError, RecordChangedError } from './errors';

/**
 * The lifecycle concurrency protocol (LP1-01, findings F02/F03).
 *
 * Every write to an activity record, to its evidence links, or to a period's
 * lock runs as ONE interactive transaction that:
 *
 *  1. reads what it needs to know which locks to take (the record's period,
 *     the file's records) — outside the transaction, so a 404 costs no lock;
 *  2. takes the PERIOD locks: a transaction-scoped advisory lock per period,
 *     SHARED for a record or evidence writer, EXCLUSIVE for lock/unlock. A
 *     period that has never been locked has no `period_locks` row to lock,
 *     which is why this is an advisory lock and not a row lock: it exists for
 *     an empty period too, so a create and a lock of the same period still
 *     meet;
 *  3. takes the ROW locks, `FOR UPDATE`: activity records, then evidence files;
 *  4. re-reads the rows and re-runs every gate (status, author, role, tenant,
 *     period lock, evidence, anomaly) against what it just locked — never
 *     against the step-1 read;
 *  5. writes the change AND its audit row through the same transaction client,
 *     so neither commits without the other.
 *
 * Lock ORDER is fixed, and that is what makes it deadlock-free: period locks
 * before row locks, records before files, each class in ascending key order.
 * Lock/unlock take one exclusive period lock and only then touch that period's
 * rows. A writer never waits on a period lock while holding a row lock.
 *
 * A gate that refuses a row which changed after step 1 is a lost race, not the
 * caller's mistake: it answers `RecordChangedError` (409), the "reload and try
 * again" response. A gate that refuses an unchanged row keeps its own answer,
 * so an API caller sees exactly what it saw before this protocol — unless it
 * lost a race. The server never retries on the caller's behalf.
 *
 * Isolation stays READ COMMITTED: every statement after a lock is granted sees
 * what the previous holder committed, which is all step 4 needs.
 *
 * Its own file, apart from any code that names the audit table:
 * `audit.service.spec.ts` refuses a source file holding both raw SQL and that
 * name, which is its guard on the trail staying append-only.
 */

/** The four columns that name a reporting period — the key of `period_locks`. */
export interface PeriodKey {
  subsidiaryId: string;
  reportingYear: number;
  reportingPeriod: string;
  periodValue: string;
}

/**
 * Options for a lifecycle transaction. Longer than Prisma's 5 s default because
 * a writer may queue behind another writer's locks before doing its own work.
 */
export const LIFECYCLE_TX = { timeout: 15_000 } as const;

// The first key of the two-int advisory-lock form, so these locks share no key
// with anything else in the database that takes advisory locks ("TPLK").
const PERIOD_LOCK_NAMESPACE = 0x54504c4b;

/**
 * A period's advisory-lock key: 32 bits of a SHA-256 over its four columns.
 * A collision makes two periods share a lock — extra waiting, never a missed
 * one — and sorting by this key (not by the text) keeps the order total.
 */
export function periodLockKey(p: PeriodKey): number {
  return createHash('sha256')
    .update([p.subsidiaryId, p.reportingYear, p.reportingPeriod, p.periodValue].join('|'))
    .digest()
    .readInt32BE(0);
}

type RawClient = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

/** Step 2 for a record or evidence writer: share the periods it touches. */
export async function lockPeriodsShared(tx: RawClient, periods: readonly PeriodKey[]): Promise<void> {
  const keys = [...new Set(periods.map(periodLockKey))].sort((x, y) => x - y);
  for (const key of keys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${PERIOD_LOCK_NAMESPACE}::int4, ${key}::int4)`;
  }
}

/** Step 2 for lock/unlock: wait out every writer of the period, then hold it alone. */
export async function lockPeriodExclusive(tx: RawClient, period: PeriodKey): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PERIOD_LOCK_NAMESPACE}::int4, ${periodLockKey(period)}::int4)`;
}

/**
 * Step 3: lock activity records `FOR UPDATE`, in id order, and return the ids
 * that were there to lock. A concurrent delete holds the lock first and
 * removes the row, so the waiter wakes to nothing — and must answer "not
 * found" rather than fail on its own write.
 *
 * `FOR UPDATE` also conflicts with the `FOR KEY SHARE` a foreign-key check
 * takes on the referenced row, so while it is held nothing can link an
 * evidence file to these records.
 */
export async function lockActivityRecordRows(
  tx: RawClient,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const sorted = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS id FROM "activity_records"
    WHERE "id" = ANY(${sorted}::uuid[])
    ORDER BY "id"
    FOR UPDATE`;
  return new Set(rows.map((r) => r.id));
}

/** Step 3 for one record: whether it was there to lock. */
export async function lockActivityRecordRow(tx: RawClient, id: string): Promise<boolean> {
  return (await lockActivityRecordRows(tx, [id])).size > 0;
}

/**
 * Step 3, files: lock evidence rows `FOR UPDATE`, in id order, after any
 * record locks. Two requests unlinking the last two records of one shared
 * file must serialise here, or each sees the other's link still in place and
 * neither deletes the file.
 */
export async function lockEvidenceRows(tx: RawClient, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const sorted = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS id FROM "evidence"
    WHERE "id" = ANY(${sorted}::uuid[])
    ORDER BY "id"
    FOR UPDATE`;
  return new Set(rows.map((r) => r.id));
}

/** Whether a row changed between the caller's read and the locked re-read. */
export function changedSince(
  seen: { status: string; updatedAt: Date },
  current: { status: string; updatedAt: Date },
): boolean {
  return seen.status !== current.status || seen.updatedAt.getTime() !== current.updatedAt.getTime();
}

/**
 * Step 4: run `gates` against the locked row. When they refuse a row that
 * changed since the caller's read, the refusal is a lost race and answers
 * `RecordChangedError`; a refusal of an unchanged row propagates as it is. A
 * period-lock refusal always keeps its own sentence — it names what happened.
 */
export function regate(
  seen: { status: string; updatedAt: Date },
  current: { status: string; updatedAt: Date },
  gates: () => void,
): void {
  try {
    gates();
  } catch (error) {
    if (changedSince(seen, current) && !(error instanceof PeriodLockedError)) {
      throw new RecordChangedError();
    }
    throw error;
  }
}

/**
 * The database's own "you lost a race" signals, mapped to the same 409:
 * P2025 is a write whose expected-state WHERE matched nothing (the protocol's
 * belt-and-braces compare-and-set), P2034 a deadlock or serialisation failure.
 * Neither should happen under the protocol; if one does, the caller reloads.
 */
export function asLostRace(error: unknown): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2025' || error.code === 'P2034')
  ) {
    return new RecordChangedError();
  }
  return error;
}
