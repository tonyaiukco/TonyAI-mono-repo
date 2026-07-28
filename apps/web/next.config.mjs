import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const baseConfig = {
  transpilePackages: ["@tonyai/shared-types"],
  images: {
    unoptimized: true,
  },
}

/**
 * `output: 'standalone'` + `outputFileTracingRoot` are needed by the Docker
 * build only: the traced server must reach pnpm's hoisted `.pnpm` store at the
 * monorepo root, or the runtime image misses modules.
 *
 * They are deliberately NOT applied to `next dev`, because Next's Turbopack dev
 * server adopts the tracing root as its PROJECT root:
 *
 *   // next/dist/server/dev/hot-reloader-turbopack.js
 *   const rootPath = nextConfig.turbopack?.root || nextConfig.outputFileTracingRoot || projectPath
 *   await bindings.turbo.createProject({ rootPath, watch: { enable: dev } })
 *
 * With the monorepo root there, `pnpm dev` indexed and watched the whole ~7 GB
 * tree (root node_modules, packages/db engines, sibling .next dirs) instead of
 * apps/web — which is what exhausted memory on a 16 GB machine. Turbopack's
 * allocations are native, so no `--max-old-space-size` can bound them; scoping
 * the root is the actual fix.
 */
export default function nextConfig(phase) {
  if (phase === PHASE_DEVELOPMENT_SERVER) return baseConfig;
  return {
    ...baseConfig,
    output: 'standalone',
    outputFileTracingRoot: path.join(__dirname, '../../'),
  };
}
