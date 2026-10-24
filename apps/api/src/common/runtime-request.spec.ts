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
    ['RATE_READ_PER_MINUTE', 'POST', '/api/v1/calculations/preview'],
    ['RATE_IMPORT_PER_MINUTE', 'POST', '/api/v1/bulk-upload/activity-records'],
    ['RATE_SUBMIT_PER_MINUTE', 'POST', '/api/v1/activity-records/bulk-submit'],
    ['RATE_EXPORT_PER_MINUTE', 'GET', '/api/v1/reports/pdf'],
    ['RATE_EXPORT_PER_MINUTE', 'GET', '/api/v1/reports/context/pdf'],
    ['RATE_EXPORT_PER_MINUTE', 'HEAD', '/api/v1/reports/context/excel'],
    ['RATE_EXPORT_PER_MINUTE', 'GET', '/api/v1/reports/context/csv'],
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
  it('shares one export quota across alternating context and legacy paths for the same user', async () => {
    vi.stubEnv('RATE_EXPORT_PER_MINUTE', '2');
    const guard = new RuntimeAuthGuard(auth as never, policy());
    for (const path of ['/api/v1/reports/context/csv', '/api/v1/reports/pdf']) {
      const admitted = request(path, 'GET', 'same-user');
      expect(await guard.canActivate(admitted.context)).toBe(true);
      admitted.req.runtimeLease.release();
    }
    const third = request('/api/v1/reports/context/excel', 'GET', 'same-user');
    await expect(guard.canActivate(third.context)).rejects.toBeInstanceOf(CapacityError);
    expect(third.res.setHeader).toHaveBeenCalledWith('Retry-After', 60);
  });
  it('admits one live report preview per user, another user\'s beside it, apart from the exports (LP4-03)', async () => {
    vi.stubEnv('REPORT_CONCURRENCY', '1');
    const guard = new RuntimeAuthGuard(auth as never, policy());
    const first = request('/api/v1/reports/context/meta', 'GET', 'a');
    expect(await guard.canActivate(first.context)).toBe(true);
    // The same user's second preview, context or legacy, waits for the first.
    const again = request('/api/v1/reports/meta', 'GET', 'a');
    await expect(guard.canActivate(again.context)).rejects.toBeInstanceOf(CapacityError);
    expect(again.res.setHeader).toHaveBeenCalledWith('Retry-After', 1);
    // Another user's preview is not refused by the first user's.
    const other = request('/api/v1/reports/context/meta/', 'GET', 'b');
    expect(await guard.canActivate(other.context)).toBe(true);
    other.req.runtimeLease.release();
    // The exports' lease is not the previews': an export runs beside a preview.
    const exporting = request('/api/v1/reports/context/csv', 'GET', 'b');
    expect(await guard.canActivate(exporting.context)).toBe(true);
    exporting.req.runtimeLease.release();
    // An ordinary read takes no preview permit.
    const read = request('/api/v1/emissions/context/summary', 'GET', 'a');
    expect(await guard.canActivate(read.context)).toBe(true);
    read.req.runtimeLease.release();
    first.req.runtimeLease.release();
    const after = request('/api/v1/reports/meta', 'GET', 'a');
    expect(await guard.canActivate(after.context)).toBe(true);
    after.req.runtimeLease.release();
  });

  it('shares the reports concurrency lease across legacy and context exports', async () => {
    vi.stubEnv('REPORT_CONCURRENCY', '1');
    const guard = new RuntimeAuthGuard(auth as never, policy());
    const first = request('/api/v1/reports/context/csv', 'GET', 'a');
    expect(await guard.canActivate(first.context)).toBe(true);
    await expect(guard.canActivate(request('/api/v1/reports/pdf', 'GET', 'b').context)).rejects.toBeInstanceOf(CapacityError);
    first.req.runtimeLease.release();
    const next = request('/api/v1/reports/context/excel', 'GET', 'b');
    expect(await guard.canActivate(next.context)).toBe(true);
    next.req.runtimeLease.release();
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
  it("admits Data Entry's live preview without a mutation permit, so it never refuses the user's own submit", async () => {
    const guard = new RuntimeAuthGuard(auth as never, policy());
    // The debounced preview is still running when Submit is pressed (nightly
    // e2e, 2026-10-22: the submit was refused 429 instead of its evidence gate).
    const previews = ['a', 'b', 'c'].map((user) => request('/api/v1/calculations/preview', 'POST', user));
    for (const preview of previews) expect(await guard.canActivate(preview.context)).toBe(true);
    const submit = request('/api/v1/activity-records/id/submit', 'POST', 'a');
    expect(await guard.canActivate(submit.context)).toBe(true);
    const other = request('/api/v1/records', 'POST', 'b');
    expect(await guard.canActivate(other.context)).toBe(true);
    // Writes still hold their permits: a third user's write beyond the API-wide
    // two is refused, while a GET export (no mutation) is not …
    await expect(guard.canActivate(request('/api/v1/records', 'POST', 'c').context)).rejects.toBeInstanceOf(CapacityError);
    const exported = request('/api/v1/reports/pdf', 'GET', 'c');
    expect(await guard.canActivate(exported.context)).toBe(true);
    // … and with an API-wide permit free again, the same user's next write
    // still meets their own one — a preview does not.
    other.req.runtimeLease.release();
    await expect(guard.canActivate(request('/api/v1/records', 'PATCH', 'a').context)).rejects.toBeInstanceOf(CapacityError);
    const during = request('/api/v1/calculations/preview', 'POST', 'a');
    expect(await guard.canActivate(during.context)).toBe(true);
    [...previews, submit, exported, during].forEach((r) => r.req.runtimeLease.release());
  });
  it('spends a preview from the READ budget, never the WRITE budget a save or submit needs', async () => {
    vi.stubEnv('RATE_WRITE_PER_MINUTE', '1');
    const guard = new RuntimeAuthGuard(auth as never, policy());
    for (let i = 0; i < 3; i++) {
      const preview = request('/api/v1/calculations/preview', 'POST');
      expect(await guard.canActivate(preview.context)).toBe(true); preview.req.runtimeLease.release();
    }
    const save = request('/api/v1/records', 'POST');
    expect(await guard.canActivate(save.context)).toBe(true); save.req.runtimeLease.release();
    await expect(guard.canActivate(request('/api/v1/records', 'POST').context)).rejects.toBeInstanceOf(CapacityError);
  });
  it('honors authentication refusal and maps only pre-work pool exhaustion', async () => {
    const p = policy(); const r = request('/api/v1/records', 'POST');
    expect(await new RuntimeAuthGuard({ canActivate: async () => false } as never, p).canActivate(r.context)).toBe(false);
    await expect(new RuntimeAuthGuard({ canActivate: async () => { throw { code: 'P2024' }; } } as never, p)
      .canActivate(r.context)).rejects.toBeInstanceOf(CapacityError);
    expect(r.req.runtimeLease.releases).toHaveLength(0);
  });
});
