import { HttpException, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { errorBody } from './api-error';
import { readRuntimeConfig, type RuntimeConfig } from './runtime-config';

export class CapacityError extends HttpException {
  constructor(readonly retryAfter = 1) {
    super(errorBody('rate_limited', 'Request capacity is exhausted. Try again later.'), 429);
  }
}

export type RouteGroup = 'READ' | 'WRITE' | 'IMPORT' | 'EXPORT' | 'SUBMIT';
export const routeGroup = (method: string, path: string): RouteGroup => {
  const route = path.split('?')[0].toLowerCase().replace(/\/+$/, '');
  if (method === 'POST' && route === '/api/v1/bulk-upload/activity-records') return 'IMPORT';
  if (method === 'POST' && (route === '/api/v1/activity-records/bulk-submit'
    || /^\/api\/v1\/import-batches\/[^/]+\/submit$/.test(route))) return 'SUBMIT';
  if (['GET', 'HEAD'].includes(method) && /^\/api\/v1\/reports\/(pdf|excel|csv)$/.test(route)) return 'EXPORT';
  return ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'READ' : 'WRITE';
};

@Injectable()
export class RuntimeLimits implements OnApplicationShutdown {
  stopping = false;
  readonly config: RuntimeConfig;
  private readonly rates = new ThrottlerStorageService();
  private readonly active = new Map<string, number>();
  constructor() { this.config = readRuntimeConfig(); }

  async quota(key: string, limit: number): Promise<void> {
    // The public storage accessor is used only for admission, never to mutate
    // library counters/timers. A full map cannot evict a still-limited caller.
    if (!this.rates.storage.has(key) && this.rates.storage.size >= this.config.RATE_MAX_KEYS) {
      throw new CapacityError(60);
    }
    const result = await this.rates.increment(key, 60_000, limit, 60_000, 'runtime');
    if (result.isBlocked) throw new CapacityError(Math.max(1, result.timeToBlockExpire));
  }

  acquire(key: string, maximum: number): () => void {
    const count = this.active.get(key) ?? 0;
    if (count >= maximum) throw new CapacityError();
    this.active.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.active.get(key) ?? 1) - 1;
      if (next) this.active.set(key, next); else this.active.delete(key);
    };
  }

  async settle(): Promise<void> {
    this.stopping = true;
    const until = Date.now() + this.config.SHUTDOWN_GRACE_MS - 5_000;
    while (this.active.size && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  onApplicationShutdown(): void { this.rates.onApplicationShutdown(); }
}
