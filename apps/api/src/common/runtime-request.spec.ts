import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Subject } from 'rxjs';
import { RuntimeAuthGuard, RuntimeRequestInterceptor } from './runtime-request';
import { CapacityError, RuntimeLimits } from './runtime-limits';

const policies: RuntimeLimits[] = [];
afterEach(() => { policies.splice(0).forEach((p) => p.onApplicationShutdown()); vi.unstubAllEnvs(); });
const policy = () => { const p = new RuntimeLimits(); policies.push(p); return p; };
const request = (path: string, method: string, user = 'a') => {
  const releases: Array<() => void> = [];
  const req = { method, path, user: { id: user }, runtimeLease: { executing: false, releases,
    release: () => releases.splice(0).forEach((release) => release()) } };
  const res = { setHeader: vi.fn(), destroyed: false, writableEnded: false };
  const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext;
  return { req, res, context };
};
const auth = { canActivate: vi.fn(async () => true) };

describe('verified-user runtime admission', () => {
  it.each([
    ['RATE_READ_PER_MINUTE', 'GET', '/api/v1/records'],
    ['RATE_WRITE_PER_MINUTE', 'POST', '/api/v1/records'],
    ['RATE_IMPORT_PER_MINUTE', 'POST', '/api/v1/bulk-upload/activity-records'],
    ['RATE_SUBMIT_PER_MINUTE', 'POST', '/api/v1/activity-records/bulk-submit'],
    ['RATE_EXPORT_PER_MINUTE', 'GET', '/api/v1/reports/pdf'],
  ])('%s accepts its full budget and refuses the next request independently per verified user', async (key, method, path) => {
    vi.stubEnv(key, '2');
    const guard = new RuntimeAuthGuard(auth as never, policy());
    for (let i = 0; i < 2; i++) {
      const r = request(path, method); expect(await guard.canActivate(r.context)).toBe(true); r.req.runtimeLease.release();
    }
    const extra = request(path, method);
    await expect(guard.canActivate(extra.context)).rejects.toBeInstanceOf(CapacityError);
    expect(extra.res.setHeader).toHaveBeenCalledWith('Retry-After', 60);
    const other = request(path, method, 'b'); expect(await guard.canActivate(other.context)).toBe(true); other.req.runtimeLease.release();
  });
  it('holds global and per-user mutation permits until the work settles, even after client disconnect', async () => {
    const guard = new RuntimeAuthGuard(auth as never, policy());
    const a = request('/api/v1/records', 'POST', 'a');
    const b = request('/api/v1/records', 'POST', 'b');
    expect(await guard.canActivate(a.context)).toBe(true);
    await expect(guard.canActivate(request('/api/v1/records', 'POST', 'a').context)).rejects.toBeInstanceOf(CapacityError);
    expect(await guard.canActivate(b.context)).toBe(true);
    const c = request('/api/v1/records', 'POST', 'c');
    await expect(guard.canActivate(c.context)).rejects.toBeInstanceOf(CapacityError);
    a.res.destroyed = true;
    const work = new Subject();
    new RuntimeRequestInterceptor().intercept(a.context, { handle: () => work }).subscribe();
    await expect(guard.canActivate(c.context)).rejects.toBeInstanceOf(CapacityError);
    work.complete();
    expect(await guard.canActivate(c.context)).toBe(true);
    b.req.runtimeLease.release(); c.req.runtimeLease.release();
  });
  it('honors authentication refusal and maps only pre-work pool exhaustion', async () => {
    const p = policy(); const r = request('/api/v1/records', 'POST');
    expect(await new RuntimeAuthGuard({ canActivate: async () => false } as never, p).canActivate(r.context)).toBe(false);
    await expect(new RuntimeAuthGuard({ canActivate: async () => { throw { code: 'P2024' }; } } as never, p)
      .canActivate(r.context)).rejects.toBeInstanceOf(CapacityError);
    expect(r.req.runtimeLease.releases).toHaveLength(0);
  });
});
