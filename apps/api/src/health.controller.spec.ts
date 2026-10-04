import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';
import { HealthReadiness } from './health-readiness';
import type { PrismaService } from './prisma/prisma.service';
import { Reflector } from '@nestjs/core';
import { SupabaseAuthGuard } from './auth/auth.guard';
import type { ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import { captureException } from './observability/sentry';

vi.mock('./observability/sentry', () => ({ captureException: vi.fn() }));
import { IS_PUBLIC_KEY } from './auth/public.decorator';

const setup = () => {
  vi.stubEnv('SUPABASE_URL', 'https://synthetic.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-secret');
  const query = vi.fn().mockResolvedValue([{ value: 1 }]);
  const transaction = vi.fn(async (callback, _options?: unknown) => callback({ $queryRaw: query }));
  const prisma = { $transaction: transaction } as unknown as PrismaService;
  const fetch = vi.fn(async (url: string, _options?: RequestInit) => new Response(JSON.stringify({ id: url.split('/').pop(), public: false })));
  vi.stubGlobal('fetch', fetch);
  const response = { status: vi.fn() } as unknown as Response;
  return { prisma, transaction, query, fetch, response, health: new HealthController(prisma) };
};
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

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
    const { health, transaction, query, fetch, response } = setup();
    expect(await health.ready(response)).toEqual({ status: 'ready' });
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

  it('abandons a stale flight and recovers while the old query remains hung', async () => {
    vi.useFakeTimers();
    const { prisma, transaction } = setup();
    transaction.mockImplementationOnce(() => new Promise(() => {}));
    const readiness = new HealthReadiness(prisma);
    const first = readiness.check();
    await vi.advanceTimersByTimeAsync(2500);
    expect(await first).toBe(false);
    await vi.advanceTimersByTimeAsync(7500);
    expect(await readiness.check()).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows at most two unsettled flights and frees capacity when one settles', async () => {
    vi.useFakeTimers();
    const { prisma, transaction } = setup();
    let settle!: () => void;
    transaction.mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));
    transaction.mockImplementationOnce(() => new Promise(() => {}));
    const readiness = new HealthReadiness(prisma);
    for (let attempt = 0; attempt < 180; attempt++) {
      const check = readiness.check();
      await vi.advanceTimersByTimeAsync(2500);
      expect(await check).toBe(false);
      await vi.advanceTimersByTimeAsync(7500);
    }
    expect(transaction).toHaveBeenCalledTimes(2);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(await readiness.check()).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('clears response deadline timers when a probe settles early', async () => {
    vi.useFakeTimers();
    const { prisma } = setup();
    expect(await new HealthReadiness(prisma).check()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['ready', 'synthetic'] as const)('returns dependency failure from %s without throwing or Sentry capture', async (method) => {
    const { health, transaction, response } = setup();
    transaction.mockRejectedValue(new Error('secret DB error'));
    await expect(health[method](response)).resolves.toEqual({ status: 'Not ready' });
    expect(response.status).toHaveBeenCalledWith(503);
    expect(captureException).not.toHaveBeenCalled();
    expect(health.check().status).toBe('ok');
  });

  it.each(['public', 'wrong-id', 'missing-public', '401', '404', '500', 'throw'])('refuses Storage %s independently for either bucket', async (failure) => {
    for (const failedBucket of ['evidence', 'import-sources']) {
      const { health, fetch, response } = setup();
      fetch.mockImplementation(async (url: string) => {
        const id = url.split('/').pop();
        if (id !== failedBucket) return new Response(JSON.stringify({ id, public: false }));
        if (failure === 'throw') throw new Error('secret Storage error');
        if (/^\d/.test(failure)) return new Response(JSON.stringify({ id, public: false }), { status: Number(failure) });
        return new Response(JSON.stringify({
          id: failure === 'wrong-id' ? 'foreign-bucket' : id,
          ...(failure === 'missing-public' ? {} : { public: failure === 'public' }),
        }));
      });
      expect(await health.ready(response)).toEqual({ status: 'Not ready' });
      expect(response.status).toHaveBeenCalledWith(503);
    }
  });

  it.each(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])('refuses missing %s before any Storage request', async (key) => {
    const { health, fetch, response } = setup();
    vi.stubEnv(key, '');
    expect(await health.ready(response)).toEqual({ status: 'Not ready' });
    expect(response.status).toHaveBeenCalledWith(503);
    expect(fetch).not.toHaveBeenCalled();
  });
});
