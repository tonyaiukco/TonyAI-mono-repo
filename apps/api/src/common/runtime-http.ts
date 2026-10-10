import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Response, NextFunction } from 'express';
import { STATUS_CODES, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { toErrorBody } from './api-error';
import { CapacityError, routeGroup, RuntimeLimits } from './runtime-limits';
import { type LimitedRequest, RuntimeRequestInterceptor } from './runtime-request';

const refuse = (res: Response, status: number, message: string): void => {
  if (res.headersSent || res.destroyed) return;
  res.setHeader('Connection', 'close');
  res.status(status).json(toErrorBody(status, { message }));
};

export const configureRuntimeHttp = (app: NestExpressApplication, limits: RuntimeLimits): void => {
  const c = limits.config;
  // Express validates the CIDR list when compiling trust; malformed CIDRs fail boot.
  app.set('trust proxy', c.proxyMode === 'cidr' ? c.trustedProxies : c.proxyMode === 'azure' ? 1 : false);
  app.set('query parser', 'simple');
  app.disable('x-powered-by');
  app.use((req: LimitedRequest, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (limits.stopping && req.path !== '/api/v1/health') return refuse(res, 503, 'Server is shutting down.');
    // Probe exemptions are exact, read-only, and do not exempt /health/synthetic.
    if (req.method === 'GET' && /^\/api\/v1\/health(?:\/ready)?\/?$/.test(req.path)) return next();
    const releases: Array<() => void> = [];
    const lease = { executing: false, releases, release: () => { for (const release of releases.splice(0)) release(); } };
    req.runtimeLease = lease;
    res.once('close', () => { if (!lease.executing) lease.release(); });
    res.once('finish', () => { if (!lease.executing) lease.release(); });
    void (async () => {
      try {
        // req.ip follows only the explicitly configured trust boundary. Never
        // read the first forwarded address or trust a caller's user identifier.
        const ip = req.ip ?? req.socket.remoteAddress ?? '';
        if (!isIP(ip)) return refuse(res, 400, 'Invalid client address.');
        releases.push(limits.acquire(`http-ip:${ip}`, c.HTTP_IP_MAX_INFLIGHT));
        await limits.quota(`ip:${ip}`, c.RATE_IP_PER_MINUTE);
        if (res.destroyed) return lease.release();
        const group = routeGroup(req.method, req.path);
        const hasBody = Boolean(req.headers['transfer-encoding']) || Number(req.headers['content-length'] ?? 0) > 0;
        const media = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        const multipart = media === 'multipart/form-data';
        req.runtimeMultipart = multipart;
        const uploadRoute = req.method === 'POST' && (group === 'IMPORT'
          || /^\/api\/v1\/(evidence|activity-records\/[^/]+\/evidence)\/?$/i.test(req.path));
        if (multipart && !uploadRoute) return refuse(res, 415, 'Multipart is not supported on this route.');
        if (hasBody && !multipart && !['application/json', 'application/x-www-form-urlencoded'].includes(media)) {
          return refuse(res, 415, 'Unsupported request content type.');
        }
        if (multipart) releases.push(limits.acquire('multipart', c.UPLOAD_CONCURRENCY));
        if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
          return refuse(res, 415, 'Compressed request bodies are not supported.');
        }
        const bytesLimit = multipart ? (group === 'IMPORT' ? 2 : 10) * 1024 * 1024 + 65_536 : c.BODY_MAX_BYTES;
        const length = req.headers['content-length'];
        if (length && (!/^\d+$/.test(length) || Number(length) > bytesLimit)) {
          return refuse(res, 413, 'Request body is too large.');
        }
        const abortBody = (status: number, message: string) => {
          // Finish the refusal before aborting Multer. A paused stream never
          // settles its interceptor and would retain execution permits forever.
          res.once('close', () => { if (!req.destroyed) req.destroy(); });
          refuse(res, status, message);
          req.pause();
        };
        let bytes = 0;
        const onData = (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > bytesLimit) { abortBody(413, 'Request body is too large.'); }
        };
        const timer = setTimeout(() => abortBody(408, 'Request body reception timed out.'), c.HTTP_BODY_TIMEOUT_MS);
        timer.unref();
        const cleanup = () => { clearTimeout(timer); req.off('data', onData); };
        req.once('end', cleanup);
        res.once('close', cleanup);
        // Keep multipart paused until Multer pipes it after authentication.
        // A counting listener alone would otherwise consume the upload early.
        if (multipart) req.pause();
        req.on('data', onData);
        next();
      } catch (error) {
        lease.release();
        if (error instanceof CapacityError) {
          res.setHeader('Retry-After', error.retryAfter);
          refuse(res, 429, 'Request capacity is exhausted. Try again later.');
        } else next(error);
      }
    })();
  });
  // Register explicitly BEFORE Nest's defaults; its adapter recognizes these
  // parsers and does not install a second set on init.
  app.useBodyParser('json', { limit: c.BODY_MAX_BYTES, inflate: false });
  app.useBodyParser('urlencoded', { limit: c.BODY_MAX_BYTES, extended: false, parameterLimit: c.BODY_MAX_PARAMETERS, inflate: false });
  app.useGlobalInterceptors(new RuntimeRequestInterceptor());
  const server = app.getHttpServer() as Server;
  Object.defineProperty(server, 'maxHeaderSize', { value: c.HTTP_HEADER_BYTES });
  // Node otherwise checks header deadlines only every 30 seconds.
  Object.defineProperty(server, 'connectionsCheckingInterval', { value: Math.min(1_000, c.HTTP_HEADERS_TIMEOUT_MS) });
  server.headersTimeout = c.HTTP_HEADERS_TIMEOUT_MS;
  server.requestTimeout = c.HTTP_BODY_TIMEOUT_MS;
  server.keepAliveTimeout = c.HTTP_KEEPALIVE_MS;
  server.once('close', () => limits.onApplicationShutdown());
  // Node's parser refuses headers before Express can produce a body. Supply
  // the same code contract for that transport-level rejection.
  const responses = new WeakMap<object, ServerResponse>();
  server.prependListener('request', (req, res) => responses.set(req.socket, res));
  server.on('clientError', (error: Error & { code?: string }, socket) => {
    if (!socket.writable || responses.get(socket)?.headersSent) return socket.destroy();
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? 431 : error.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400;
    const body = JSON.stringify(toErrorBody(status, { message: 'Invalid or incomplete HTTP request.' }));
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
};
