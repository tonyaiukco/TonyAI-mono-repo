import { test, expect } from '@playwright/test';
import { login, pickByFieldLabel, ADMIN_EMAIL } from './helpers';

/**
 * Targets & intensity (WP5): the Targets tab shows live progress against
 * committed emissions (seeded demo targets), a super_admin can create a target,
 * and the Intensity toggle reveals configured metrics. E2E rows use the `E2E-`
 * sentinel so the global teardown removes exactly them (seed preserved).
 */

test('targets: seeded progress + create round-trip', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto('/emissions');
  await page.getByRole('tab', { name: 'Targets' }).click();

  // Seeded targets render. The Scope-1 target has a 2024 baseline, so its
  // progress is honestly "n/a" regardless of any other test's data (a stable
  // assertion; exact % status depends on mutable committed emissions).
  await expect(page.getByText('Manufacturing SBTi 1.5°C')).toBeVisible();
  await expect(page.getByText('Net-zero pathway 2030')).toBeVisible();
  await expect(page.getByText(/no committed data for a year after the 2024 baseline/i)).toBeVisible();

  // Create a target (sentinel name) via the super_admin dialog.
  await page.getByRole('button', { name: 'Add target' }).click();
  await pickByFieldLabel(page, 'Subsidiary', 'TonyAI Energy (TR)');
  await page.getByPlaceholder('e.g. Net-zero pathway 2030').fill('E2E-target');
  await page.getByPlaceholder('e.g. 1600').fill('2000');
  await page.getByPlaceholder('e.g. 900').fill('1000');
  await page.getByRole('button', { name: 'Create target' }).click();

  await expect(page.getByText('Target created')).toBeVisible();
  await expect(page.getByText('E2E-target')).toBeVisible();
  // The `E2E-` sentinel row is removed by the global teardown (seed preserved).
});

test('targets: intensity toggle reveals configured metrics', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto('/emissions');

  await page.getByRole('button', { name: 'Intensity' }).click();
  await expect(page.getByRole('heading', { name: /Emissions intensity/i })).toBeVisible();
  // Seeded denominators → the Revenue metric card is shown.
  await expect(page.getByText('Revenue').first()).toBeVisible();
});
