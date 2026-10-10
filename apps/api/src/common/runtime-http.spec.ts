import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Body, Controller, Get, Module, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FileInterceptor, type NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from '../app-setup';
import { JsonLogger } from '../observability/json-logger';
import { RuntimeLimits } from './runtime-limits';
import { connect } from 'node:net';
import { IMPORT_MULTIPART_LIMITS, EVIDENCE_MULTIPART_LIMITS, SHARED_EVIDENCE_MULTIPART_LIMITS } from './multipart-limits';
import { RuntimeAuthGuard, RuntimeUploadWorkInterceptor } from './runtime-request';

@Controller()
class HttpProbe {
  @Post('json') json(@Body() body: unknown) { return body; }
  @Get('read') read() { return { ok: true }; }
  @Get('pool') pool() { throw Object.assign(new Error('pool full'), { code: 'P2024' }); }
  @Post('pool') mutationPool() { throw Object.assign(new Error('uncertain outcome'), { code: 'P2024' }); }
  @Get('reports/pdf') pdf() { return { ok: true }; }
  @Post('bulk-upload/activity-records')
  @UseInterceptors(FileInterceptor('file', { limits: IMPORT_MULTIPART_LIMITS }), RuntimeUploadWorkInterceptor)
  upload(@UploadedFile() file: Express.Multer.File) { return { bytes: file.buffer.length }; }
  @Post('activity-records/probe/evidence')
  @UseInterceptors(FileInterceptor('file', { limits: EVIDENCE_MULTIPART_LIMITS }), RuntimeUploadWorkInterceptor)
  evidence(@UploadedFile() file: Express.Multer.File) { return { bytes: file.buffer.length }; }
  @Post('evidence')
  @UseInterceptors(FileInterceptor('file', { limits: SHARED_EVIDENCE_MULTIPART_LIMITS }), RuntimeUploadWorkInterceptor)
  sharedEvidence(@UploadedFile() file: Express.Multer.File) { return { bytes: file.buffer.length }; }
}
@Module({ controllers: [HttpProbe] })
class ProbeModule {}

const apps: NestExpressApplication[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); vi.unstubAllEnvs(); });
const boot = async (env: NodeJS.ProcessEnv = {}) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const app = await NestFactory.create<NestExpressApplication>(ProbeModule, { logger: false });
  apps.push(app);
  const limits = new RuntimeLimits();
  const logger = { event: vi.fn() };
  configureApp(app, logger as unknown as JsonLogger, { requestLogging: false, runtimeLimits: limits });
  app.useGlobalGuards(new RuntimeAuthGuard({ canActivate: async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    ctx.switchToHttp().getRequest().user = { id: ctx.switchToHttp().getRequest().headers['x-test-user'] ?? 'verified-user' };
    return true;
  } } as never, limits));
  await app.listen(0, '127.0.0.1');
  return { app, limits, logger, url: await app.getUrl() };
};

describe('real HTTP protections without a database', () => {
  it('accepts the exact JSON byte budget; refuses over it, malformed JSON and compression with CORS', async () => {
    const { url } = await boot({ BODY_MAX_BYTES: '16' });
    const post = (body: string, extra = {}) => fetch(`${url}/api/v1/json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', ...extra }, body,
    });
    expect((await post('{"x":"12345678"}')).status).toBe(201);
    const big = await post('{"x":"123456789"}');
    expect(big.status).toBe(413);
    expect(((await big.json()) as { code: string }).code).toBe('payload_too_large');
    expect(big.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect((await post('{')).status).toBe(400);
    expect((await post('{}', { 'Content-Encoding': 'gzip' })).status).toBe(415);
    expect((await post('{}', { 'Content-Type': 'application/octet-stream' })).status).toBe(415);
  });
  it('admits the dashboard five-read burst with production IP defaults', async () => {
    const { url } = await boot();
    const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(`${url}/api/v1/read`)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
  });
  it('holds exactly eight slow bodies per IP by default and refuses the ninth', async () => {
    const { url, limits } = await boot();
    expect(limits.config.HTTP_IP_MAX_INFLIGHT).toBe(8);
    const sockets = Array.from({ length: 8 }, () => connect(Number(new URL(url).port), '127.0.0.1', function () {
      this.write('POST /api/v1/json HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
    }));
    try {
      await waitFor(() => activePermits(limits).get('http-ip:127.0.0.1') === 8);
      const refused = await fetch(`${url}/api/v1/read`);
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ code: 'rate_limited' });
    } finally { sockets.forEach((socket) => socket.destroy()); }
    await waitFor(() => activePermits(limits).size === 0);
    expect((await fetch(`${url}/api/v1/read`)).status).toBe(200);
  });
  it('does not let spoofed forwarding change direct-mode IP quotas; exposes Retry-After', async () => {
    const { url } = await boot({ RATE_IP_PER_MINUTE: '1' });
    const get = (ip: string) => fetch(`${url}/api/v1/reports/pdf`, {
      headers: { 'X-Forwarded-For': ip, Origin: 'http://localhost:3000' },
    });
    expect((await get('1.1.1.1')).status).toBe(200);
    const refused = await get('2.2.2.2');
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { code: string }).code).toBe('rate_limited');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(refused.headers.get('access-control-expose-headers')).toContain('Retry-After');
    expect(refused.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('retains every multipart byte while asynchronous authentication runs', async () => {
    const { url } = await boot();
    const body = new FormData(); body.append('file', new Blob(['retained-bytes']), 'probe.csv');
    const response = await fetch(`${url}/api/v1/bulk-upload/activity-records`, { method: 'POST', body });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ bytes: 14 });
  });
});


const rawRequest = (url: string, request: string): Promise<string> => new Promise((resolve, reject) => {
  const socket = connect(Number(new URL(url).port), '127.0.0.1', () => socket.write(request));
  let data = '';
  socket.setTimeout(3_000, () => socket.destroy(new Error('Test socket did not receive a response')));
  socket.on('data', (chunk) => { data += chunk.toString(); });
  socket.on('end', () => { socket.destroy(); resolve(data); });
  socket.on('error', reject);
});

describe('transport and parser boundaries', () => {
  it('returns coded 431 for excessive headers and 408 for incomplete headers/body', async () => {
    const { url } = await boot({ HTTP_HEADER_BYTES: '256', HTTP_HEADERS_TIMEOUT_MS: '100', HTTP_BODY_TIMEOUT_MS: '200' });
    const large = await rawRequest(url, `GET /api/v1/reports/pdf HTTP/1.1\r\nHost: localhost\r\nX-Large: ${'x'.repeat(256)}\r\n\r\n`);
    expect(large).toContain('431'); expect(large).toContain('bad_request');
    const headers = await rawRequest(url, 'GET /api/v1/reports/pdf HTTP/1.1\r\nHost: localhost\r\n');
    expect(headers).toContain('408'); expect(headers).toContain('bad_request');
    const body = await rawRequest(url, 'POST /api/v1/json HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{');
    expect(body).toContain('408'); expect(body).toContain('bad_request');
  });
  it('bounds chunked bytes and URL-encoded parameter counts, including exact acceptance', async () => {
    const { url } = await boot({ BODY_MAX_BYTES: '16', BODY_MAX_PARAMETERS: '2' });
    const post = (body: string) => fetch(`${url}/api/v1/json`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    expect((await post('a=1&b=2')).status).toBe(201);
    expect((await post('a=1&b=2&c=3')).status).toBe(413);
    const result = await rawRequest(url, 'POST /api/v1/json HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n11\r\n{"x":"123456789"}\r\n0\r\n\r\n');
    expect(result).toContain('413'); expect(result).toContain('payload_too_large');
  });
  it.each([
    ['bulk-upload/activity-records', 2 * 1024 * 1024, 4, 16_384],
    ['activity-records/probe/evidence', 10 * 1024 * 1024, 4, 16_384],
    ['evidence', 10 * 1024 * 1024, 2, 65_536],
  ])('uses inclusive real Multer ceilings on %s', async (path, bytes, fields, fieldBytes) => {
    const { url } = await boot({ RATE_IMPORT_PER_MINUTE: '30' });
    const upload = (size: number, count = 0, length = 1, files = 1) => {
      const form = new FormData();
      for (let i = 0; i < files; i++) form.append('file', new Blob([new Uint8Array(size)]), 'probe.csv');
      for (let i = 0; i < count; i++) form.append(`f${i}`, 'x'.repeat(length));
      return fetch(`${url}/api/v1/${path}`, { method: 'POST', body: form });
    };
    const at = await upload(bytes); expect(at.status).toBe(201); expect(await at.json()).toEqual({ bytes });
    expect((await upload(bytes + 1)).status).toBe(413);
    expect((await upload(1, fields)).status).toBe(201);
    expect((await upload(1, fields + 1)).status).toBe(400);
    expect((await upload(1, 1, fieldBytes)).status).toBe(201);
    expect((await upload(1, 1, fieldBytes + 1)).status).toBe(400);
    expect((await upload(1, 0, 1, 2)).status).toBe(400);
  });
  it.each([
    { PROXY_MODE: 'azure', AZURE_INGRESS_ONLY: 'true' },
    { PROXY_MODE: 'cidr', TRUSTED_PROXY_CIDRS: '127.0.0.1/32' },
    { PROXY_MODE: 'cidr', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' },
  ])('ignores caller-supplied leftmost forwarding entries under $PROXY_MODE', async (proxy) => {
    const { url } = await boot({ ...proxy, RATE_IP_PER_MINUTE: '1' });
    const get = (spoof: string) => fetch(`${url}/api/v1/reports/pdf`, { headers: { 'X-Forwarded-For': `${spoof}, 198.51.100.7` } });
    expect((await get('1.1.1.1')).status).toBe(200);
    expect((await get('2.2.2.2')).status).toBe(429);
  });
  it('maps post-authentication read pool refusal but preserves uncertain mutation failures', async () => {
    const { url } = await boot();
    const read = await fetch(`${url}/api/v1/pool`);
    expect(read.status).toBe(429); expect(read.headers.get('retry-after')).toBe('1');
    expect(await read.json()).toMatchObject({ code: 'rate_limited' });
    expect((await fetch(`${url}/api/v1/pool`, { method: 'POST' })).status).toBe(500);
  });
  it('refuses excess work before parsing and releases the HTTP permit after a response', async () => {
    const { url, limits } = await boot({ HTTP_MAX_INFLIGHT: '1' });
    const release = limits.acquire('http', 1);
    expect((await fetch(`${url}/api/v1/reports/pdf`)).status).toBe(429);
    release();
    expect((await fetch(`${url}/api/v1/reports/pdf`)).status).toBe(200);
    expect((await fetch(`${url}/api/v1/reports/pdf`)).status).toBe(200);
  });
});

const activePermits = (limits: RuntimeLimits) => (limits as unknown as { active: Map<string, number> }).active;
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(predicate()).toBe(true);
};
const partialUpload = (url: string, path: string, user: string, body: string, chunked = false) => {
  const socket = connect(Number(new URL(url).port), '127.0.0.1');
  const response = new Promise<string>((resolve, reject) => {
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => resolve(data)); socket.on('error', reject);
  });
  socket.on('connect', () => socket.write(`POST /api/v1/${path} HTTP/1.1\r\nHost: localhost\r\nX-Test-User: ${user}\r\nContent-Type: multipart/form-data; boundary=b\r\n${chunked ? 'Transfer-Encoding: chunked' : 'Content-Length: 10000'}\r\n\r\n${chunked ? Buffer.byteLength(body).toString(16) + '\r\n' + body + '\r\n' : body}`));
  return { socket, response };
};
const fileStart = '--b\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\nContent-Type: text/csv\r\n\r\n';

describe('slow and refused uploads cannot monopolise settled work', () => {
  it.each(['file', 'preamble', 'epilogue'])('releases chunked over-limit %s uploads and admits another user', async (part) => {
    const { url, limits } = await boot();
    const large = 'x'.repeat(2 * 1024 * 1024 + 65537);
    const body = part === 'preamble' ? large : part === 'file' ? fileStart + large : fileStart + 'x\r\n--b--\r\n' + large;
    const { socket, response } = partialUpload(url, 'bulk-upload/activity-records', 'attacker', body, true);
    try {
      expect(await response).toContain('413');
      await waitFor(() => activePermits(limits).size === 0);
      expect((await fetch(`${url}/api/v1/json`, { method: 'POST', headers: { 'X-Test-User': 'victim' } })).status).toBe(201);
      const form = new FormData(); form.append('file', new Blob(['ok']), 'a.csv');
      expect((await fetch(`${url}/api/v1/bulk-upload/activity-records`, { method: 'POST', headers: { 'X-Test-User': 'victim' }, body: form })).status).toBe(201);
    } finally { socket.destroy(); }
  });
  it('settles a body timer refusal without a 500 log and admits the next upload', async () => {
    const { url, limits, logger } = await boot({ HTTP_HEADERS_TIMEOUT_MS: '100', HTTP_BODY_TIMEOUT_MS: '200' });
    const { socket, response } = partialUpload(url, 'bulk-upload/activity-records', 'slow', fileStart + 'x');
    try {
      expect(await response).toContain('408');
      expect(logger.event.mock.calls.some(([level]) => level === 'error')).toBe(false);
      await waitFor(() => activePermits(limits).size === 0);
      const form = new FormData(); form.append('file', new Blob(['ok']), 'a.csv');
      expect((await fetch(`${url}/api/v1/bulk-upload/activity-records`, { method: 'POST', body: form })).status).toBe(201);
    } finally { socket.destroy(); }
  });
  it('holds only bounded upload slots during reception, with one upload per verified user', async () => {
    const { url, limits } = await boot({ UPLOAD_CONCURRENCY: '3' });
    const first = partialUpload(url, 'bulk-upload/activity-records', 'a', fileStart + 'x');
    const second = partialUpload(url, 'evidence', 'b', fileStart + 'x');
    try {
      await waitFor(() => activePermits(limits).has('upload:b'));
      expect(activePermits(limits).has('http')).toBe(false);
      expect(activePermits(limits).has('mutations')).toBe(false);
      expect(activePermits(limits).has('imports')).toBe(false);
      const form = new FormData(); form.append('file', new Blob(['x']), 'a.csv');
      expect((await fetch(`${url}/api/v1/evidence`, { method: 'POST', headers: { 'X-Test-User': 'a' }, body: form })).status).toBe(429);
      expect((await fetch(`${url}/api/v1/json`, { method: 'POST', headers: { 'X-Test-User': 'c' } })).status).toBe(201);
    } finally { first.socket.destroy(); second.socket.destroy(); }
    await waitFor(() => activePermits(limits).size === 0);
  });
  it('caps one IP before global admission while another IP can work', async () => {
    const { url, limits } = await boot({ PROXY_MODE: 'azure', AZURE_INGRESS_ONLY: 'true', HTTP_IP_MAX_INFLIGHT: '2', HTTP_MAX_INFLIGHT: '1' });
    const sockets = [0, 1].map(() => {
      const socket = connect(Number(new URL(url).port), '127.0.0.1', () => socket.write('POST /api/v1/json HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 203.0.113.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{'));
      return socket;
    });
    try {
      await waitFor(() => activePermits(limits).get('http-ip:203.0.113.1') === 2);
      expect(activePermits(limits).has('http')).toBe(false);
      expect((await fetch(`${url}/api/v1/json`, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.1' } })).status).toBe(429);
      expect((await fetch(`${url}/api/v1/json`, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.2' } })).status).toBe(201);
    } finally { sockets.forEach((s) => s.destroy()); }
    await waitFor(() => activePermits(limits).size === 0);
  });
  it('rejects multipart-like media types with 415', async () => {
    const { url } = await boot();
    expect((await fetch(`${url}/api/v1/bulk-upload/activity-records`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-dataX; boundary=b' }, body: 'x' })).status).toBe(415);
  });
});
