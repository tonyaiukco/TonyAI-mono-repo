import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { FUEL_DEDUPE_KEY_BYTES, organisationDedupeKey } from './dedupe-key';

/** DB-free: an organisation's dedupe key is read, created once when absent, and never accepted malformed (D5, revised). */

const ORG = '00000000-0000-4000-8000-0000000000aa';

function store(initial: Uint8Array | null) {
  let secret = initial;
  const fuelDedupeKey = {
    findUnique: vi.fn(async () => (secret ? { secret } : null)),
    findUniqueOrThrow: vi.fn(async () => {
      if (!secret) throw new Error('missing');
      return { secret };
    }),
    createMany: vi.fn(async ({ data }: { data: Array<{ secret: Uint8Array }> }) => {
      // skipDuplicates: an existing key stays.
      if (!secret) secret = data[0]!.secret;
      return { count: 1 };
    }),
  };
  return { db: { fuelDedupeKey } as unknown as Pick<PrismaService, 'fuelDedupeKey'>, fuelDedupeKey };
}

describe('organisationDedupeKey', () => {
  it('reads an existing key and writes nothing', async () => {
    const existing = Buffer.alloc(FUEL_DEDUPE_KEY_BYTES, 3);
    const { db, fuelDedupeKey } = store(existing);
    expect(await organisationDedupeKey(db, ORG)).toEqual(existing);
    expect(fuelDedupeKey.createMany).not.toHaveBeenCalled();
    expect(fuelDedupeKey.findUnique).toHaveBeenCalledWith({ where: { organisationId: ORG }, select: { secret: true } });
  });

  it('creates a random 32-byte key on the first upload, skipping a duplicate, and answers the stored one', async () => {
    const { db, fuelDedupeKey } = store(null);
    const key = await organisationDedupeKey(db, ORG);
    expect(key).toHaveLength(FUEL_DEDUPE_KEY_BYTES);
    const call = fuelDedupeKey.createMany.mock.calls[0]![0];
    expect(call).toMatchObject({ skipDuplicates: true, data: [{ organisationId: ORG }] });
    expect(key).toEqual(Buffer.from(call.data[0]!.secret));
    // Two organisations' first uploads draw two keys.
    expect(await organisationDedupeKey(store(null).db, ORG)).not.toEqual(key);
  });

  it('answers the key a concurrent first upload stored, not its own draw', async () => {
    const winner = Buffer.alloc(FUEL_DEDUPE_KEY_BYTES, 9);
    const { db, fuelDedupeKey } = store(null);
    fuelDedupeKey.createMany.mockImplementationOnce(async () => ({ count: 0 }));
    fuelDedupeKey.findUniqueOrThrow.mockImplementationOnce(async () => ({ secret: winner }));
    expect(await organisationDedupeKey(db, ORG)).toEqual(winner);
  });

  it('refuses a key of the wrong length', async () => {
    await expect(organisationDedupeKey(store(Buffer.alloc(16, 1)).db, ORG)).rejects.toThrow(/malformed/);
  });
});
