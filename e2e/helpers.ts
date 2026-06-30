import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'TonyAI!2026';
export const ADMIN_EMAIL = 'admin@tonyai.local';
export const ENTRY_EMAIL = 'entry@tonyai.local';

/**
 * Logs in via the real Supabase-backed login form and waits to land on the
 * dashboard (middleware redirects unauthenticated users to /login).
 */
export async function login(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // After sign-in the app routes to "/" (Carbon Dashboard).
  await expect(page.getByRole('heading', { name: 'Carbon Dashboard' })).toBeVisible();
}

/** Rows in the live "Subsidiary register" table on /subsidiaries (excludes header). */
export function subsidiaryRows(page: Page) {
  return page.locator('table tbody tr');
}
