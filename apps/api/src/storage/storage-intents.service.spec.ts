import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from './storage.service';
import { captureException } from '../observability/sentry';

vi.mock('../observability/sentry', () => ({ captureException: vi.fn() }));
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

  it('removes nothing, and gives the intents back, when the role cannot see every owning row', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const claimed = [{ id: 'i-1', bucket: 'evidence', objectPath: 'sub-1/a.pdf', attempts: 1 }];
    const prisma = {
      // The claim, then the visibility check: RLS hides rows from this role.
      $queryRaw: vi.fn().mockResolvedValueOnce(claimed).mockResolvedValueOnce([{ ok: false }]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      evidence: { findMany: vi.fn() },
      // The check and the owned-bytes read share one transaction (and so one connection).
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const remove = vi.fn();
    const intents = new StorageIntentsService(prisma as unknown as PrismaService, { remove } as unknown as StorageService);

    await intents.runNow([{ bucket: 'evidence', path: 'sub-1/a.pdf' }]);

    expect(remove).not.toHaveBeenCalled();
    // Not even asked who owns it: under RLS the answer would be "nobody".
    expect(prisma.evidence.findMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledOnce(); // the release
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0][0]).toMatch(/cannot see every row/);
    logged.mockRestore();
  });

  it('asks the visibility question on the transaction that reads the owners, not on the pool', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // The pool's connection would say yes; the transaction's says no — and the transaction decides.
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ ok: false }]),
      evidence: { findMany: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'i-1', bucket: 'evidence', objectPath: 'sub-1/a.pdf', attempts: 1, lease: 'L' }])
        .mockResolvedValue([{ ok: true }]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      evidence: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
    };
    const remove = vi.fn();
    await new StorageIntentsService(prisma as unknown as PrismaService, { remove } as unknown as StorageService).runNow([
      { bucket: 'evidence', path: 'sub-1/a.pdf' },
    ]);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledOnce(); // the release
    logged.mockRestore();
  });

  it('keeps bytes a row owns, and reports the intent to Sentry without the key (a key carries a file name)', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const path = 'sub-1/uuid-Ayse-Yilmaz-fatura.pdf';
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'i-1', bucket: 'evidence', objectPath: path, attempts: 1, lease: 'L' }])
        .mockResolvedValueOnce([{ ok: true }]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      evidence: { findMany: vi.fn().mockResolvedValue([{ storagePath: path }]) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    const remove = vi.fn();
    await new StorageIntentsService(prisma as unknown as PrismaService, { remove } as unknown as StorageService).runNow([
      { bucket: 'evidence', path },
    ]);

    expect(remove).not.toHaveBeenCalled();
    // Closed — under its lease — without a removal.
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toEqual([['i-1'], ['L']]);
    expect(logged.mock.calls[0][0]).toContain(path); // the operator's log keeps it
    const reported = vi.mocked(captureException).mock.calls.at(-1)![0] as Error;
    expect(reported.message).toContain('i-1');
    expect(reported.message).not.toContain('Ayse');
    logged.mockRestore();
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

describe('StorageIntentsService — abandonUpload, after the owning transaction ran', () => {
  it('with the intent gone and an ordinary cause — the transaction may have committed — enqueues and removes nothing', async () => {
    const prisma = { storageIntent: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, $executeRaw: vi.fn() };
    const s = new StorageIntentsService(prisma as unknown as PrismaService, {} as StorageService);
    const runNow = vi.spyOn(s, 'runNow').mockResolvedValue(undefined);
    await s.abandonUpload('intent-1', { bucket: 'report-artifacts', path: 'org-1/a.pdf' }, new Error('ack lost'), { organisationId: 'org-1' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(runNow).not.toHaveBeenCalled();
  });
});

/*
 * A failure BEFORE the owning transaction (Codex's B9 review of #198, P2): no
 * row can own the object, so it goes whatever became of the intent — the
 * real-Storage proof is report-issuance.int.spec.ts ("a late upload").
 */
describe('StorageIntentsService — abandonUnadoptedUpload', () => {
  const ref = { bucket: 'report-artifacts' as const, path: 'org-1/a.pdf' };
  function service(prisma: Partial<Record<string, unknown>>) {
    const s = new StorageIntentsService(prisma as unknown as PrismaService, {} as StorageService);
    const runNow = vi.spyOn(s, 'runNow').mockResolvedValue(undefined);
    return { s, runNow };
  }

  it('turns a standing upload intent into the delete and removes the object now — nothing enqueued beside it', async () => {
    const prisma = { storageIntent: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, $executeRaw: vi.fn() };
    const { s, runNow } = service(prisma);
    await s.abandonUnadoptedUpload('intent-1', ref, { organisationId: 'org-1' });
    expect(prisma.storageIntent.updateMany).toHaveBeenCalledWith({ where: { id: 'intent-1', kind: 'upload' }, data: { kind: 'delete' } });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(runNow).toHaveBeenCalledWith([ref]);
  });

  it('with the intent gone — the sweeper took it while the bytes were on their way — enqueues the delete anew and removes the object now', async () => {
    const prisma = { storageIntent: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, $executeRaw: vi.fn().mockResolvedValue(1) };
    const { s, runNow } = service(prisma);
    await s.abandonUnadoptedUpload('intent-1', ref, { organisationId: 'org-1' });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = prisma.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toMatch(/INSERT INTO storage_intents[\s\S]*'delete'[\s\S]*ON CONFLICT \(bucket, object_path\) DO UPDATE/);
    expect(values).toEqual(['report-artifacts', 'upload.abandoned', 'org-1', null, ['org-1/a.pdf']]);
    expect(runNow).toHaveBeenCalledWith([ref]);
    expect(prisma.storageIntent.updateMany.mock.invocationCallOrder[0]).toBeLessThan(runNow.mock.invocationCallOrder[0]);
  });

  it('logs a database failure instead of throwing over the request\'s own error', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const prisma = { storageIntent: { updateMany: vi.fn().mockRejectedValue(new Error('db down')) } };
    const { s, runNow } = service(prisma);
    await expect(s.abandonUnadoptedUpload('intent-1', ref)).resolves.toBeUndefined();
    expect(logged.mock.calls[0][0]).toContain('unadopted upload');
    expect(runNow).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it('with the intent gone and its re-enqueue failing: logged, resolved, nothing removed (`security-rls` P3)', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const prisma = { storageIntent: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, $executeRaw: vi.fn().mockRejectedValue(new Error('db down')) };
    const { s, runNow } = service(prisma);
    await expect(s.abandonUnadoptedUpload('intent-1', ref)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(runNow).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it('under STORAGE_CLEANUP_HOLD the re-enqueued delete waits as an intent: nothing is claimed or removed (`security-rls` P3)', async () => {
    vi.stubEnv('STORAGE_CLEANUP_HOLD', '1');
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const remove = vi.fn();
      const prisma = {
        storageIntent: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        $executeRaw: vi.fn().mockResolvedValue(1), $queryRaw: vi.fn(), $transaction: vi.fn(),
      };
      const s = new StorageIntentsService(prisma as unknown as PrismaService, { remove } as unknown as StorageService);
      await s.abandonUnadoptedUpload('intent-1', ref);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
