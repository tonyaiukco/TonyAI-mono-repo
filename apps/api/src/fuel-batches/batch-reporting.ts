import type { Prisma } from '@tonyai/db';
import { can } from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { accessRowsOf, reportingEntityOf } from '../central-reporting/record-entities';

/**
 * Keep on the batch the reporting company its records were written for
 * (TA025 derives it from the author's access, a central reporter's main
 * company): while the batch holds live records, the newest one's (null when
 * it is the batch's own company), so a rebuild under a moved main company
 * moves the header with its records (fifth review of WP9 PR B); once none is
 * live (withdrawn, every record voided) the last one stays, so the batch still
 * names it (fourth review). Called in the transaction that writes the records.
 */
export async function keepReportingCompany(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, batchId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE fuel_batches b
       SET reported_by_subsidiary_id = CASE WHEN r.reported_by_subsidiary_id = b.subsidiary_id THEN NULL ELSE r.reported_by_subsidiary_id END
      FROM (
        SELECT reported_by_subsidiary_id FROM activity_records
         WHERE fuel_batch_id = ${batchId}::uuid AND status <> 'voided'
         ORDER BY created_at DESC, id DESC LIMIT 1
      ) r
     WHERE b.id = ${batchId}::uuid
       AND b.reported_by_subsidiary_id IS DISTINCT FROM
           (CASE WHEN r.reported_by_subsidiary_id = b.subsidiary_id THEN NULL ELSE r.reported_by_subsidiary_id END)`;
}

/**
 * The reporting company a record the caller writes for `subsidiaryId` now
 * would carry, as the batch header keeps it (null: the company itself): a
 * standard user's by its grants (`reportingEntityOf`, as the create core);
 * any other role writes for the company itself. A batch's live records all
 * carry one — a group joins an open batch, and a declaration change rebuilds
 * one, only when this equals the batch's (sixth review of WP9 PR B).
 */
export function reportingHeaderFor(user: RequestUser, subsidiaryId: string): string | null {
  const entity = can(user.role, 'scope.categories') ? reportingEntityOf(accessRowsOf(user), subsidiaryId) : subsidiaryId;
  return entity === subsidiaryId ? null : entity;
}
