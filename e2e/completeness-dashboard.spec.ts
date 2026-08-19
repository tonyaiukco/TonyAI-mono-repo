import { test, expect } from '@playwright/test';
import { ADMIN_EMAIL, login } from './helpers';

/**
 * The dashboard half of WP17 (round-1 UAT DASH-3).
 *
 * These assertions are all READ-ONLY against the seed: `TonyAI Energy` ships in
 * `location` granularity with two sites and three covered slots (Istanbul HQ,
 * January–March electricity), which is the shape the whole rule is meant to be
 * legible on. Nothing here writes, so it needs no quarterly-space isolation.
 */

test('an invoice-tracked cell shows its fraction, not a tonnage', async ({ page }) => {
  await login(page, ADMIN_EMAIL);

  // The number on the cell face IS the answer for these categories. A cell
  // showing "818" where the answer is "3 of 24 invoices" answers a question
  // nobody asked.
  const electricity = page.getByRole('button', {
    name: 'TonyAI Energy Electricity',
  });
  await expect(electricity).toHaveAccessibleName(/3 of 24 invoices/);
  await expect(electricity).toContainText('3/24');

  // A subsidiary measured as a whole keeps the old reading, in the same table.
  await expect(
    page.getByRole('button', { name: 'TonyAI Gas Electricity' }),
  ).toHaveAccessibleName(/tCO2e/);
});

test('a cell holding records is Partial, never Missing', async ({ page }) => {
  await login(page, ADMIN_EMAIL);

  // Natural Gas holds twelve approved, evidence-backed records worth real
  // tonnes — they simply are not attributed to a site. Calling that "Missing"
  // put a red cell displaying 198 tCO2e on the dashboard, which is the blocker
  // two review seats caught in PR 2.
  await expect(
    page.getByRole('button', { name: 'TonyAI Energy Natural Gas' }),
  ).toHaveAccessibleName(/Partial, 0 of 24 invoices/);

  // Water genuinely has no records at all, so it IS missing.
  await expect(
    page.getByRole('button', { name: 'TonyAI Energy Water' }),
  ).toHaveAccessibleName(/Missing, 0 of 24 invoices/);
});

test('the drawer names every open month, and says why the count is short', async ({
  page,
}) => {
  await login(page, ADMIN_EMAIL);
  await page.getByRole('button', { name: /TonyAI Energy.*per location/s }).click();

  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Invoices by site and month')).toBeVisible();
  await expect(drawer.getByText('Measured per location · 2 sites')).toBeVisible();

  // The three seeded invoices, and the twenty-one that are not there.
  await expect(
    // "and approved" is load-bearing. WP17 PR 4 split a closed slot into two
    // states, and the bare `/invoice attached/` matches BOTH — including
    // "invoice attached, waiting for review", which is the one this assertion
    // exists to distinguish from an accepted invoice.
    drawer.getByRole('button', {
      name: /Istanbul HQ January: invoice attached and approved/,
    }),
  ).toBeDisabled();
  // Nine of Electricity's twelve months are recorded company-wide, so every
  // uncovered slot in those months is a `◆` and the grid refuses the click
  // rather than inviting a second row for a month that already has one.
  await expect(
    drawer.getByRole('button', { name: /Ankara Power Plant July: recorded for the whole company/ }),
  ).toBeDisabled();

  // The reconciliation line. Without it, "0 of 24" beside existing entries
  // reads as the app having lost data.
  await expect(
    drawer.getByText(
      /9 entries are recorded for the whole company rather than a site/,
    ),
  ).toBeVisible();

  // WP18, and the reason this file's numbers moved. January–March are reported
  // site by site: Istanbul HQ has the invoice, and no company-level row claims
  // those months as well. So Ankara's February is a genuinely OPEN slot — the
  // month is counted exactly once and the second site can still key its own
  // invoice — where before the repair it was a blocked `◆` sitting on top of a
  // month the inventory had already counted twice.
  await expect(
    drawer.getByRole('button', {
      name: /Ankara Power Plant February: missing/,
    }),
  ).toBeEnabled();

  // The legend, which is gated on the category having ANY company-level month
  // and so still renders for the nine that remain. Kept because dropping it
  // when the numbers moved would have quietly retired the only assertion that
  // the `◆` marker explains itself, and nothing else in the repo covers it.
  await expect(
    drawer.getByText(/would count that month twice/),
  ).toBeVisible();

  // The sentence a real overlap prints — a different string from the legend
  // above, in the present tense, and it has to be ABSENT now: the six pairs it
  // was written for are gone. This is the assertion that would fail if the seed
  // ever went back to writing a company row and a site row for the same month,
  // which is the whole defect and left no other visible trace.
  await expect(
    drawer.getByText(/already counted twice in the emissions total/),
  ).toHaveCount(0);
});

test('clicking an open month opens Data Entry on that exact slot', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.getByRole('button', { name: /TonyAI Energy.*per location/s }).click();

  const drawer = page.getByRole('dialog');
  // Water: no records at any level, so every one of its slots is open and the
  // assertion below cannot be satisfied by accident. Electricity now has open
  // slots too (January–March, see the test above), but only some of them.
  await drawer.getByRole('button', { name: /^Water/ }).click();
  await drawer
    .getByRole('button', { name: /Ankara Power Plant July: missing/ })
    .click();

  await page.waitForURL(/\/data-entry\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get('category')).toBe('Water');
  expect(url.searchParams.get('period')).toBe('monthly');
  expect(url.searchParams.get('periodValue')).toBe('July');
  expect(url.searchParams.get('locationId')).toBeTruthy();

  // The form arrives pointed at the site and the month. A matrix cell can only
  // name the category and the year, which is why Data Entry answers THAT with
  // "several records exist, pick one" — from a slot there is nothing to guess,
  // so no such notice appears.
  // Read off the controls themselves, the way analytics.spec does: a Radix
  // trigger's text is the only honest evidence the form actually moved.
  const field = (label: string) =>
    page.locator('div.space-y-2').filter({ hasText: label }).getByRole('combobox');
  await expect(field('Location')).toContainText('Ankara Power Plant');
  await expect(field('Period')).toContainText('Monthly');
  await expect(field('Value')).toContainText('July');
  await expect(page.getByText(/records exist for/)).toHaveCount(0);
});
