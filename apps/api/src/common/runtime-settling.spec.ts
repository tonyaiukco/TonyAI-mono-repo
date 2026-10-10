import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CanActivate, Controller, ForbiddenException, Get, Module, Post, UseGuards } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from '../app-setup';
import type { JsonLogger } from '../observability/json-logger';
import { RuntimeLimits } from './runtime-limits';
import { RuntimeAuthGuard } from './runtime-request';

let releaseWork: () => void = () => undefined;
let started: () => void = () => undefined;

class Deny implements CanActivate {
  canActivate(): boolean { throw new ForbiddenException('role refused by a later guard'); }
}

@Controller()
class Probe {
  @Post('slow') async slow() {
    await new Promise<void>((resolve) => { releaseWork = resolve; started(); });
    return { ok: true };
  }
  @Post('ok') ok() { return { ok: true }; }
  @Post('denied') @UseGuards(Deny) denied() { return { ok: true }; }
  @Get('read') read() { return { ok: true }; }
  @Get('health') health() { return { ok: true }; }
  @Get('health/synthetic') synthetic() { return { ok: true }; }
}
@Module({ controllers: [Probe] })
class ProbeModule {}

const apps: NestExpressApplication[] = [];
afterEach(async () => { releaseWork(); await Promise.all(apps.splice(0).map((a) => a.close())); vi.unstubAllEnvs(); });
const boot = async (env: NodeJS.ProcessEnv = {}) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const app = await NestFactory.create<NestExpressApplication>(ProbeModule, { logger: false });
  apps.push(app);
  const limits = new RuntimeLimits();
  configureApp(app, { event: vi.fn() } as unknown as JsonLogger, { requestLogging: false, runtimeLimits: limits });
  app.useGlobalGuards(new RuntimeAuthGuard({ canActivate: async (ctx) => {
    ctx.switchToHttp().getRequest().user = { id: 'verified-user' };
    return true;
  } } as never, limits));
  await app.listen(0, '127.0.0.1');
  return { url: await app.getUrl() };
};

describe('settled work admission regressions', () => {
  it('M2: a client abort does not free the mutation permits while the handler still runs', async () => {
    const { url } = await boot();
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const controller = new AbortController();
    const first = fetch(`${url}/api/v1/slow`, { method: 'POST', signal: controller.signal }).catch(() => 'aborted');
    await begun;
    controller.abort();
    expect(await first).toBe('aborted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await fetch(`${url}/api/v1/ok`, { method: 'POST' });
    expect(second.status).toBe(429);
    releaseWork();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await fetch(`${url}/api/v1/ok`, { method: 'POST' })).status).toBe(201);
  });

  it('M3: a later guard refusal (403) releases the request permits', async () => {
    const { url } = await boot();
    expect((await fetch(`${url}/api/v1/denied`, { method: 'POST' })).status).toBe(403);
    expect((await fetch(`${url}/api/v1/ok`, { method: 'POST' })).status).toBe(201);
  });

  it('M10: azure mode keys distinct ingress-appended clients separately', async () => {
    const { url } = await boot({ PROXY_MODE: 'azure', AZURE_INGRESS_ONLY: 'true', RATE_IP_PER_MINUTE: '1' });
    const get = (ip: string) => fetch(`${url}/api/v1/read`, { headers: { 'X-Forwarded-For': ip } });
    expect((await get('203.0.113.1')).status).toBe(200);
    expect((await get('203.0.113.2')).status).toBe(200);
    expect((await get('203.0.113.1')).status).toBe(429);
  });

  it('M16: health is exempt from the IP quota but /health/synthetic is not', async () => {
    const { url } = await boot({ RATE_IP_PER_MINUTE: '1' });
    for (let i = 0; i < 3; i++) expect((await fetch(`${url}/api/v1/health`)).status).toBe(200);
    expect((await fetch(`${url}/api/v1/health/synthetic`)).status).toBe(200);
    expect((await fetch(`${url}/api/v1/health/synthetic`)).status).toBe(429);
  });

  it('M25: multipart to a non-upload route is refused 415', async () => {
    const { url } = await boot();
    const form = new FormData(); form.append('file', new Blob(['x']), 'x.csv');
    expect((await fetch(`${url}/api/v1/ok`, { method: 'POST', body: form })).status).toBe(415);
  });
});
