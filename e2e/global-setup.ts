import { request as playwrightRequest } from '@playwright/test';
import {
  cleanupQuarterly,
  cleanupE2ELocations,
  cleanupE2ESubsidiaries,
  cleanupE2EFactors,
  cleanupE2ETargets,
  seedE2EFactor,
} from './helpers';

/**
 * Pre-run reset: wipe any quarterly rows left by a previous (possibly aborted)
 * run so every run starts from the pristine monthly-only seed. Env is loaded by
 * playwright.config.ts before this runs.
 */
export default async function globalSetup(): Promise<void> {
  const ctx = await playwrightRequest.newContext();
  try {
    await cleanupQuarterly(ctx);
    await cleanupE2ETargets(ctx);
    await cleanupE2ESubsidiaries(ctx);
    await cleanupE2ELocations(ctx);
    await cleanupE2EFactors(ctx);
    // Seeded LAST, after the sweep that would otherwise remove it. Without a
    // factor for a non-evidence category there is nothing a bulk submit can
    // submit: every category the seed covers requires an evidence file, and an
    // import cannot attach one.
    await seedE2EFactor(ctx);
  } finally {
    await ctx.dispose();
  }
}
