import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, E2E_YEAR, login } from './helpers';

/** The main total is Scope 1 + 2; Scope 3 is shown beside it, labelled (Decisions 2026-11-09 (3)). */
test('Emissions labels Scope 3 as outside the total, and a Scope 3 selection is not an empty year', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto(`/emissions?year=${E2E_YEAR}&subsidiaryId=all&scope=all&category=all`);
  await expect(page.getByTestId('summary-scope3')).toBeVisible();
  await expect(page.getByText('Not covered — outside the total').first()).toBeVisible();
  await expect(page.getByText('Value chain (Phase 2)')).toHaveCount(0);

  await page.goto(`/emissions?year=${E2E_YEAR}&subsidiaryId=all&scope=3&category=all`);
  await expect(page.getByTestId('summary-scope3')).toBeVisible();
  await expect(page.getByText('No Scope 1 or 2 figures for the selected filters.')).toHaveCount(0);
});

test('the dashboard warns about its non-authoritative figures, read from the server', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto(`/?year=${E2E_YEAR}&subsidiaryId=all&scope=all&category=all`);
  await expect(page.getByText('Scope 1 + 2 total').first()).toBeVisible();
  // The local library prices on placeholder factors, so the warning shows here; hosted hides it.
  await expect(page.getByTestId('dashboard-non-authoritative')).toContainText('placeholder (demo)');
});
