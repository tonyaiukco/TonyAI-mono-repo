import { request as playwrightRequest } from '@playwright/test';
import { cleanupQuarterly } from './helpers';

/**
 * Pre-run reset: wipe any quarterly rows left by a previous (possibly aborted)
 * run so every run starts from the pristine monthly-only seed. Env is loaded by
 * playwright.config.ts before this runs.
 */
export default async function globalSetup(): Promise<void> {
  const ctx = await playwrightRequest.newContext();
  try {
    await cleanupQuarterly(ctx);
  } finally {
    await ctx.dispose();
  }
}
