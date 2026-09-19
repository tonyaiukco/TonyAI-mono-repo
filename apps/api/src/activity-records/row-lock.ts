import type { Prisma } from '@tonyai/db';

/**
 * Lock one activity record's row until the end of the caller's transaction.
 *
 * Prisma has no `FOR UPDATE`, hence the raw statement. `FOR UPDATE` conflicts
 * with the `FOR KEY SHARE` a foreign-key check takes on the referenced row, so
 * while it is held nothing can link an evidence file to this record: the link
 * waits, then either sees the record or fails because it is gone.
 *
 * Its own file so the one raw statement it runs stays apart from any code
 * that names the audit table: `audit.service.spec.ts` refuses a source file
 * holding both, which is its guard on the audit trail staying append-only.
 */
export async function lockActivityRecordRow(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  id: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "activity_records" WHERE "id" = ${id}::uuid FOR UPDATE`;
}
