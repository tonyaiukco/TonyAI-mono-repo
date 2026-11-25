import { test, expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import enUsers from '../apps/web/messages/en/users.json';
import trUsers from '../apps/web/messages/tr/users.json';
import enCategories from '../apps/web/messages/en/categories.json';
import type { SubsidiaryDTO, UserSummaryDTO } from '@tonyai/shared-types';
import {
  ADMIN_EMAIL,
  API_BASE,
  APPROVER_EMAIL,
  AUDITOR_EMAIL,
  ENTRY_EMAIL,
  SEED_APPROVER_GRANTS,
  SEED_ENTRY_GRANTS,
  SUB,
  VIEWER_EMAIL,
  bearer,
  getAccessToken,
  listAllPages,
  login,
  pickByFieldLabel,
  resetSeedAccess,
  switchUser,
} from './helpers';

/**
 * User Management on the four roles (inc26-roles-approval-chain, INC-2.6 §1,
 * §6; design Decision 9; BUG-R2-01's visible access kept): the access column
 * names each granted account's companies, and "Edit access" sits in the
 * access cell of the rows the reader may set — a masterkey's super_admin
 * rows, a super_admin's standard user rows. A masterkey invites super admins
 * (with companies) and auditors and changes roles; a super admin sets a
 * standard user's one company and its categories, and sees a carried-over
 * account's companies as held. Empty selections are warned, never refused.
 *
 * No account is created: the seed's users are changed and put back to their
 * SEED values before and after every test (roles, both granted users' grants,
 * and the languages, through the API) — not to values a test captured — and
 * globalSetup does the same, so a run killed mid-test is repaired before the
 * next run's other specs. The invite dialog is cancelled (an invitation that
 * is sent is `roles-approval-chain.spec.ts`'s BUG-14 case). Copy is read from
 * the catalogues.
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

async function setLanguage(email: string, language: 'tr' | 'en') {
  const api = await playwrightRequest.newContext();
  try {
    const token = await getAccessToken(api, email);
    const res = await api.patch(`${API_BASE}/me/preferences`, { headers: bearer(token), data: { language } });
    if (res.status() !== 200) throw new Error(`language ${language}: ${res.status()}`);
  } finally {
    await api.dispose();
  }
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

/** The seed's state for everything this file changes: roles, both granted users' grants, the two administrators' languages. */
async function restoreSeed() {
  await setLanguage(ADMIN_EMAIL, 'en');
  await setLanguage(APPROVER_EMAIL, 'en');
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

async function openUsers(page: Page, copy: Copy, visibleEmail = APPROVER_EMAIL) {
  await page.goto('/users');
  await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
  await expect(rowOf(page, visibleEmail)).toBeVisible();
}

const sortedNames = (subs: SubsidiaryDTO[], ids: readonly string[], locale: string) =>
  ids.map((id) => subs.find((s) => s.id === id)!.legalName).sort((a, b) => a.localeCompare(b, locale, { sensitivity: 'base' }));

// Hooks, not a test's `finally`: a hook still runs, with its own timeout, after a test times out.
test.beforeEach(restoreSeed);
test.afterEach(restoreSeed);

test('the access column names the grants; a masterkey edits a super admin\'s companies from the row', async ({ page }) => {
  const approver = await seedUser(APPROVER_EMAIL);
  const entry = await seedUser(ENTRY_EMAIL);
  const subs = await subsidiaries();
  expect(approver.access.map((g) => g.subsidiaryId).sort()).toEqual([...SEED_APPROVER_GRANTS].sort());

  await login(page, ADMIN_EMAIL);
  await openUsers(page, enUsers);

  // Four companies: three names in name order, then "+1 more" — never "Subsidiaries: 4".
  const row = rowOf(page, APPROVER_EMAIL);
  const four = sortedNames(subs, SEED_APPROVER_GRANTS, 'en');
  await expect(row.getByTestId('user-access-names')).toHaveText(four.slice(0, 3).join(', '));
  await expect(row).toContainText(fill(enUsers.accessMore, { count: 1 }));
  await expect(row).toContainText(enUsers.roles.super_admin);

  // A standard user's row is named but not the masterkey's to edit (ruling R3).
  const entryRow = rowOf(page, ENTRY_EMAIL);
  await expect(entryRow.getByTestId('user-access-names')).toHaveText(sortedNames(subs, SEED_ENTRY_GRANTS, 'en').join(', '));
  await expect(entryRow.getByRole('button', { name: fill(enUsers.actions.editAccessFor, { name: entry.fullName }) })).toHaveCount(0);
  await expect(entryRow).toContainText(enUsers.roles.standard_user);

  // An auditor row has no access button and reads the whole parent company.
  const auditorRow = rowOf(page, AUDITOR_EMAIL);
  await expect(auditorRow).toContainText(enUsers.wholeOrganisation);
  await expect(auditorRow).toContainText(enUsers.roles.auditor);
  await expect(auditorRow.getByRole('button', { name: enUsers.actions.editAccess })).toHaveCount(0);

  await row.getByRole('button', { name: fill(enUsers.actions.editAccessFor, { name: approver.fullName }) }).click();
  const dialog = page.getByRole('dialog', { name: fill(enUsers.accessDialog.title, { name: approver.fullName }) });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(enUsers.accessDialog.superAdminDescription)).toBeVisible();
  await expect(dialog.getByTestId('subsidiary-picker-count')).toHaveText(
    fill(enUsers.picker.selectedCount, { count: 4, total: subs.length }),
  );
  // A super admin's grant carries no category list.
  await expect(dialog.getByTestId('category-picker')).toHaveCount(0);
  const trading = subs.find((s) => s.id === SUB.trading)!.legalName;
  await dialog.getByRole('checkbox', { name: trading }).click();
  await expect(dialog.getByTestId('subsidiary-picker-count')).toHaveText(
    fill(enUsers.picker.selectedCount, { count: 5, total: subs.length }),
  );
  await expect(dialog.getByRole('button', { name: enUsers.picker.selectAll })).toBeDisabled();
  await dialog.getByRole('button', { name: enUsers.accessDialog.submit }).click();
  await expect(page.getByText(enUsers.accessSaved)).toBeVisible();

  await expect(row).toContainText(fill(enUsers.accessMore, { count: 2 }));
  const after = await seedUser(APPROVER_EMAIL);
  expect(after.access.map((g) => g.subsidiaryId).sort()).toEqual([...SEED_APPROVER_GRANTS, SUB.trading].sort());
  expect(after.access.every((g) => g.categories.length === 0)).toBe(true);
});

test('the masterkey invites a super admin or an auditor; the picker counts, selects all, clears and warns', async ({ page }) => {
  const subs = await subsidiaries();
  await login(page, ADMIN_EMAIL);
  await openUsers(page, enUsers);

  await page.getByRole('button', { name: enUsers.invite }).click();
  const dialog = page.getByRole('dialog');
  // Nobody invites a masterkey, and a masterkey does not invite standard users (ruling R1, R3).
  await dialog.getByRole('combobox', { name: enUsers.inviteDialog.role }).click();
  await expect(page.getByRole('option')).toHaveText([enUsers.roles.super_admin, enUsers.roles.auditor]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('option')).toHaveCount(0);

  const count = dialog.getByTestId('subsidiary-picker-count');
  await expect(dialog.getByText(enUsers.picker.heading)).toBeVisible();
  await expect(dialog.getByText(enUsers.inviteDialog.superAdminHelp)).toBeVisible();
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

  // One tick survives a trip through the auditor, whose access is stated instead.
  await dialog.getByRole('checkbox', { name: subs[0].legalName }).click();
  await pickByFieldLabel(page, enUsers.inviteDialog.role, enUsers.roles.auditor);
  await expect(dialog.getByTestId('invite-role-access-note')).toHaveText(enUsers.roleAccessNote.auditor);
  await expect(dialog.getByTestId('subsidiary-picker')).toHaveCount(0);
  await pickByFieldLabel(page, enUsers.inviteDialog.role, enUsers.roles.super_admin);
  await expect(count).toHaveText(fill(enUsers.picker.selectedCount, { count: 1, total: subs.length }));

  await dialog.getByRole('button', { name: enUsers.inviteDialog.cancel }).click();
  await expect(dialog).toHaveCount(0);
});

test('a role change to Super Admin opens the access editor; the account starts with none', async ({ page }) => {
  const viewer = await seedUser(VIEWER_EMAIL);
  expect(viewer.role).toBe('auditor');

  await login(page, ADMIN_EMAIL);
  await openUsers(page, enUsers);
  const row = rowOf(page, VIEWER_EMAIL);
  await row.getByRole('button', { name: fill(enUsers.actions.menu, { name: viewer.fullName }) }).click();
  await page.getByRole('menuitem', { name: enUsers.actions.changeRole }).click();

  const roleDialog = page.getByRole('dialog', { name: fill(enUsers.roleDialog.title, { name: viewer.fullName }) });
  await expect(roleDialog.getByText(enUsers.roleDialog.description)).toBeVisible();
  await roleDialog.getByRole('combobox', { name: enUsers.columns.role }).click();
  // Never Masterkey (ruling R1).
  await expect(page.getByRole('option')).toHaveText([enUsers.roles.super_admin, enUsers.roles.standard_user, enUsers.roles.auditor]);
  await page.getByRole('option', { name: enUsers.roles.super_admin, exact: true }).click();
  await roleDialog.getByRole('button', { name: enUsers.roleDialog.submit }).click();

  const accessDialog = page.getByRole('dialog', { name: fill(enUsers.accessDialog.title, { name: viewer.fullName }) });
  await expect(accessDialog).toBeVisible();
  await expect(accessDialog.getByTestId('subsidiary-picker-empty')).toBeVisible();
  await accessDialog.getByRole('button', { name: enUsers.accessDialog.cancel }).click();
  await expect(accessDialog).toHaveCount(0);

  await expect(row.getByTestId('user-access-none')).toHaveText(enUsers.noAccess);
  await expect(row.getByRole('button', { name: fill(enUsers.actions.editAccessFor, { name: viewer.fullName }) })).toBeVisible();
  const after = await seedUser(VIEWER_EMAIL);
  expect(after.role).toBe('super_admin');
  expect(after.access).toEqual([]);
});

test('a standard user made by the masterkey is assigned by the super admin: one company, its categories', async ({ page }) => {
  const viewer = await seedUser(VIEWER_EMAIL);
  const subs = await subsidiaries();

  await login(page, ADMIN_EMAIL);
  await openUsers(page, enUsers);
  const adminRow = rowOf(page, VIEWER_EMAIL);
  await adminRow.getByRole('button', { name: fill(enUsers.actions.menu, { name: viewer.fullName }) }).click();
  await page.getByRole('menuitem', { name: enUsers.actions.changeRole }).click();
  const roleDialog = page.getByRole('dialog', { name: fill(enUsers.roleDialog.title, { name: viewer.fullName }) });
  await roleDialog.getByRole('combobox', { name: enUsers.columns.role }).click();
  await page.getByRole('option', { name: enUsers.roles.standard_user, exact: true }).click();
  await roleDialog.getByRole('button', { name: enUsers.roleDialog.submit }).click();
  // Not the masterkey's to assign: the screen says whose it is, and opens nothing.
  await expect(page.getByText(enUsers.roleChangedStandardUser)).toBeVisible();
  await expect(page.getByRole('dialog', { name: fill(enUsers.accessDialog.title, { name: viewer.fullName }) })).toHaveCount(0);
  await expect(adminRow.getByTestId('user-access-none')).toHaveText(enUsers.noAccess);
  await expect(adminRow.getByRole('button', { name: fill(enUsers.actions.editAccessFor, { name: viewer.fullName }) })).toHaveCount(0);

  // The super admin lists it (a standard user with no grant) and assigns it.
  await switchUser(page, APPROVER_EMAIL);
  await openUsers(page, enUsers, VIEWER_EMAIL);
  const row = rowOf(page, VIEWER_EMAIL);
  await row.getByRole('button', { name: fill(enUsers.actions.editAccessFor, { name: viewer.fullName }) }).click();
  const dialog = page.getByRole('dialog', { name: fill(enUsers.accessDialog.title, { name: viewer.fullName }) });
  await expect(dialog.getByText(enUsers.accessDialog.standardUserDescription)).toBeVisible();
  await expect(dialog.getByText(enUsers.picker.singleHeading)).toBeVisible();
  // Only the super admin's own four companies, one at a time.
  await expect(dialog.getByRole('radio')).toHaveCount(SEED_APPROVER_GRANTS.length);
  await expect(dialog.getByRole('radio', { name: subs.find((s) => s.id === SUB.trading)!.legalName })).toHaveCount(0);
  await expect(dialog.getByTestId('subsidiary-picker-count')).toHaveText(
    fill(enUsers.picker.selectedCount, { count: 0, total: SEED_APPROVER_GRANTS.length }),
  );
  await expect(dialog.getByTestId('subsidiary-picker-empty')).toHaveText(enUsers.picker.emptyWarning);
  const energy = subs.find((s) => s.id === SUB.energy)!.legalName;
  const gas = subs.find((s) => s.id === SUB.gas)!.legalName;
  await dialog.getByRole('radio', { name: gas }).click();
  await dialog.getByRole('radio', { name: energy }).click();
  await expect(dialog.getByRole('radio', { name: gas })).not.toBeChecked();
  await expect(dialog.getByTestId('subsidiary-picker-count')).toHaveText(
    fill(enUsers.picker.selectedCount, { count: 1, total: SEED_APPROVER_GRANTS.length }),
  );

  // A newly chosen company starts with no category: warned.
  const categories = dialog.getByTestId('category-picker');
  await expect(categories.getByTestId('category-picker-count')).toHaveText(
    fill(enUsers.picker.categoriesCount, { count: 0, total: 13 }),
  );
  await expect(categories.getByTestId('category-picker-empty')).toHaveText(fill(enUsers.picker.noCategoryWarning, { name: energy }));
  await categories.getByRole('button', { name: fill(enUsers.picker.selectAllCategoriesFor, { name: energy }) }).click();
  await expect(categories.getByTestId('category-picker-count')).toHaveText(
    fill(enUsers.picker.categoriesCount, { count: 13, total: 13 }),
  );
  await categories.getByRole('button', { name: fill(enUsers.picker.clearCategoriesFor, { name: energy }) }).click();
  await categories.getByRole('checkbox', { name: enCategories.Electricity }).click();
  await categories.getByRole('checkbox', { name: enCategories.Water }).click();
  await expect(categories.getByTestId('category-picker-count')).toHaveText(
    fill(enUsers.picker.categoriesCount, { count: 2, total: 13 }),
  );
  await expect(categories.getByTestId('category-picker-empty')).toHaveCount(0);
  await dialog.getByRole('button', { name: enUsers.accessDialog.submit }).click();
  await expect(page.getByText(enUsers.accessSaved)).toBeVisible();
  await expect(row.getByTestId('user-access-names')).toHaveText(energy);

  const after = await seedUser(VIEWER_EMAIL);
  expect(after.role).toBe('standard_user');
  expect(after.access).toEqual([{ subsidiaryId: SUB.energy, categories: ['Electricity', 'Water'] }]);
});

test('a super admin lists only the standard users it administers; a carried-over account\'s companies are held', async ({ page }) => {
  const entry = await seedUser(ENTRY_EMAIL);
  const subs = await subsidiaries();
  await login(page, APPROVER_EMAIL);
  await openUsers(page, enUsers, ENTRY_EMAIL);

  // Not the masterkey, not the auditors, not itself: the standard users of its companies.
  for (const email of [ADMIN_EMAIL, AUDITOR_EMAIL, VIEWER_EMAIL, APPROVER_EMAIL]) {
    await expect(rowOf(page, email), email).toHaveCount(0);
  }
  // The super admin invites standard users only.
  await page.getByRole('button', { name: enUsers.invite }).click();
  const invite = page.getByRole('dialog', { name: enUsers.inviteDialog.title });
  await expect(invite.getByRole('combobox', { name: enUsers.inviteDialog.role })).toHaveText(enUsers.roles.standard_user);
  await expect(invite.getByRole('combobox', { name: enUsers.inviteDialog.role })).toBeDisabled();
  await invite.getByRole('button', { name: enUsers.inviteDialog.cancel }).click();
  await expect(invite).toHaveCount(0);

  const row = rowOf(page, ENTRY_EMAIL);
  await row.getByRole('button', { name: fill(enUsers.actions.editAccessFor, { name: entry.fullName }) }).click();
  const dialog = page.getByRole('dialog', { name: fill(enUsers.accessDialog.title, { name: entry.fullName }) });
  await expect(dialog.getByText(enUsers.picker.heldHeading)).toBeVisible();
  await expect(dialog.getByTestId('held-companies-note')).toHaveText(enUsers.picker.heldNote);
  const held = dialog.getByTestId('held-company');
  await expect(held).toHaveCount(2);
  for (const id of SEED_ENTRY_GRANTS) {
    const name = subs.find((s) => s.id === id)!.legalName;
    const block = held.filter({ hasText: name });
    await expect(block.getByTestId('category-picker-count')).toHaveText(fill(enUsers.picker.categoriesCount, { count: 13, total: 13 }));
  }
  // No company can be added: no radio, no company checkbox.
  await expect(dialog.getByRole('radio')).toHaveCount(0);

  // Withdrawn when saved, and kept again on request; cancelled, nothing changes.
  const logistics = subs.find((s) => s.id === SUB.logistics)!.legalName;
  await dialog.getByRole('button', { name: fill(enUsers.picker.withdrawFor, { name: logistics }) }).click();
  await expect(held.filter({ hasText: logistics })).toContainText(enUsers.picker.withdrawn);
  await expect(held.filter({ hasText: logistics }).getByTestId('category-picker')).toHaveCount(0);
  await dialog.getByRole('button', { name: fill(enUsers.picker.restoreFor, { name: logistics }) }).click();
  await expect(held.filter({ hasText: logistics }).getByTestId('category-picker')).toBeVisible();
  await dialog.getByRole('button', { name: enUsers.accessDialog.cancel }).click();
  await expect(dialog).toHaveCount(0);
  expect((await seedUser(ENTRY_EMAIL)).access.map((g) => g.subsidiaryId).sort()).toEqual([...SEED_ENTRY_GRANTS].sort());
});

for (const [who, email] of [['a standard user', ENTRY_EMAIL], ['an auditor', AUDITOR_EMAIL]] as const) {
  test(`${who} is told who manages users, and the API refuses the list`, async ({ page, request }) => {
    await login(page, email);
    await page.goto('/users');
    await expect(page.getByText(enUsers.forbiddenTitle)).toBeVisible();
    await expect(page.getByRole('button', { name: enUsers.invite })).toHaveCount(0);
    await expect(page.locator('table')).toHaveCount(0);
    const res = await request.get(`${API_BASE}/users`, { headers: bearer(await getAccessToken(request, email)) });
    expect(res.status()).toBe(403);
  });
}

test('the access copy speaks Turkish', async ({ page }) => {
  const approver = await seedUser(APPROVER_EMAIL);
  const subs = await subsidiaries();
  const names = sortedNames(subs, approver.access.map((g) => g.subsidiaryId), 'tr');

  await setLanguage(ADMIN_EMAIL, 'tr');
  await login(page, ADMIN_EMAIL);
  await openUsers(page, trUsers);
  const row = rowOf(page, APPROVER_EMAIL);
  await expect(row.getByTestId('user-access-names')).toHaveText(names.slice(0, 3).join(', '));
  await expect(row).toContainText(fill(trUsers.accessMore, { count: 1 }));
  await expect(row).toContainText(trUsers.roles.super_admin);
  await expect(rowOf(page, AUDITOR_EMAIL)).toContainText(trUsers.wholeOrganisation);
  await expect(rowOf(page, AUDITOR_EMAIL)).toContainText(trUsers.roles.auditor);

  await row.getByRole('button', { name: fill(trUsers.actions.editAccessFor, { name: approver.fullName }) }).click();
  const dialog = page.getByRole('dialog', { name: fill(trUsers.accessDialog.title, { name: approver.fullName }) });
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
  await pickByFieldLabel(page, trUsers.inviteDialog.role, trUsers.roles.auditor);
  await expect(page.getByRole('dialog').getByTestId('invite-role-access-note')).toHaveText(trUsers.roleAccessNote.auditor);
  await page.getByRole('dialog').getByRole('button', { name: trUsers.inviteDialog.cancel }).click();
  expect((await seedUser(APPROVER_EMAIL)).access.map((g) => g.subsidiaryId).sort()).toEqual([...SEED_APPROVER_GRANTS].sort());
});

for (const [language, copy] of [['en', enUsers], ['tr', trUsers]] as const) {
  test(`with no subsidiary at all the picker still counts and warns (${language})`, async ({ page }) => {
    // A parent company with no subsidiary yet (a fresh registration): the
    // browser's read of the list answers empty; everything else is real.
    await page.route(/\/api\/v1\/subsidiaries$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ response: await route.fetch(), json: [] });
    });
    if (language === 'tr') await setLanguage(ADMIN_EMAIL, 'tr');
    await login(page, ADMIN_EMAIL);
    await openUsers(page, copy);

    await page.getByRole('button', { name: copy.invite }).click();
    const dialog = page.getByRole('dialog', { name: copy.inviteDialog.title });
    await expect(dialog.getByTestId('subsidiary-picker-none')).toHaveText(copy.picker.noneAssignable);
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

    // The same picker in the access editor after a role change to Super Admin.
    const viewer = await seedUser(VIEWER_EMAIL);
    await rowOf(page, VIEWER_EMAIL).getByRole('button', { name: fill(copy.actions.menu, { name: viewer.fullName }) }).click();
    await page.getByRole('menuitem', { name: copy.actions.changeRole }).click();
    const roleDialog = page.getByRole('dialog', { name: fill(copy.roleDialog.title, { name: viewer.fullName }) });
    await roleDialog.getByRole('combobox', { name: copy.columns.role }).click();
    await page.getByRole('option', { name: copy.roles.super_admin, exact: true }).click();
    await roleDialog.getByRole('button', { name: copy.roleDialog.submit }).click();
    const accessDialog = page.getByRole('dialog', { name: fill(copy.accessDialog.title, { name: viewer.fullName }) });
    await expect(accessDialog.getByTestId('subsidiary-picker-none')).toHaveText(copy.picker.noneAssignable);
    await expect(accessDialog.getByTestId('subsidiary-picker-count')).toHaveText(
      fill(copy.picker.selectedCount, { count: 0, total: 0 }),
    );
    await expect(accessDialog.getByTestId('subsidiary-picker-empty')).toHaveText(copy.picker.emptyWarning);
    await expect(accessDialog.getByRole('button', { name: copy.accessDialog.submit })).toBeEnabled();
    await accessDialog.getByRole('button', { name: copy.accessDialog.cancel }).click();
  });
}
