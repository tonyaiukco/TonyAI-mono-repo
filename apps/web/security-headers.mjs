/**
 * The headers every web response carries (Decisions 2026-11-09;
 * `pre-g5-security-hardening`). One content security policy, enforced: the
 * structural directives and the resource directives together. The resource
 * directives were report-only until QA round 2; the pen-test is next.
 *
 * Next's inline bootstrap scripts and the chart's injected style need
 * 'unsafe-inline' until a nonce pipeline exists (Open questions). `connect-src`
 * names the hosts the browser calls, read from the NEXT_PUBLIC_* values that an
 * image inlines at build, so a value this file cannot read as a URL is left out
 * rather than failing the build.
 *
 * Violations go to the API's report receiver (`POST /security/csp-reports`)
 * through `report-uri` alone. Chrome, Firefox and Safari all post it at once;
 * with `report-to` present Chrome ignores `report-uri` and queues the report
 * in its Reporting API instead, which headless Chrome did not deliver within
 * 100 s (measured, `pre-g5-security-hardening`). Without an API URL (a bare
 * local build) the policy names no receiver rather than a guess.
 */
const originOf = (value) => {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
};

/** The API's report receiver, or null when the API URL cannot be read. */
export function cspReportUrl(env = process.env) {
  try {
    if (!env.NEXT_PUBLIC_API_BASE_URL) return null;
    const base = new URL(env.NEXT_PUBLIC_API_BASE_URL);
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/security/csp-reports`;
    base.search = '';
    base.hash = '';
    return base.toString();
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(env = process.env) {
  const connect = [
    "'self'",
    originOf(env.NEXT_PUBLIC_API_BASE_URL),
    originOf(env.NEXT_PUBLIC_SUPABASE_URL),
    originOf(env.NEXT_PUBLIC_SENTRY_DSN),
  ].filter(Boolean);
  const report = cspReportUrl(env);
  return [
    // Structural.
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    // Resources.
    "default-src 'self'",
    // `next dev` only: React's development build evaluates code to rebuild
    // stack traces. A built image (NODE_ENV production) never allows eval.
    `script-src 'self' 'unsafe-inline'${env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${[...new Set(connect)].join(' ')}`,
    ...(report ? [`report-uri ${report}`] : []),
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
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(env) },
  ];
}
