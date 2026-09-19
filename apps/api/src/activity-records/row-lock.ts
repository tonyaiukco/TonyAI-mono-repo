import type { Prisma } from '@tonyai/db';

/**
 * Lock one activity record's row until the end of the caller's transaction.
 *
 * Prisma has no `FOR UPDATE`, hence the raw statement. `FOR UPDATE` conflicts
 * with the `FOR KEY SHARE` a foreign-key check takes on the referenced row, so
 * while it is held nothing can link an evidence file to this record: the link
 * waits, then either sees the record or fails because it is gone.
 *
 * Returns whether the row was there to lock. A concurrent delete of the same
 * record holds the lock first and removes the row, so the waiter wakes to
 * nothing — and must answer "not found" rather than fail on its own delete.
 *
 * Its own file so the one raw statement it runs stays apart from any code
 * that names the audit table: `audit.service.spec.ts` refuses a source file
 * holding both, which is its guard on the audit trail staying append-only.
 */
export async function lockActivityRecordRow(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  id: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<unknown[]>`SELECT 1 FROM "activity_records" WHERE "id" = ${id}::uuid FOR UPDATE`;
  return rows.length > 0;
}
