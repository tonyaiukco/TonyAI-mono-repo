import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@tonyai/db';
import type { RequestUser } from '../auth/auth.types';

/**
 * The actor as it stands now, under its profile row's share lock: the same
 * role and organisation the request was authorised with, and not disabled
 * (403 otherwise). Every fuel write that acts on others' data on the strength
 * of the caller's role — a mapping, a takeover, a withdrawal of another
 * holder's rows — calls it first in its transaction, so a role lowered or an
 * account disabled after the request was authorised writes nothing (D14;
 * WP9 PR B review, P1). An access change holding the profile commits first.
 */
export async function lockActor(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, user: RequestUser): Promise<void> {
  const [actor] = await tx.$queryRaw<Array<{ same: boolean }>>`
    SELECT (p.role::text = ${user.role} AND p.organisation_id = ${user.organisationId}::uuid AND p.disabled_at IS NULL) AS same
    FROM profiles p WHERE p.id = ${user.id}::uuid FOR SHARE`;
  if (!actor?.same) throw new ForbiddenException();
}
