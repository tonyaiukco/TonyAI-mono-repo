import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, base64url } from 'jose';
import type { JWK, JWTVerifyGetKey } from 'jose';
import { TokenVerifier, TokenVerificationError } from './token-verifier';

const SECRET = 'local-shared-jwt-secret-for-tests';
const encoded = new TextEncoder().encode(SECRET);

async function hsToken(
  claims: Record<string, unknown> = { sub: 'user-1' },
  key: Uint8Array = encoded,
  expiresIn = '5m',
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

describe('TokenVerifier', () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = SECRET;
  });
  afterEach(() => {
    process.env.SUPABASE_JWT_SECRET = SECRET;
  });

  describe('HS256 (legacy shared secret)', () => {
    it('accepts a token signed with the configured secret', async () => {
      const payload = await new TokenVerifier().verify(await hsToken());
      expect(payload.sub).toBe('user-1');
    });

    it('rejects a token signed with a DIFFERENT secret', async () => {
      const foreign = await hsToken({ sub: 'user-1' }, new TextEncoder().encode('other-secret'));
      await expect(new TokenVerifier().verify(foreign)).rejects.toThrow();
    });

    it('rejects an expired token', async () => {
      const expired = await new SignJWT({ sub: 'user-1' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(encoded);
      await expect(new TokenVerifier().verify(expired)).rejects.toThrow();
    });

    it('flags a missing secret as a CONFIG error so the guard can log it', async () => {
      const token = await hsToken();
      delete process.env.SUPABASE_JWT_SECRET;
      await expect(new TokenVerifier().verify(token)).rejects.toThrow(/SUPABASE_JWT_SECRET/);
      const error = await new TokenVerifier().verify(token).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).configError).toBe(true);
    });

    it('does NOT flag a bad signature as a config error (no log spam under attack)', async () => {
      const foreign = await hsToken({ sub: 'x' }, new TextEncoder().encode('other-secret'));
      const error = await new TokenVerifier().verify(foreign).catch((e: unknown) => e);
      expect((error as TokenVerificationError).configError).toBeFalsy();
    });
  });

  describe('ES256 (asymmetric, via JWKS)', () => {
    let jwks: JWTVerifyGetKey;
    let publicJwk: JWK;
    let sign: (claims?: Record<string, unknown>) => Promise<string>;

    beforeEach(async () => {
      const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
      publicJwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'test-key-1' };
      jwks = createLocalJWKSet({ keys: [publicJwk] });
      sign = (claims = { sub: 'user-1' }) =>
        new SignJWT(claims)
          .setProtectedHeader({ alg: 'ES256', kid: 'test-key-1' })
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
    });

    it('accepts a token signed by a key in the JWKS', async () => {
      const payload = await new TokenVerifier(jwks).verify(await sign());
      expect(payload.sub).toBe('user-1');
    });

    it('rejects a token signed by a key that is NOT in the JWKS', async () => {
      const { privateKey } = await generateKeyPair('ES256', { extractable: true });
      const foreign = await new SignJWT({ sub: 'user-1' })
        .setProtectedHeader({ alg: 'ES256', kid: 'test-key-1' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      await expect(new TokenVerifier(jwks).verify(foreign)).rejects.toThrow();
    });

    it('does NOT fall back to the shared secret for asymmetric tokens', async () => {
      // No JWKS injected and no SUPABASE_URL → must fail loudly rather than
      // silently trying the HS256 secret.
      delete process.env.SUPABASE_URL;
      await expect(new TokenVerifier().verify(await sign())).rejects.toThrow(/JWKS|SUPABASE_URL/);
    });
  });

  describe('algorithm confusion / malformed input', () => {
    it('rejects an HS256 token forged with the JWKS public key as the HMAC secret', async () => {
      // The classic attack: take the published EC public key, use its bytes as
      // an HMAC secret, and claim alg=HS256. The HS path must only ever consult
      // SUPABASE_JWT_SECRET, so this cannot verify.
      const { publicKey } = await generateKeyPair('ES256', { extractable: true });
      const jwk = await exportJWK(publicKey);
      const publicKeyBytes = new TextEncoder().encode(JSON.stringify(jwk));
      const forged = await hsToken({ sub: 'attacker' }, publicKeyBytes);

      const jwks = createLocalJWKSet({ keys: [{ ...jwk, alg: 'ES256', kid: 'k' }] });
      await expect(new TokenVerifier(jwks).verify(forged)).rejects.toThrow();
    });

    it('rejects alg: none', async () => {
      const header = base64url.encode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const body = base64url.encode(JSON.stringify({ sub: 'attacker' }));
      await expect(new TokenVerifier().verify(`${header}.${body}.`)).rejects.toThrow(
        /Unsupported token algorithm/,
      );
    });

    it('rejects an unsupported algorithm', async () => {
      const header = base64url.encode(JSON.stringify({ alg: 'HS1024', typ: 'JWT' }));
      const body = base64url.encode(JSON.stringify({ sub: 'attacker' }));
      // HS-prefixed but not HS256 → the explicit allow-list must still reject it.
      await expect(new TokenVerifier().verify(`${header}.${body}.x`)).rejects.toThrow();
    });

    it('rejects a malformed token', async () => {
      await expect(new TokenVerifier().verify('not-a-jwt')).rejects.toThrow(/Malformed token/);
    });
  });
});
