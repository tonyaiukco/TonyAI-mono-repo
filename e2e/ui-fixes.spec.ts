import { test, expect } from '@playwright/test';
import { login, bearer, getAccessToken, ADMIN_EMAIL, API_BASE, SUB } from './helpers';

/**
 * WP15 slice (d) — round-1 DE-1 + DASH-1.
 */

test('DE-1: a very long subsidiary name does not push the control over its neighbour', async ({
  page,
  request,
}) => {
  // Asserted on GEOMETRY, not text. The overflow came from the trigger sizing to
  // its content (`w-fit` + `whitespace-nowrap`), so every text assertion passes
  // while the box quietly covers the field beside it.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const longName =
    'E2E Test Co Extraordinarily Long Legal Entity Name For Layout Verification A.Ş.';
  const created = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: { legalName: longName, geographyCode: 'TR', reportingStatus: 'active' },
  });
  expect(created.status()).toBe(201);
  const sub = await created.json();

  try {
    await login(page, ADMIN_EMAIL);
    await page.goto(`/data-entry?subsidiaryId=${sub.id}&category=Electricity&year=2026`);
    await expect(page.getByRole('heading', { name: 'Data Entry' })).toBeVisible();

    const field = (label: string) =>
      page.locator('div.space-y-2').filter({ has: page.getByText(label, { exact: true }) }).last();
    const subBox = await field('Subsidiary').getByRole('combobox').boundingBox();
    const locBox = await field('Location').getByRole('combobox').boundingBox();
    expect(subBox && locBox).toBeTruthy();

    // The two controls sit in adjacent grid columns: the first must end before
    // the second begins.
    expect(
      subBox!.x + subBox!.width,
      'the Subsidiary control overlaps the Location control',
    ).toBeLessThanOrEqual(locBox!.x);

    // …and the long name must be clipped rather than expanding the box.
    const trigger = field('Subsidiary').getByRole('combobox');
    const scrollW = await trigger.evaluate((el) => el.scrollWidth);
    const clientW = await trigger.evaluate((el) => el.clientWidth);
    expect(scrollW, 'the trigger grew to fit the name instead of clipping it').toBeLessThanOrEqual(
      clientW + 1,
    );
  } finally {
    await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) });
  }
});

test('DASH-1: the dashboard picks up a location added elsewhere when the tab regains focus', async ({
  page,
  request,
}) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const locations = page.getByText('Locations', { exact: true }).locator('..');

  await login(page, ADMIN_EMAIL);
  const before = (await locations.textContent())?.replace(/\D/g, '');

  const created = await request.post(`${API_BASE}/locations`, {
    headers: bearer(token),
    data: { subsidiaryId: SUB.energy, name: 'E2E Focus Probe Site', geographyCode: 'TR' },
  });
  expect(created.status()).toBe(201);
  const loc = await created.json();

  try {
    // Still stale: nothing on this page knows the write happened.
    await page.waitForTimeout(500);
    expect((await locations.textContent())?.replace(/\D/g, '')).toBe(before);

    // Coming back to the tab is what refreshes it.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(locations).toHaveText(new RegExp(String(Number(before) + 1)));
  } finally {
    await request.delete(`${API_BASE}/locations/${loc.id}`, { headers: bearer(token) });
  }
});
