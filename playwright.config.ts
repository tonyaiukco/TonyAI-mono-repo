import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load the local Supabase URL / keys the specs + teardown need, from the
 * gitignored env files, into process.env.E2E_* — before anything else runs.
 * (URL + anon are public NEXT_PUBLIC_ values; the service key is used only for
 * the local teardown wipe of the E2E-only quarterly rows.)
 */
function loadE2EEnv(): void {
  const readVar = (file: string, key: string): string | undefined => {
    try {
      const m = readFileSync(resolve(__dirname, file), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
    } catch {
      return undefined;
    }
  };
  process.env.E2E_SUPABASE_URL ??= readVar('apps/web/.env.local', 'NEXT_PUBLIC_SUPABASE_URL');
  process.env.E2E_SUPABASE_ANON_KEY ??= readVar('apps/web/.env.local', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  process.env.E2E_SUPABASE_SERVICE_KEY ??= readVar('apps/api/.env', 'SUPABASE_SERVICE_ROLE_KEY');
}
loadE2EEnv();

/**
 * Playwright smoke E2E for the Milestone-1 slice.
 *
 * Preconditions (the harness already provides these):
 *  - Local Supabase running on :54321 (DB :54322), migrated + seeded.
 *  - Seed users admin@tonyai.local (super_admin) / entry@tonyai.local (data_entry),
 *    password TonyAI!2026.
 *
 * This config auto-starts BOTH servers via `webServer`:
 *  - API: `node dist/main.js` launched with cwd = apps/api so NestJS ConfigModule
 *    loads apps/api/.env (it has no explicit envFilePath, so cwd matters).
 *  - Web: `pnpm --filter @tonyai/web dev` on :3000.
 *
 * Run with:  pnpm e2e        (or: pnpm exec playwright test)
 * NOT part of the turbo `test` pipeline — CI stays unit-only for now.
 */

const apiDir = resolve(__dirname, 'apps/api');

// ALWAYS build before starting, never "build only if dist is missing".
//
// `pnpm e2e` rebuilds up front, but `pnpm exec playwright test` does not — and
// with a dist present the old conditional started it unchanged, so the suite
// reported on the PREVIOUS build of the API. That is the worst kind of green:
// it bit this repo during WP15, where six specs failed against stale code and
// then passed untouched after a rebuild. The safeguard must not depend on which
// command someone types.
const apiStartCmd = 'pnpm --filter @tonyai/api build && node dist/main.js';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  // Under CI the list reporter scrolls past in a log nobody reads; the HTML
  // report is uploaded as an artifact instead.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // Reset the DB to the pristine (monthly-only) seed before and after the run:
  // every E2E write lives in the otherwise-unused `quarterly` space.
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  use: {
    baseURL: 'http://localhost:3000',
    // NOT `on-first-retry`: `retries` is 0 — deliberately, because the suite is
    // serial against one shared database and a retried write-heavy test would
    // collide with its own leftovers — so there is never a first retry and that
    // setting captured a trace exactly never. This one fires on the run that
    // actually failed, which is the only one there is.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      command: apiStartCmd,
      cwd: apiDir,
      url: 'http://localhost:3001/api/v1/health',
      reuseExistingServer: !process.env.CI,
      // 180s rather than 120s: tuned on a laptop, but a 2-vCPU CI runner has to
    // cold-build Nest / cold-compile Next before the health check can pass.
    timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @tonyai/web dev',
      cwd: __dirname,
      url: 'http://localhost:3000/login',
      reuseExistingServer: !process.env.CI,
      // 180s rather than 120s: tuned on a laptop, but a 2-vCPU CI runner has to
    // cold-build Nest / cold-compile Next before the health check can pass.
    timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
