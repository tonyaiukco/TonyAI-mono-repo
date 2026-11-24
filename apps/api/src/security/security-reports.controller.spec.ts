import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Controller, Get, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from '../app-setup';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { CSP_REPORT_BODY_MAX_BYTES, CSP_REPORT_PER_IP_PER_MINUTE, RuntimeLimits } from '../common/runtime-limits';
import type { JsonLogger } from '../observability/json-logger';
import { SecurityReportsController } from './security-reports.controller';

/**
 * The receiver behind the real HTTP protections (`runtime-http.ts`), with no
 * database: what a browser, or anyone, can make it do (pre-g5-security-hardening).
 */
const apps: NestExpressApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Another route, to show what a flood of reports leaves alone. */
@Controller()
class OtherRoute {
  @Get('other') other() { return { ok: true }; }
}

const boot = async (env: NodeJS.ProcessEnv = {}) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const limits = new RuntimeLimits();
  @Module({ controllers: [SecurityReportsController, OtherRoute] })
  class ReceiverModule {}
  const app = await NestFactory.create<NestExpressApplication>(ReceiverModule, { logger: false });
  apps.push(app);
  configureApp(app, { event: vi.fn() } as unknown as JsonLogger, { requestLogging: false, runtimeLimits: limits });
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api/v1`;
  return Object.assign(`${base}/security/csp-reports`, { other: `${base}/other` });
};

const post = (url: string, body: string, type: string) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body });

const report = JSON.stringify({
  'csp-report': {
    'document-uri': 'https://qa.example/users?invite=a@b.test',
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'https://evil.example/x.js?token=secret',
    disposition: 'enforce',
  },
});

describe('POST /security/csp-reports (pre-g5-security-hardening)', () => {
  it('keeps its limits: 30 bodies a minute per address, 16 KiB a body', () => {
    expect(CSP_REPORT_PER_IP_PER_MINUTE).toBe(30);
    expect(CSP_REPORT_BODY_MAX_BYTES).toBe(16_384);
  });

  it('is public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, SecurityReportsController.prototype.receive)).toBe(true);
  });

  it('answers 204 to both formats and logs only the four fields', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const url = await boot();
    expect((await post(url, report, 'application/csp-report')).status).toBe(204);
    const reportingApi = JSON.stringify([{ type: 'csp-violation', body: { documentURL: 'https://qa.example/', blockedURL: 'inline', effectiveDirective: 'style-src-attr', disposition: 'enforce' } }]);
    expect((await post(url, reportingApi, 'application/reports+json')).status).toBe(204);
    const lines = warn.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, string>);
    expect(lines).toEqual([
      { event: 'csp_violation', directive: 'script-src-elem', blockedOrigin: 'https://evil.example', pagePath: '/users', disposition: 'enforce' },
      { event: 'csp_violation', directive: 'style-src-attr', blockedOrigin: 'inline', pagePath: '/', disposition: 'enforce' },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|invite=|a@b\.test/);
  });

  it('answers 204, logging nothing, to malformed JSON and to an empty body', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const url = await boot();
    expect((await post(url, '{"csp-report":', 'application/csp-report')).status).toBe(204);
    expect((await post(url, '', 'application/json')).status).toBe(204);
    expect((await post(url, '{"csp-report": [', 'application/json')).status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses another media type with 415 and an oversized body with 413, never a 500', async () => {
    const url = await boot();
    expect((await post(url, report, 'text/plain')).status).toBe(415);
    const big = JSON.stringify({ 'csp-report': { 'document-uri': 'x'.repeat(CSP_REPORT_BODY_MAX_BYTES) } });
    expect((await post(url, big, 'application/csp-report')).status).toBe(413);
  });

  it(`answers 429 past ${CSP_REPORT_PER_IP_PER_MINUTE} reports a minute from one address`, async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const url = await boot();
    for (let i = 0; i < CSP_REPORT_PER_IP_PER_MINUTE; i += 1) {
      expect((await post(url, report, 'application/csp-report')).status).toBe(204);
    }
    const refused = await post(url, report, 'application/csp-report');
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { code: string }).code).toBe('rate_limited');
  });

  it('spends none of the address\'s budget for the application, however many reports it sends', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // The application's budget for this address is far below the reports sent.
    const url = await boot({ RATE_IP_PER_MINUTE: '5' });
    for (let i = 0; i < CSP_REPORT_PER_IP_PER_MINUTE + 10; i += 1) await post(url, report, 'application/csp-report');
    for (let i = 0; i < 5; i += 1) expect((await fetch(url.other)).status, `other route, call ${i + 1}`).toBe(200);
  });
});
