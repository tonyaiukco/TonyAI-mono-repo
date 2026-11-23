import { test, expect } from '@playwright/test';
import enUsers from '../apps/web/messages/en/users.json';
import { ADMIN_EMAIL, login } from './helpers';

/**
 * Two tabs of one browser share one session (Codex review of #350). A page
 * opened directly — `/users` reads no reporting context, so it never mounted
 * the old listener — must not keep showing the previous user's data after the
 * other tab signs out: the root layout's `SessionWatch` sends it to sign-in.
 * Read-only: nothing is written.
 */
test('a sign-out in another tab takes a page opened directly on /users to sign-in', async ({ context, page }) => {
  await login(page, ADMIN_EMAIL);
  const users = await context.newPage();
  await users.goto('/users');
  await expect(users.getByRole('heading', { name: enUsers.title })).toBeVisible();
  await expect(users.getByText(ADMIN_EMAIL).first()).toBeVisible();

  await page.getByTestId('sign-out').click();
  await page.waitForURL('**/login');

  await users.waitForURL('**/login');
  await expect(users.getByText(ADMIN_EMAIL)).toHaveCount(0);
});

test('a page whose /me has not answered still follows a sign-out in another tab (Codex re-review of #350)', async ({ context, page }) => {
  await login(page, ADMIN_EMAIL);
  const users = await context.newPage();
  let held = false;
  // /me is held: the page knows no profile yet, only the session.
  await users.route('**/api/v1/me', async () => {
    held = true;
  });
  await users.goto('/users');
  await expect.poll(() => held).toBe(true);

  await page.getByTestId('sign-out').click();
  await page.waitForURL('**/login');

  await users.waitForURL('**/login');
});

test('a sign-out Auth cannot complete keeps the page and says so', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  // auth-js answers a failed logout call with an error and keeps the session.
  await page.route('**/auth/v1/logout**', (route) => route.abort());
  await page.getByTestId('sign-out').click();
  await expect(page.getByText('Could not sign out. Check your connection and try again.')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.getByTestId('dashboard-title')).toBeVisible();

  // With Auth reachable again, the same button signs out.
  await page.unroute('**/auth/v1/logout**');
  await page.getByTestId('sign-out').click();
  await page.waitForURL('**/login');
});
