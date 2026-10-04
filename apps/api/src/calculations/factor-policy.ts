/**
 * Whether this API may calculate from non-authoritative factors — the
 * prototype's placeholder values and a test run's fixtures (owner decision K3,
 * 2026-10-04): only where `ALLOW_PLACEHOLDER_FACTORS` is exactly `true`, which
 * `pnpm setup` writes for local development and the test harnesses set for CI.
 * Staging and production never set it, and need not: they are never seeded,
 * so they hold no placeholder to refuse — the flag is a second lock, not the
 * only one.
 *
 * Read ONCE, at boot, and frozen: every calculation — preview, create, update,
 * a bulk import and its dry run — goes through `CalculationsService`, which is
 * handed this one object, so no request can see a different answer and no
 * code path reads the environment for itself.
 */
export const FACTOR_POLICY = Symbol('FACTOR_POLICY');

export interface FactorPolicy {
  readonly allowPlaceholders: boolean;
}

export const ALLOW_PLACEHOLDER_FACTORS = 'ALLOW_PLACEHOLDER_FACTORS';

/** Only the exact string `true` is on: `TRUE`, `1`, `yes`, ` true` are off. */
export function parseAllowPlaceholders(raw: string | undefined): boolean {
  return raw === 'true';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * True only for a URL that plainly names this machine: a loopback host and,
 * for a PostgreSQL URL, no `host` / `hostaddr` query parameter (libpq lets one
 * redirect the connection elsewhere whatever the authority says). Anything
 * unparsable is not local. An accident guard — it keeps a flag copied into a
 * deployed environment from taking effect — not a proof of locality.
 */
export function isPlainlyLocalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return false;
  for (const key of url.searchParams.keys()) {
    if (['host', 'hostaddr'].includes(key.toLowerCase())) return false;
  }
  return true;
}

/**
 * The policy for this environment, or an error naming why the flag may not
 * be on here: it is refused against a database or Supabase project that is
 * not plainly local, and against an unset `DATABASE_URL` (nothing then shows
 * the database is local).
 */
export function factorPolicyFrom(env: Readonly<Record<string, string | undefined>>): FactorPolicy {
  const allowPlaceholders = parseAllowPlaceholders(env[ALLOW_PLACEHOLDER_FACTORS]);
  if (allowPlaceholders) {
    const database = env.DATABASE_URL;
    if (!database || !isPlainlyLocalUrl(database)) {
      throw new Error(
        `${ALLOW_PLACEHOLDER_FACTORS}=true is refused: DATABASE_URL is not a local database. ` +
          'Placeholder factors are for local development and CI only (LP3-03, K3); remove the flag.',
      );
    }
    const supabase = env.SUPABASE_URL;
    if (supabase !== undefined && supabase !== '' && !isPlainlyLocalUrl(supabase)) {
      throw new Error(
        `${ALLOW_PLACEHOLDER_FACTORS}=true is refused: SUPABASE_URL is not a local project. ` +
          'Placeholder factors are for local development and CI only (LP3-03, K3); remove the flag.',
      );
    }
  }
  return Object.freeze({ allowPlaceholders });
}

let bootPolicy: FactorPolicy | undefined;

/**
 * The process's policy, computed from `process.env` the first time it is
 * asked for and never again. `main.ts` asks before Nest is built, so a refused
 * flag stops the boot; the `FACTOR_POLICY` provider returns the same object.
 */
export function bootFactorPolicy(): FactorPolicy {
  bootPolicy ??= factorPolicyFrom(process.env);
  return bootPolicy;
}
