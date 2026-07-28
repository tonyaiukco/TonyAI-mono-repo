import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, base64url } from 'jose';
import type { JWK, JWTVerifyGetKey } from 'jose';
import { TokenVerifier, TokenVerificationError, assertAuthConfig } from './token-verifier';

const SECRET = 'local-shared-jwt-secret-for-tests';
const encoded = new TextEncoder().encode(SECRET);
const DEMO_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

/** Shaped like a real Supabase user token: aud + sub + exp. */
function userClaims(overrides: Record<string, unknown> = {}) {
  return { sub: 'user-1', aud: 'authenticated', role: 'authenticated', ...overrides };
}

async function hsToken(
  claims: Record<string, unknown> = userClaims(),
  key: Uint8Array = encoded,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('TokenVerifier', () => {
  const ENV = { ...process.env };

  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = SECRET;
    delete process.env.SUPABASE_JWT_SCHEME;
    delete process.env.NODE_ENV;
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  describe('HS256 (legacy shared secret)', () => {
    it('accepts a token signed with the configured secret', async () => {
      const payload = await new TokenVerifier().verify(await hsToken());
      expect(payload.sub).toBe('user-1');
    });

    it('rejects a token signed with a DIFFERENT secret', async () => {
      const foreign = await hsToken(userClaims(), new TextEncoder().encode('other-secret'));
      await expect(new TokenVerifier().verify(foreign)).rejects.toThrow();
    });

    it('rejects an expired token', async () => {
      const expired = await new SignJWT(userClaims())
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(encoded);
      await expect(new TokenVerifier().verify(expired)).rejects.toThrow();
    });

    it('rejects a token that is not yet valid (nbf in the future)', async () => {
      const future = await new SignJWT(userClaims())
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setNotBefore(Math.floor(Date.now() / 1000) + 3600)
        .setExpirationTime('2h')
        .sign(encoded);
      await expect(new TokenVerifier().verify(future)).rejects.toThrow();
    });

    it('flags a missing secret as a CONFIG error so the guard can log it', async () => {
      const token = await hsToken();
      delete process.env.SUPABASE_JWT_SECRET;
      const error = await errorOf(new TokenVerifier().verify(token));
      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).configError).toBe(true);
    });

    it('does NOT flag a bad signature as a config error (no log spam under attack)', async () => {
      const foreign = await hsToken(userClaims(), new TextEncoder().encode('other-secret'));
      const error = await errorOf(new TokenVerifier().verify(foreign));
      expect((error as TokenVerificationError).configError).toBeFalsy();
    });
  });

  describe('required claims (service/anon keys must not pass as user tokens)', () => {
    it('rejects a token with no sub — this is what anon/service_role keys look like', async () => {
      const serviceLike = await new SignJWT({ role: 'service_role', aud: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(encoded);
      await expect(new TokenVerifier().verify(serviceLike)).rejects.toThrow();
    });

    it('rejects a token with the wrong audience', async () => {
      const wrongAud = await hsToken(userClaims({ aud: 'anon' }));
      await expect(new TokenVerifier().verify(wrongAud)).rejects.toThrow();
    });

    it('rejects a token with no exp (a non-expiring token)', async () => {
      const noExp = await new SignJWT(userClaims())
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(encoded);
      await expect(new TokenVerifier().verify(noExp)).rejects.toThrow();
    });
  });

  // Supabase Cloud's asymmetric option covers both curves/algorithms, so both
  // must be exercised — not just the one the local CLI happens to emit.
  describe.each(['ES256', 'RS256'] as const)('%s (asymmetric, via JWKS)', (algorithm) => {
    let jwks: JWTVerifyGetKey;
    let sign: (claims?: Record<string, unknown>) => Promise<string>;

    beforeEach(async () => {
      const { privateKey, publicKey } = await generateKeyPair(algorithm, { extractable: true });
      const publicJwk: JWK = { ...(await exportJWK(publicKey)), alg: algorithm, kid: 'test-key-1' };
      jwks = createLocalJWKSet({ keys: [publicJwk] });
      sign = (claims = userClaims()) =>
        new SignJWT(claims)
          .setProtectedHeader({ alg: algorithm, kid: 'test-key-1' })
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
    });

    it('accepts a token signed by a key in the JWKS', async () => {
      const payload = await new TokenVerifier(jwks).verify(await sign());
      expect(payload.sub).toBe('user-1');
    });

    it('rejects a token signed by a key that is NOT in the JWKS', async () => {
      const { privateKey } = await generateKeyPair(algorithm, { extractable: true });
      const foreign = await new SignJWT(userClaims())
        .setProtectedHeader({ alg: algorithm, kid: 'test-key-1' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      await expect(new TokenVerifier(jwks).verify(foreign)).rejects.toThrow();
    });

    it('rejects an unknown kid WITHOUT flagging a config error (attacker-triggerable)', async () => {
      const { privateKey } = await generateKeyPair(algorithm, { extractable: true });
      const unknownKid = await new SignJWT(userClaims())
        .setProtectedHeader({ alg: algorithm, kid: 'no-such-key' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      const error = await errorOf(new TokenVerifier(jwks).verify(unknownKid));
      expect((error as TokenVerificationError).configError).toBeFalsy();
    });

    it('rejects every token when the JWKS publishes no keys', async () => {
      // Documents a real blind spot: an empty key set is indistinguishable from
      // an unknown kid, so it stays a plain rejection with no server-side
      // signal. `pnpm setup` catches this case at setup time instead.
      const empty = createLocalJWKSet({ keys: [] });
      const error = await errorOf(new TokenVerifier(empty).verify(await sign()));
      expect(error).toBeInstanceOf(Error);
      expect((error as TokenVerificationError).configError).toBeFalsy();
    });

    it('reports an unreachable JWKS as a CONFIG error, not a bad token', async () => {
      // An outage on our side must be distinguishable from "the token is bad".
      const unreachable: JWTVerifyGetKey = () => {
        throw new TypeError('fetch failed');
      };
      const error = await errorOf(new TokenVerifier(unreachable).verify(await sign()));
      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).configError).toBe(true);
    });

    it('does NOT fall back to the shared secret for asymmetric tokens', async () => {
      delete process.env.SUPABASE_URL;
      const error = await errorOf(new TokenVerifier().verify(await sign()));
      expect((error as TokenVerificationError).configError).toBe(true);
      expect((error as Error).message).toMatch(/SUPABASE_URL|JWKS/);
    });
  });

  describe('scheme pinning (SUPABASE_JWT_SCHEME)', () => {
    it('hs256 refuses asymmetric tokens without touching the JWKS', async () => {
      process.env.SUPABASE_JWT_SCHEME = 'hs256';
      const { privateKey } = await generateKeyPair('ES256', { extractable: true });
      const token = await new SignJWT(userClaims())
        .setProtectedHeader({ alg: 'ES256', kid: 'k' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      const neverCalled: JWTVerifyGetKey = () => {
        throw new Error('JWKS must not be consulted when the scheme is pinned to hs256');
      };
      await expect(new TokenVerifier(neverCalled).verify(token)).rejects.toThrow(
        /not accepted by this API/,
      );
    });

    it('jwks refuses shared-secret tokens even when the secret is still set', async () => {
      // The whole point: a leaked legacy secret must be worthless after migrating.
      process.env.SUPABASE_JWT_SCHEME = 'jwks';
      await expect(new TokenVerifier().verify(await hsToken())).rejects.toThrow(
        /not accepted by this API/,
      );
    });

    it('rejects an unknown scheme value outright', async () => {
      process.env.SUPABASE_JWT_SCHEME = 'rs256-please';
      await expect(new TokenVerifier().verify(await hsToken())).rejects.toThrow(
        /Invalid SUPABASE_JWT_SCHEME/,
      );
    });
  });

  describe('assertAuthConfig (boot-time)', () => {
    it('passes for a normal local setup', () => {
      process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
      expect(() => assertAuthConfig()).not.toThrow();
    });

    it('refuses to boot in production without an explicit scheme', () => {
      process.env.NODE_ENV = 'production';
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      expect(() => assertAuthConfig()).toThrow(/must be set to "hs256" or "jwks" in production/);
    });

    it('refuses to boot in production with the publicly known demo secret', () => {
      process.env.NODE_ENV = 'production';
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      process.env.SUPABASE_JWT_SCHEME = 'hs256';
      process.env.SUPABASE_JWT_SECRET = DEMO_SECRET;
      expect(() => assertAuthConfig()).toThrow(/demo secret/);
    });

    it('accepts a correctly configured production deployment (jwks)', () => {
      process.env.NODE_ENV = 'production';
      process.env.SUPABASE_JWT_SCHEME = 'jwks';
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      delete process.env.SUPABASE_JWT_SECRET;
      expect(() => assertAuthConfig()).not.toThrow();
    });

    it('accepts a correctly configured production deployment (hs256, real secret)', () => {
      process.env.NODE_ENV = 'production';
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      process.env.SUPABASE_JWT_SCHEME = 'hs256';
      process.env.SUPABASE_JWT_SECRET = 'a-real-project-secret-not-the-demo-one';
      expect(() => assertAuthConfig()).not.toThrow();
    });

    it.each([
      'http://localhost:54321',
      'http://127.0.0.1:54321',
      'http://host.docker.internal:54321',
    ])('does NOT apply the production rules to the local stack at %s', (url) => {
      // `pnpm docker:up` runs a production BUILD against local Supabase and the
      // demo secret; refusing to boot there would kill the container workflow.
      process.env.NODE_ENV = 'production';
      process.env.SUPABASE_URL = url;
      process.env.SUPABASE_JWT_SCHEME = 'auto';
      process.env.SUPABASE_JWT_SECRET = DEMO_SECRET;
      expect(() => assertAuthConfig()).not.toThrow();
    });

    it('refuses hs256 without a secret and jwks without a URL', () => {
      process.env.SUPABASE_JWT_SCHEME = 'hs256';
      delete process.env.SUPABASE_JWT_SECRET;
      expect(() => assertAuthConfig()).toThrow(/SUPABASE_JWT_SECRET is not set/);

      process.env.SUPABASE_JWT_SCHEME = 'jwks';
      delete process.env.SUPABASE_URL;
      expect(() => assertAuthConfig()).toThrow(/SUPABASE_URL is not set/);
    });

    it('refuses to boot when nothing at all is configured', () => {
      delete process.env.SUPABASE_JWT_SECRET;
      delete process.env.SUPABASE_URL;
      expect(() => assertAuthConfig()).toThrow(/Auth is not configured/);
    });
  });

  describe('algorithm confusion / malformed input', () => {
    it('rejects an HS256 token forged with the JWKS public key as the HMAC secret', async () => {
      // The classic attack: take the published EC public key, use its bytes as
      // an HMAC secret, and claim alg=HS256. The HS path must only ever consult
      // SUPABASE_JWT_SECRET, so this cannot verify.
      const { publicKey } = await generateKeyPair('ES256', { extractable: true });
      const jwk = await exportJWK(publicKey);
      const forged = await hsToken(
        userClaims({ sub: 'attacker' }),
        new TextEncoder().encode(JSON.stringify(jwk)),
      );
      const jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: 'ES256', kid: 'k' }] });
      await expect(new TokenVerifier(jwks).verify(forged)).rejects.toThrow();
    });

    it('rejects alg: none', async () => {
      const header = base64url.encode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const body = base64url.encode(JSON.stringify(userClaims({ sub: 'attacker' })));
      await expect(new TokenVerifier().verify(`${header}.${body}.`)).rejects.toThrow(
        /Unsupported token algorithm/,
      );
    });

    it.each(['HS384', 'HS512'] as const)(
      'rejects a VALIDLY SIGNED %s token — the HS allow-list is HS256 only',
      async (alg) => {
        // The realistic downgrade: the HS secret is shared, so an attacker can
        // legitimately sign with a stronger/weaker HS variant. A junk-signature
        // test would pass even with the allow-list deleted; this one would not.
        const downgraded = await new SignJWT(userClaims({ sub: 'attacker' }))
          .setProtectedHeader({ alg })
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(encoded);
        await expect(new TokenVerifier().verify(downgraded)).rejects.toThrow();
      },
    );

    it.each(['PS256', 'EdDSA', 'ES384', 'hs256'])(
      'rejects the unsupported algorithm %s at the router',
      async (alg) => {
        // `hs256` (lowercase) matters: it exercises the case-sensitive routing.
        const header = base64url.encode(JSON.stringify({ alg, typ: 'JWT' }));
        const body = base64url.encode(JSON.stringify(userClaims()));
        await expect(new TokenVerifier().verify(`${header}.${body}.x`)).rejects.toThrow();
      },
    );

    it('rejects a non-string alg without throwing a raw TypeError', async () => {
      const header = base64url.encode(JSON.stringify({ alg: ['HS256'], typ: 'JWT' }));
      const body = base64url.encode(JSON.stringify(userClaims()));
      const error = await errorOf(new TokenVerifier().verify(`${header}.${body}.x`));
      expect(error).toBeInstanceOf(TokenVerificationError);
    });

    it('rejects a malformed token', async () => {
      await expect(new TokenVerifier().verify('not-a-jwt')).rejects.toThrow(/Malformed token/);
    });
  });
});
