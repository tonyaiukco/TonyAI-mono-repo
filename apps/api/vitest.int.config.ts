import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { RUNTIME_ROLE, runtimeUrlFrom, urlUser } from '../../packages/db/scripts/runtime-role.mjs';

// PostgreSQL integration tests (LP0-03). They run against a real database with
// the repository's migrations applied — the local Supabase stack, or in CI the
// `supabase-stack` composite action — and never as part of `pnpm test`.
//
// Local runs read DATABASE_URL / DIRECT_URL from `apps/api/.env`, which
// `pnpm setup` writes; values already in the environment (CI) win.
const apiEnv = resolve(__dirname, '.env');
if (!process.env.DATABASE_URL && existsSync(apiEnv)) process.loadEnvFile(apiEnv);

// Two connections, as in a deployed environment (LP1-03): the services under
// test run as the least-privileged runtime role, so every spec proves the
// runtime's grants suffice; fixtures and cleanup — which create organisations
// and profiles and delete synthetic audit rows — run as the owner. The owner is
// DIRECT_URL (local), or DATABASE_URL where both name it (CI's supabase-stack);
// the runtime URL is then derived from it, and the global setup gives the role
// its local login.
const databaseUrl = process.env.DATABASE_URL ?? '';
const ownerUrl = process.env.DIRECT_URL || databaseUrl;
process.env.INT_OWNER_DATABASE_URL = ownerUrl;
process.env.INT_RUNTIME_DATABASE_URL =
  databaseUrl && urlUser(databaseUrl) === RUNTIME_ROLE ? databaseUrl : ownerUrl ? runtimeUrlFrom(ownerUrl) : '';

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
