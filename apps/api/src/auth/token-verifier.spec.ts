import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, base64url } from 'jose';
import type { JWK, JWTVerifyGetKey } from 'jose';
import { TokenVerifier, TokenVerificationError, assertAuthConfig, expectedIssuers } from './token-verifier';

const SECRET = 'local-shared-jwt-secret-for-tests';
const encoded = new TextEncoder().encode(SECRET);
const DEMO_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
const SUPABASE_URL = 'https://project.supabase.co';
/** What GoTrue stamps: its external URL + /auth/v1 (measured on the local CLI). */
const ISSUER = `${SUPABASE_URL}/auth/v1`;

/** Shaped like a real Supabase user token: iss + aud + sub + exp. */
function userClaims(overrides: Record<string, unknown> = {}) {
  return { iss: ISSUER, sub: 'user-1', aud: 'authenticated', role: 'authenticated', ...overrides };
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
    process.env.SUPABASE_URL = SUPABASE_URL;
    delete process.env.SUPABASE_JWT_ISSUER;
    delete process.env.SUPABASE_JWT_SCHEME;
    delete process.env.SUPABASE_JWT_AUDIENCE;
    delete process.env.ALLOW_INSECURE_LOCAL_AUTH;
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
      const serviceLike = await new SignJWT({ iss: ISSUER, role: 'service_role', aud: 'authenticated' })
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

    it('an EMPTY SUPABASE_JWT_AUDIENCE keeps the default audience (jose skips a falsy one)', async () => {
      process.env.SUPABASE_JWT_AUDIENCE = '';
      await expect(new TokenVerifier().verify(await hsToken(userClaims({ aud: 'anon' })))).rejects.toThrow();
      expect((await new TokenVerifier().verify(await hsToken())).sub).toBe('user-1');
    });

    it('rejects a token with no exp (a non-expiring token)', async () => {
      const noExp = await new SignJWT(userClaims())
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(encoded);
      await expect(new TokenVerifier().verify(noExp)).rejects.toThrow();
    });
  });

  // The key proves WHO signed, not for which project: a second environment or a
  // copied `.env` can share the secret or key set while its GoTrue stamps its
  // own issuer. Every case runs on both paths, because each path builds its own
  // options and catches its own errors.
  describe('issuer (iss must be this project’s Auth server)', () => {
    type Signer = (claims: Record<string, unknown>) => Promise<string>;
    type SigningKey = Parameters<SignJWT['sign']>[0];
    let es256: { sign: Signer; foreign: Signer; jwks: JWTVerifyGetKey };

    beforeEach(async () => {
      const signer =
        (key: SigningKey): Signer =>
        (claims) =>
          new SignJWT(claims)
            .setProtectedHeader({ alg: 'ES256', kid: 'issuer-key' })
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(key);
      const trusted = await generateKeyPair('ES256', { extractable: true });
      const other = await generateKeyPair('ES256', { extractable: true });
      const publicJwk: JWK = { ...(await exportJWK(trusted.publicKey)), alg: 'ES256', kid: 'issuer-key' };
      es256 = {
        sign: signer(trusted.privateKey),
        foreign: signer(other.privateKey),
        jwks: createLocalJWKSet({ keys: [publicJwk] }),
      };
    });

    const paths = [
      ['HS256', () => ({ sign: (c: Record<string, unknown>) => hsToken(c), verifier: new TokenVerifier() })],
      ['ES256', () => ({ sign: es256.sign, verifier: new TokenVerifier(es256.jwks) })],
    ] as const;

    describe.each(paths)('%s', (alg, path) => {
      it('accepts the issuer derived from SUPABASE_URL, a trailing slash or path included', async () => {
        for (const url of [SUPABASE_URL, `${SUPABASE_URL}/`, `${SUPABASE_URL}/rest/v1`]) {
          process.env.SUPABASE_URL = url;
          const { sign, verifier } = path();
          expect((await verifier.verify(await sign(userClaims()))).sub).toBe('user-1');
        }
      });

      it('rejects a correctly signed token from another project and flags it for the log', async () => {
        const { sign, verifier } = path();
        const foreign = await sign(userClaims({ iss: 'https://other.supabase.co/auth/v1' }));
        const error = await errorOf(verifier.verify(foreign));
        expect(error).toBeInstanceOf(TokenVerificationError);
        expect((error as TokenVerificationError).configError).toBe(true);
        expect((error as Error).message).toContain(ISSUER);
        expect((error as Error).message).toContain('"https://other.supabase.co/auth/v1"');
        expect((error as Error).message).toContain('SUPABASE_JWT_ISSUER');
        expect((error as Error).message).toMatch(/shares this signing secret or key set: rotate it/);
        expect((error as TokenVerificationError).logKey).toBe('issuer-mismatch');
      });

      it('quotes a non-string issuer without throwing, and bounds the line', async () => {
        const { sign, verifier } = path();
        const objectIss = await errorOf(verifier.verify(await sign(userClaims({ iss: { toString: 'x' } }))));
        expect((objectIss as TokenVerificationError).configError).toBe(true);
        expect((objectIss as Error).message).toContain('{"toString":"x"}');
        const long = `https://evil.test/${'a'.repeat(5000)}\ninjected`;
        const flood = await errorOf(verifier.verify(await sign(userClaims({ iss: long }))));
        expect((flood as TokenVerificationError).configError).toBe(true);
        expect((flood as Error).message.length).toBeLessThan(800);
        expect((flood as Error).message).not.toContain('\n');
        expect((flood as TokenVerificationError).logKey).toBe('issuer-mismatch');
      });

      it.each([
        ['a wrong audience', { aud: 'anon' }],
        ['a future nbf', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
      ])('does NOT report %s as an issuer problem', async (_label, overrides) => {
        const { sign, verifier } = path();
        const error = await errorOf(verifier.verify(await sign(userClaims(overrides))));
        expect(error).toBeInstanceOf(Error);
        expect((error as TokenVerificationError).configError).toBeFalsy();
      });

      it('derives from the origin only — userinfo in SUPABASE_URL never reaches the issuer or the log', async () => {
        process.env.SUPABASE_URL = 'https://user:hunter2@project.supabase.co/rest/v1';
        const { sign, verifier } = path();
        expect((await verifier.verify(await sign(userClaims()))).sub).toBe('user-1');
        const error = await errorOf(verifier.verify(await sign(userClaims({ iss: 'https://x.test/auth/v1' }))));
        expect((error as TokenVerificationError).configError).toBe(true);
        expect((error as Error).message).not.toContain('hunter2');
      });

      it.each([
        ['an http spelling of the same host', 'http://project.supabase.co/auth/v1'],
        ['a trailing slash', `${ISSUER}/`],
        ['the bare origin', SUPABASE_URL],
        ['a different case', 'https://PROJECT.supabase.co/auth/v1'],
        ['the anon/service-role keys’ issuer', 'supabase'],
        ['an array holding the right issuer', [ISSUER]],
      ])('rejects %s (exact match only) — on the issuer check itself', async (_label, iss) => {
        const { sign, verifier } = path();
        const error = await errorOf(verifier.verify(await sign(userClaims({ iss }))));
        expect((error as TokenVerificationError).configError).toBe(true);
        expect((error as Error).message).toMatch(/^Auth issuer mismatch/);
      });

      it.each([
        ['a string audience', 'authenticated'],
        ['an audience array holding ours', ['other', 'authenticated']],
      ])('rejects a USER token (%s) with no iss and flags it — an Auth server that stamps none', async (_label, aud) => {
        const { sign, verifier } = path();
        const { iss: _dropped, ...claims } = userClaims({ aud });
        const error = await errorOf(verifier.verify(await sign(claims)));
        expect((error as TokenVerificationError).configError).toBe(true);
        expect((error as Error).message).toMatch(/carries no issuer/);
        expect((error as TokenVerificationError).logKey).toBe('issuer-missing');
      });

      it.each([
        ['a storage URL token', { url: 'evidence/a.pdf' }],
        ['an anon-key shape', { role: 'anon' }],
        ['a user shape with another audience', { sub: 'user-1', aud: 'anon' }],
        ['a user shape with a non-string sub', { sub: 42, aud: 'authenticated' }],
      ])('rejects %s with no iss WITHOUT flagging a config error', async (_label, claims) => {
        const { sign, verifier } = path();
        const error = await errorOf(verifier.verify(await sign(claims)));
        expect(error).toBeInstanceOf(Error);
        expect((error as TokenVerificationError).configError).toBeFalsy();
      });

      it('an EMPTY SUPABASE_JWT_ISSUER falls back to the derived issuer', async () => {
        process.env.SUPABASE_JWT_ISSUER = '';
        process.env.SUPABASE_JWT_SCHEME = alg === 'HS256' ? 'hs256' : 'jwks';
        const { sign, verifier } = path();
        expect(() => assertAuthConfig()).not.toThrow();
        expect((await verifier.verify(await sign(userClaims()))).sub).toBe('user-1');
      });

      it('SUPABASE_JWT_ISSUER replaces the derived issuer instead of adding to it', async () => {
        process.env.SUPABASE_JWT_ISSUER = 'https://qa.example.test/auth/v1';
        const { sign, verifier } = path();
        await expect(verifier.verify(await sign(userClaims()))).rejects.toThrow();
        const ok = await verifier.verify(await sign(userClaims({ iss: 'https://qa.example.test/auth/v1' })));
        expect(ok.sub).toBe('user-1');
      });

      it('fails closed, as a config error, when no issuer can be determined', async () => {
        delete process.env.SUPABASE_URL;
        process.env.SUPABASE_JWT_SCHEME = alg === 'HS256' ? 'hs256' : 'jwks';
        const { sign, verifier } = path();
        const error = await errorOf(verifier.verify(await sign(userClaims())));
        expect(error).toBeInstanceOf(TokenVerificationError);
        expect((error as TokenVerificationError).configError).toBe(true);
        // Its own message — never mistaken for a JWKS outage.
        expect((error as Error).message).toMatch(/expected token issuer is unknown/);
        expect((error as Error).message).not.toMatch(/JWKS|degraded/);
      });
    });

    it('does NOT flag a wrong issuer under an untrusted signature (attacker-triggerable)', async () => {
      const forgedHs = await hsToken(
        userClaims({ iss: 'https://other.supabase.co/auth/v1' }),
        new TextEncoder().encode('attacker-secret'),
      );
      const forgedEs = await es256.foreign(userClaims({ iss: 'https://other.supabase.co/auth/v1' }));
      for (const [verifier, token] of [
        [new TokenVerifier(), forgedHs],
        [new TokenVerifier(es256.jwks), forgedEs],
      ] as const) {
        const error = await errorOf(verifier.verify(token));
        expect(error).toBeInstanceOf(Error);
        expect((error as TokenVerificationError).configError).toBeFalsy();
      }
    });

    it.each<[string, Record<string, string | undefined>, string[]]>([
      ['a hosted project', { SUPABASE_URL: SUPABASE_URL }, [ISSUER]],
      ['a hosted project even with the local flag', { SUPABASE_URL: SUPABASE_URL, ALLOW_INSECURE_LOCAL_AUTH: 'true' }, [ISSUER]],
      ['the local CLI, opted in', { SUPABASE_URL: 'http://127.0.0.1:54321', ALLOW_INSECURE_LOCAL_AUTH: 'true' },
        ['http://127.0.0.1:54321/auth/v1', 'http://localhost:54321/auth/v1', 'http://[::1]:54321/auth/v1']],
      ['an https loopback stack, opted in (aliases keep the scheme)', { SUPABASE_URL: 'https://localhost:8443', ALLOW_INSECURE_LOCAL_AUTH: 'true' },
        ['https://localhost:8443/auth/v1', 'https://127.0.0.1:8443/auth/v1', 'https://[::1]:8443/auth/v1']],
      ['pnpm docker:up, opted in', { SUPABASE_URL: 'http://host.docker.internal:54321', ALLOW_INSECURE_LOCAL_AUTH: 'true' },
        ['http://host.docker.internal:54321/auth/v1', 'http://127.0.0.1:54321/auth/v1', 'http://localhost:54321/auth/v1', 'http://[::1]:54321/auth/v1']],
      ...(['false', '1', 'TRUE', ' true', 'yes'] as const).map((flag): [string, Record<string, string>, string[]] => [
        `the local CLI with ALLOW_INSECURE_LOCAL_AUTH=${JSON.stringify(flag)}`,
        { SUPABASE_URL: 'http://127.0.0.1:54321', ALLOW_INSECURE_LOCAL_AUTH: flag },
        ['http://127.0.0.1:54321/auth/v1'],
      ]),
      ['an explicit issuer, opted in', { SUPABASE_URL: 'http://127.0.0.1:54321', ALLOW_INSECURE_LOCAL_AUTH: 'true', SUPABASE_JWT_ISSUER: 'https://qa.example.test/auth/v1' },
        ['https://qa.example.test/auth/v1']],
    ])('accepts exactly the expected issuers for %s', (_label, env, expected) => {
      delete process.env.ALLOW_INSECURE_LOCAL_AUTH;
      Object.assign(process.env, env);
      expect(expectedIssuers()).toEqual(expected);
    });

    describe('the opted-in local stack', () => {
      const cliIssuer = 'http://127.0.0.1:54321/auth/v1';

      it.each(['http://127.0.0.1:54321', 'http://localhost:54321', 'http://host.docker.internal:54321'])(
        'accepts the CLI’s 127.0.0.1 issuer when SUPABASE_URL is %s',
        async (url) => {
          process.env.SUPABASE_URL = url;
          process.env.ALLOW_INSECURE_LOCAL_AUTH = 'true';
          const ok = await new TokenVerifier().verify(await hsToken(userClaims({ iss: cliIssuer })));
          expect(ok.sub).toBe('user-1');
        },
      );

      it('keeps the port and refuses a non-loopback issuer even when opted in', async () => {
        process.env.SUPABASE_URL = 'http://host.docker.internal:54321';
        process.env.ALLOW_INSECURE_LOCAL_AUTH = 'true';
        for (const iss of ['http://127.0.0.1:9999/auth/v1', ISSUER, 'http://host.docker.internal/auth/v1']) {
          await expect(new TokenVerifier().verify(await hsToken(userClaims({ iss })))).rejects.toThrow();
        }
      });

      it('adds no loopback aliases without the opt-in flag', async () => {
        process.env.SUPABASE_URL = 'http://host.docker.internal:54321';
        delete process.env.ALLOW_INSECURE_LOCAL_AUTH;
        await expect(
          new TokenVerifier().verify(await hsToken(userClaims({ iss: cliIssuer }))),
        ).rejects.toThrow();
      });

      it('adds no aliases to an explicit SUPABASE_JWT_ISSUER', async () => {
        process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
        process.env.ALLOW_INSECURE_LOCAL_AUTH = 'true';
        process.env.SUPABASE_JWT_ISSUER = 'http://localhost:54321/auth/v1';
        await expect(
          new TokenVerifier().verify(await hsToken(userClaims({ iss: cliIssuer }))),
        ).rejects.toThrow();
      });
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
      // An explicit issuer keeps the issuer check satisfiable, so the only
      // config error left to raise is the missing JWKS origin.
      process.env.SUPABASE_JWT_ISSUER = ISSUER;
      const error = await errorOf(new TokenVerifier().verify(await sign()));
      expect((error as TokenVerificationError).configError).toBe(true);
      expect((error as Error).message).toMatch(/\(JWKS\) cannot be fetched/);
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
    /** What `pnpm setup` writes into apps/api/.env. */
    function localDevEnv() {
      process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
      process.env.ALLOW_INSECURE_LOCAL_AUTH = 'true';
      process.env.SUPABASE_JWT_SECRET = DEMO_SECRET;
    }

    it('passes for a normal local setup', () => {
      localDevEnv();
      expect(() => assertAuthConfig()).not.toThrow();
    });

    // The whole point of the gate: NODE_ENV must NOT be what decides. A staging
    // box started as `node dist/main.js` has no NODE_ENV at all, and an earlier
    // revision of this check silently passed it.
    it.each([
      ['unset', undefined],
      ['staging', 'staging'],
      ['development', 'development'],
      ['production', 'production'],
    ])('refuses an unpinned scheme against a real project with NODE_ENV=%s', (_label, env) => {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      expect(() => assertAuthConfig()).toThrow(/must be pinned to "hs256" or "jwks"/);
    });

    it.each([
      ['unset', undefined],
      ['staging', 'staging'],
      ['production', 'production'],
    ])('refuses the publicly known demo secret against a real project (NODE_ENV=%s)', (_l, env) => {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      process.env.SUPABASE_JWT_SCHEME = 'hs256';
      process.env.SUPABASE_JWT_SECRET = DEMO_SECRET;
      expect(() => assertAuthConfig()).toThrow(/demo secret/);
    });

    it('ignores the local opt-in when the Supabase host is NOT loopback', () => {
      // A copied local .env pointed at a real project must still fail closed.
      process.env.ALLOW_INSECURE_LOCAL_AUTH = 'true';
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      process.env.SUPABASE_JWT_SECRET = DEMO_SECRET;
      expect(() => assertAuthConfig()).toThrow();
    });

    it('does NOT treat a corporate .local host as local', () => {
      // An on-prem Supabase behind corporate DNS holds real tenant data.
      process.env.ALLOW_INSECURE_LOCAL_AUTH = 'true';
      process.env.SUPABASE_URL = 'https://supabase.corp.local';
      process.env.SUPABASE_JWT_SECRET = DEMO_SECRET;
      process.env.SUPABASE_JWT_SCHEME = 'hs256';
      expect(() => assertAuthConfig()).toThrow(/demo secret/);
    });

    it('requires the opt-in flag even on a loopback host', () => {
      process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
      process.env.SUPABASE_JWT_SECRET = DEMO_SECRET;
      delete process.env.ALLOW_INSECURE_LOCAL_AUTH;
      expect(() => assertAuthConfig()).toThrow(/pnpm setup/);
    });

    it.each(['jwks', 'hs256'])('accepts a correctly configured deployment (%s)', (scheme) => {
      process.env.NODE_ENV = 'production';
      process.env.SUPABASE_JWT_SCHEME = scheme;
      process.env.SUPABASE_URL = 'https://project.supabase.co';
      process.env.SUPABASE_JWT_SECRET = 'a-real-project-secret-not-the-demo-one';
      expect(() => assertAuthConfig()).not.toThrow();
    });

    it.each([
      'http://localhost:54321',
      'http://127.0.0.1:54321',
      'http://host.docker.internal:54321',
    ])('allows the opted-in local stack at %s', (url) => {
      // `pnpm docker:up` runs a production BUILD against local Supabase and the
      // demo secret; refusing to boot there would kill the container workflow.
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_INSECURE_LOCAL_AUTH = 'true';
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
      // Fails closed on the scheme gate first (no URL means not local, so the
      // strict rules apply) — which message wins matters less than that one does.
      delete process.env.SUPABASE_JWT_SECRET;
      delete process.env.SUPABASE_URL;
      expect(() => assertAuthConfig()).toThrow();
    });

    it.each([
      ['not a URL', 'project-issuer'],
      ['a non-http scheme', 'ftp://project.supabase.co/auth/v1'],
      ['padded with whitespace', ` ${ISSUER} `],
      ['carrying a zero-width space', `${ISSUER}${String.fromCharCode(0x200b)}`],
      ['carrying a non-ASCII lookalike', ISSUER.replace('a', String.fromCharCode(0x430))],
      ['missing the slashes', 'https:project.supabase.co/auth/v1'],
      ['carrying credentials', 'https://user:pw@project.supabase.co/auth/v1'],
    ])('refuses a SUPABASE_JWT_ISSUER that is %s — strict or opted in', (_label, value) => {
      process.env.SUPABASE_JWT_SCHEME = 'jwks';
      process.env.SUPABASE_JWT_ISSUER = value;
      expect(() => assertAuthConfig()).toThrow(/SUPABASE_JWT_ISSUER must be/);
      localDevEnv();
      expect(() => assertAuthConfig()).toThrow(/SUPABASE_JWT_ISSUER must be/);
    });

    it('refuses hs256 when no issuer can be determined, and accepts an explicit one', () => {
      process.env.SUPABASE_JWT_SCHEME = 'hs256';
      process.env.SUPABASE_JWT_SECRET = 'a-real-project-secret-not-the-demo-one';
      delete process.env.SUPABASE_URL;
      expect(() => assertAuthConfig()).toThrow(/expected token issuer/);
      process.env.SUPABASE_JWT_ISSUER = ISSUER;
      expect(() => assertAuthConfig()).not.toThrow();
    });

    it.each(['project.supabase.co', 'file:///etc/supabase', 'ftp://project.supabase.co'])(
      'refuses a SUPABASE_URL it cannot derive an issuer from (%s) rather than enforcing none',
      (url) => {
        process.env.SUPABASE_JWT_SCHEME = 'jwks';
        process.env.SUPABASE_URL = url;
        expect(() => assertAuthConfig()).toThrow(/expected token issuer/);
      },
    );

    it('still refuses when a pinned scheme has nothing to verify with', () => {
      delete process.env.SUPABASE_JWT_SECRET;
      delete process.env.SUPABASE_URL;
      process.env.SUPABASE_JWT_SCHEME = 'hs256';
      expect(() => assertAuthConfig()).toThrow(/SUPABASE_JWT_SECRET is not set/);
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
