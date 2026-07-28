import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from 'jose';
import type { JWTPayload, JWTVerifyGetKey, JWTVerifyOptions } from 'jose';

/**
 * Verifies Supabase access tokens under BOTH signing schemes.
 *
 * Supabase used to sign local/legacy projects with a shared HS256 secret
 * (`SUPABASE_JWT_SECRET`). Newer projects (and newer supabase-cli versions)
 * sign asymmetrically (ES256/RS256) and publish the public keys at
 * `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`. A clone whose CLI issues
 * asymmetric tokens against an HS256-only API logs in fine in the browser and
 * then gets 401 on every API call — which reads as "no data / auth error".
 *
 * Security notes:
 *  - The key material decides which algorithms are acceptable, never the token:
 *    the HS path accepts ONLY HS256 and the JWKS path ONLY asymmetric algs, so
 *    a token cannot downgrade an RSA/EC public key into an HMAC secret (the
 *    classic algorithm-confusion attack), and `alg: none` matches neither path.
 *  - `SUPABASE_JWT_SCHEME` PINS the accepted scheme. Accepting both at once
 *    means migrating to asymmetric keys buys nothing while the legacy secret is
 *    still present in the environment — anyone who learns it can mint tokens
 *    for any user. `auto` (the default) is for local dev only, where the
 *    supabase-cli version decides the scheme; production must be explicit.
 *  - The JWKS URL is derived from trusted configuration (`SUPABASE_URL`), never
 *    from the token (no `jku`/`iss`-driven fetching).
 *  - The remote key set is created once and cached by `jose`, which also
 *    rate-limits refetches, so a burst of unknown `kid`s cannot be turned into
 *    a fetch storm against the auth server.
 */
const HS_ALGORITHMS = ['HS256'] as const;
const ASYMMETRIC_ALGORITHMS = ['ES256', 'RS256'] as const;

/** Every Supabase user token carries these; service/anon keys and signed
 * storage URLs do not, so requiring them blocks replaying those as user
 * tokens instead of relying on GoTrue happening to omit `sub`. */
const VERIFY_OPTIONS: JWTVerifyOptions = {
  audience: 'authenticated',
  requiredClaims: ['exp', 'sub'],
};

/** The published default of every local Supabase and of the self-hosted sample. */
const DEMO_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

export type JwtScheme = 'hs256' | 'jwks' | 'auto';

export class TokenVerificationError extends Error {
  /**
   * True when the API itself is misconfigured (rather than the token being bad).
   * The guard logs these — at most once per process, because on a single-scheme
   * deployment an unauthenticated attacker can trigger the "other" scheme's
   * message at will just by writing an `alg` header.
   */
  constructor(
    message: string,
    readonly configError = false,
  ) {
    super(message);
  }
}

/**
 * The containerized local stack (`pnpm docker:up`) runs a production BUILD
 * (`NODE_ENV=production` in apps/api/Dockerfile) against the developer's local
 * Supabase, demo secret and all. Keying the strict checks on NODE_ENV alone
 * would refuse to boot there, so they key on the Supabase host instead: a
 * deployment that talks to a real project is held to the strict rules, a
 * loopback one is not.
 */
const LOCAL_SUPABASE_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'host.docker.internal',
]);

function targetsLocalSupabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return LOCAL_SUPABASE_HOSTS.has(host) || host.endsWith('.local');
  } catch {
    return false;
  }
}

export function resolveScheme(): JwtScheme {
  const raw = (process.env.SUPABASE_JWT_SCHEME ?? 'auto').toLowerCase();
  if (raw === 'hs256' || raw === 'jwks' || raw === 'auto') return raw;
  throw new Error(
    `Invalid SUPABASE_JWT_SCHEME "${raw}" — expected one of: hs256, jwks, auto`,
  );
}

/**
 * Fail fast at boot rather than 401-ing every request later. Called from
 * `bootstrap()`; throwing here stops the process with a readable message.
 */
export function assertAuthConfig(): void {
  const scheme = resolveScheme();
  const secret = process.env.SUPABASE_JWT_SECRET;
  const url = process.env.SUPABASE_URL;
  const strict = process.env.NODE_ENV === 'production' && !targetsLocalSupabase(url);

  if (strict && scheme === 'auto') {
    throw new Error(
      'SUPABASE_JWT_SCHEME must be set to "hs256" or "jwks" in production. ' +
        'Accepting both lets a leaked legacy secret mint tokens even after ' +
        'the project moved to asymmetric keys.',
    );
  }
  if (strict && secret === DEMO_JWT_SECRET) {
    throw new Error(
      'SUPABASE_JWT_SECRET is still the publicly known Supabase demo secret. ' +
        'Anyone could forge a super_admin token. Set the real project secret.',
    );
  }
  if (scheme === 'hs256' && !secret) {
    throw new Error('SUPABASE_JWT_SCHEME=hs256 but SUPABASE_JWT_SECRET is not set.');
  }
  if (scheme === 'jwks' && !url) {
    throw new Error('SUPABASE_JWT_SCHEME=jwks but SUPABASE_URL is not set (JWKS origin).');
  }
  if (scheme === 'auto' && !secret && !url) {
    throw new Error(
      'Auth is not configured: set SUPABASE_JWT_SECRET (HS256) or SUPABASE_URL (JWKS).',
    );
  }
}

export class TokenVerifier {
  /** Injected in tests; in production it is built lazily from SUPABASE_URL. */
  private jwks: JWTVerifyGetKey | null;

  constructor(jwks?: JWTVerifyGetKey) {
    this.jwks = jwks ?? null;
  }

  async verify(token: string): Promise<JWTPayload> {
    let alg: unknown;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw new TokenVerificationError('Malformed token');
    }
    if (typeof alg !== 'string') {
      throw new TokenVerificationError('Malformed token header');
    }

    const scheme = resolveScheme();
    if (alg.startsWith('HS')) {
      if (scheme === 'jwks') {
        throw new TokenVerificationError('Shared-secret tokens are not accepted by this API');
      }
      return this.verifyWithSecret(token);
    }
    if ((ASYMMETRIC_ALGORITHMS as readonly string[]).includes(alg)) {
      if (scheme === 'hs256') {
        throw new TokenVerificationError('Asymmetric tokens are not accepted by this API');
      }
      return this.verifyWithJwks(token);
    }
    throw new TokenVerificationError(`Unsupported token algorithm: ${alg}`);
  }

  private async verifyWithSecret(token: string): Promise<JWTPayload> {
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      // Reachable in `auto` mode on a JWKS-only deployment by anyone who writes
      // `{"alg":"HS256"}`, so this must stay cheap and log-once (see the guard).
      throw new TokenVerificationError(
        'Auth is not configured: a shared-secret token arrived but SUPABASE_JWT_SECRET ' +
          'is not set. Re-run `pnpm setup`.',
        true,
      );
    }
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      ...VERIFY_OPTIONS,
      algorithms: [...HS_ALGORITHMS],
    });
    return payload;
  }

  private async verifyWithJwks(token: string): Promise<JWTPayload> {
    const jwks = this.getJwks();
    try {
      const { payload } = await jwtVerify(token, jwks, {
        ...VERIFY_OPTIONS,
        algorithms: [...ASYMMETRIC_ALGORITHMS],
      });
      return payload;
    } catch (error) {
      // A JWKS the API cannot reach is OUR outage, not a bad token, and it
      // would otherwise be indistinguishable from "everyone's token expired".
      // `ERR_JWKS_NO_MATCHING_KEY` stays a plain rejection: it is
      // attacker-triggerable with an unknown `kid`.
      const code = (error as { code?: string }).code;
      if (code === 'ERR_JWKS_TIMEOUT' || error instanceof TypeError) {
        throw new TokenVerificationError(
          `Auth is degraded: could not fetch the JWKS from ${this.jwksUrl() ?? 'SUPABASE_URL'}.`,
          true,
        );
      }
      throw error;
    }
  }

  private jwksUrl(): string | null {
    const base = process.env.SUPABASE_URL;
    return base ? new URL('/auth/v1/.well-known/jwks.json', base).toString() : null;
  }

  private getJwks(): JWTVerifyGetKey {
    if (this.jwks) return this.jwks;
    const url = this.jwksUrl();
    if (!url) {
      throw new TokenVerificationError(
        'Auth is not configured: this project signs tokens asymmetrically, but SUPABASE_URL ' +
          'is not set so the public keys (JWKS) cannot be fetched. Re-run `pnpm setup`.',
        true,
      );
    }
    this.jwks = createRemoteJWKSet(new URL(url));
    return this.jwks;
  }
}

/** Process-wide instance so the remote key set is fetched and cached once. */
export const tokenVerifier = new TokenVerifier();
