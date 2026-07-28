import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from 'next/constants.js';
import nextConfig from './next.config.mjs';

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
