import { test, expect } from '@playwright/test';
import { login, pickByFieldLabel, ADMIN_EMAIL, SUB } from './helpers';

/**
 * WP15 slice (a) — round-1 DE-6 + DE-7.
 *
 * The tester asked for Türkiye as a selectable "grid region". The field they
 * were looking at was metadata that never reached the calculation engine, so
 * this covers what was done instead: the geographies that DO drive the factor
 * offer UK + Türkiye by name, `EU` is hidden without becoming unreachable, and
 * Data Entry states the geography it will actually use.
 */

test('geography pickers offer UK + Türkiye by name, not raw codes', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto('/subsidiaries');
  await page.getByRole('button', { name: 'Add Subsidiary' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.locator('div.space-y-2').filter({ hasText: 'Geography' }).getByRole('combobox').click();
  const options = await page.getByRole('option').allTextContents();
  expect(options).toEqual(['United Kingdom (UK)', 'Türkiye (TR)']);
  // Hidden, not deleted: absent from a NEW record's choices…
  expect(options.join(' ')).not.toContain('European Union');
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('…but an EU subsidiary still opens on EU and can be saved', async ({ page, request }) => {
  // The blank-trigger trap: a Radix Select bound to a value with no matching
  // item renders EMPTY — no error, no placeholder. Hiding EU while the seeded
  // Munich subsidiary holds it would silently empty the one control that can
  // change it, and a blind save would still submit EU.
  await login(page, ADMIN_EMAIL);
  await page.goto('/subsidiaries');
  await page
    .locator('tr', { hasText: 'TonyAI Manufacturing GmbH' })
    .getByRole('button', { name: 'Edit subsidiary' })
    .click();

  const dialog = page.getByRole('dialog');
  const geo = dialog.locator('div.space-y-2').filter({ hasText: 'Geography' }).getByRole('combobox');
  await expect(geo).toContainText('European Union (EU)');

  // Saving an untouched geography must not trigger the change confirmation.
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Subsidiary settings updated successfully.')).toBeVisible();

  const subs = await (await request.get('http://localhost:3001/api/v1/subsidiaries', {
    headers: { Authorization: `Bearer ${await (await import('./helpers')).getAccessToken(request, ADMIN_EMAIL)}` },
  })).json();
  expect(subs.find((s: { legalName: string }) => s.legalName === 'TonyAI Manufacturing GmbH').geographyCode).toBe('EU');
});

test('Data Entry states the geography it will use, and no longer offers a fake one', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto(`/data-entry?subsidiaryId=${SUB.energy}&category=Electricity&year=2026`);
  await expect(page.getByRole('heading', { name: 'Data Entry' })).toBeVisible();

  // The metadata picker that claimed to choose the factor is gone.
  await expect(page.getByText('Grid Region')).toHaveCount(0);

  // …replaced by the geography that is actually resolved, and its source.
  await expect(page.getByText(/Factor geography:/)).toContainText('TR');
  await expect(page.getByText(/Factor geography:/)).toContainText('Türkiye');
  await expect(page.getByText(/Factor geography:/)).toContainText('subsidiary');
});
