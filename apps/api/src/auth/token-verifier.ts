import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';

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
 *  - The JWKS URL is derived from trusted configuration (`SUPABASE_URL`), never
 *    from the token (no `jku`/`iss`-driven fetching).
 *  - The remote key set is created once and cached by `jose`, which also
 *    rate-limits refetches, so a burst of unknown `kid`s cannot be turned into
 *    a fetch storm against the auth server.
 */
const HS_ALGORITHMS = ['HS256'] as const;
const ASYMMETRIC_ALGORITHMS = ['ES256', 'RS256'] as const;

export class TokenVerificationError extends Error {
  /**
   * True when the API itself is misconfigured (rather than the token being bad).
   * The guard logs these so a broken setup is visible in the server output
   * instead of silently 401-ing every request.
   */
  constructor(
    message: string,
    readonly configError = false,
  ) {
    super(message);
  }
}

export class TokenVerifier {
  /** Injected in tests; in production it is built lazily from SUPABASE_URL. */
  private jwks: JWTVerifyGetKey | null;

  constructor(jwks?: JWTVerifyGetKey) {
    this.jwks = jwks ?? null;
  }

  async verify(token: string): Promise<JWTPayload> {
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw new TokenVerificationError('Malformed token');
    }

    if (alg && alg.startsWith('HS')) return this.verifyWithSecret(token);
    if (alg && (ASYMMETRIC_ALGORITHMS as readonly string[]).includes(alg)) {
      return this.verifyWithJwks(token);
    }
    throw new TokenVerificationError(`Unsupported token algorithm: ${alg ?? 'none'}`);
  }

  private async verifyWithSecret(token: string): Promise<JWTPayload> {
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      throw new TokenVerificationError(
        'Auth is not configured: this project signs tokens with the shared HS256 secret, ' +
          'but SUPABASE_JWT_SECRET is not set. Re-run `pnpm setup`.',
        true,
      );
    }
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: [...HS_ALGORITHMS],
    });
    return payload;
  }

  private async verifyWithJwks(token: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.getJwks(), {
      algorithms: [...ASYMMETRIC_ALGORITHMS],
    });
    return payload;
  }

  private getJwks(): JWTVerifyGetKey {
    if (this.jwks) return this.jwks;
    const base = process.env.SUPABASE_URL;
    if (!base) {
      throw new TokenVerificationError(
        'Auth is not configured: this project signs tokens asymmetrically, but SUPABASE_URL ' +
          'is not set so the public keys (JWKS) cannot be fetched. Re-run `pnpm setup`.',
        true,
      );
    }
    this.jwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', base));
    return this.jwks;
  }
}

/** Process-wide instance so the remote key set is fetched and cached once. */
export const tokenVerifier = new TokenVerifier();
