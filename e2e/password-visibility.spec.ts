import { test, expect, type Page } from '@playwright/test';
import { login, ENTRY_EMAIL, profileIdByEmail } from './helpers';

/**
 * UAT BUG-09 (`web-form-controls`, "Password fields offer a show/hide toggle"):
 * every password field starts masked, a button reveals and re-masks it, and the
 * button never submits its form. Nothing here submits a password form, so no
 * account's password changes.
 */

/** Counts sign-in attempts: a submitted sign-in form asks Auth for a token. */
function countTokenRequests(page: Page): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (request.url().includes('/auth/v1/token')) count += 1;
  });
  return () => count;
}

test('sign-in: the password starts masked, and the toggle reveals and re-masks it', async ({ page }) => {
  await page.goto('/login');
  const password = page.locator('#password');
  await expect(password).toHaveAttribute('type', 'password');
  await password.fill('not-a-real-password');

  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(password).toHaveValue('not-a-real-password');
  const hide = page.getByRole('button', { name: 'Hide password' });
  await expect(hide).toHaveAttribute('aria-pressed', 'true');

  await hide.click();
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveValue('not-a-real-password');
  await expect(password).toHaveAttribute('autocomplete', 'current-password');
});

test('sign-in: Enter and Space on the toggle never submit the form', async ({ page }) => {
  const tokenRequests = countTokenRequests(page);
  await page.goto('/login');
  await page.locator('#email').fill('someone@example.com');
  await page.locator('#password').fill('not-a-real-password');

  await page.getByRole('button', { name: 'Show password' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#password')).toHaveAttribute('type', 'text');
  await page.keyboard.press('Space');
  await expect(page.locator('#password')).toHaveAttribute('type', 'password');

  // The real submit button still submits; the toggle never did.
  expect(tokenRequests()).toBe(0);
  await expect(page).toHaveURL(/\/login$/);
});

test('sign-in in Turkish: the toggle is labelled in Turkish', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'tonyai-locale', value: 'tr', url: baseURL ?? 'http://localhost:3000' }]);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Şifreyi göster' }).click();
  await expect(page.locator('#password')).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: 'Şifreyi gizle' })).toBeVisible();
});

test('set-password: each field starts masked and toggles on its own', async ({ page }) => {
  // The screen offers its fields only to a session an email link opened in
  // this tab (pre-g5-security-hardening): the tab is given the marker the
  // email-link page writes, for the signed-in user. The form is never submitted.
  await login(page, ENTRY_EMAIL);
  const userId = await profileIdByEmail(ENTRY_EMAIL);
  await page.evaluate((id) => sessionStorage.setItem('tonyai.emailLink', JSON.stringify({ userId: id, flow: 'invite', at: Date.now() })), userId);
  await page.goto('/auth/set-password');
  const first = page.locator('#new-password');
  const repeat = page.locator('#repeat-password');
  await expect(first).toBeEnabled();
  await expect(first).toHaveAttribute('type', 'password');
  await expect(repeat).toHaveAttribute('type', 'password');

  await page.getByRole('button', { name: 'Show password' }).first().click();
  await expect(first).toHaveAttribute('type', 'text');
  await expect(repeat).toHaveAttribute('type', 'password');
  await expect(first).toHaveAttribute('autocomplete', 'new-password');
});

test('set-password: a signed-in user who opens it directly gets no field, and is told to use their email link', async ({ page }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto('/auth/set-password');
  await expect(page.getByText('This page sets a password only right after you open the link from your email')).toBeVisible();
  await expect(page.locator('#new-password')).toHaveCount(0);
  await expect(page.locator('#repeat-password')).toHaveCount(0);

  // Another user's marker in this tab opens nothing either.
  await page.evaluate(() => sessionStorage.setItem('tonyai.emailLink', JSON.stringify({ userId: '00000000-0000-4000-8000-000000000000', flow: 'recovery', at: Date.now() })));
  await page.reload();
  await expect(page.getByText('This page sets a password only right after you open the link from your email')).toBeVisible();
  await expect(page.locator('#new-password')).toHaveCount(0);
});
