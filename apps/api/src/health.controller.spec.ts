import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';
import { HealthReadiness } from './health-readiness';
import type { PrismaService } from './prisma/prisma.service';
import { Reflector } from '@nestjs/core';
import { SupabaseAuthGuard } from './auth/auth.guard';
import type { ExecutionContext } from '@nestjs/common';
import { IS_PUBLIC_KEY } from './auth/public.decorator';

const setup = () => {
  vi.stubEnv('SUPABASE_URL', 'https://synthetic.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-secret');
  const query = vi.fn().mockResolvedValue([{ value: 1 }]);
  const transaction = vi.fn(async (callback, _options?: unknown) => callback({ $queryRaw: query }));
  const prisma = { $transaction: transaction } as unknown as PrismaService;
  const fetch = vi.fn(async (url: string, _options?: RequestInit) => new Response(JSON.stringify({ id: url.split('/').pop(), public: false })));
  vi.stubGlobal('fetch', fetch);
  return { prisma, transaction, query, fetch, health: new HealthController(prisma) };
};
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('health boundaries', () => {
  it('keeps liveness independent and synthetic behind the global guard', () => {
    const { health, transaction, fetch } = setup();
    expect(health.check().status).toBe('ok');
    expect(transaction).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, HealthController.prototype.check)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, HealthController.prototype.ready)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, HealthController.prototype.synthetic)).toBeUndefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, HealthController)).toBeUndefined();
  });

  it('refuses an unauthenticated synthetic check through the real global guard', async () => {
    const { prisma } = setup();
    const guard = new SupabaseAuthGuard(new Reflector(), prisma);
    const context = {
      getHandler: () => HealthController.prototype.synthetic,
      getClass: () => HealthController,
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });

  it('checks both private buckets and only runtime-safe SQL, with bounded calls', async () => {
    const { health, transaction, query, fetch } = setup();
    expect(await health.ready()).toEqual({ status: 'ready' });
    expect(transaction.mock.calls[0][1]).toEqual({ maxWait: 500, timeout: 1500 });
    expect(query.mock.calls.map((call) => String(call[0]))).toEqual([
      "SELECT set_config('statement_timeout', '1000', true)", 'SELECT 1',
    ]);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://synthetic.supabase.co/storage/v1/bucket/evidence',
      'https://synthetic.supabase.co/storage/v1/bucket/import-sources',
    ]);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });

  it('coalesces concurrent probes, caches failures and recovers after expiry', async () => {
    vi.useFakeTimers();
    const { prisma, transaction } = setup();
    transaction.mockRejectedValueOnce(new Error('private DB address/password'));
    const readiness = new HealthReadiness(prisma);
    expect(await Promise.all(Array.from({ length: 20 }, () => readiness.check()))).toEqual(Array(20).fill(false));
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(await readiness.check()).toBe(false);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await readiness.check()).toBe(true);
  });

  it('bounds a stalled driver without starting more underlying work', async () => {
    vi.useFakeTimers();
    const { prisma, transaction } = setup();
    transaction.mockImplementation(() => new Promise(() => {}));
    const readiness = new HealthReadiness(prisma);
    const first = readiness.check();
    await vi.advanceTimersByTimeAsync(2500);
    expect(await first).toBe(false);
    await vi.advanceTimersByTimeAsync(5001);
    const second = readiness.check();
    await vi.advanceTimersByTimeAsync(2500);
    expect(await second).toBe(false);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it.each(['db', 'storage', 'public-bucket'])('fails closed without disclosing %s details', async (failure) => {
    const { health, transaction, fetch } = setup();
    if (failure === 'db') transaction.mockRejectedValue(new Error('secret database error'));
    if (failure === 'storage') fetch.mockRejectedValue(new Error('secret storage error'));
    if (failure === 'public-bucket') fetch.mockResolvedValue(new Response('{"id":"evidence","public":true}'));
    await expect(health.ready()).rejects.toMatchObject({ status: 503, message: 'Not ready' });
    expect(health.check().status).toBe('ok');
  });
});
