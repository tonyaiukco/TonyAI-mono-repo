import { randomBytes } from 'node:crypto';
import type { RequestUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { lockActor } from './lock-actor';

/**
 * An organisation's key for the fuel dedupe digest (inc28-fuel-bulk D5,
 * revised by the owner 2026-11-27). 32 random bytes in `fuel_dedupe_keys`,
 * which only the API's role may read or write; created on the organisation's
 * first fuel preview or apply, then only read. It is never updated or
 * deleted, so a key once read keys every later upload the same way. The key
 * itself is never logged, audited or sent: it is the one thing that keeps a
 * stored digest from being reversed. Its creation is audited without it.
 */

export const FUEL_DEDUPE_KEY_BYTES = 32;

/** Rows are stored but their key is gone: a new key would match none of them. */
export class FuelDedupeKeyLostError extends Error {
  constructor() {
    super('The organisation holds fuel rows but no fuel dedupe key; a new key would store every re-uploaded row again.');
  }
}

export async function organisationDedupeKey(
  prisma: Pick<PrismaService, 'fuelDedupeKey' | '$transaction'>,
  audit: Pick<AuditService, 'record'>,
  user: RequestUser,
): Promise<Buffer> {
  const organisationId = user.organisationId!;
  let row = await prisma.fuelDedupeKey.findUnique({ where: { organisationId }, select: { secret: true } });
  if (!row) {
    await prisma.$transaction(async (tx) => {
      // The caller as it stands, before the key or its audit row is written: one
      // whose role dropped while its file was read creates nothing (fourth review, P2).
      await lockActor(tx, user);
      // Two first uploads at once: the one inserted first wins (the other's
      // insert waits for it, then skips), and both read the winner's key.
      const created = await tx.fuelDedupeKey.createMany({
        data: [{ organisationId, secret: randomBytes(FUEL_DEDUPE_KEY_BYTES) }],
        skipDuplicates: true,
      });
      if (created.count === 0) return;
      // Only the upload that creates the key asks whether rows exist without
      // one, after its insert — so a concurrent first upload that committed a
      // key and its rows meanwhile is never taken for a lost key (review of
      // the fixes, P2). Every row is stored under a key, so rows with none mean
      // the key was lost (a repair or restore by hand), and a fresh key would
      // silently store each re-uploaded row again — counted twice. Refuse
      // loudly; the new key goes with the rollback.
      if (await tx.fuelRow.findFirst({ where: { organisationId }, select: { id: true } })) {
        throw new FuelDedupeKeyLostError();
      }
      await audit.record(user, { action: 'create', entity: 'fuel_dedupe_key', entityId: organisationId, diff: { fuelDedupeKey: 'created' } }, tx);
    });
    row = await prisma.fuelDedupeKey.findUniqueOrThrow({ where: { organisationId }, select: { secret: true } });
  }
  const key = Buffer.from(row.secret);
  // The table's CHECK holds this; a short key would key nothing safely.
  if (key.length !== FUEL_DEDUPE_KEY_BYTES) throw new Error('The organisation’s fuel dedupe key is malformed.');
  return key;
}
