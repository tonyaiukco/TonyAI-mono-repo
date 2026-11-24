import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { ADMIN_EMAIL, login } from './helpers';

/**
 * The headers every web response carries, and the enforced content security
 * policy against every screen a pilot user opens (Decisions 2026-11-09;
 * `pre-g5-security-hardening`: the resource directives are enforced, and
 * violations are reported to the API).
 */
function expectSecurityHeaders(response: APIResponse): void {
  const headers = response.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  const policy = headers['content-security-policy'];
  for (const directive of ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'",
    "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", 'connect-src ']) {
    expect(policy, directive).toContain(directive);
  }
  expect(policy).toMatch(/report-uri \S+\/security\/csp-reports$/);
  expect(policy).not.toContain('report-to');
  expect(headers['content-security-policy-report-only']).toBeUndefined();
  expect(headers['x-powered-by']).toBeUndefined();
}

test('a page and a redirect both carry the security headers', async ({ request }) => {
  const page = await request.get('/login');
  expect(page.status()).toBe(200);
  expectSecurityHeaders(page);

  const redirect = await request.get('/', { maxRedirects: 0 });
  expect(redirect.status()).toBeGreaterThanOrEqual(300);
  expect(redirect.status()).toBeLessThan(400);
  expectSecurityHeaders(redirect);
});

test('another origin cannot frame a page', async ({ page, baseURL }) => {
  await page.goto('about:blank');
  await page.setContent('<iframe id="framed" title="framed"></iframe>');
  await page.evaluate((src) => document.getElementById('framed')!.setAttribute('src', src), `${baseURL}/login`);
  // The browser refuses the page and shows its own error document in the frame.
  await expect.poll(() => page.frames()[1]?.url(), { timeout: 15_000 }).toMatch(/^chrome-error:/);
});

/** Collects every CSP message the console prints while `walk` runs. */
async function violationsWhile(page: Page, walk: () => Promise<void>): Promise<string[]> {
  const violations: string[] = [];
  const listener = (message: { text(): string }) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(message.text())) violations.push(message.text());
  };
  page.on('console', listener);
  try {
    await walk();
  } finally {
    page.off('console', listener);
  }
  return violations;
}

test('every pilot screen loads under the enforced policy with no violation', async ({ page }) => {
  const signedOut = await violationsWhile(page, async () => {
    for (const path of ['/login', '/register', '/forgot-password']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }
  });
  expect(signedOut).toEqual([]);

  const signedIn = await violationsWhile(page, async () => {
    await login(page, ADMIN_EMAIL);
    for (const path of ['/', '/emissions', '/data-entry', '/review', '/reports', '/users', '/subsidiaries', '/inventory-boundary', '/audit']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }
  });
  expect(signedIn).toEqual([]);
});

test('a script from another origin is blocked, not merely reported', async ({ page }) => {
  await page.goto('/login');
  const violation = await page.evaluate(
    () =>
      new Promise<{ directive: string; disposition: string; blocked: string }>((resolve) => {
        document.addEventListener('securitypolicyviolation', (event) =>
          resolve({ directive: event.effectiveDirective, disposition: event.disposition, blocked: event.blockedURI }),
        );
        const script = document.createElement('script');
        script.src = 'https://blocked.invalid/injected.js';
        document.head.appendChild(script);
      }),
  );
  expect(violation).toEqual({ directive: 'script-src-elem', disposition: 'enforce', blocked: 'https://blocked.invalid/injected.js' });
});
