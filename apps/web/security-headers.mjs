/**
 * The headers every web response carries (Decisions 2026-11-09). The structural
 * CSP directives are enforced now. The resource directives are report-only until
 * they are enforced after QA round 2, before the pen-test, because a wrong source
 * there would break a screen during QA.
 *
 * Next's inline scripts and styles need 'unsafe-inline' here. `connect-src` names
 * the hosts the browser calls, read from the NEXT_PUBLIC_* values that an image
 * inlines at build, so a value this file cannot read as a URL is left out rather
 * than failing the build.
 */
const originOf = (value) => {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
};

const ENFORCED_POLICY = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

export function reportOnlyPolicy(env = process.env) {
  const connect = [
    "'self'",
    originOf(env.NEXT_PUBLIC_API_BASE_URL),
    originOf(env.NEXT_PUBLIC_SUPABASE_URL),
    originOf(env.NEXT_PUBLIC_SENTRY_DSN),
  ].filter(Boolean);
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${[...new Set(connect)].join(' ')}`,
  ].join('; ');
}

export function securityHeaders(env = process.env) {
  return [
    // As the API sets it. A production image's value is fixed at its build.
    ...(env.NODE_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }] : []),
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'Content-Security-Policy', value: ENFORCED_POLICY },
    { key: 'Content-Security-Policy-Report-Only', value: reportOnlyPolicy(env) },
  ];
}
