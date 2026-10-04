import { afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  httpIntegration: vi.fn(() => ({ name: 'Http' })),
  requestDataIntegration: vi.fn(() => ({ name: 'RequestData' })),
  captureException: vi.fn(),
  withScope: vi.fn((callback) => callback({ setTag: vi.fn(), setUser: vi.fn() })),
}));
vi.mock('@sentry/nestjs', () => sdk);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

describe('Sentry privacy and reporting', () => {
  it('does not initialise or report without an opt-in DSN', async () => {
    vi.stubEnv('SENTRY_DSN', '');
    const sentry = await import('./sentry');
    await sentry.initSentry();
    sentry.captureException(new Error('synthetic'));
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it('drops fetch/HTTP breadcrumbs before a later error can carry Storage keys or tokens', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://synthetic@example.invalid/1');
    const sentry = await import('./sentry');
    await sentry.initSentry();
    const options = sdk.init.mock.calls[0][0];
    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
    expect(options.beforeSendTransaction({ spans: [{ data: { 'http.url': 'secret' } }] })).toBeNull();
    expect(sdk.httpIntegration).toHaveBeenCalledWith({ maxIncomingRequestBodySize: 'none' });
    expect(options.beforeSend({ request: { method: 'POST', url: '/upload?secret=1', data: 'private', headers: { authorization: 'secret' } }, tags: { path: '/upload?secret=1' } })).toEqual({
      request: { method: 'POST', url: '/upload' }, tags: { path: '/upload' },
    });
    for (const path of ['object/evidence/tenant/private-invoice.pdf', 'object/sign/evidence/file?token=secret']) {
      for (const classification of [{ type: 'http' }, { category: 'http' }, { category: 'fetch' }]) {
        expect(options.beforeBreadcrumb({
          ...classification,
          data: { url: `https://project.supabase.co/storage/v1/${path}` },
          message: path,
        })).toBeNull();
      }
    }
    const safe = { category: 'operational', message: 'synthetic check' };
    expect(options.beforeBreadcrumb(safe)).toEqual(safe);
    const error = new Error('LP2-03 synthetic error');
    sentry.captureException(error, { requestId: 'synthetic-check' });
    expect(sdk.captureException).toHaveBeenCalledWith(error);
    expect(sentry.isSentryEnabled()).toBe(true);
  });
});
