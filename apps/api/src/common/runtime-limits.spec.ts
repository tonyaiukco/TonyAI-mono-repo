import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMIT_DEFAULTS, configurePool, readRuntimeConfig } from './runtime-config';
import { CapacityError, routeGroup, RuntimeLimits } from './runtime-limits';
import { WorkDeadline } from './work-deadline';

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('runtime configuration', () => {
  it.each(Object.keys(LIMIT_DEFAULTS))('validates %s rather than silently coercing it', (key) => {
    for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '1e2', ' 5', '2147483648']) {
      expect(() => readRuntimeConfig({ [key]: value })).toThrow();
    }
    expect(readRuntimeConfig({})[key]).toBe(LIMIT_DEFAULTS[key]);
  });
  it('rejects incompatible budgets and proxy trust', () => {
    for (const env of [
      { HTTP_HEADERS_TIMEOUT_MS: '30001' }, { MUTATION_CONCURRENCY: '5' },
      { MUTATION_USER_CONCURRENCY: '3' }, { REPORT_CONCURRENCY: '4' },
      { PROXY_MODE: 'true' }, { PROXY_MODE: 'azure' }, { PROXY_MODE: 'cidr' },
      { PROXY_MODE: 'cidr', TRUSTED_PROXY_CIDRS: '0.0.0.0/0' },
    ]) expect(() => readRuntimeConfig(env)).toThrow();
  });
  it('accepts the inclusive integer ceiling and enforces upload/grace compatibility', () => {
    expect(readRuntimeConfig({ RATE_MAX_KEYS: '2147483647' }).RATE_MAX_KEYS).toBe(2147483647);
    expect(readRuntimeConfig({ SHUTDOWN_GRACE_MS: '110000' }).SHUTDOWN_GRACE_MS).toBe(110000);
    for (const env of [{ SHUTDOWN_GRACE_MS: '109999' }, { SHUTDOWN_GRACE_MS: '3600001' }, { UPLOAD_USER_CONCURRENCY: '3' }]) {
      expect(() => readRuntimeConfig(env)).toThrow();
    }
  });
  it('sets a bounded pool and refuses conflicting/duplicate URL parameters without leaking credentials', () => {
    const config = readRuntimeConfig({});
    const env = { DATABASE_URL: 'postgresql://runtime:private@db/database' };
    configurePool(config, env);
    const url = new URL(env.DATABASE_URL);
    expect(url.searchParams.get('connection_limit')).toBe('5');
    expect(url.searchParams.get('pool_timeout')).toBe('5');
    const legacy = { DATABASE_URL: 'postgresql://runtime:private@db/database?connection_limit=9&pool_timeout=8&sslmode=require' };
    configurePool(config, legacy);
    expect(new URL(legacy.DATABASE_URL).searchParams.get('connection_limit')).toBe('5');
    expect(new URL(legacy.DATABASE_URL).searchParams.get('pool_timeout')).toBe('5');
    expect(new URL(legacy.DATABASE_URL).searchParams.get('sslmode')).toBe('require');
    for (const query of ['connection_limit=0', 'pool_timeout=0', 'connection_limit=5&connection_limit=5']) {
      expect(() => configurePool(config, { DATABASE_URL: `${env.DATABASE_URL.split('?')[0]}?${query}` })).toThrow(/conflicts/);
    }
  });
});

describe('bounded admission', () => {
  it('admits exactly the concurrency limit; release is idempotent and permits are independent', () => {
    const limits = new RuntimeLimits();
    const release = limits.acquire('pdf', 1);
    expect(() => limits.acquire('pdf', 1)).toThrow(CapacityError);
    const importRelease = limits.acquire('import', 1);
    release(); release();
    const next = limits.acquire('pdf', 1);
    expect(() => limits.acquire('pdf', 1)).toThrow(CapacityError);
    next(); importRelease(); limits.onApplicationShutdown();
  });
  it('uses the full minute, isolates users, and refuses new keys at storage capacity', async () => {
    vi.useFakeTimers();
    vi.stubEnv('RATE_MAX_KEYS', '2');
    const limits = new RuntimeLimits();
    try {
      await limits.quota('user:a', 2); await limits.quota('user:a', 2);
      await expect(limits.quota('user:a', 2)).rejects.toMatchObject({ retryAfter: 60 });
      await limits.quota('user:b', 2);
      await expect(limits.quota('user:c', 2)).rejects.toBeInstanceOf(CapacityError);
      vi.advanceTimersByTime(59_000);
      await expect(limits.quota('user:a', 2)).rejects.toBeInstanceOf(CapacityError);
      vi.advanceTimersByTime(2_000);
      await expect(limits.quota('user:a', 2)).resolves.toBeUndefined();
    } finally { limits.onApplicationShutdown(); }
  });
  it.each([
    ['GET', '/api/v1/reports/pdf', 'EXPORT'], ['HEAD', '/api/v1/REPORTS/pdf/', 'EXPORT'],
    ['POST', '/api/v1/BULK-UPLOAD/activity-records', 'IMPORT'],
    ['POST', '/api/v1/import-batches/id/submit', 'SUBMIT'],
    ['POST', '/api/v1/activity-records/bulk-submit', 'SUBMIT'],
    ['POST', '/api/v1/activity-records/id/submit', 'WRITE'],
    ['GET', '/api/v1/reports/meta', 'READ'],
  ])('groups %s %s', (method, path, group) => expect(routeGroup(method, path)).toBe(group));
  it('stops new work at the exact monotonic deadline', () => {
    let clock = 10;
    const deadline = new WorkDeadline(60, () => clock);
    clock = 69; expect(deadline.expired).toBe(false);
    clock = 70; expect(deadline.expired).toBe(true);
  });
});
