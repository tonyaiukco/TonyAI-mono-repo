import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// PostgreSQL integration tests (LP0-03). They run against a real database with
// the repository's migrations applied — the local Supabase stack, or in CI the
// `supabase-stack` composite action — and never as part of `pnpm test`.
//
// Local runs read DATABASE_URL from the repo-root `.env` that `pnpm setup`
// writes; a value already in the environment (CI) wins.
const rootEnv = resolve(__dirname, '../../.env');
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/int/**/*.int.spec.ts', 'src/**/*.int.spec.ts'],
    globalSetup: ['test/int/global-setup.ts'],
    // One database, so one file at a time: interleaving tests count lock
    // waits across the whole database and must not see another file's.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
