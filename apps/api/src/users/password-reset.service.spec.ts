import { afterEach, describe, expect, it, vi } from 'vitest';
import { PasswordResetService, readResetPerIpLimit } from './password-reset.service';

describe('readResetPerIpLimit (decision S6)', () => {
  it('defaults to 5 a minute and refuses anything but a whole number in range', () => {
    expect(readResetPerIpLimit({} as NodeJS.ProcessEnv)).toBe(5);
    expect(readResetPerIpLimit({ AUTH_EMAIL_PER_IP_PER_MINUTE: '20' } as NodeJS.ProcessEnv)).toBe(20);
    for (const bad of ['0', '-1', '1.5', 'many', '10001']) {
      expect(() => readResetPerIpLimit({ AUTH_EMAIL_PER_IP_PER_MINUTE: bad } as NodeJS.ProcessEnv)).toThrow();
    }
  });
});

describe('PasswordResetService.request — the answer leaves before the work', () => {
  afterEach(() => vi.restoreAllMocks());

  it('takes the per-address quota, then schedules the job after returning, released when done', async () => {
    const order: string[] = [];
    const release = vi.fn(() => order.push('release'));
    const limits = {
      quota: vi.fn(async () => { order.push('quota'); }),
      acquire: vi.fn(() => release),
    };
    const service = new PasswordResetService({} as never, {} as never, {} as never, {} as never, { get: () => limits } as never);
    service.onModuleInit();
    vi.spyOn(service, 'run').mockImplementation(async () => { order.push('run'); return 'skipped'; });
    await service.request('203.0.113.7', 'a@b.test');
    order.push('returned');
    expect(limits.quota).toHaveBeenCalledWith('auth-email:ip:203.0.113.7', 5);
    expect(limits.acquire).toHaveBeenCalledWith('auth-email:jobs', expect.any(Number));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['quota', 'returned', 'run', 'release']);
  });

  it('refuses past the quota without scheduling anything', async () => {
    const limits = { quota: vi.fn(async () => { throw Object.assign(new Error('429'), { status: 429 }); }), acquire: vi.fn() };
    const service = new PasswordResetService({} as never, {} as never, {} as never, {} as never, { get: () => limits } as never);
    service.onModuleInit();
    await expect(service.request('203.0.113.7', 'a@b.test')).rejects.toMatchObject({ status: 429 });
    expect(limits.acquire).not.toHaveBeenCalled();
  });
});
