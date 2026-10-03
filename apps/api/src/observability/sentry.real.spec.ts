import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

afterEach(() => { vi.unstubAllEnvs(); });

it('real SDK emits only allowlisted request data and no transactions, even with tracing requested', async () => {
  vi.stubEnv('SENTRY_DSN', 'http://synthetic@127.0.0.1:1/1');
  vi.stubEnv('SENTRY_TRACES_SAMPLE_RATE', '1');
  const markers = { jwt: randomUUID(), cookie: randomUUID(), query: randomUUID(), filename: `${randomUUID()}.pdf`, bytes: randomUUID(), token: randomUUID() };
  const envelopes: unknown[] = [];
  const { initSentry, captureException, flushSentry } = await import('./sentry');
  await initSentry(() => ({
    send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
    flush: async () => true,
  }));
  const sdk = await import('@sentry/nestjs');
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/storage/')) { response.end('ok'); return; }
    // Consume a real multipart body while the SDK's HTTP request isolation is active.
    const body = await new Promise<string>((resolve) => {
      let value = '';
      request.on('data', (chunk) => { value += chunk.toString(); });
      request.on('end', () => resolve(value));
    });
    expect(body).toContain(markers.bytes);
    await sdk.startSpan({ name: 'synthetic-upload' }, async () => {
      const port = (server.address() as AddressInfo).port;
      await fetch(`http://127.0.0.1:${port}/storage/v1/object/evidence/${markers.filename}?token=${markers.token}`);
      captureException(new Error('Synthetic in-request failure'), { path: request.url });
    });
    response.writeHead(500).end('Synthetic failure');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${origin}/api/v1/evidence?subsidiaryId=${markers.query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${markers.jwt}`, Cookie: `session=${markers.cookie}`, 'Content-Type': 'multipart/form-data; boundary=fixture' },
      body: `--fixture\r\nContent-Disposition: form-data; name="file"; filename="${markers.filename}"\r\nContent-Type: application/pdf\r\n\r\n${markers.bytes}\r\n--fixture--\r\n`,
    });
    expect(response.status).toBe(500);
    await response.text();
    expect(await flushSentry()).toBe(true);
    const items = envelopes.flatMap((envelope) => (envelope as [unknown, [Record<string, unknown>, Record<string, unknown>][]])[1]);
    const events = items.filter(([header]) => header.type === 'event').map(([, event]) => event);
    expect(events).toHaveLength(1);
    expect(events[0].request).toEqual({ method: 'POST', url: `${origin}/api/v1/evidence` });
    expect(events[0].tags).toMatchObject({ path: '/api/v1/evidence' });
    expect(items.filter(([header]) => header.type === 'transaction')).toHaveLength(0);
    expect(sdk.getClient()?.getOptions().tracesSampleRate).toBe(0);
    for (const secret of Object.values(markers)) {
      expect(JSON.stringify(envelopes)).not.toContain(secret);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sdk.close();
  }
}, 15_000);
