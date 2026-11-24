import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfRenderer } from '../../src/common/pdf-renderer';

/**
 * `pdf-rendering` (`pre-g5-security-hardening`): the real renderer, the real
 * Chromium. A document that references a local server every way it can — an
 * image, a stylesheet, a frame, and a script that would fetch — reaches it
 * zero times, and still prints. Removing the page's isolation makes the hits
 * appear (the change's mutation check).
 */

let server: Server;
let base: string;
/** The same server by a host name: resolving it is itself a lookup the render must not make. */
let named: string;
const hits: string[] = [];
/** Every TCP connection to the server, a preconnect's included — it sends no request. */
let connections = 0;
const renderer = new PdfRenderer();

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('x');
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  named = `http://localhost:${port}`;
}, 30_000);

afterAll(async () => {
  await renderer.onModuleDestroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a PDF render runs no script and reaches no network', () => {
  it('prints a hostile document without a single request to the server it names', async () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="${base}/style.css">
      <style>body { background: url('${base}/background.png'); }</style>
      </head><body>
      <h1 id="title">Report as written</h1>
      <img src="${base}/image.png" alt="">
      <iframe src="${base}/frame.html"></iframe>
      <script>
        document.getElementById('title').textContent = 'Changed by a script';
        fetch('${base}/fetch');
        new Image().src = '${base}/beacon.png';
      </script>
      </body></html>`;

    const { bytes } = await renderer.render(html);

    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    // Give a late request (a frame, a beacon) time to arrive before counting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(hits).toEqual([]);
  }, 60_000);

  it('runs no script, measured by what it would have printed (Codex review)', async () => {
    // With JavaScript on, the script adds five hundred paragraphs: many pages.
    // It asks for nothing over the network, so request interception alone
    // cannot hide it — only the page's script switch can.
    const html = `<!doctype html><html><body><p>One page as written</p>
      <script>for (let i = 0; i < 500; i += 1) { const p = document.createElement('p'); p.textContent = 'added ' + i; document.body.appendChild(p); }</script>
      </body></html>`;

    const { bytes } = await renderer.render(html);

    const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
    expect(pages).toBe(1);
  }, 60_000);

  it('makes no connection and no lookup for hints and refreshes that bypass request interception (security-rls review)', async () => {
    connections = 0;
    hits.length = 0;
    // A DNS prefetch and a preconnect go through the host resolver and the
    // socket pool, not through a request; a meta refresh is a navigation.
    const html = `<!doctype html><html><head>
      <link rel="dns-prefetch" href="${named}">
      <link rel="preconnect" href="${named}">
      <link rel="preconnect" href="${named.replace('localhost', 'localhost.')}" crossorigin>
      <meta http-equiv="refresh" content="0; url=${named}/refresh">
      </head><body><p>Hints only</p></body></html>`;

    const { bytes } = await renderer.render(html);

    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect({ connections, hits }).toEqual({ connections: 0, hits: [] });
  }, 60_000);
});
