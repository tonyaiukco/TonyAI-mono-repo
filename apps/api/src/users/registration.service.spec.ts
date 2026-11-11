import { afterEach, describe, expect, it, vi } from 'vitest';
import { REGISTRATION_CONSENT_VERSION, type RegistrationRequest } from '@tonyai/shared-types';
import { EmailUnavailableError } from '../auth/access-errors';
import { RuntimeLimits } from '../common/runtime-limits';
import { readRegistrationConfig } from './registration-config';
import {
  REGISTRATION_COOLDOWN_SECONDS,
  REGISTRATION_MAX_DELIVERIES,
  REGISTRATION_QUEUE_MAX,
  REGISTRATION_WORKERS,
  RegistrationService,
} from './registration.service';

const CODE = 'aB3x9';
const CONFIG = readRegistrationConfig({ REGISTRATION_CODE: CODE, REGISTRATION_ALLOW_PLACEHOLDER_CONSENT: 'true' } as NodeJS.ProcessEnv);
const REQUEST: RegistrationRequest = {
  firstName: 'Ada',
  lastName: 'Yilmaz',
  companyName: 'Example Holding',
  jobTitle: 'Sustainability Manager',
  email: 'Ada@Example.test',
  registrationCode: CODE,
  consent: true,
  consentVersion: REGISTRATION_CONSENT_VERSION,
  language: 'tr',
};
const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(options: { config?: typeof CONFIG; existing?: { id: string } | null } = {}) {
  const limits = new RuntimeLimits();
  const prisma = { profile: { findUnique: vi.fn(async () => options.existing ?? null) } };
  const access = {
    registerOrganisation: vi.fn(async () => ({ organisationId: 'org', profileId: 'new-profile' })),
    reopenRegistration: vi.fn(async () => true),
  };
  const delivery = { deliver: vi.fn(async () => ({ delivered: true }) as unknown) };
  const service = new RegistrationService(
    prisma as never,
    access as never,
    delivery as never,
    limits,
    options.config === undefined ? CONFIG : options.config,
  );
  return { limits, prisma, access, delivery, service };
}

describe('RegistrationService — the registration code is the switch', () => {
  it('answers 404 to the status and to a submission while no code is configured, and spends no quota', async () => {
    const { service, limits, access } = setup({ config: null });
    const quota = vi.spyOn(limits, 'quota');
    expect(service.enabled).toBe(false);
    expect(() => service.status()).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'registration_unavailable' }) }));
    await expect(service.request('203.0.113.7', REQUEST)).rejects.toMatchObject({ status: 404 });
    expect(quota).not.toHaveBeenCalled();
    expect(access.registerOrganisation).not.toHaveBeenCalled();
    limits.onApplicationShutdown();
  });

  it('names the notice version while enabled', () => {
    const { service, limits } = setup();
    expect(service.status()).toEqual({ consentVersion: REGISTRATION_CONSENT_VERSION, consentIsPlaceholder: true });
    limits.onApplicationShutdown();
  });
});

describe('RegistrationService.request — admission', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['AB3X9', 'aB3x', '', 'zzzzz'])('refuses the wrong code %j in words, after spending the quota, and queues nothing', async (registrationCode) => {
    const { service, limits } = setup();
    const quota = vi.spyOn(limits, 'quota');
    const run = vi.spyOn(service, 'run');
    await expect(service.request('203.0.113.7', { ...REQUEST, registrationCode })).rejects.toMatchObject({
      status: 403,
      response: { code: 'registration_code_invalid' },
    });
    expect(quota).toHaveBeenCalledWith('auth-email:ip:203.0.113.7', 5);
    await immediate();
    expect(run).not.toHaveBeenCalled();
    limits.onApplicationShutdown();
  });

  it('logs a wrong code with a running count and never the code that was tried', async () => {
    const { service, limits } = setup();
    const lines: string[] = [];
    vi.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation((m) => void lines.push(m));
    await expect(service.request('203.0.113.7', { ...REQUEST, registrationCode: 'Guess' })).rejects.toBeDefined();
    await expect(service.request('203.0.113.8', { ...REQUEST, registrationCode: 'Gues2' })).rejects.toBeDefined();
    expect(lines).toEqual(['Registration refused: wrong code (1 since start)', 'Registration refused: wrong code (2 since start)']);
    limits.onApplicationShutdown();
  });

  it('answers 429 past the client address quota — wrong codes spend it, so a right code is refused too', async () => {
    const { service, limits } = setup();
    const run = vi.spyOn(service, 'run').mockResolvedValue('skipped');
    for (let i = 0; i < 5; i += 1) {
      await expect(service.request('203.0.113.9', { ...REQUEST, registrationCode: 'wrong' })).rejects.toMatchObject({ status: 403 });
    }
    await expect(service.request('203.0.113.9', REQUEST)).rejects.toMatchObject({ status: 429 });
    await immediate();
    expect(run).not.toHaveBeenCalled();
    limits.onApplicationShutdown();
  });

  it('returns before the work runs, and hands the job on without the code', async () => {
    const { service, limits } = setup();
    const order: string[] = [];
    const run = vi.spyOn(service, 'run').mockImplementation(async () => { order.push('run'); return 'sent'; });
    await service.request('203.0.113.7', REQUEST);
    order.push('returned');
    await immediate();
    await immediate();
    expect(order).toEqual(['returned', 'run']);
    expect(run.mock.calls[0][0]).not.toHaveProperty('registrationCode');
    expect(JSON.stringify(run.mock.calls[0][0])).not.toContain(CODE);
    await limits.settle();
    limits.onApplicationShutdown();
  });

  it('gives a new and a known address the same answer', async () => {
    const fresh = setup({ existing: null });
    const known = setup({ existing: { id: 'p' } });
    const a = await fresh.service.request('203.0.113.7', REQUEST);
    const b = await known.service.request('203.0.113.7', REQUEST);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    for (const s of [fresh, known]) { await s.limits.settle(); s.limits.onApplicationShutdown(); }
  });

  it('drops a request past the full queue without an error, and runs no more than its workers at once', async () => {
    const { service, limits } = setup();
    const holds: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const run = vi.spyOn(service, 'run').mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => holds.push(resolve));
      running -= 1;
      return 'sent';
    });
    vi.spyOn(limits, 'quota').mockResolvedValue(undefined as never);
    const total = REGISTRATION_WORKERS + REGISTRATION_QUEUE_MAX;
    for (let i = 0; i < REGISTRATION_WORKERS; i += 1) await service.request(`198.51.100.${i}`, REQUEST);
    await immediate(); // the workers each hold one job
    for (let i = REGISTRATION_WORKERS; i < total; i += 1) await service.request('198.51.100.200', REQUEST);
    // The queue is full: one more is accepted and dropped.
    await expect(service.request('198.51.100.201', REQUEST)).resolves.toBeUndefined();
    while (run.mock.calls.length < total || running > 0) {
      holds.splice(0).forEach((release) => release());
      await immediate();
    }
    expect(run).toHaveBeenCalledTimes(total);
    expect(peak).toBe(REGISTRATION_WORKERS);
    await limits.settle();
    limits.onApplicationShutdown();
  });
});

describe('RegistrationService.run — the three kinds of address', () => {
  const { registrationCode: _code, consent: _consent, ...JOB } = REQUEST;

  it('a new address: creates the rows from the form, then delivers', async () => {
    const { service, access, delivery, prisma, limits } = setup({ existing: null });
    await expect(service.run({ ...JOB, firstName: ' Ada ', lastName: ' Yilmaz ' })).resolves.toBe('sent');
    expect(prisma.profile.findUnique).toHaveBeenCalledWith({ where: { email: 'ada@example.test' }, select: { id: true } });
    expect(access.registerOrganisation).toHaveBeenCalledWith({
      email: 'ada@example.test',
      fullName: 'Ada Yilmaz',
      jobTitle: 'Sustainability Manager',
      companyName: 'Example Holding',
      language: 'tr',
      consentVersion: REGISTRATION_CONSENT_VERSION,
    });
    expect(delivery.deliver).toHaveBeenCalledWith(prisma, 'new-profile');
    expect(access.reopenRegistration).not.toHaveBeenCalled();
    limits.onApplicationShutdown();
  });

  it('a known address whose invitation re-opens: no second organisation, that invitation again', async () => {
    const { service, access, delivery, prisma, limits } = setup({ existing: { id: 'p' } });
    await expect(service.run(JOB)).resolves.toBe('sent');
    expect(access.reopenRegistration).toHaveBeenCalledWith('p', REGISTRATION_COOLDOWN_SECONDS, REGISTRATION_MAX_DELIVERIES);
    expect(REGISTRATION_COOLDOWN_SECONDS).toBe(300);
    expect(REGISTRATION_MAX_DELIVERIES).toBe(5);
    expect(access.registerOrganisation).not.toHaveBeenCalled();
    expect(delivery.deliver).toHaveBeenCalledWith(prisma, 'p');
    limits.onApplicationShutdown();
  });

  it('a known address with nothing to re-open (active, disabled, invited, cooling down): nothing is written or sent', async () => {
    const { service, access, delivery, limits } = setup({ existing: { id: 'p' } });
    access.reopenRegistration.mockResolvedValue(false);
    await expect(service.run(JOB)).resolves.toBe('skipped');
    expect(access.registerOrganisation).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
    limits.onApplicationShutdown();
  });

  it('two submissions of one new address at once: the loser sends nothing', async () => {
    const { service, access, delivery, limits } = setup({ existing: null });
    access.registerOrganisation.mockRejectedValue(new EmailUnavailableError());
    await expect(service.run(JOB)).resolves.toBe('skipped');
    expect(delivery.deliver).not.toHaveBeenCalled();
    limits.onApplicationShutdown();
  });

  it('reports a delivery that stopped as failed, the rows left in place', async () => {
    const { service, delivery, limits } = setup({ existing: null });
    delivery.deliver.mockResolvedValue({ delivered: false, step: 'email', code: 'smtp_failed' });
    await expect(service.run(JOB)).resolves.toBe('failed');
    limits.onApplicationShutdown();
  });

  it('any other failure of the write is not swallowed as a duplicate', async () => {
    const { service, access, limits } = setup({ existing: null });
    access.registerOrganisation.mockRejectedValue(new Error('database down'));
    await expect(service.run(JOB)).rejects.toThrow('database down');
    limits.onApplicationShutdown();
  });
});
