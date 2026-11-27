import type { Prisma } from '@tonyai/db';

/**
 * Keep on the batch the reporting company its records were written for
 * (TA025 derives it from the author's access, a central reporter's main
 * company): set once, from its first record that names one other than the
 * batch's own company, never cleared — so a withdrawn batch, whose records
 * are removed, or one whose every record was voided still names it (fourth
 * review of WP9 PR B). Called in the transaction that writes the records.
 */
export async function keepReportingCompany(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, batchId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE fuel_batches b SET reported_by_subsidiary_id = r.reported_by_subsidiary_id
      FROM (
        SELECT reported_by_subsidiary_id FROM activity_records
         WHERE fuel_batch_id = ${batchId}::uuid AND reported_by_subsidiary_id IS NOT NULL
         ORDER BY created_at, id LIMIT 1
      ) r
     WHERE b.id = ${batchId}::uuid AND b.reported_by_subsidiary_id IS NULL
       AND r.reported_by_subsidiary_id <> b.subsidiary_id`;
}
