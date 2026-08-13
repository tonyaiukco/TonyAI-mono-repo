import { test, expect } from '@playwright/test';
import { login, bearer, getAccessToken, ADMIN_EMAIL, API_BASE, SUB } from './helpers';

/**
 * WP15 slice (a) — round-1 DE-6 + DE-7.
 *
 * The tester asked for Türkiye as a selectable "grid region". The field they
 * were looking at was metadata that never reached the calculation engine, so
 * this covers what was done instead: the geographies that DO drive the factor
 * offer UK + Türkiye by name, `EU` is hidden without becoming unreachable, and
 * Data Entry states the geography it will actually use.
 */

const geoCombo = (scope: import('@playwright/test').Locator, page: import('@playwright/test').Page) =>
  scope.locator('div.space-y-2').filter({ has: page.getByText('Geography', { exact: false }) }).last().getByRole('combobox');

test('geography pickers offer UK + Türkiye by name, not raw codes', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto('/subsidiaries');
  await page.getByRole('button', { name: 'Add Subsidiary' }).click();

  const dialog = page.getByRole('dialog');
  await geoCombo(dialog, page).click();
  expect(await page.getByRole('option').allTextContents()).toEqual([
    'United Kingdom (UK)',
    'Türkiye (TR)',
  ]);
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('a subsidiary on a hidden geography opens on it, and a mis-click is reversible', async ({
  page,
  request,
}) => {
  // The blank-trigger trap: a Radix Select bound to a value with no matching
  // item renders EMPTY — no error, no placeholder — and a blind save still
  // submits the old value. Exercised on a record this test owns, so the seeded
  // Munich subsidiary keeps its audit history clean.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const created = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: { legalName: 'E2E Test Co Hidden Geo', geographyCode: 'EU', reportingStatus: 'pending' },
  });
  expect(created.status()).toBe(201);

  await login(page, ADMIN_EMAIL);
  await page.goto('/subsidiaries');
  await page
    .locator('tr', { hasText: 'E2E Test Co Hidden Geo' })
    .getByRole('button', { name: 'Edit subsidiary' })
    .click();

  const dialog = page.getByRole('dialog');
  await expect(geoCombo(dialog, page)).toContainText('European Union (EU)');

  // Change it away and back: the hidden code must not disappear from the list
  // the moment you leave it, or Cancel — which discards every other edit — is
  // the only way home.
  await geoCombo(dialog, page).click();
  await page.getByRole('option', { name: 'United Kingdom (UK)' }).click();
  await geoCombo(dialog, page).click();
  await expect(page.getByRole('option', { name: 'European Union (EU)' })).toBeVisible();
  await page.getByRole('option', { name: 'European Union (EU)' }).click();

  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Subsidiary settings updated successfully.')).toBeVisible();

  const subs = await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) })).json();
  const row = subs.find((s: { legalName: string }) => s.legalName === 'E2E Test Co Hidden Geo');
  expect(row.geographyCode).toBe('EU');
  await request.delete(`${API_BASE}/subsidiaries/${row.id}`, { headers: bearer(token) });
});

test('the locations drawer keeps a hidden geography reachable too', async ({ page, request }) => {
  // Half of this PR's fix lived here with no guard at all: reverting the drawer
  // to raw codes without the escape hatch left the whole suite green, while a
  // super_admin adding a location under an EU subsidiary would face a blank
  // REQUIRED control and save a geography they never chose.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  await login(page, ADMIN_EMAIL);
  await page.goto('/subsidiaries');
  await page
    .locator('tr', { hasText: 'TonyAI Manufacturing GmbH' })
    .getByRole('button', { name: 'Manage locations' })
    .click();

  const drawer = page.getByRole('dialog');
  // The ADD form seeds the parent's geography — the case that would blank.
  await expect(geoCombo(drawer, page)).toContainText('European Union (EU)');
  await expect(page.getByRole('button', { name: /^Add location$/ })).toBeVisible();
  void token;
});

test('Data Entry states the geography it will use — subsidiary and location', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto(`/data-entry?subsidiaryId=${SUB.energy}&category=Electricity&year=2026`);
  await expect(page.getByRole('heading', { name: 'Data Entry' })).toBeVisible();

  // The metadata picker that claimed to choose the factor is gone.
  await expect(page.getByText('Grid Region')).toHaveCount(0);

  const line = page.getByText(/Factor geography:/);
  await expect(line).toContainText('TR');
  await expect(line).toContainText('Türkiye');
  await expect(line).toContainText('(subsidiary)');

  // Targeting a location must switch both the geography AND the stated source —
  // this same value feeds the live preview, so getting the precedence wrong
  // shows a figure computed against a different factor than the one that saves.
  await page.locator('div.space-y-2').filter({ has: page.getByText('Location', { exact: true }) }).last().getByRole('combobox').click();
  const locOption = page.getByRole('option').nth(1);
  const locName = (await locOption.textContent())?.trim() ?? '';
  await locOption.click();
  await expect(line).toContainText('(location)');
  await expect(line).toContainText(locName.replace(/\s*\(.*\)$/, ''));
});
