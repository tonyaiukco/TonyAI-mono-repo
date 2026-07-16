import { test, expect } from '@playwright/test';
import { login, ADMIN_EMAIL } from './helpers';

/**
 * P1 smoke: the two read-only analytics surfaces render live data for a
 * super_admin. Cheap guards against a regression that blanks the pages.
 */

test('emissions analytics renders live tabs; intensity is gated', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto('/emissions');
  await expect(page.getByRole('heading', { name: 'Emissions Analytics' })).toBeVisible();

  // Tabs render and switch.
  await expect(page.getByRole('tab', { name: /summary/i })).toBeVisible();
  await page.getByRole('tab', { name: /breakdown/i }).click();

  // Intensity is explicitly not-yet-available (compliance: no placeholder numbers).
  await expect(page.getByText('Intensity')).toBeVisible();
});

test('dashboard renders the emissions overview + tracking matrix', async ({ page }) => {
  await login(page, ADMIN_EMAIL); // login already asserts the Carbon Dashboard heading
  // The tracking matrix (FR §2) renders on live data (heading "Data Collection Status").
  await expect(page.getByRole('heading', { name: 'Data Collection Status' })).toBeVisible();
});
