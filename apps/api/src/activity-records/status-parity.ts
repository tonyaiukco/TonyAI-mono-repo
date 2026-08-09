import type { ActivityRecordStatus as PrismaStatus } from '@tonyai/db';
import type { ActivityRecordStatus as SharedStatus } from '@tonyai/shared-types';

/**
 * Fails to compile if the shared status union and Prisma's generated enum
 * diverge in EITHER direction.
 *
 * The assignment in `period-locks.service.ts` catches a status the shared list
 * has and Prisma does not. Nothing caught the opposite — a status added to the
 * schema that the shared union never learns about, which would let a record
 * reach a state no API filter, queue or lock gate knows how to reason about.
 * This file is the whole check; it has no runtime job.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const _statusParity: Exact<SharedStatus, PrismaStatus> = true;
