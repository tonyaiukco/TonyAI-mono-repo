import { test, expect } from '@playwright/test';
import {
  login,
  bearer,
  getAccessToken,
  ADMIN_EMAIL,
  API_BASE,
  E2E_PERIOD,
  E2E_YEAR,
  SUB,
} from './helpers';

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

test('a cell reopens the single record that already exists there', async ({
  page,
  request,
}) => {
  // The behaviour the deep link exists for, and the one a URL assertion cannot
  // see: this only worked in the browser after the effect stopped firing before
  // the records had loaded — an empty list read as "nothing exists" and burned
  // the single shot the effect gets.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const created = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    // A DRAFT, deliberately not submitted: the point is that it can be continued.
    data: {
      subsidiaryId: SUB.trading,
      locationId: null,
      reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD,
      periodValue: 'Q3',
      category: 'Fuel',
      activityValue: 640,
      activityUnit: 'litres',
      varianceReason: null,
      input: null,
    },
  });
  expect(created.status()).toBe(201);

  await login(page, ADMIN_EMAIL);
  await page.getByRole('button', { name: 'TonyAI Trading Fuel' }).click();
  await page.waitForURL(/\/data-entry\?/);

  // Loaded into the form, not offered as a blank duplicate that would 409.
  await expect(page.getByText(/Editing draft/)).toBeVisible();
  await expect(page.getByPlaceholder('e.g. 45000')).toHaveValue('640');
});

test('a cell with several records that year guesses nothing', async ({ page }) => {
  // The seed holds twelve monthly Electricity records for Energy in 2024, so
  // the target is ambiguous. Opening the first would silently put the user in a
  // period they did not ask for.
  await login(page, ADMIN_EMAIL);
  await page.getByRole('button', { name: 'TonyAI Energy Electricity' }).click();
  await page.waitForURL(/\/data-entry\?/);

  await expect(
    page.getByText(/Electricity records exist for 2024/),
  ).toBeVisible();
  await expect(page.getByText(/Editing draft/)).toHaveCount(0);
});
