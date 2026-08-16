import { test, expect } from '@playwright/test';
import {
  login, bearer, getAccessToken, pickByFieldLabel, cleanupE2ESubsidiaries,
  ADMIN_EMAIL, ENTRY_EMAIL, API_BASE, SUB,
} from './helpers';

/**
 * WP16 PR 2b — `/subsidiaries/[id]`, the super_admin control panel (round-1 UAT
 * SUB-2). It replaces the row-level Edit dialog, so this file inherits the edit
 * coverage that used to live in `smoke.spec.ts` and `grid-regions.spec.ts`.
 */

test.afterAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext();
  try {
    await cleanupE2ESubsidiaries(ctx);
  } finally {
    await ctx.dispose();
  }
});

async function makeSubsidiary(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  name: string,
) {
  const res = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: { legalName: name, geographyCode: 'TR', reportingStatus: 'active' },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

test('the register opens the panel, and the panel edits — including a declined geography change', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const name = `E2E Test Co Panel ${Date.now()}`;
  const sub = await makeSubsidiary(request, token, name);
  const renamed = `${name} Renamed`;

  await login(page, ADMIN_EMAIL);
  await page.goto('/subsidiaries');
  await page.locator('tr', { hasText: name }).getByRole('button', { name: 'Open subsidiary' }).click();
  await expect(page).toHaveURL(new RegExp(`/subsidiaries/${sub.id}$`));

  // The panel opens populated, not blank — otherwise "edit" silently means
  // "retype everything", and any field left alone would be wiped.
  const legalName = page.getByLabel('Legal name');
  await expect(legalName).toHaveValue(name);
  await legalName.fill(renamed);

  // Changing the geography must be confirmed, not saved silently. The field is
  // "Reporting geography" here: the locations panel on the same page has its
  // own "Geography *", and a label match that hit both would be ambiguous.
  await pickByFieldLabel(page, 'Reporting geography', 'United Kingdom (UK)');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const geoAlert = page.getByRole('alertdialog');
  await expect(geoAlert.getByText(/Change geography from TR to UK\?/)).toBeVisible();
  await expect(geoAlert.getByText(/will change the configured factor basis/)).toBeVisible();
  await expect(
    geoAlert.getByText(/records already committed keep the emission factor/i),
  ).toBeVisible();

  // Declining must not save. Asserted against the SERVER, because the page does
  // not refetch on cancel — checking the DOM passes even if the cancel wrote to
  // the API, which is exactly how the dialog version of this test was once
  // green while a cancelled edit persisted. A page has no Cancel-to-close, so
  // the discard is explicit and then the reload proves it.
  await geoAlert.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.reload();
  await expect(page.getByLabel('Legal name')).toHaveValue(name);
  const afterCancel = await (await request.get(`${API_BASE}/subsidiaries/${sub.id}`, {
    headers: bearer(token),
  })).json();
  expect(afterCancel.legalName).toBe(name);
  expect(afterCancel.geographyCode).toBe('TR');

  // Redo it, this time confirming.
  await page.getByLabel('Legal name').fill(renamed);
  await pickByFieldLabel(page, 'Reporting geography', 'United Kingdom (UK)');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Subsidiary settings updated successfully.')).toBeVisible();

  const saved = await (await request.get(`${API_BASE}/subsidiaries/${sub.id}`, {
    headers: bearer(token),
  })).json();
  expect(saved.legalName).toBe(renamed);
  expect(saved.geographyCode).toBe('UK');

  // …and the register reflects it.
  await page.goto('/subsidiaries');
  await expect(page.getByRole('cell', { name: renamed })).toBeVisible();
});

test('the contact section round-trips, and says what it is for', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, `E2E Test Co Contact UI ${Date.now()}`);

  await login(page, ADMIN_EMAIL);
  await page.goto(`/subsidiaries/${sub.id}`);

  // The labels carry the legal framing: these values are visible to everyone in
  // the tenant (including an external consultant) and are kept in an
  // append-only audit trail, so the copy steers toward a role mailbox.
  await expect(page.getByText(/prepares or coordinates the inventory/)).toBeVisible();
  await expect(page.getByText(/role mailbox/)).toBeVisible();
  await expect(page.getByLabel('Work email')).toHaveAttribute('placeholder', 'esg@company.com');

  await page.getByLabel('Responsible person').fill('Aylin Demir');
  await page.getByLabel('Work email').fill('esg@example.com');
  await page.getByLabel('Work phone').fill('+90 212 000 00 00');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Subsidiary settings updated successfully.')).toBeVisible();

  const saved = await (await request.get(`${API_BASE}/subsidiaries/${sub.id}`, {
    headers: bearer(token),
  })).json();
  expect(saved).toMatchObject({
    designatedPerson: 'Aylin Demir',
    contactEmail: 'esg@example.com',
    contactPhone: '+90 212 000 00 00',
  });

  // Clearing a contact must reach the column as null, not as an empty string.
  await page.reload();
  await page.getByLabel('Work phone').fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Subsidiary settings updated successfully.')).toBeVisible();
  const cleared = await (await request.get(`${API_BASE}/subsidiaries/${sub.id}`, {
    headers: bearer(token),
  })).json();
  expect(cleared.contactPhone).toBeNull();
  expect(cleared.contactEmail).toBe('esg@example.com');
});

test('the panel explains a refused delete in the API\'s own words', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, `E2E Test Co Blockers ${Date.now()}`);

  await login(page, ADMIN_EMAIL);
  await page.goto(`/subsidiaries/${sub.id}`);
  await expect(page.getByText(/Nothing depends on this subsidiary/)).toBeVisible();

  // Add a location through the panel itself — the extracted body, mounted
  // inline rather than in the drawer.
  // The locations form's inputs are not label-linked, so scope by the field
  // container the way `pickByFieldLabel` does rather than by accessible name.
  const nameField = page.locator('div.space-y-2', {
    has: page.getByText('Name *', { exact: true }),
  });
  await nameField.getByRole('textbox').fill('E2E Panel Site');
  await pickByFieldLabel(page, 'Geography *', 'United Kingdom (UK)');
  await page.getByRole('button', { name: 'Add location' }).click();
  await expect(page.getByText('E2E Panel Site')).toBeVisible();

  await expect(page.getByText('This subsidiary cannot be deleted')).toBeVisible();
  // The sentence must be the API's, not one the UI wrote: same text as the 409.
  const blockers = await (await request.get(`${API_BASE}/subsidiaries/${sub.id}/summary`, {
    headers: bearer(token),
  })).json();
  expect(blockers.blockers).toContain('1 location(s)');
  await expect(page.getByText('1 location(s)', { exact: false })).toBeVisible();

  const refused = await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) });
  expect(refused.status()).toBe(409);
  for (const phrase of blockers.blockers as string[]) {
    expect((await refused.json()).message).toContain(phrase);
  }
});

test('a data_entry user can read the panel but change nothing', async ({ page }) => {
  // This replaces `rbac-tenant.spec.ts`'s assertion that the row-level "Edit
  // subsidiary" button renders zero times. That button no longer exists for
  // anyone, so the old check would have passed while proving nothing — a
  // vacuous green created by this very change.
  await login(page, ENTRY_EMAIL);
  await page.goto(`/subsidiaries/${SUB.energy}`);

  await expect(page.getByText(/only a super_admin can change it/i)).toBeVisible();
  await expect(page.getByLabel('Legal name')).toBeDisabled();
  await expect(page.getByLabel('Work email')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add location' })).toHaveCount(0);
  await expect(page.getByText('Only a super_admin can add or modify locations.')).toBeVisible();

  // …and the counts it CAN read are the real ones, not a blank shell.
  await expect(page.getByText('What depends on this subsidiary')).toBeVisible();
});

test('a subsidiary outside the tenant is not found, not forbidden', async ({ page }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto(`/subsidiaries/${SUB.trading}`);
  await expect(page.getByRole('heading', { name: 'Subsidiary not found' })).toBeVisible();
});
