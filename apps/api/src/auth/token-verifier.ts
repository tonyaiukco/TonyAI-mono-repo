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
 *  - The token's `iss` must be this project's Auth server (`expectedIssuers`).
 *    The key proves who signed, not for which project: another GoTrue sharing
 *    the secret or key set (a second environment, a copied `.env`) mints
 *    correctly signed tokens with its own issuer, and those must not pass.
 *  - The remote key set is created once. Against a REACHABLE JWKS `jose` caches
 *    it and rate-limits refetches, so a burst of unknown `kid`s costs one fetch.
 *    Against a failing one it retries per call (the cooldown timestamp is only
 *    set after a success), so an unauthenticated caller can make an `auto`-mode
 *    API dial its auth server once per request — another reason to pin the
 *    scheme outside local dev, which removes that path entirely.
 */
const HS_ALGORITHMS = ['HS256'] as const;
const ASYMMETRIC_ALGORITHMS = ['ES256', 'RS256'] as const;

/** Every Supabase user token carries these; service/anon keys and signed
 * storage URLs do not, so requiring them blocks replaying those as user
 * tokens instead of relying on GoTrue happening to omit `sub`. */
function verifyOptions(): JWTVerifyOptions {
  const issuer = expectedIssuers();
  if (!issuer) {
    // Boot refuses this (assertAuthConfig); reaching it means the environment
    // changed underneath a running process. Fail closed, and say why.
    throw new TokenVerificationError(
      'Auth is not configured: the expected token issuer is unknown. Set SUPABASE_URL ' +
        `(the issuer defaults to its origin + ${AUTH_PATH}) or SUPABASE_JWT_ISSUER.`,
      true,
    );
  }
  return { audience: expectedAudience(), issuer, requiredClaims: ['exp', 'sub'] };
}

/**
 * GoTrue's default; overridable because a self-hosted project can set
 * GOTRUE_JWT_AUD, and hardcoding it would 401 every request with no signal.
 * An EMPTY value falls back too: jose skips the audience check entirely when
 * `audience` is falsy, so `SUPABASE_JWT_AUDIENCE=` would otherwise turn it off.
 */
function expectedAudience(): string {
  return process.env.SUPABASE_JWT_AUDIENCE || 'authenticated';
}

/** The published default of every local Supabase and of the self-hosted sample. */
const DEMO_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

/**
 * jose error codes that mean "the presented token is bad" — everything else on
 * the JWKS path means the key set itself is unusable, i.e. our problem.
 * `ERR_JWKS_NO_MATCHING_KEY` belongs here: an unknown `kid` is attacker-supplied,
 * so treating it as a config error would hand out a free log line.
 */
const TOKEN_FAULT_CODES = new Set([
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWS_INVALID',
  'ERR_JWT_INVALID',
  'ERR_JOSE_ALG_NOT_ALLOWED',
]);

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
    /**
     * What the guard throttles this log line by, when the message itself
     * varies (it quotes a token's issuer): one line per window per kind, and a
     * bounded throttle map, however many issuers a key holder writes.
     */
    readonly logKey: string = message,
  ) {
    super(message);
  }
}

/**
 * The strict rules below are ON BY DEFAULT and are relaxed only by an explicit
 * opt-in: `ALLOW_INSECURE_LOCAL_AUTH=true` AND a loopback Supabase host.
 *
 * Both halves are deliberate. NODE_ENV is useless as the discriminator — the
 * containerized local stack (`pnpm docker:up`) runs a production BUILD
 * (`NODE_ENV=production` in apps/api/Dockerfile) against the developer's local
 * Supabase, while a staging box started as `node dist/main.js` has no NODE_ENV
 * at all; keying on it left real deployments unguarded. The host alone is not
 * enough either: it only reflects where the JWKS lives, so a deploy reaching
 * Supabase through a tunnel, or one that copied a local `.env` and repointed
 * only DATABASE_URL, would still look "local" while holding real tenant data.
 * Requiring a named, greppable flag makes the exemption a deliberate act that a
 * reviewer can see, and anything copied into a real environment fails closed.
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
    // `.local` is deliberately NOT treated as local: an on-prem Supabase behind
    // corporate DNS is a real deployment with real tenant data behind it.
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return LOCAL_SUPABASE_HOSTS.has(host);
  } catch {
    return false;
  }
}

/** The explicit local opt-in — honoured only together with a loopback Supabase host. */
function insecureLocalAuth(): boolean {
  return (
    process.env.ALLOW_INSECURE_LOCAL_AUTH === 'true' && targetsLocalSupabase(process.env.SUPABASE_URL)
  );
}

/** GoTrue serves under this prefix and stamps it into the issuer it publishes. */
const AUTH_PATH = '/auth/v1';

/** Loopback spellings of one local GoTrue (the CLI stamps `http://127.0.0.1:<port>`). */
const LOCAL_ISSUER_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * The `iss` values a user token may carry, or null when none can be determined
 * (callers fail closed). GoTrue stamps its external URL plus `/auth/v1` — the
 * local CLI `http://127.0.0.1:54321/auth/v1`, a hosted project
 * `https://<ref>.supabase.co/auth/v1` — so the default is derived from
 * SUPABASE_URL exactly like the JWKS URL. Where the API reaches Auth through
 * another address than the one GoTrue publishes (a private hostname, a proxy),
 * SUPABASE_JWT_ISSUER names the issuer exactly and is the only value accepted.
 *
 * Only the opted-in local stack also accepts the other loopback spellings of
 * the same port: `pnpm docker:up` reaches Supabase as host.docker.internal while
 * its GoTrue still stamps 127.0.0.1.
 */
export function expectedIssuers(): string[] | null {
  const explicit = process.env.SUPABASE_JWT_ISSUER;
  if (explicit) return [explicit];
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // The origin alone: no path, and no userinfo to leak into the mismatch log.
  const derived = `${url.origin}${AUTH_PATH}`;
  if (!insecureLocalAuth()) return [derived];
  const port = url.port ? `:${url.port}` : '';
  const aliases = LOCAL_ISSUER_HOSTS.map((host) => `${url.protocol}//${host}${port}${AUTH_PATH}`);
  return [...new Set([derived, ...aliases])];
}

/**
 * An absolute http(s) URL written exactly as GoTrue stamps it. jose compares
 * `iss` byte for byte, so a value a log line would show identically to the
 * real issuer — an invisible or non-ASCII character, `https:host` without the
 * slashes, embedded credentials — is refused at boot instead of 401-ing every
 * request behind a log that looks right.
 */
function isIssuerUrl(value: string): boolean {
  if (!/^https?:\/\/[\x21-\x7e]+$/.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password;
  } catch {
    return false;
  }
}

function audienceMatches(aud: unknown): boolean {
  const expected = expectedAudience();
  return aud === expected || (Array.isArray(aud) && aud.includes(expected));
}

/**
 * Turns an issuer fault on a CORRECTLY SIGNED token into a config error, so
 * the guard logs it: jose validates claims only after the signature, so
 * producing one needs the signing key and hands an unauthenticated caller
 * nothing. Two causes look alike and both need an operator — the expected
 * issuer is wrong (every user gets 401 with no other signal), or another Auth
 * server shares this secret or key set (the attack this check blocks; this
 * line is its only trace) — so the message names both. The received value is
 * a trusted signer's, JSON-quoted and cut short; `logKey` keeps the guard's
 * throttle at one line per kind however many issuers a key holder writes.
 *
 * A MISSING `iss` is logged only on a token shaped like a user's (`sub` and
 * our audience); storage URL tokens and the anon/service-role keys never are,
 * so they stay ordinary bad tokens.
 */
function issuerMismatch(error: unknown): TokenVerificationError | null {
  const fault = error as { code?: string; claim?: string; reason?: string; payload?: JWTPayload };
  if (fault?.code !== 'ERR_JWT_CLAIM_VALIDATION_FAILED' || fault.claim !== 'iss') return null;
  const payload = fault.payload ?? {};
  const expected = JSON.stringify(expectedIssuers());
  if (fault.reason === 'check_failed') {
    const received = (JSON.stringify(payload.iss) ?? 'undefined').slice(0, 200);
    return new TokenVerificationError(
      `Auth issuer mismatch: a correctly signed token carries the issuer ${received}, but this ` +
        `API expects ${expected}. Either the expected issuer is wrong — set SUPABASE_JWT_ISSUER ` +
        'to the issuer your Auth server stamps, or fix SUPABASE_URL — or another Auth server ' +
        'shares this signing secret or key set: rotate it.',
      true,
      'issuer-mismatch',
    );
  }
  if (fault.reason === 'missing' && typeof payload.sub === 'string' && audienceMatches(payload.aud)) {
    return new TokenVerificationError(
      `Auth issuer missing: a correctly signed user token carries no issuer, so it cannot match ` +
        `${expected}. Either your Auth server stamps none — configure its issuer — or another ` +
        'signer shares this signing secret or key set: rotate it.',
      true,
      'issuer-missing',
    );
  }
  return null;
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
  const strict = !insecureLocalAuth();
  const localHint =
    ' (For local development run `pnpm setup`, which writes ' +
    'ALLOW_INSECURE_LOCAL_AUTH=true alongside a loopback SUPABASE_URL.)';

  if (strict && scheme === 'auto') {
    throw new Error(
      'SUPABASE_JWT_SCHEME must be pinned to "hs256" or "jwks" for a non-local ' +
        'Supabase project. Accepting both lets a leaked legacy secret mint tokens ' +
        'even after the project moved to asymmetric keys.' +
        localHint,
    );
  }
  if (strict && secret === DEMO_JWT_SECRET) {
    throw new Error(
      'SUPABASE_JWT_SECRET is still the publicly known Supabase demo secret. ' +
        'Anyone could forge a super_admin token.' +
        localHint,
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
  const issuer = process.env.SUPABASE_JWT_ISSUER;
  if (issuer && !isIssuerUrl(issuer)) {
    throw new Error(
      'SUPABASE_JWT_ISSUER must be the exact absolute http(s) URL your Auth server stamps ' +
        `in a token's iss claim — printable ASCII, no credentials (for example https://<host>${AUTH_PATH}).`,
    );
  }
  if (!expectedIssuers()) {
    throw new Error(
      'Cannot determine the expected token issuer: set SUPABASE_URL (the issuer defaults to ' +
        `its origin + ${AUTH_PATH}) or SUPABASE_JWT_ISSUER. Without it a token minted by ` +
        'another Auth server sharing this secret or key set would be accepted.',
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
    const options = { ...verifyOptions(), algorithms: [...HS_ALGORITHMS] };
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), options);
      return payload;
    } catch (error) {
      throw issuerMismatch(error) ?? error;
    }
  }

  private async verifyWithJwks(token: string): Promise<JWTPayload> {
    const jwks = this.getJwks();
    // Outside the try: an unknown issuer is a config error of its own, not a JWKS outage.
    const options = { ...verifyOptions(), algorithms: [...ASYMMETRIC_ALGORITHMS] };
    try {
      const { payload } = await jwtVerify(token, jwks, options);
      return payload;
    } catch (error) {
      const mismatch = issuerMismatch(error);
      if (mismatch) throw mismatch;
      // Anything that is NOT a fault of the presented token is OUR outage and
      // must be visible, otherwise it is indistinguishable from "everyone's
      // token expired" — the exact symptom this file exists to eliminate.
      // Allow-listing the token faults (rather than enumerating the failures)
      // is what catches the modes that actually happen: jose raises a bare
      // JOSEError for a 404, a proxy 5xx, a redirect or a non-JSON body.
      const code = (error as { code?: string }).code;
      if (!TOKEN_FAULT_CODES.has(code ?? '')) {
        throw new TokenVerificationError(
          `Auth is degraded: could not use the JWKS at ${this.jwksUrl() ?? 'SUPABASE_URL'} ` +
            `(${code ?? (error as Error)?.name ?? 'unknown error'}).`,
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
