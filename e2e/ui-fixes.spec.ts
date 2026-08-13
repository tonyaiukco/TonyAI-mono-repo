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
    // Pinned: below the `sm` breakpoint the two fields STACK, and the
    // side-by-side assertion below does not go vacuous — it fails outright
    // (measured at 375px). The suite happens to run one Desktop Chrome project;
    // adding a mobile one would turn this red for a reason unrelated to DE-1.
    await page.setViewportSize({ width: 1280, height: 720 });
    await login(page, ADMIN_EMAIL);
    await page.goto(`/data-entry?subsidiaryId=${sub.id}&category=Electricity&year=2026`);
    await expect(page.getByRole('heading', { name: 'Data Entry' })).toBeVisible();

    // No `.last()`: a second field sharing the label should fail loudly in
    // strict mode, not be silently measured.
    const field = (label: string) =>
      page.locator('div.space-y-2').filter({ has: page.getByText(label, { exact: true }) });
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

/**
 * Note what this can and cannot prove: Playwright keeps pages `visible`, so a
 * real alt-tab is not reproducible here. It asserts that `window.focus` is wired
 * to a silent refresh; the `visibilitychange` half is covered by the manual UAT
 * case, not by this.
 */
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
    // The background refresh must NOT blank the page into skeletons — that is
    // the whole point of `silent`, and nothing else asserts it.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(locations).toHaveText(`${Number(before) + 1}Locations`);
  } finally {
    await request.delete(`${API_BASE}/locations/${loc.id}`, { headers: bearer(token) });
  }
});

test('DASH-1: a background refresh neither blanks the page nor stampedes', async ({
  page,
  request,
}) => {
  // Both of these needed controlled timing to test at all — asserting after the
  // fetch has already resolved proves nothing, which is how the first attempt at
  // these guards passed against code that had neither behaviour.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  await login(page, ADMIN_EMAIL);

  let kpiCalls = 0;
  await page.route('**/api/v1/kpi', async (route) => {
    kpiCalls += 1;
    // Hold it open long enough to observe what the page does MEANWHILE.
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });

  const created = await request.post(`${API_BASE}/locations`, {
    headers: bearer(token),
    data: { subsidiaryId: SUB.energy, name: 'E2E Stampede Probe', geographyCode: 'TR' },
  });
  const loc = await created.json();

  try {
    // Five focus events in quick succession: a real alt-tab already fires two
    // (focus AND visibilitychange), so without coalescing one return reloaded
    // the whole dashboard twice — eight requests.
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('focus'));
    });

    // While the refresh is in flight the page must still show its data.
    await page.waitForTimeout(400);
    expect(await page.getByText('Loading…').count(), 'a silent refresh blanked the page').toBe(0);
    await expect(page.getByRole('cell', { name: 'TonyAI Energy A.Ş.' })).toBeVisible();

    await expect(page.getByText('Locations', { exact: true }).locator('..')).toContainText('9');
    expect(kpiCalls, 'five focus events should coalesce into one refresh').toBe(1);
  } finally {
    await page.unroute('**/api/v1/kpi');
    await request.delete(`${API_BASE}/locations/${loc.id}`, { headers: bearer(token) });
  }
});
