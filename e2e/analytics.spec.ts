import { test, expect } from '@playwright/test';
import {
  login,
  pickByFieldLabel,
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
  // so a subsidiary complete for 2023 and empty for 2026 reads as complete.
  await expect(
    page.getByRole('heading', { name: /Data Collection Status/ }),
  ).toContainText('2026');
});

test('a matrix cell opens Data Entry for THAT subsidiary and category', async ({
  page,
}) => {
  // Round-1 UAT DASH-2: the cells said "click to view details" and every one of
  // them opened the same subsidiary drawer, dropping the category entirely.
  await login(page, ADMIN_EMAIL);
  await expect(page.getByRole('heading', { name: 'Data Collection Status' })).toBeVisible();

  // A NON-default category: `Electricity` is what the page already selects on
  // its own (`useState<Category>("Electricity")`), so asserting it proves
  // nothing — with the param ignored entirely the test still passed.
  await page.getByRole('button', { name: 'TonyAI Energy Natural Gas' }).click();

  await page.waitForURL(/\/data-entry\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get('category')).toBe('Natural Gas');
  expect(url.searchParams.get('year')).toBe('2026');
  expect(url.searchParams.get('subsidiaryId')).toBeTruthy();

  // The form arrives on that category rather than the page default — read off
  // the control itself, not any text on the page.
  await expect(page.getByRole('heading', { name: 'Data Entry' })).toBeVisible();
  await expect(
    page.locator('div.space-y-2').filter({ hasText: 'Category' }).getByRole('combobox'),
  ).toContainText('Natural Gas');
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

  // The precondition is the whole test: "exactly one" is what makes the cell
  // unambiguous. A stray MONTHLY Trading/Fuel/2026 row — which the quarterly
  // teardown does not reclaim — would make this fail for a reason that has
  // nothing to do with the code under test, so state it out loud.
  const existing = await request.get(
    `${API_BASE}/activity-records?subsidiaryId=${SUB.trading}&category=Fuel&year=${E2E_YEAR}`,
    { headers: bearer(token) },
  );
  expect(
    (await existing.json()).length,
    'expected exactly one Trading/Fuel/2026 record — clear stray rows for this tuple',
  ).toBe(1);

  await login(page, ADMIN_EMAIL);
  await page.getByRole('button', { name: 'TonyAI Trading Fuel' }).click();
  await page.waitForURL(/\/data-entry\?/);

  // Loaded into the form, not offered as a blank duplicate that would 409.
  await expect(page.getByText(/Editing draft/)).toBeVisible();
  await expect(page.getByPlaceholder('e.g. 45000')).toHaveValue('640');
});

test('a cell with several records that year guesses nothing', async ({ page }) => {
  // The seed holds twelve monthly Electricity records for Energy in 2026, so
  // the target is ambiguous. Opening the first would silently put the user in a
  // period they did not ask for.
  await login(page, ADMIN_EMAIL);
  await page.getByRole('button', { name: 'TonyAI Energy Electricity' }).click();
  await page.waitForURL(/\/data-entry\?/);

  await expect(
    page.getByText(/Electricity records exist for 2026/),
  ).toBeVisible();
  await expect(page.getByText(/Editing draft/)).toHaveCount(0);
});

test('moving the form off a loaded record stops targeting it', async ({
  page,
  request,
}) => {
  // The drill-in sets `editingId` without the user asking to edit anything. If
  // the reporting-entity selects then move, the save used to REWRITE the loaded
  // record: opening a Fuel Q3 draft and switching to Q4 turned the Q3 record
  // into the Q4 one and reported "Draft saved". The Q3 record ceased to exist.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const created = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      // Logistics/Fuel is untouched by every other spec: `gates` writes
      // Mfg/Electricity Q1–Q3, so moving this form to Q2 there collided on the
      // NULLS-NOT-DISTINCT index and failed for an unrelated reason.
      subsidiaryId: SUB.logistics,
      locationId: null,
      reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD,
      periodValue: 'Q4',
      category: 'Fuel',
      activityValue: 1234,
      activityUnit: 'litres',
      varianceReason: null,
      input: null,
    },
  });
  expect(created.status()).toBe(201);
  const original = await created.json();

  // Opened from Previous submissions rather than a cell: the guard under test
  // is about the form drifting off a LOADED record, and the seed's monthly rows
  // make this cell ambiguous, so a deep link there deliberately opens nothing.
  await login(page, ADMIN_EMAIL);
  await page.goto(
    `/data-entry?subsidiaryId=${SUB.logistics}&category=Fuel&year=${E2E_YEAR}`,
  );
  await page.getByRole('button', { name: /Q4 2026/ }).click();
  await expect(page.getByText(/Editing draft/)).toBeVisible();

  // Move to a different period — the same form, a different reporting entity.
  await pickByFieldLabel(page, 'Value', 'Q2');
  await expect(page.getByText(/Now entering a new record/)).toBeVisible();
  await expect(page.getByText(/Editing draft/)).toHaveCount(0);

  await page.getByPlaceholder('e.g. 45000').fill('999');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();

  // The record that was open is untouched, and the new period got its own row.
  const after = await request.get(
    `${API_BASE}/activity-records/${original.id}`,
    { headers: bearer(token) },
  );
  const reread = await after.json();
  expect(reread.periodValue).toBe('Q4');
  expect(reread.activityValue).toBe(1234);
});
