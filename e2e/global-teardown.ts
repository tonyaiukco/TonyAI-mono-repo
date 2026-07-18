import { request as playwrightRequest } from '@playwright/test';
import { cleanupQuarterly, cleanupE2ETargets } from './helpers';

/** Post-run tidy-up: leave the DB back at the pristine monthly-only seed. */
export default async function globalTeardown(): Promise<void> {
  const ctx = await playwrightRequest.newContext();
  try {
    await cleanupQuarterly(ctx);
    await cleanupE2ETargets(ctx);
  } finally {
    await ctx.dispose();
  }
}
