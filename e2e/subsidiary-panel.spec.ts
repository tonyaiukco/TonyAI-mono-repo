import { test, expect } from '@playwright/test';
import {
  login, bearer, getAccessToken, pickByFieldLabel, cleanupE2ESubsidiaries,
  ADMIN_EMAIL, ENTRY_EMAIL, CONSULTANT_EMAIL, API_BASE, SUB, E2E_YEAR, E2E_PERIOD,
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

  // …and the register reflects it. Both of these came across from
  // `smoke.spec.ts`: an edit must not be an insert, and the register's
  // geography column must move with the save — nothing else asserts either.
  const before = await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) })).json();
  await page.goto('/subsidiaries');
  await expect(page.getByRole('cell', { name: renamed })).toBeVisible();
  await expect(page.locator('tr', { hasText: renamed })).toContainText('UK');
  expect(
    (before as { id: string }[]).filter((s) => s.id === sub.id),
    'the edit must have updated one row, not inserted another',
  ).toHaveLength(1);
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

  // `designatedPerson` has no `@Transform(blankToNull)` on the API side — the
  // page's own `orNull` is the only thing standing between a cleared field and
  // an empty string in the column. Asserting the phone alone tested the DTO,
  // not this page: gutting `orNull` left that green.
  await page.reload();
  await page.getByLabel('Responsible person').fill('   ');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Subsidiary settings updated successfully.')).toBeVisible();
  const blanked = await (await request.get(`${API_BASE}/subsidiaries/${sub.id}`, {
    headers: bearer(token),
  })).json();
  expect(blanked.designatedPerson, 'a cleared contact must be null, not ""').toBeNull();
});

test('the panel explains a refused delete in the API\'s own words', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, `E2E Test Co Blockers ${Date.now()}`);

  await login(page, ADMIN_EMAIL);
  await page.goto(`/subsidiaries/${sub.id}`);
  await expect(page.getByText(/Nothing depends on this subsidiary/)).toBeVisible();

  // Type into the detail form FIRST and leave it unsaved. Adding a location
  // refetches, and the refetch must not reset this form — `load(false)` exists
  // for exactly that, and nothing pinned it: switching it to `load(true)`
  // silently discarded a user's half-finished edit and stayed green.
  await page.getByLabel('Trading name').fill('Unsaved While Adding');

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

  await expect(
    page.getByLabel('Trading name'),
    'adding a location must not discard an unsaved detail edit',
  ).toHaveValue('Unsaved While Adding');

  // A record-free location does not block: the panel says the subsidiary can
  // still go, and names what would go with it.
  await expect(page.getByText(/1 location would go with it/)).toBeVisible();
  await expect(page.getByText('This subsidiary cannot be deleted')).toHaveCount(0);

  // Add a draft record, and now something DOES block — in the API's own words,
  // not a sentence the UI wrote.
  const subs = await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) })).json();
  void subs;
  await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, locationId: null, reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD, periodValue: 'Q2', category: 'Electricity',
      activityValue: 9, activityUnit: 'kWh', varianceReason: null, input: null },
  });
  await page.reload();
  await expect(page.getByText('This subsidiary cannot be deleted')).toBeVisible();

  const blockers = await (await request.get(`${API_BASE}/subsidiaries/${sub.id}/summary`, {
    headers: bearer(token),
  })).json();
  expect(blockers.blockers).toContain('1 draft or rejected record(s)');
  await expect(page.getByText('1 draft or rejected record(s)', { exact: false })).toBeVisible();

  const refused = await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) });
  expect(refused.status()).toBe(409);
  for (const phrase of blockers.blockers as string[]) {
    expect((await refused.json()).message).toContain(phrase);
  }
});

test('a data_entry user can read the panel but change nothing', async ({ page, request }) => {
  // This replaces `rbac-tenant.spec.ts`'s assertion that the row-level "Edit
  // subsidiary" button renders zero times. That button no longer exists for
  // anyone, so the old check would have passed while proving nothing — a
  // vacuous green created by this very change.
  await login(page, ENTRY_EMAIL);
  await page.goto(`/subsidiaries/${SUB.energy}`);

  await expect(page.getByText(/only a super_admin can change it/i)).toBeVisible();

  // By rule, not by sample: asserting two named fields left eight other write
  // controls ungated, and removing `disabled` from them stayed green.
  const inputs = page.locator('form, div').locator('input');
  const count = await inputs.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    await expect(inputs.nth(i), `input ${i} must be read-only`).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add location' })).toHaveCount(0);
  await expect(page.getByText('Only a super_admin can add or modify locations.')).toBeVisible();

  // The period-locks drawer is mounted by this page too, and its gating was
  // only ever checked on the register. Flipping its canManage to true here
  // stayed green.
  await page.getByRole('button', { name: 'Reporting periods' }).click();
  await expect(page.getByText(/only a super_admin can lock or unlock/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lock period' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // …and the counts it CAN read are the REAL ones — asserting only the heading
  // let a summary of all zeros pass. Cross-checked against the API rather than
  // against the seed's numbers: another spec adding a location to this
  // subsidiary earlier in the run would otherwise fail this for the wrong
  // reason, which is how a hardcoded count becomes a flake.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const expected = await (await request.get(
    `${API_BASE}/subsidiaries/${SUB.energy}/summary`, { headers: bearer(token) },
  )).json();
  expect(expected.locations, 'the fixture must be non-empty for this to mean anything').toBeGreaterThan(0);
  expect(expected.terminalRecords).toBeGreaterThan(0);

  const locationsRow = page.locator('div', {
    has: page.getByText('Locations', { exact: true }),
  }).last();
  await expect(locationsRow).toContainText(String(expected.locations));
  const committedRow = page.locator('div', {
    has: page.getByText('Approved, locked or voided records', { exact: true }),
  }).last();
  await expect(committedRow).toContainText(String(expected.terminalRecords));
});

test('a data_entry user is refused at the API too, not just in the UI', async ({ request }) => {
  // The panel is what puts editable-looking fields in front of this user, so
  // the API-level negative belongs beside it. `rbac-tenant.spec.ts` only ever
  // patched a FOREIGN id, which 404s for tenancy rather than 403 for role.
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const res = await request.patch(`${API_BASE}/subsidiaries/${SUB.energy}`, {
    headers: bearer(token),
    data: { contactEmail: 'nope@example.com' },
  });
  expect(res.status(), 'in-scope but wrong role is 403, not 404').toBe(403);
});

test('an external consultant sees the contact but cannot change it', async ({ page }) => {
  // `permissions_and_roles.md` §6.4 makes this the headline of the visibility
  // decision — the consultant seat is typically filled from outside the holding
  // company. A decision nothing tests is a decision that can quietly reverse.
  await login(page, CONSULTANT_EMAIL);
  await page.goto(`/subsidiaries/${SUB.energy}`);
  await expect(page.getByLabel('Work email')).toHaveValue('aylin.demir@example.com');
  await expect(page.getByLabel('Work email')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});

test('a failed load says so instead of spinning forever', async ({ page }) => {
  // Before this, a non-404 failure only toasted: the render fell through to the
  // loading branch and an expired session looked like a spinner that never
  // resolved. `errMessage` was never executed by any test at all.
  await login(page, ADMIN_EMAIL);
  await page.route('**/api/v1/subsidiaries/*/summary', (route) =>
    route.fulfill({ status: 500, body: '{"message":"boom"}' }),
  );
  await page.goto(`/subsidiaries/${SUB.energy}`);

  const panelError = page.locator('div', {
    has: page.getByText('This subsidiary could not be loaded.'),
  }).last();
  await expect(panelError).toBeVisible();
  // Scoped: the same sentence is also in the toast, so an unscoped match is a
  // strict-mode violation rather than a stronger assertion.
  await expect(panelError).toContainText(/service is unavailable right now/i);
  await expect(page.getByText('Loading subsidiary…')).toHaveCount(0);

  // …and it recovers without a full reload once the API is healthy again.
  await page.unroute('**/api/v1/subsidiaries/*/summary');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('What depends on this subsidiary')).toBeVisible();
});

test('a subsidiary outside the tenant is not found, not forbidden', async ({ page }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto(`/subsidiaries/${SUB.trading}`);
  await expect(page.getByRole('heading', { name: 'Subsidiary not found' })).toBeVisible();
});
