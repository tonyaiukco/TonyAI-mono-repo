import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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

const apiDist = resolve(__dirname, 'apps/api/dist/main.js');
const apiDir = resolve(__dirname, 'apps/api');

// If the API isn't built, build it first, then start it (with cwd = apps/api).
// Using a shell so the build only runs when the dist is missing.
const apiStartCmd = existsSync(apiDist)
  ? 'node dist/main.js'
  : 'pnpm --filter @tonyai/api build && node dist/main.js';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
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
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @tonyai/web dev',
      cwd: __dirname,
      url: 'http://localhost:3000/login',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
