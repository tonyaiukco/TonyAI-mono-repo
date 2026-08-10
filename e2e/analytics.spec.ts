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
  // Scoped to one year: without it the endpoint folds every year into a cell,
  // so a subsidiary complete for 2023 and empty for 2024 reads as complete.
  await expect(
    page.getByRole('heading', { name: /Data Collection Status/ }),
  ).toContainText('2024');
});

test('a matrix cell opens Data Entry for THAT subsidiary and category', async ({
  page,
}) => {
  // Round-1 UAT DASH-2: the cells said "click to view details" and every one of
  // them opened the same subsidiary drawer, dropping the category entirely.
  await login(page, ADMIN_EMAIL);
  await expect(page.getByRole('heading', { name: 'Data Collection Status' })).toBeVisible();

  // Addressed by the cell's own accessible name rather than by grid position —
  // a positional locator would silently follow a column reorder.
  await page.getByRole('button', { name: 'TonyAI Energy Electricity' }).click();

  await page.waitForURL(/\/data-entry\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get('category')).toBe('Electricity');
  expect(url.searchParams.get('year')).toBe('2024');
  expect(url.searchParams.get('subsidiaryId')).toBeTruthy();

  // The form arrives on that category rather than the page default.
  await expect(page.getByRole('heading', { name: 'Data Entry' })).toBeVisible();
  await expect(page.getByText('Electricity').first()).toBeVisible();
});
