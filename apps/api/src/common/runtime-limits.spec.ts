import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMIT_DEFAULTS, configurePool, readRuntimeConfig } from './runtime-config';
import {
  CapacityError, INVENTORY_DECLARATION_BODY_MAX_BYTES, jsonBodyLimit, routeGroup, RuntimeLimits,
} from './runtime-limits';
import { REPORTING_CONTEXT_API_PATHS } from '@tonyai/shared-types';
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
    // LP3-04 PR C (V7): a capture and one retained dataset take the exports'
    // quota and lease; the list is a read.
    ['POST', '/api/v1/report-datasets', 'EXPORT'], ['POST', '/api/v1/REPORT-DATASETS/', 'EXPORT'],
    ['GET', '/api/v1/report-datasets/0b1d0000-0000-4000-8000-000000000001', 'EXPORT'],
    ['HEAD', '/api/v1/report-datasets/ID/', 'EXPORT'],
    ['GET', '/api/v1/report-datasets?year=2026', 'READ'],
    ['POST', '/api/v1/report-datasets/id', 'WRITE'],
    ['GET', '/api/v1/report-datasets/id/extra', 'READ'],
    // LP3-04 PR D: an issuance renders and stores a PDF; a download re-hashes one.
    ['POST', '/api/v1/report-issuances', 'EXPORT'], ['POST', '/api/v1/Report-Issuances/', 'EXPORT'],
    ['GET', '/api/v1/report-issuances/0b1d0000-0000-4000-8000-000000000001/pdf', 'EXPORT'],
    ['HEAD', '/api/v1/report-issuances/ID/PDF/', 'EXPORT'],
    ['GET', '/api/v1/report-issuances/0b1d0000-0000-4000-8000-000000000001', 'READ'],
    ['GET', '/api/v1/report-issuances?year=2026', 'READ'],
    ['POST', '/api/v1/report-issuances/id/pdf', 'WRITE'],
  ])('groups %s %s', (method, path, group) => expect(routeGroup(method, path)).toBe(group));
  it.each(['GET', 'HEAD'])('classifies every legacy and context export as EXPORT for %s', (method) => {
    for (const path of [REPORTING_CONTEXT_API_PATHS.pdf, REPORTING_CONTEXT_API_PATHS.excel, REPORTING_CONTEXT_API_PATHS.csv,
      '/reports/pdf', '/reports/excel', '/reports/csv']) {
      expect(routeGroup(method, `/api/v1${path}`)).toBe('EXPORT');
      expect(routeGroup(method, `/api/v1${path.toUpperCase()}/?year=2027`)).toBe('EXPORT');
    }
    expect(routeGroup(method, `/api/v1${REPORTING_CONTEXT_API_PATHS.meta}`)).toBe('READ');
  });
  it("caps LP3-04's whole-subsidiary PUT at its own 1 MB, in code — every other route at the global cap", () => {
    expect(INVENTORY_DECLARATION_BODY_MAX_BYTES).toBe(1_048_576);
    const declaration = '/api/v1/inventory-boundaries/0b1d/subsidiaries/5b00';
    for (const path of [declaration, declaration.toUpperCase(), `${declaration}/`, `${declaration}?x=1`]) {
      expect(jsonBodyLimit('PUT', path, 100)).toBe(1_048_576);
    }
    for (const [method, path] of [
      ['POST', declaration], ['DELETE', declaration], ['GET', declaration],
      ['PUT', '/api/v1/inventory-boundaries/0b1d'], ['POST', '/api/v1/inventory-boundaries'],
      ['POST', '/api/v1/inventory-boundaries/0b1d/confirm'], ['PUT', `${declaration}/extra`],
      ['PUT', '/api/v1/inventory-boundaries//subsidiaries/5b00'], ['PUT', `/x${declaration}`],
      ['PUT', '/api/v1/subsidiaries/5b00'],
    ]) {
      expect(jsonBodyLimit(method, path, 100)).toBe(100);
    }
  });
  it('stops new work at the exact monotonic deadline', () => {
    let clock = 10;
    const deadline = new WorkDeadline(60, () => clock);
    clock = 69; expect(deadline.expired).toBe(false);
    clock = 70; expect(deadline.expired).toBe(true);
  });
});
