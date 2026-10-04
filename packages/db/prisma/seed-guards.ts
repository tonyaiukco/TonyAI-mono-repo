/**
 * The seed's guards, apart from the seed so they can be tested without running
 * it (`seed.ts` connects and writes on import).
 */
import { recordActivityTypesFor } from '@tonyai/shared-types';
import { SEED_ACTIVITY_TYPES } from './factor-library';

/**
 * The seed writes the PLACEHOLDER factor library and demo tenants, so it runs
 * against a plainly local database only (LP3-03, obligation 3: placeholder
 * rows come from the seed, locally — staging and production are never
 * seeded). A loopback host, and no `host`/`hostaddr` parameter redirecting the
 * connection elsewhere. An accident guard, not a proof of locality.
 */
export function assertLocalSeedTarget(raw: string | undefined, what: string): void {
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    throw new Error(`The seed needs ${what} naming a local target.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
  const redirected = [...url.searchParams.keys()].some((k) => ['host', 'hostaddr'].includes(k.toLowerCase()));
  if (!loopback || redirected) {
    throw new Error(
      `Refusing to seed ${url.hostname} (${what}): the seed loads placeholder factors, demo users and buckets, and runs ` +
        'against a local database only. A deployed environment is never seeded.',
    );
  }
}
/**
 * The activity type a seeded record of `category` names: its typed category's
 * seed type, or none for an implicit category. A typed category the seed has
 * no type for is a defect in the seed, refused here rather than written as an
 * untyped (legacy-only) record.
 */
export function seedActivityType(category: string): string | null {
  if (recordActivityTypesFor(category).length === 0) return null;
  const type = SEED_ACTIVITY_TYPES[category];
  if (!type) throw new Error(`The seed names no activity type for ${category}, a typed category`);
  return type;
}

