import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import type { SubsidiaryDTO, UserSummaryDTO } from '@tonyai/shared-types';
import enCategories from '../apps/web/messages/en/categories.json';
import enErrors from '../apps/web/messages/en/errors.json';
import enReview from '../apps/web/messages/en/review.json';
import enUsers from '../apps/web/messages/en/users.json';
import trUsers from '../apps/web/messages/tr/users.json';
import {
  ADMIN_EMAIL,
  API_BASE,
  APPROVER_EMAIL,
  E2E_INVITED_PREFIX,
  E2E_YEAR,
  ENTRY_EMAIL,
  SEED_ENTRY_GRANT,
  SEED_ENTRY_MAIN,
  SUB,
  bearer,
  createCommittedRecord,
  deleteRecordsAsService,
  getAccessToken,
  listAllPages,
  login,
  removeE2EInvitedAccounts,
  insertDraftAsOwner,
  resetSeedAccess,
} from './helpers';

/**
 * Central reporting end to end (inc26-central-reporter-onboarding, task 6.2):
 * a masterkey gives the grant on the users screen; the reporter enters for the
 * owning company; the owning company's super admin finds it, sees the
 * reporting company on the sheet and approves; a super admin without the
 * owning company sees nothing of it; a conflicting assignment and a record in
 * a period the other party holds are refused in the reader's words.
 */

test.describe.configure({ mode: 'serial' });

const OTHER_ADMIN = `${E2E_INVITED_PREFIX}central-reporter-sa@tonyai.local`;
const OWN_USER = `${E2E_INVITED_PREFIX}central-reporter-own@tonyai.local`;
const created: string[] = [];

async function restore() {
  const api = await playwrightRequest.newContext();
  try {
    if (created.length) await deleteRecordsAsService(api, created.splice(0));
    await removeE2EInvitedAccounts(api);
    await resetSeedAccess(api);
  } finally {
    await api.dispose();
  }
}
test.beforeAll(restore);
test.afterAll(restore);

async function users(request: APIRequestContext): Promise<UserSummaryDTO[]> {
  return listAllPages<UserSummaryDTO>(request, await getAccessToken(request, ADMIN_EMAIL), '/users');
}
async function companies(request: APIRequestContext): Promise<SubsidiaryDTO[]> {
  const res = await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(await getAccessToken(request, ADMIN_EMAIL)) });
  return res.json();
}

test('a masterkey gives the grant on the users screen; the owning company decides the reporter\'s record', async ({ page, request }) => {
  const entry = (await users(request)).find((u) => u.email === ENTRY_EMAIL)!;
  const subs = await companies(request);
  const name = (id: string) => subs.find((s) => s.id === id)!.legalName;
  // Start from no grant, so the screen gives it.
  const withdraw = await request.put(`${API_BASE}/users/${entry.id}/central-reporter-grant`, {
    headers: bearer(await getAccessToken(request, ADMIN_EMAIL)),
    data: { subsidiaryIds: [], categories: [] },
  });
  expect(withdraw.status()).toBe(200);

  await login(page, ADMIN_EMAIL);
  await page.goto('/users');
  const row = page.locator('tbody tr', { hasText: ENTRY_EMAIL });
  await row.getByRole('button', { name: fill(enUsers.actions.menu, { name: entry.fullName }) }).click();
  await page.getByRole('menuitem', { name: fill(enUsers.actions.centralReporterFor, { name: entry.fullName }) }).click();
  const dialog = page.getByTestId('central-reporter-dialog');
  await dialog.getByTestId('grant-companies').getByText(name(SEED_ENTRY_GRANT), { exact: true }).click();
  await dialog.getByTestId('grant-categories').getByText(enCategories.Electricity, { exact: true }).click();
  // The change is shown before it is saved: the main company named, the grant company added.
  await expect(dialog.getByTestId('grant-preview')).toContainText(fill(enUsers.grantDialog.mainCompany, { name: name(SEED_ENTRY_MAIN) }));
  await dialog.getByRole('button', { name: enUsers.grantDialog.submit }).click();
  await expect(page.getByText(enUsers.grantDialog.saved)).toBeVisible();
  await expect(row.getByTestId('user-access-grant')).toContainText(name(SEED_ENTRY_GRANT));

  // The reporter enters for the owning company: Logistics owns it, Energy reported it.
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  const id = await createCommittedRecord(request, entryToken, {
    subsidiaryId: SEED_ENTRY_GRANT, category: 'Electricity', periodValue: 'Q3', activityValue: 1200, varianceReason: 'e2e: central reporter',
  });
  created.push(id);
  const read = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(entryToken) })).json();
  expect(read).toMatchObject({ subsidiaryId: SEED_ENTRY_GRANT, reportedBySubsidiaryId: SEED_ENTRY_MAIN });

  // A super admin without the owning company sees nothing of it.
  const invite = await request.post(`${API_BASE}/users/invitations`, {
    headers: bearer(await getAccessToken(request, ADMIN_EMAIL)),
    data: { email: OTHER_ADMIN, fullName: 'E2E Other Super Admin', role: 'super_admin', language: 'en', access: [{ subsidiaryId: SUB.gas, categories: [] }] },
  });
  expect(invite.status()).toBe(201);

  // The owning company's super admin: in its queue, the reporting company on the sheet, approved.
  await page.getByTestId('sign-out').click();
  await page.waitForURL('**/login');
  await login(page, APPROVER_EMAIL);
  await page.goto('/review');
  await expect(page.getByTestId('review-queue-total')).not.toContainText('—');
  const queued = page.locator('table tbody tr', { hasText: name(SEED_ENTRY_GRANT) }).filter({ hasText: `Q3 ${E2E_YEAR}` }).filter({ hasText: 'Electricity' });
  await queued.click();
  await expect(page.getByTestId('review-reported-by')).toHaveText(read.reportedBySubsidiaryName);
  await page.getByRole('button', { name: enReview.sheet.approve, exact: true }).click();
  await expect(page.getByText(enReview.toast.approved)).toBeVisible();
  const approved = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(await getAccessToken(request, ADMIN_EMAIL)) })).json();
  expect(approved).toMatchObject({ status: 'approved', reportedBySubsidiaryId: SEED_ENTRY_MAIN });
});

test('a conflicting assignment and a taken period are refused in the reader\'s words', async ({ page, request }) => {
  // The seed's grant (every category at Logistics), whatever the case before left.
  await resetSeedAccess(request);
  const subs = await companies(request);
  const name = (id: string) => subs.find((s) => s.id === id)!.legalName;
  const approverToken = await getAccessToken(request, APPROVER_EMAIL);
  // A company's own standard user at the grant's company, with a category the grant does not hold.
  const own = await request.post(`${API_BASE}/users/invitations`, {
    headers: bearer(approverToken),
    data: { email: OWN_USER, fullName: 'E2E Own User', role: 'standard_user', language: 'en', access: [{ subsidiaryId: SEED_ENTRY_GRANT, categories: ['Waste'] }] },
  });
  // The seed's grant holds every category at Logistics: Waste cannot be opened to its own user.
  expect(own.status()).toBe(409);
  const refusal = await own.json();
  expect(refusal).toMatchObject({ code: 'single_entry_conflict', params: { side: 'central_reporter' }, conflicts: [{ subsidiaryId: SEED_ENTRY_GRANT, categories: ['Waste'] }] });

  // On the screen, in English and in Turkish: the sentence names the company and the category.
  await login(page, APPROVER_EMAIL);
  await page.goto('/users');
  await page.getByRole('button', { name: enUsers.invite }).click();
  const dialog = page.getByRole('dialog', { name: enUsers.inviteDialog.title });
  await dialog.getByLabel(enUsers.inviteDialog.email, { exact: true }).fill(OWN_USER);
  await dialog.getByLabel(enUsers.inviteDialog.name, { exact: true }).fill('E2E Own User');
  await dialog.getByRole('radio', { name: name(SEED_ENTRY_GRANT) }).click();
  await dialog.getByText(enCategories.Waste, { exact: true }).click();
  await dialog.getByRole('button', { name: enUsers.inviteDialog.submit }).click();
  await expect(page.getByText(fill(enUsers.errors.singleEntry.centralReporter, { company: name(SEED_ENTRY_GRANT), categories: enCategories.Waste }))).toBeVisible();
  expect(trUsers.errors.singleEntry.centralReporter).toContain('{company}');

  // A record in a period the other party holds. The category is handed over:
  // the grant gives up Waste, the company's own user is assigned it and enters
  // Q1, then Waste goes back to the grant — and the reporter's Q1 is refused.
  const adminToken = await getAccessToken(request, ADMIN_EMAIL);
  const entry = (await users(request)).find((u) => u.email === ENTRY_EMAIL)!;
  const grant = (categories: string[]) => request.put(`${API_BASE}/users/${entry.id}/central-reporter-grant`, {
    headers: bearer(adminToken), data: { subsidiaryIds: [SEED_ENTRY_GRANT], categories },
  });
  expect((await grant(['Electricity'])).status()).toBe(200);
  const invited = await request.post(`${API_BASE}/users/invitations`, {
    headers: bearer(approverToken),
    data: { email: OWN_USER, fullName: 'E2E Own User', role: 'standard_user', language: 'en', access: [{ subsidiaryId: SEED_ENTRY_GRANT, categories: ['Waste'] }] },
  });
  expect(invited.status()).toBe(201);
  const ownUser = (await invited.json()) as UserSummaryDTO;
  created.push(await insertDraftAsOwner(OWN_USER, SEED_ENTRY_GRANT, 'Waste', 3, 'Q1'));
  const moved = await request.put(`${API_BASE}/users/${ownUser.id}/access`, {
    headers: bearer(approverToken), data: { access: [{ subsidiaryId: SEED_ENTRY_GRANT, categories: ['Water'] }] },
  });
  expect(moved.status()).toBe(200);
  expect((await grant(['Electricity', 'Waste'])).status()).toBe(200);
  const refused = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(await getAccessToken(request, ENTRY_EMAIL)),
    data: {
      subsidiaryId: SEED_ENTRY_GRANT, reportingYear: E2E_YEAR, reportingPeriod: 'quarterly', periodValue: 'Q1', category: 'Waste',
      activityValue: 2, activityUnit: 'tonnes', locationId: null, input: null, varianceReason: null,
    },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({
    code: 'single_entry_period_conflict', params: { side: 'company_users', category: 'Waste', year: E2E_YEAR, period: 'Q1' },
  });
  // The reporter's own next period passes.
  const next = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(await getAccessToken(request, ENTRY_EMAIL)),
    data: {
      subsidiaryId: SEED_ENTRY_GRANT, reportingYear: E2E_YEAR, reportingPeriod: 'quarterly', periodValue: 'Q2', category: 'Waste',
      activityValue: 2, activityUnit: 'tonnes', locationId: null, input: null, varianceReason: null,
    },
  });
  expect(next.status()).toBe(201);
  created.push((await next.json()).id);
  expect(enErrors.codes.single_entry_period_conflict).toContain('{period}');
});

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), template);
}
