import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from './storage.service';
import { StorageIntentsService, removalsHeld, sweepIntervalSeconds } from './storage-intents.service';

/*
 * The protocol itself — intents, leases, backoff, the owned-object guard — is
 * proven against real PostgreSQL and the local Supabase Storage in
 * test/int/storage-recovery.int.spec.ts. These are the parts that need no
 * database: the two switches operators set, and the "never throws" promise
 * the writers rely on after their commit.
 */

describe('removalsHeld — STORAGE_CLEANUP_HOLD', () => {
  it('holds on the usual spellings of "on"', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) {
      expect(removalsHeld({ STORAGE_CLEANUP_HOLD: value }), value).toBe(true);
    }
  });

  it('does not hold when unset, empty or off', () => {
    for (const value of [undefined, '', '0', 'false', 'off', 'no']) {
      expect(removalsHeld({ STORAGE_CLEANUP_HOLD: value }), String(value)).toBe(false);
    }
  });
});

describe('sweepIntervalSeconds — STORAGE_SWEEP_INTERVAL_SECONDS', () => {
  it('defaults to five minutes, takes a number, and 0 turns the sweeper off', () => {
    expect(sweepIntervalSeconds({})).toBe(300);
    expect(sweepIntervalSeconds({ STORAGE_SWEEP_INTERVAL_SECONDS: '60' })).toBe(60);
    expect(sweepIntervalSeconds({ STORAGE_SWEEP_INTERVAL_SECONDS: '0' })).toBe(0);
  });

  it('falls back to the default rather than sweeping in a tight loop on nonsense', () => {
    for (const value of ['-5', 'abc', 'Infinity']) {
      expect(sweepIntervalSeconds({ STORAGE_SWEEP_INTERVAL_SECONDS: value }), value).toBe(300);
    }
  });
});

describe('StorageIntentsService — after the commit, never throws', () => {
  function service(prisma: Partial<Record<string, unknown>>) {
    return new StorageIntentsService(prisma as unknown as PrismaService, {} as StorageService);
  }

  it('runNow logs a database failure and leaves the intents for the sweeper', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const prisma = { $queryRaw: vi.fn().mockRejectedValue(new Error('db down')) };
    await expect(
      service(prisma).runNow([{ bucket: 'evidence', path: 'sub-1/a.pdf' }]),
    ).resolves.toBeUndefined();
    expect(logged.mock.calls[0][0]).toContain('evidence/sub-1/a.pdf');
    logged.mockRestore();
  });

  it('runNow removes nothing while STORAGE_CLEANUP_HOLD is set', async () => {
    vi.stubEnv('STORAGE_CLEANUP_HOLD', 'true');
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const prisma = { $queryRaw: vi.fn() };
    await service(prisma).runNow([{ bucket: 'evidence', path: 'sub-1/a.pdf' }]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
    vi.unstubAllEnvs();
  });

  it('abandonUpload logs a database failure instead of throwing over the request\'s own error', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const prisma = { storageIntent: { updateMany: vi.fn().mockRejectedValue(new Error('db down')) } };
    await expect(
      service(prisma).abandonUpload('intent-1', { bucket: 'evidence', path: 'sub-1/a.pdf' }),
    ).resolves.toBeUndefined();
    expect(logged.mock.calls[0][0]).toContain('sweeper');
    logged.mockRestore();
  });
});
