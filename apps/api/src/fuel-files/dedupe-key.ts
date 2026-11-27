import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * An organisation's key for the fuel dedupe digest (inc28-fuel-bulk D5,
 * revised by the owner 2026-11-27). 32 random bytes in `fuel_dedupe_keys`,
 * which only the API's role may read or write; created on the organisation's
 * first fuel upload, then only read. It is never updated or deleted, so a key
 * once read keys every later upload the same way. Never logged, audited or
 * sent: it is the one thing that keeps a stored digest from being reversed.
 */

export const FUEL_DEDUPE_KEY_BYTES = 32;

export async function organisationDedupeKey(
  db: Pick<PrismaService, 'fuelDedupeKey'>,
  organisationId: string,
): Promise<Buffer> {
  let row = await db.fuelDedupeKey.findUnique({ where: { organisationId }, select: { secret: true } });
  if (!row) {
    // Two first uploads at once: the one inserted first wins, and both read it.
    await db.fuelDedupeKey.createMany({
      data: [{ organisationId, secret: randomBytes(FUEL_DEDUPE_KEY_BYTES) }],
      skipDuplicates: true,
    });
    row = await db.fuelDedupeKey.findUniqueOrThrow({ where: { organisationId }, select: { secret: true } });
  }
  const key = Buffer.from(row.secret);
  // The table's CHECK holds this; a short key would key nothing safely.
  if (key.length !== FUEL_DEDUPE_KEY_BYTES) throw new Error('The organisation’s fuel dedupe key is malformed.');
  return key;
}
