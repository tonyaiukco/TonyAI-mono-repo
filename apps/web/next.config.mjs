import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@tonyai/shared-types"],
  images: {
    unoptimized: true,
  },
  // Containerization: emit a self-contained server (copied into the runtime
  // image). The tracing root must be the monorepo root or the file trace
  // misses pnpm's hoisted .pnpm store.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
}

export default nextConfig
