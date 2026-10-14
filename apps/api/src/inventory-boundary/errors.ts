import { Prisma } from '@tonyai/db';

/**
 * Did the inventory boundary's guard refuse this write (SQLSTATE TA014)? A
 * frozen version took a change, or a subsidiary or site it declares was being
 * deleted (W9). Prisma 6 reports a trigger's RAISE on a model query as an
 * unknown request error whose message carries the PostgreSQL code, and on a
 * raw query as P2010 with the code in `meta` (as `recordTriggerCode`).
 */
export function boundaryGuardRefused(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2010') {
    return (e.meta as { code?: unknown } | undefined)?.code === 'TA014';
  }
  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    // Anchored on the engine's own framing, so text inside the message cannot
    // be read as a code.
    return /PostgresError \{ code: "TA014"/.test(e.message);
  }
  return false;
}
