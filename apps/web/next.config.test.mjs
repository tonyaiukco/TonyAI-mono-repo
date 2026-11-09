import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from 'next/constants.js';
import nextConfig from './next.config.mjs';
import { reportOnlyPolicy, securityHeaders } from './security-headers.mjs';

/**
 * Guards the dev-memory fix. Next's Turbopack dev server adopts
 * `outputFileTracingRoot` as its PROJECT root:
 *
 *   // next/dist/server/dev/hot-reloader-turbopack.js
 *   rootPath = turbopack?.root || outputFileTracingRoot || projectPath
 *
 * so leaking the build-only tracing root into the dev phase makes `next dev`
 * index and watch the whole monorepo (~7 GB) instead of apps/web — which
 * exhausted memory on a 16 GB machine. That regression is invisible to
 * typecheck, unit tests and CI, hence this file.
 */
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../');

const dev = await nextConfig(PHASE_DEVELOPMENT_SERVER);
assert.equal(
  dev.outputFileTracingRoot,
  undefined,
  'dev must NOT set outputFileTracingRoot — Turbopack would index the whole monorepo',
);
assert.equal(dev.output, undefined, 'dev must not request standalone output');

const runtime = await nextConfig(PHASE_PRODUCTION_SERVER);
assert.equal(
  runtime.output,
  undefined,
  '`next start` warns when it sees output: standalone — keep it build-only',
);

const build = await nextConfig(PHASE_PRODUCTION_BUILD);
assert.equal(build.output, 'standalone', 'the Docker image copies .next/standalone');
assert.equal(
  build.outputFileTracingRoot,
  repoRoot,
  'the traced server must reach pnpm’s hoisted store at the monorepo root',
);

for (const [phase, config] of [
  ['dev', dev],
  ['production server', runtime],
  ['build', build],
]) {
  assert.deepEqual(
    config.transpilePackages,
    ['@tonyai/shared-types'],
    `${phase} must keep transpiling the shared-types workspace package`,
  );
}

console.log('next.config.mjs: dev/runtime/build phases OK (4 assertions + 3 shared checks)');

// Every phase serves the security headers (Decisions 2026-11-09). The policies
// are read from the build's NEXT_PUBLIC_* values, so a bad one must not fail it.
for (const phase of [PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER]) {
  const rules = await (await nextConfig(phase)).headers();
  assert.equal(rules[0].source, '/:path*', 'the headers must cover every route');
  const byKey = Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]));
  assert.equal(byKey['X-Content-Type-Options'], 'nosniff');
  assert.equal(byKey['X-Frame-Options'], 'DENY');
  assert.equal(byKey['Referrer-Policy'], 'no-referrer');
  assert.equal(byKey['Permissions-Policy'], 'camera=(), microphone=(), geolocation=()');
  assert.equal(byKey['Content-Security-Policy'], "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  assert.match(byKey['Content-Security-Policy-Report-Only'], /default-src 'self'/);
}

assert.equal(securityHeaders({}).some((h) => h.key === 'Strict-Transport-Security'), false, 'HSTS is for a production image only');
assert.deepEqual(securityHeaders({ NODE_ENV: 'production' }).find((h) => h.key === 'Strict-Transport-Security').value, 'max-age=31536000');
assert.equal((await nextConfig(PHASE_PRODUCTION_BUILD)).poweredByHeader, false);

const connectSrc = (env) => /connect-src ([^;]+)/.exec(reportOnlyPolicy(env))[1];
assert.equal(
  connectSrc({
    NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com/api/v1',
    NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
    NEXT_PUBLIC_SENTRY_DSN: 'https://key@o1.ingest.de.sentry.io/2',
  }),
  "'self' https://api.example.com https://abc.supabase.co https://o1.ingest.de.sentry.io",
  'connect-src names the origins only, and no key',
);
assert.equal(connectSrc({}), "'self'");
assert.equal(connectSrc({ NEXT_PUBLIC_API_BASE_URL: 'not a url' }), "'self'");
