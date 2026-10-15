import type { Prisma } from '@tonyai/db';

/**
 * A version's header row lock (LP3-04's write path; W8, PR B's (6)). Every
 * write to a version takes its header FOR UPDATE as its first statement — a
 * later freeze in the same transaction would otherwise wait on another
 * writer's share lock while holding its own, and deadlock — and a copy reads
 * its source under FOR SHARE, so no edit tears it. Bound to the organisation:
 * another's version locks nothing and reads as none (false).
 *
 * The raw SQL lives here, away from the service that writes the audit trail
 * (the audit spec's rule for raw queries).
 */
export async function lockBoundaryHeader(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  id: string,
  organisationId: string,
  mode: 'update' | 'share',
): Promise<boolean> {
  const rows = mode === 'update'
    ? await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"::text AS id FROM "inventory_boundaries"
        WHERE "id" = ${id}::uuid AND "organisation_id" = ${organisationId}::uuid
        FOR UPDATE`
    : await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"::text AS id FROM "inventory_boundaries"
        WHERE "id" = ${id}::uuid AND "organisation_id" = ${organisationId}::uuid
        FOR SHARE`;
  return rows.length > 0;
}
