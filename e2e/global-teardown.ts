import { request as playwrightRequest } from '@playwright/test';
import {
  cleanupQuarterly,
  cleanupE2ELocations,
  cleanupE2ESubsidiaries,
  cleanupE2ETargets,
} from './helpers';

/** Post-run tidy-up: leave the DB back at the pristine monthly-only seed. */
export default async function globalTeardown(): Promise<void> {
  const ctx = await playwrightRequest.newContext();
  try {
    await cleanupQuarterly(ctx);
    await cleanupE2ETargets(ctx);
    await cleanupE2ESubsidiaries(ctx);
    await cleanupE2ELocations(ctx);
  } finally {
    await ctx.dispose();
  }
}
