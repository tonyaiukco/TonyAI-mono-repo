import { test, expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import enUsers from '../apps/web/messages/en/users.json';
import trUsers from '../apps/web/messages/tr/users.json';
import type { SubsidiaryDTO, UserSummaryDTO } from '@tonyai/shared-types';
import {
  ADMIN_EMAIL,
  API_BASE,
  CONSULTANT_EMAIL,
  ENTRY_EMAIL,
  SEED_ENTRY_GRANTS,
  SUB,
  bearer,
  getAccessToken,
  listAllPages,
  login,
  pickByFieldLabel,
  resetSeedAccess,
} from './helpers';

/**
 * User Management makes a Data Entry user's subsidiaries visible and editable
 * (BUG-R2-01, OpenSpec `uat2-user-access-clarity`, `organisation-hierarchy`):
 * the access column names the grants, "Edit access" is a button on the row
 * rather than a menu item, the picker counts, selects all and clears, an empty
 * selection is warned, every other role's access is stated in the invitation,
 * and a role change to Data Entry opens the access editor.
 *
 * No account is created: the seed's Data Entry and Consultant users are changed
 * and put back to their SEED values before and after every test (grants, role
 * and the admin's language, through the API) — not to values a test captured —
 * and globalSetup does the same, so a run killed mid-test is repaired before
 * the next run's other specs. The invite dialog is
 * cancelled. Copy is read from the catalogues.
 */


type Copy = typeof enUsers;

async function withApi<T>(fn: (api: APIRequestContext, token: string) => Promise<T>): Promise<T> {
  // Its own request context, so a timed-out test still restores the seed.
  const api = await playwrightRequest.newContext();
  try {
    return await fn(api, await getAccessToken(api, ADMIN_EMAIL));
  } finally {
    await api.dispose();
  }
}

async function setAdminLanguage(language: 'tr' | 'en') {
  await withApi(async (api, token) => {
    const res = await api.patch(`${API_BASE}/me/preferences`, { headers: bearer(token), data: { language } });
    if (res.status() !== 200) throw new Error(`language ${language}: ${res.status()}`);
  });
}

async function seedUser(email: string): Promise<UserSummaryDTO> {
  return withApi(async (api, token) => {
    const users = await listAllPages<UserSummaryDTO>(api, token, '/users');
    const user = users.find((u) => u.email === email);
    if (!user) throw new Error(`seed user ${email} not found`);
    return user;
  });
}

async function subsidiaries(): Promise<SubsidiaryDTO[]> {
  return withApi(async (api, token) => {
    const res = await api.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) });
    expect(res.ok()).toBe(true);
    return (await res.json()) as SubsidiaryDTO[];
  });
}

/** The seed's state for everything this file changes: roles, the entry user's grants, the admin's language. */
async function restoreSeed() {
  await setAdminLanguage('en');
  const api = await playwrightRequest.newContext();
  try {
    await resetSeedAccess(api);
  } finally {
    await api.dispose();
  }
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), template);
}

function rowOf(page: Page, email: string) {
  return page.locator('tbody tr', { hasText: email });
}

async function openUsers(page: Page, copy: Copy) {
  await page.goto('/users');
  await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
  await expect(rowOf(page, ENTRY_EMAIL)).toBeVisible();
}

// Hooks, not a test's `finally`: a hook still runs, with its own timeout, after a test times out.
test.beforeEach(restoreSeed);
test.afterEach(restoreSeed);

test('the access column names the grants, and Edit access is a row button', async ({ page }) => {
  const entry = await seedUser(ENTRY_EMAIL);
  const subs = await subsidiaries();
  const name = (id: string) => subs.find((s) => s.id === id)!.legalName;
  expect([...entry.subsidiaryIds].sort()).toEqual([...SEED_ENTRY_GRANTS].sort());

  await login(page, ADMIN_EMAIL);
  await openUsers(page, enUsers);
  const row = rowOf(page, ENTRY_EMAIL);

  // Names in name order, never "Subsidiaries: 2".
  const names = [name(SUB.energy), name(SUB.logistics)].sort((a, b) => a.localeCompare(b, 'en'));
  await expect(row.getByTestId('user-access-names')).toHaveText(names.join(', '));
  await expect(row).not.toContainText('Subsidiaries: ');

  // The menu no longer holds the action; the row does.
  await row.getByRole('button', { name: fill(enUsers.actions.menu, { name: entry.fullName }) }).click();
  await expect(page.getByRole('menuitem', { name: enUsers.actions.changeRole })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: enUsers.actions.editAccess })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A consultant row has no access button and reads the whole parent company.
  const consultantRow = rowOf(page, CONSULTANT_EMAIL);
  await expect(consultantRow).toContainText(enUsers.wholeOrganisation);
  await expect(consultantRow.getByRole('button', { name: enUsers.actions.editAccess })).toHaveCount(0);

  await row.getByRole('button', { name: fill(enUsers.actions.editAccessFor, { name: entry.fullName }) }).click();
  const dialog = page.getByRole('dialog', { name: fill(enUsers.accessDialog.title, { name: entry.fullName }) });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('subsidiary-picker-count')).toHaveText(
    fill(enUsers.picker.selectedCount, { count: 2, total: subs.length }),
  );
  await dialog.getByRole('checkbox', { name: name(SUB.gas) }).click();
  await expect(dialog.getByTestId('subsidiary-picker-count')).toHaveText(
    fill(enUsers.picker.selectedCount, { count: 3, total: subs.length }),
  );
  await dialog.getByRole('button', { name: enUsers.accessDialog.submit }).click();
  await expect(page.getByText(enUsers.accessSaved)).toBeVisible();

  const three = [name(SUB.energy), name(SUB.gas), name(SUB.logistics)].sort((a, b) => a.localeCompare(b, 'en'));
  await expect(row.getByTestId('user-access-names')).toHaveText(three.join(', '));
  expect((await seedUser(ENTRY_EMAIL)).subsidiaryIds.sort()).toEqual([SUB.energy, SUB.gas, SUB.logistics].sort());
});

test('the invite picker counts, selects all, clears, warns, and states other roles', async ({ page }) => {
  const subs = await subsidiaries();
  await login(page, ADMIN_EMAIL);
  await openUsers(page, enUsers);

  await page.getByRole('button', { name: enUsers.invite }).click();
  const dialog = page.getByRole('dialog');
  const count = dialog.getByTestId('subsidiary-picker-count');
  await expect(dialog.getByText(enUsers.picker.heading)).toBeVisible();
  await expect(count).toHaveText(fill(enUsers.picker.selectedCount, { count: 0, total: subs.length }));
  await expect(dialog.getByTestId('subsidiary-picker-empty')).toHaveText(enUsers.picker.emptyWarning);
  await expect(dialog.getByRole('button', { name: enUsers.picker.clear })).toBeDisabled();
  // Warned, never refused: the invitation can still be sent with nothing ticked.
  await dialog.getByLabel(enUsers.inviteDialog.email, { exact: true }).fill('not-sent@tonyai.local');
  await dialog.getByLabel(enUsers.inviteDialog.name, { exact: true }).fill('Not Sent');
  await expect(dialog.getByRole('button', { name: enUsers.inviteDialog.submit })).toBeEnabled();

  await dialog.getByRole('button', { name: enUsers.picker.selectAll }).click();
  await expect(count).toHaveText(fill(enUsers.picker.selectedCount, { count: subs.length, total: subs.length }));
  await expect(dialog.getByTestId('subsidiary-picker-empty')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: enUsers.picker.selectAll })).toBeDisabled();

  await dialog.getByRole('button', { name: enUsers.picker.clear }).click();
  await expect(count).toHaveText(fill(enUsers.picker.selectedCount, { count: 0, total: subs.length }));
  await expect(dialog.getByTestId('subsidiary-picker-empty')).toBeVisible();

  // One tick survives a trip through another role, whose access is stated instead.
  await dialog.getByRole('checkbox', { name: subs[0].legalName }).click();
  await pickByFieldLabel(page, enUsers.inviteDialog.role, enUsers.roles.consultant);
  await expect(dialog.getByTestId('invite-role-access-note')).toHaveText(enUsers.roleAccessNote.consultant);
  await expect(dialog.getByTestId('subsidiary-picker')).toHaveCount(0);
  await pickByFieldLabel(page, enUsers.inviteDialog.role, enUsers.roles.executive_viewer);
  await expect(dialog.getByTestId('invite-role-access-note')).toHaveText(enUsers.roleAccessNote.executive_viewer);
  await pickByFieldLabel(page, enUsers.inviteDialog.role, enUsers.roles.data_entry);
  await expect(count).toHaveText(fill(enUsers.picker.selectedCount, { count: 1, total: subs.length }));

  await dialog.getByRole('button', { name: enUsers.inviteDialog.cancel }).click();
  await expect(dialog).toHaveCount(0);
});

test('a role change to Data Entry opens the access editor', async ({ page }) => {
  const consultant = await seedUser(CONSULTANT_EMAIL);
  expect(consultant.role).toBe('consultant');

  await login(page, ADMIN_EMAIL);
  await openUsers(page, enUsers);
  const row = rowOf(page, CONSULTANT_EMAIL);
  await row.getByRole('button', { name: fill(enUsers.actions.menu, { name: consultant.fullName }) }).click();
  await page.getByRole('menuitem', { name: enUsers.actions.changeRole }).click();

  const roleDialog = page.getByRole('dialog', { name: fill(enUsers.roleDialog.title, { name: consultant.fullName }) });
  await roleDialog.getByRole('combobox', { name: enUsers.columns.role }).click();
  await page.getByRole('option', { name: enUsers.roles.data_entry, exact: true }).click();
  await roleDialog.getByRole('button', { name: enUsers.roleDialog.submit }).click();

  const accessDialog = page.getByRole('dialog', { name: fill(enUsers.accessDialog.title, { name: consultant.fullName }) });
  await expect(accessDialog).toBeVisible();
  await expect(accessDialog.getByTestId('subsidiary-picker-empty')).toBeVisible();
  await accessDialog.getByRole('button', { name: enUsers.accessDialog.cancel }).click();
  await expect(accessDialog).toHaveCount(0);

  await expect(row.getByTestId('user-access-none')).toHaveText(enUsers.noAccess);
  await expect(row.getByRole('button', { name: fill(enUsers.actions.editAccessFor, { name: consultant.fullName }) })).toBeVisible();
  expect((await seedUser(CONSULTANT_EMAIL)).role).toBe('data_entry');
});

test('the access copy speaks Turkish', async ({ page }) => {
  const entry = await seedUser(ENTRY_EMAIL);
  const subs = await subsidiaries();
  const names = entry.subsidiaryIds
    .map((id) => subs.find((s) => s.id === id)!.legalName)
    .sort((a, b) => a.localeCompare(b, 'tr'));

  await setAdminLanguage('tr');
  await login(page, ADMIN_EMAIL);
  await openUsers(page, trUsers);
  const row = rowOf(page, ENTRY_EMAIL);
  await expect(row.getByTestId('user-access-names')).toHaveText(names.join(', '));
  await expect(rowOf(page, CONSULTANT_EMAIL)).toContainText(trUsers.wholeOrganisation);

  await row.getByRole('button', { name: fill(trUsers.actions.editAccessFor, { name: entry.fullName }) }).click();
  const dialog = page.getByRole('dialog', { name: fill(trUsers.accessDialog.title, { name: entry.fullName }) });
  await expect(dialog.getByText(trUsers.picker.heading)).toBeVisible();
  await expect(dialog.getByTestId('subsidiary-picker-count')).toHaveText(
    fill(trUsers.picker.selectedCount, { count: names.length, total: subs.length }),
  );
  await expect(dialog.getByRole('button', { name: trUsers.picker.selectAll })).toBeVisible();
  await dialog.getByRole('button', { name: trUsers.picker.clear }).click();
  await expect(dialog.getByTestId('subsidiary-picker-empty')).toHaveText(trUsers.picker.emptyWarning);
  // Not saved: the grants stay as seeded.
  await dialog.getByRole('button', { name: trUsers.accessDialog.cancel }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: trUsers.invite }).click();
  await pickByFieldLabel(page, trUsers.inviteDialog.role, trUsers.roles.consultant);
  await expect(page.getByRole('dialog').getByTestId('invite-role-access-note')).toHaveText(trUsers.roleAccessNote.consultant);
  await page.getByRole('dialog').getByRole('button', { name: trUsers.inviteDialog.cancel }).click();
  expect((await seedUser(ENTRY_EMAIL)).subsidiaryIds.sort()).toEqual([...entry.subsidiaryIds].sort());
});

for (const [language, copy] of [['en', enUsers], ['tr', trUsers]] as const) {
  test(`with no subsidiary at all the picker still counts and warns (${language})`, async ({ page }) => {
    // A parent company with no subsidiary yet (a fresh registration): the
    // browser's read of the list answers empty; everything else is real.
    await page.route(/\/api\/v1\/subsidiaries$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ response: await route.fetch(), json: [] });
    });
    if (language === 'tr') await setAdminLanguage('tr');
    await login(page, ADMIN_EMAIL);
    await openUsers(page, copy);

    await page.getByRole('button', { name: copy.invite }).click();
    const dialog = page.getByRole('dialog', { name: copy.inviteDialog.title });
    await expect(dialog.getByTestId('subsidiary-picker-none')).toHaveText(copy.inviteDialog.noSubsidiaries);
    await expect(dialog.getByTestId('subsidiary-picker-count')).toHaveText(
      fill(copy.picker.selectedCount, { count: 0, total: 0 }),
    );
    await expect(dialog.getByTestId('subsidiary-picker-empty')).toHaveText(copy.picker.emptyWarning);
    await expect(dialog.getByRole('button', { name: copy.picker.selectAll })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: copy.picker.clear })).toBeDisabled();
    // Warned, never refused.
    await dialog.getByLabel(copy.inviteDialog.email, { exact: true }).fill('not-sent@tonyai.local');
    await dialog.getByLabel(copy.inviteDialog.name, { exact: true }).fill('Not Sent');
    await expect(dialog.getByRole('button', { name: copy.inviteDialog.submit })).toBeEnabled();
    await dialog.getByRole('button', { name: copy.inviteDialog.cancel }).click();

    // The same picker in the access editor after a role change to Data Entry.
    const consultant = await seedUser(CONSULTANT_EMAIL);
    await rowOf(page, CONSULTANT_EMAIL).getByRole('button', { name: fill(copy.actions.menu, { name: consultant.fullName }) }).click();
    await page.getByRole('menuitem', { name: copy.actions.changeRole }).click();
    const roleDialog = page.getByRole('dialog', { name: fill(copy.roleDialog.title, { name: consultant.fullName }) });
    await roleDialog.getByRole('combobox', { name: copy.columns.role }).click();
    await page.getByRole('option', { name: copy.roles.data_entry, exact: true }).click();
    await roleDialog.getByRole('button', { name: copy.roleDialog.submit }).click();
    const accessDialog = page.getByRole('dialog', { name: fill(copy.accessDialog.title, { name: consultant.fullName }) });
    await expect(accessDialog.getByTestId('subsidiary-picker-none')).toHaveText(copy.inviteDialog.noSubsidiaries);
    await expect(accessDialog.getByTestId('subsidiary-picker-count')).toHaveText(
      fill(copy.picker.selectedCount, { count: 0, total: 0 }),
    );
    await expect(accessDialog.getByTestId('subsidiary-picker-empty')).toHaveText(copy.picker.emptyWarning);
    await expect(accessDialog.getByRole('button', { name: copy.accessDialog.submit })).toBeEnabled();
    await accessDialog.getByRole('button', { name: copy.accessDialog.cancel }).click();
  });
}
