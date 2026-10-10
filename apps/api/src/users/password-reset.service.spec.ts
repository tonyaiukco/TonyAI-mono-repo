import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeLimits } from '../common/runtime-limits';
import { PasswordResetService, readResetPerIpLimit, RESET_QUEUE_MAX, RESET_WORKERS } from './password-reset.service';

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

  it('takes the per-address quota, then runs the job after returning, its worker released when done', async () => {
    const order: string[] = [];
    const limits = new RuntimeLimits();
    const quota = vi.spyOn(limits, 'quota');
    const service = new PasswordResetService({} as never, {} as never, {} as never, {} as never, { get: () => limits } as never);
    service.onModuleInit();
    vi.spyOn(service, 'run').mockImplementation(async () => { order.push('run'); return 'skipped'; });
    await service.request('203.0.113.7', 'a@b.test');
    order.push('returned');
    expect(quota).toHaveBeenCalledWith('auth-email:ip:203.0.113.7', 5);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['returned', 'run']);
    await limits.settle(); // nothing left holding a worker
    limits.onApplicationShutdown();
  });

  it('refuses past the quota without queueing anything', async () => {
    const limits = { quota: vi.fn(async () => { throw Object.assign(new Error('429'), { status: 429 }); }), acquire: vi.fn() };
    const service = new PasswordResetService({} as never, {} as never, {} as never, {} as never, { get: () => limits } as never);
    service.onModuleInit();
    const run = vi.spyOn(service, 'run');
    await expect(service.request('203.0.113.7', 'a@b.test')).rejects.toMatchObject({ status: 429 });
    expect(limits.acquire).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

/**
 * Codex review, finding 4 (its paired regression, adapted): with every worker
 * held by eligible accounts' slow deliveries, an eligible target and an
 * unknown one must leave the next request's answer the same — capacity never
 * shows in a status. Distinct client addresses, so the IP quota is not what
 * differs.
 */
describe('PasswordResetService — capacity is not an oracle', () => {
  const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));

  async function scenario(targetExists: boolean) {
    const limits = new RuntimeLimits();
    const holds: (() => void)[] = [];
    const sends: string[] = [];
    const target = 'target@example.test';
    const known = new Set(Array.from({ length: RESET_WORKERS + 25 }, (_, i) => `background-${i}@example.test`));
    if (targetExists) known.add(target);
    const claimed = new Set<string>();
    const prisma = {
      profile: { findFirst: async ({ where }: { where: { email: string } }) => (known.has(where.email)
        ? { id: where.email, email: where.email, fullName: 'Fixture', language: 'en', organisationId: 'org' } : null) },
      $transaction: async (run: (tx: unknown) => unknown) => run({
        $executeRaw: async (_s: unknown, id: string) => (claimed.has(id) ? 0 : (claimed.add(id), 1)),
      }),
    };
    const mail = {
      config: {},
      confirmLink: () => 'https://example.test/auth/confirm',
      send: async (email: string) => { sends.push(email); await new Promise<void>((r) => holds.push(r)); return { ok: true }; },
    };
    const service = new PasswordResetService(
      prisma as never, { recoveryToken: async () => 'token' } as never, mail as never,
      { recordSystem: async () => undefined } as never, { get: () => limits } as never,
    );
    service.onModuleInit();
    const status = async (ip: string, email: string) => service.request(ip, email).then(() => 202, (e: { getStatus(): number }) => e.getStatus());
    try {
      for (let i = 0; i < RESET_WORKERS + 25; i++) {
        expect(await status(`203.0.113.${i + 1}`, `background-${i}@example.test`)).toBe(202);
        await immediate();
      }
      const targetStatus = await status('198.51.100.1', target);
      await immediate();
      await immediate();
      const probeStatus = await status('198.51.100.2', 'probe-does-not-exist@example.test');
      return { targetStatus, probeStatus, held: sends.length };
    } finally {
      holds.forEach((release) => release());
      for (let i = 0; i < 200 && holds.length < sends.length; i++) await immediate();
      holds.forEach((release) => release());
      limits.onApplicationShutdown();
    }
  }

  it('an eligible and an unknown target leave the next answer identical, all workers busy', async () => {
    const unknown = await scenario(false);
    const known = await scenario(true);
    expect(unknown).toEqual({ targetStatus: 202, probeStatus: 202, held: RESET_WORKERS });
    expect(known).toEqual({ targetStatus: 202, probeStatus: 202, held: RESET_WORKERS });
  });

  it('a request accepted while the last workers finish still runs — no later request needed (Codex re-review, finding 3)', async () => {
    for (let offset = 0; offset < 10; offset++) {
      const limits = new RuntimeLimits();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const lookups: string[] = [];
      const prisma = {
        profile: {
          findFirst: async ({ where }: { where: { email: string } }) => {
            lookups.push(where.email);
            if (where.email !== 'late@x.test') await held;
            return null;
          },
        },
      };
      const service = new PasswordResetService(prisma as never, {} as never, { config: {} } as never, {} as never, { get: () => limits } as never);
      service.onModuleInit();
      for (let i = 0; i < RESET_WORKERS; i++) {
        await service.request(`203.0.113.${i + 1}`, `bg${i}@x.test`);
        await immediate();
      }
      release(); // the four lookups finish together…
      for (let i = 0; i < offset; i++) await Promise.resolve();
      await service.request('198.51.100.9', 'late@x.test'); // …and this one arrives as their workers wind down
      for (let i = 0; i < 10; i++) await immediate();
      expect(lookups, `offset ${offset}`).toContain('late@x.test');
      await limits.settle();
      limits.onApplicationShutdown();
    }
  });

  it('a shutdown drops what is still queued and starts no worker for it', async () => {
    const limits = new RuntimeLimits();
    const service = new PasswordResetService({} as never, {} as never, {} as never, {} as never, { get: () => limits } as never);
    service.onModuleInit();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const run = vi.spyOn(service, 'run').mockImplementation(async () => { await held; return 'skipped'; });
    for (let i = 0; i < RESET_WORKERS + 10; i++) {
      await service.request(`10.1.0.${i}`, `s${i}@x.test`);
      await immediate();
    }
    expect(run).toHaveBeenCalledTimes(RESET_WORKERS);
    const settling = limits.settle(); // stopping: the running jobs finish, the queued ten are dropped
    release();
    await settling;
    for (let i = 0; i < 20; i++) await immediate();
    expect(run).toHaveBeenCalledTimes(RESET_WORKERS);
    limits.onApplicationShutdown();
  });

  it('a full queue drops the request — still 202, and nothing runs for it', async () => {
    const limits = new RuntimeLimits();
    const service = new PasswordResetService({} as never, {} as never, {} as never, {} as never, { get: () => limits } as never);
    service.onModuleInit();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const run = vi.spyOn(service, 'run').mockImplementation(async () => { await held; return 'skipped'; });
    for (let i = 0; i < RESET_WORKERS + RESET_QUEUE_MAX; i++) {
      await service.request(`10.0.${Math.floor(i / 250)}.${i % 250}`, `q${i}@x.test`);
      if (i < RESET_WORKERS) await new Promise((r) => setImmediate(r));
    }
    await expect(service.request('192.0.2.1', 'dropped@x.test')).resolves.toBeUndefined();
    release();
    // Let the workers drain everything they hold (settle() would stop them early
    // and hide a queue that admitted the extra request).
    const admitted = RESET_WORKERS + RESET_QUEUE_MAX;
    for (let i = 0; i < 20_000 && run.mock.calls.length < admitted; i++) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(run).toHaveBeenCalledTimes(admitted);
    expect(run.mock.calls.map(([e]) => e)).not.toContain('dropped@x.test');
    await limits.settle();
    limits.onApplicationShutdown();
  });
});
