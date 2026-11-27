import { describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { FUEL_DEDUPE_KEY_BYTES, FuelDedupeKeyLostError, organisationDedupeKey } from './dedupe-key';

/**
 * DB-free: an organisation's dedupe key is read, created once when absent
 * (audited without the key), refused when rows outlived their key, and never
 * accepted malformed (D5, revised).
 */

const ORG = '00000000-0000-4000-8000-0000000000aa';
const user = { id: '00000000-0000-4000-8000-0000000000ff', role: 'masterkey', organisationId: ORG } as RequestUser;

function store(initial: Uint8Array | null, { rows = false } = {}) {
  let secret = initial;
  const tx = {
    fuelRow: { findFirst: vi.fn(async () => (rows ? { id: 'row-1' } : null)) },
    fuelDedupeKey: {
      createMany: vi.fn(async ({ data }: { data: Array<{ secret: Uint8Array }> }) => {
        // skipDuplicates: an existing key stays.
        if (secret) return { count: 0 };
        secret = data[0]!.secret;
        return { count: 1 };
      }),
    },
  };
  const fuelDedupeKey = {
    findUnique: vi.fn(async () => (secret ? { secret } : null)),
    findUniqueOrThrow: vi.fn(async () => {
      if (!secret) throw new Error('missing');
      return { secret };
    }),
  };
  const prisma = { fuelDedupeKey, $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
  const audit = { record: vi.fn(async () => undefined) };
  return {
    prisma: prisma as unknown as Pick<PrismaService, 'fuelDedupeKey' | '$transaction'>,
    audit: audit as unknown as Pick<AuditService, 'record'>,
    raw: { prisma, tx, audit },
  };
}

describe('organisationDedupeKey', () => {
  it('reads an existing key and writes nothing', async () => {
    const existing = Buffer.alloc(FUEL_DEDUPE_KEY_BYTES, 3);
    const { prisma, audit, raw } = store(existing);
    expect(await organisationDedupeKey(prisma, audit, user)).toEqual(existing);
    expect(raw.prisma.$transaction).not.toHaveBeenCalled();
    expect(raw.audit.record).not.toHaveBeenCalled();
    expect(raw.prisma.fuelDedupeKey.findUnique).toHaveBeenCalledWith({ where: { organisationId: ORG }, select: { secret: true } });
  });

  it('creates a random 32-byte key on the first upload, audited in the same transaction without the key', async () => {
    const { prisma, audit, raw } = store(null);
    const key = await organisationDedupeKey(prisma, audit, user);
    expect(key).toHaveLength(FUEL_DEDUPE_KEY_BYTES);
    const call = raw.tx.fuelDedupeKey.createMany.mock.calls[0]![0];
    expect(call).toMatchObject({ skipDuplicates: true, data: [{ organisationId: ORG }] });
    expect(key).toEqual(Buffer.from(call.data[0]!.secret));
    expect(raw.audit.record).toHaveBeenCalledWith(
      user,
      { action: 'create', entity: 'fuel_dedupe_key', entityId: ORG, diff: { fuelDedupeKey: 'created' } },
      raw.tx,
    );
    expect(JSON.stringify(raw.audit.record.mock.calls)).not.toContain(key.toString('hex'));
    // Two organisations' first uploads draw two keys.
    const other = store(null);
    expect(await organisationDedupeKey(other.prisma, other.audit, user)).not.toEqual(key);
  });

  it('answers the key a concurrent first upload stored, not its own draw, and audits nothing itself', async () => {
    const winner = Buffer.alloc(FUEL_DEDUPE_KEY_BYTES, 9);
    const { prisma, audit, raw } = store(null);
    raw.tx.fuelDedupeKey.createMany.mockImplementationOnce(async () => ({ count: 0 }));
    raw.prisma.fuelDedupeKey.findUniqueOrThrow.mockImplementationOnce(async () => ({ secret: winner }));
    expect(await organisationDedupeKey(prisma, audit, user)).toEqual(winner);
    expect(raw.audit.record).not.toHaveBeenCalled();
  });

  it('refuses to create a key for an organisation that already holds fuel rows (a lost key)', async () => {
    const { prisma, audit, raw } = store(null, { rows: true });
    await expect(organisationDedupeKey(prisma, audit, user)).rejects.toBeInstanceOf(FuelDedupeKeyLostError);
    expect(raw.tx.fuelRow.findFirst).toHaveBeenCalledWith({ where: { organisationId: ORG }, select: { id: true } });
    expect(raw.tx.fuelDedupeKey.createMany).not.toHaveBeenCalled();
    expect(raw.audit.record).not.toHaveBeenCalled();
  });

  it('refuses a key of the wrong length', async () => {
    const { prisma, audit } = store(Buffer.alloc(16, 1));
    await expect(organisationDedupeKey(prisma, audit, user)).rejects.toThrow(/malformed/);
  });
});
