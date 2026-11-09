import { expect, test, type APIResponse } from '@playwright/test';
import { ADMIN_EMAIL, login } from './helpers';

/**
 * The headers every web response carries, and the report-only policy's sources
 * against the screens a pilot user opens (Decisions 2026-11-09). The resource
 * directives are enforced only once this has held on hosted, after QA round 2.
 */
function expectSecurityHeaders(response: APIResponse): void {
  const headers = response.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
  expect(headers['content-security-policy']).toBe("frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  expect(headers['content-security-policy-report-only']).toContain("default-src 'self'");
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

test('the pilot screens load with no report-only violation', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(message.text())) violations.push(message.text());
  });
  await login(page, ADMIN_EMAIL);
  for (const path of ['/', '/emissions', '/reports']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
  }
  expect(violations).toEqual([]);
});
