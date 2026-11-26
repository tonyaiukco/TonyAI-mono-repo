import { test, expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import { holdsRecords, type SubsidiaryDTO, type UserSummaryDTO } from '@tonyai/shared-types';
import enCategories from '../apps/web/messages/en/categories.json';
import enDataEntry from '../apps/web/messages/en/dataEntry.json';
import enRecordTrail from '../apps/web/messages/en/recordTrail.json';
import enReview from '../apps/web/messages/en/review.json';
import enUsers from '../apps/web/messages/en/users.json';
import {
  ADMIN_EMAIL,
  API_BASE,
  APPROVER_EMAIL,
  AUDITOR_EMAIL,
  E2E_INVITED_PREFIX,
  E2E_YEAR,
  ENTRY_EMAIL,
  SEED_APPROVER_GRANTS,
  SUB,
  VIEWER_EMAIL,
  bearer,
  createCommittedRecord,
  deleteRecordsAsService,
  findRecordId,
  getAccessToken,
  listAllPages,
  login,
  readAuditSince,
  removeE2EInvitedAccounts,
  resetSeedAccess,
  seenSubmittedAt,
} from './helpers';

/**
 * The approval chain and the four roles end to end (inc26-roles-approval-chain,
 * INC-2.6 §1, §1.1, §6; design Decisions 6, 7, 9): who decides a pending
 * record is its `approver` — the company's super_admin for a standard user's
 * record, the masterkey for a super_admin's record and for a company with no
 * super_admin (TonyAI Trading, the seed's fallback company), and a masterkey
 * alone for its own record, audited `self_approve` and shown to the auditor as
 * "Self-approved". A standard user sees only the categories ticked on its
 * grant; an auditor decides nothing.
 *
 * Lanes (quarterly `E2E_YEAR`, whole company, each deleted in `finally`):
 * Logistics·Water·Q4 (the standard user's record), Gas·Fuel·Q1 (the super
 * admin's), Trading·Fuel·Q2 (the fallback; Trading Q1 is `gates.spec`'s lock),
 * Mfg·Water·Q1 (the masterkey's own). Water needs no factor and Fuel diesel
 * the seed's placeholder, so nothing leans on a TR release.
 *
 * Access is changed through the API as each role would, and put back to the
 * seed's after every test by `resetSeedAccess`; the account BUG-14's case
 * invites is removed before and after the file (`removeE2EInvitedAccounts`).
 */

const INVITED = `${E2E_INVITED_PREFIX}super-admin@tonyai.local`;

async function restore() {
  const api = await playwrightRequest.newContext();
  try {
    await resetSeedAccess(api);
    await removeE2EInvitedAccounts(api);
  } finally {
    await api.dispose();
  }
}

test.beforeAll(restore);
// Hooks, not a test's `finally`: a hook still runs, with its own timeout, after a test times out.
test.afterEach(restore);

async function usersAsAdmin(request: APIRequestContext): Promise<UserSummaryDTO[]> {
  return listAllPages<UserSummaryDTO>(request, await getAccessToken(request, ADMIN_EMAIL), '/users');
}

async function userId(request: APIRequestContext, email: string): Promise<string> {
  const user = (await usersAsAdmin(request)).find((u) => u.email === email);
  if (!user) throw new Error(`user ${email} not found`);
  return user.id;
}

/** PATCH a role or PUT an access list, as `actor`, expecting it to pass. */
async function administer(request: APIRequestContext, actor: string, path: string, method: 'patch' | 'put', data: unknown) {
  const res = await request[method](`${API_BASE}${path}`, { headers: bearer(await getAccessToken(request, actor)), data });
  expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBe(200);
}

async function readRecord(request: APIRequestContext, id: string) {
  const res = await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(await getAccessToken(request, ADMIN_EMAIL)) });
  expect(res.ok()).toBe(true);
  return res.json();
}

/** A decision as `email`: review, reject or approve, naming the submission seen. */
async function decide(request: APIRequestContext, email: string, id: string, verb: 'review' | 'reject' | 'approve') {
  const token = await getAccessToken(request, email);
  return request.post(`${API_BASE}/activity-records/${id}/${verb}`, {
    headers: bearer(token),
    data: {
      seenSubmittedAt: await seenSubmittedAt(request, await getAccessToken(request, ADMIN_EMAIL), id),
      ...(verb === 'reject' ? { varianceReason: 'e2e: not this user to return it' } : {}),
    },
  });
}

const queueRow = (page: Page, subsidiary: string, period: string, category: string) =>
  page.locator('table tbody tr', { hasText: subsidiary }).filter({ hasText: `${period} ${E2E_YEAR}` }).filter({ hasText: category });

/** The review queue once its count has arrived, so an absent row is a real absence. */
async function openQueue(page: Page) {
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: 'Review Queue' })).toBeVisible();
  await expect(page.getByTestId('review-queue-total')).not.toContainText('—');
}

test('BUG-14: a masterkey invites a super admin for two companies through the users screen', async ({ page, request }) => {
  const subs = (await (await request.get(`${API_BASE}/subsidiaries`, {
    headers: bearer(await getAccessToken(request, ADMIN_EMAIL)),
  })).json()) as SubsidiaryDTO[];
  const name = (id: string) => subs.find((s) => s.id === id)!.legalName;

  await login(page, ADMIN_EMAIL);
  await page.goto('/users');
  await expect(page.getByRole('heading', { name: enUsers.title })).toBeVisible();
  await page.getByRole('button', { name: enUsers.invite }).click();
  const dialog = page.getByRole('dialog', { name: enUsers.inviteDialog.title });
  await dialog.getByLabel(enUsers.inviteDialog.email, { exact: true }).fill(INVITED);
  await dialog.getByLabel(enUsers.inviteDialog.name, { exact: true }).fill('E2E Invited Super Admin');
  // The masterkey's first invitable role, and the companies can be chosen —
  // the defect was a picker with nothing to select for this role.
  await expect(dialog.getByRole('combobox', { name: enUsers.inviteDialog.role })).toHaveText(enUsers.roles.super_admin);
  await dialog.getByRole('checkbox', { name: name(SUB.gas) }).click();
  await dialog.getByRole('checkbox', { name: name(SUB.mfg) }).click();
  await expect(dialog.getByTestId('subsidiary-picker-count')).toHaveText(
    // The picker lists the companies that can hold a grant: no sector group, no associate (inc26-group-tree).
    enUsers.picker.selectedCount.replace('{count}', '2').replace('{total}', String(subs.filter((s) => holdsRecords(s)).length)),
  );
  await dialog.getByRole('button', { name: enUsers.inviteDialog.submit }).click();
  // Delivered or not (a local stack may hold no mail transport), the account exists.
  await expect(
    page.getByText(enUsers.invited.replace('{email}', INVITED)).or(page.getByText(enUsers.invitedNotDelivered.replace('{email}', INVITED))),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);

  const row = page.locator('tbody tr', { hasText: INVITED });
  await expect(row).toContainText(enUsers.roles.super_admin);
  await expect(row.getByTestId('user-access-names')).toHaveText(
    [name(SUB.gas), name(SUB.mfg)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })).join(', '),
  );

  // Read back: a super_admin with exactly those two grants, no category list.
  const invited = (await usersAsAdmin(request)).find((u) => u.email === INVITED);
  expect(invited).toMatchObject({ role: 'super_admin', status: 'invited' });
  expect(invited!.access.map((g) => g.subsidiaryId).sort()).toEqual([SUB.gas, SUB.mfg].sort());
  expect(invited!.access.every((g) => g.categories.length === 0)).toBe(true);
});

test("a standard user's record is decided by its company's super admin, not by the masterkey or an auditor", async ({ page, request }) => {
  const id = await createCommittedRecord(request, await getAccessToken(request, ENTRY_EMAIL), {
    subsidiaryId: SUB.logistics,
    category: 'Water',
    periodValue: 'Q4',
    activityValue: 80,
    activityUnit: 'cubic_metres',
    varianceReason: 'e2e: approval chain lane',
  });
  try {
    expect((await readRecord(request, id)).approver).toBe('super_admin');

    // Not the masterkey's: absent from its default view, labelled in "every pending record".
    await login(page, ADMIN_EMAIL);
    await openQueue(page);
    await expect(queueRow(page, 'TonyAI Logistics', 'Q4', 'Water')).toHaveCount(0);
    await page.getByTestId('review-show-all').click();
    const row = queueRow(page, 'TonyAI Logistics', 'Q4', 'Water');
    await expect(row.getByTestId('review-row-awaits')).toHaveText(enReview.awaits.super_admin);
    await row.click();
    await expect(page.getByTestId('review-sheet-awaits')).toHaveText(enReview.sheet.decidedBy.super_admin);
    await expect(page.getByRole('button', { name: enReview.sheet.approve, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: enReview.sheet.reject, exact: true })).toHaveCount(0);
    // Opening it changed nothing.
    await expect(page.getByTestId('review-sheet-status')).toContainText('submitted');
    await page.keyboard.press('Escape');
    // ...and the API refuses each decision by the routing's code.
    for (const verb of ['review', 'reject', 'approve'] as const) {
      const res = await decide(request, ADMIN_EMAIL, id, verb);
      expect(res.status(), verb).toBe(403);
      expect((await res.json()).code, verb).toBe('not_record_approver');
    }
    // An auditor is refused on the role.
    const byAuditor = await decide(request, AUDITOR_EMAIL, id, 'approve');
    expect(byAuditor.status()).toBe(403);

    // The super admin's default view holds it; opening takes it into review; Approve.
    await page.getByTestId('sign-out').click();
    await page.waitForURL('**/login');
    await login(page, APPROVER_EMAIL);
    await openQueue(page);
    const mine = queueRow(page, 'TonyAI Logistics', 'Q4', 'Water');
    await expect(mine.getByTestId('review-row-awaits')).toHaveCount(0);
    await mine.click();
    await expect(page.getByTestId('review-sheet-status')).toContainText('under review');
    await page.getByRole('button', { name: enReview.sheet.approve, exact: true }).click();
    await expect(page.getByText(enReview.toast.approved)).toBeVisible();

    const approved = await readRecord(request, id);
    expect(approved).toMatchObject({ status: 'approved', reviewedByName: 'Arda Approver', createdByName: 'Eda Entry' });
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

test("a super admin's record is refused to a colleague super admin and approved by the masterkey", async ({ request }) => {
  // A colleague: the viewer account made a super_admin of Gas, by the masterkey.
  const viewerId = await userId(request, VIEWER_EMAIL);
  await administer(request, ADMIN_EMAIL, `/users/${viewerId}/role`, 'patch', { role: 'super_admin' });
  await administer(request, ADMIN_EMAIL, `/users/${viewerId}/access`, 'put', { access: [{ subsidiaryId: SUB.gas, categories: [] }] });

  const since = new Date(Date.now() - 60_000).toISOString();
  const id = await createCommittedRecord(request, await getAccessToken(request, APPROVER_EMAIL), {
    subsidiaryId: SUB.gas,
    category: 'Fuel',
    periodValue: 'Q1',
    activityValue: 900,
    activityUnit: 'litres',
    varianceReason: 'e2e: approval chain lane',
  });
  try {
    expect((await readRecord(request, id)).approver).toBe('masterkey');

    // The colleague reads it (Gas is granted) and decides nothing of it.
    for (const verb of ['review', 'reject', 'approve'] as const) {
      const res = await decide(request, VIEWER_EMAIL, id, verb);
      expect(res.status(), verb).toBe(403);
      const body = await res.json();
      expect(body.code, verb).toBe('not_record_approver');
      expect(body.message, verb).toMatch(/decided by a masterkey/);
    }
    // Its author neither: a non-masterkey author never decides its own record.
    const own = await decide(request, APPROVER_EMAIL, id, 'approve');
    expect(own.status()).toBe(403);
    expect((await own.json()).code).toBe('self_approval_forbidden');
    expect((await readRecord(request, id)).status).toBe('submitted');

    // The masterkey approves it: an approval, not a self-approval.
    const byMasterkey = await decide(request, ADMIN_EMAIL, id, 'approve');
    expect(byMasterkey.status(), await byMasterkey.text()).toBe(200);
    expect(await byMasterkey.json()).toMatchObject({ status: 'approved', reviewedByName: 'Tony Admin', createdByName: 'Arda Approver' });
    const approvals = (await readAuditSince(request, { entity: 'activity_record', action: 'approve', since })).filter((r) => r.entityId === id);
    expect(approvals).toHaveLength(1);
    const selfApprovals = (await readAuditSince(request, { entity: 'activity_record', action: 'self_approve', since })).filter((r) => r.entityId === id);
    expect(selfApprovals).toHaveLength(0);
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

test('the fallback company: a standard user\'s record in TonyAI Trading, which has no super admin, goes to the masterkey', async ({ page, request }) => {
  // A Trading standard user, made the way the product makes one: the masterkey
  // makes the viewer account a standard user and gives the super admin
  // Trading for a moment; the super admin assigns the user Trading with Fuel;
  // the masterkey takes Trading back. Trading is again without a super admin.
  const viewerId = await userId(request, VIEWER_EMAIL);
  const approverId = await userId(request, APPROVER_EMAIL);
  const withTrading = [...SEED_APPROVER_GRANTS, SUB.trading].map((subsidiaryId) => ({ subsidiaryId, categories: [] }));
  await administer(request, ADMIN_EMAIL, `/users/${approverId}/access`, 'put', { access: withTrading });
  await administer(request, ADMIN_EMAIL, `/users/${viewerId}/role`, 'patch', { role: 'standard_user' });
  await administer(request, APPROVER_EMAIL, `/users/${viewerId}/access`, 'put', { access: [{ subsidiaryId: SUB.trading, categories: ['Fuel'] }] });
  await administer(request, ADMIN_EMAIL, `/users/${approverId}/access`, 'put', {
    access: SEED_APPROVER_GRANTS.map((subsidiaryId) => ({ subsidiaryId, categories: [] })),
  });

  const since = new Date(Date.now() - 60_000).toISOString();
  const id = await createCommittedRecord(request, await getAccessToken(request, VIEWER_EMAIL), {
    subsidiaryId: SUB.trading,
    category: 'Fuel',
    periodValue: 'Q2',
    activityValue: 500,
    activityUnit: 'litres',
    varianceReason: 'e2e: approval chain lane',
  });
  try {
    expect((await readRecord(request, id)).approver).toBe('masterkey');
    // The super admin holds no Trading grant: the record does not exist for it.
    const byApprover = await decide(request, APPROVER_EMAIL, id, 'approve');
    expect(byApprover.status()).toBe(404);

    // The masterkey's default view holds it, and the masterkey approves it.
    await login(page, ADMIN_EMAIL);
    await openQueue(page);
    const row = queueRow(page, 'TonyAI Trading', 'Q2', 'Fuel');
    await expect(row).toContainText('Vera Viewer');
    await expect(row.getByTestId('review-row-awaits')).toHaveCount(0);
    await row.click();
    await expect(page.getByTestId('review-sheet-status')).toContainText('under review');
    await expect(page.getByTestId('review-sheet-self-approval-note')).toHaveCount(0);
    await page.getByRole('button', { name: enReview.sheet.approve, exact: true }).click();
    await expect(page.getByText(enReview.toast.approved)).toBeVisible();

    expect(await readRecord(request, id)).toMatchObject({ status: 'approved', reviewedByName: 'Tony Admin' });
    const approvals = (await readAuditSince(request, { entity: 'activity_record', action: 'approve', since })).filter((r) => r.entityId === id);
    expect(approvals).toHaveLength(1);
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

test('a masterkey decides its own record alone, as a self-approval the auditor reads as "Self-approved"', async ({ page, request }) => {
  const since = new Date(Date.now() - 60_000).toISOString();
  const id = await createCommittedRecord(request, await getAccessToken(request, ADMIN_EMAIL), {
    subsidiaryId: SUB.mfg,
    category: 'Water',
    periodValue: 'Q1',
    activityValue: 50,
    activityUnit: 'cubic_metres',
    varianceReason: 'e2e: approval chain lane',
  });
  try {
    expect((await readRecord(request, id)).approver).toBe('author');
    // Nobody else decides it: not the super admin of Mfg, not an auditor.
    const bySuperAdmin = await decide(request, APPROVER_EMAIL, id, 'approve');
    expect(bySuperAdmin.status()).toBe(403);
    expect((await bySuperAdmin.json()).code).toBe('not_record_approver');
    expect((await decide(request, AUDITOR_EMAIL, id, 'approve')).status()).toBe(403);

    const self = await decide(request, ADMIN_EMAIL, id, 'approve');
    expect(self.status(), await self.text()).toBe(200);
    expect(await self.json()).toMatchObject({ status: 'approved', reviewedByName: 'Tony Admin', createdByName: 'Tony Admin' });
    const selfApprovals = (await readAuditSince(request, { entity: 'activity_record', action: 'self_approve', since })).filter((r) => r.entityId === id);
    expect(selfApprovals).toHaveLength(1);
    const approvals = (await readAuditSince(request, { entity: 'activity_record', action: 'approve', since })).filter((r) => r.entityId === id);
    expect(approvals).toHaveLength(0);

    // The auditor reads the organisation's trail: the newest row is that
    // self-approval, and the record's timeline names it.
    await login(page, AUDITOR_EMAIL);
    await page.goto('/audit');
    await expect(page.getByRole('heading', { name: 'Audit Trail' })).toBeVisible();
    await page.locator('table tbody tr').first().click();
    const trail = page.getByTestId('record-trail');
    const event = trail.locator('[data-testid="record-trail-event"][data-kind="self_approved"]');
    await expect(event).toContainText(enRecordTrail.kinds.self_approved);
    await expect(event).toHaveAttribute('data-marked', 'true');
    await expect(trail.locator('[data-testid="record-trail-event"][data-kind="approved"]')).toHaveCount(0);
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

test('a standard user granted one category sees no other category\'s record or figure', async ({ page, request }) => {
  // The super admin narrows the standard user to Energy·Electricity (Logistics
  // withdrawn); the seed's Energy holds Natural Gas records too, all entered
  // by the admin.
  const entryId = await userId(request, ENTRY_EMAIL);
  await administer(request, APPROVER_EMAIL, `/users/${entryId}/access`, 'put', {
    access: [{ subsidiaryId: SUB.energy, categories: ['Electricity'] }],
  });
  // Logistics is the seed's central reporter grant: only the masterkey's grant
  // route withdraws it (inc26-central-reporter-onboarding).
  await administer(request, ADMIN_EMAIL, `/users/${entryId}/central-reporter-grant`, 'put', { subsidiaryIds: [], categories: [] });
  const admin = await getAccessToken(request, ADMIN_EMAIL);
  const entry = await getAccessToken(request, ENTRY_EMAIL);

  // Records: the list holds Electricity (or the user's own records) only, and
  // another category's record reads as missing.
  const listed = await listAllPages<{ category: string; createdBy: string }>(request, entry, `/activity-records?subsidiaryId=${SUB.energy}&year=${E2E_YEAR}`);
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.filter((r) => r.category !== 'Electricity' && r.createdBy !== entryId)).toEqual([]);
  const gasJanuary = await findRecordId(request, admin, { subsidiaryId: SUB.energy, category: 'Natural Gas', periodValue: 'January', reportingPeriod: 'monthly' });
  expect((await request.get(`${API_BASE}/activity-records/${gasJanuary}`, { headers: bearer(entry) })).status()).toBe(404);
  expect((await request.get(`${API_BASE}/activity-records/${gasJanuary}/evidence`, { headers: bearer(entry) })).status()).toBe(404);
  // Logistics was withdrawn: its records are gone from this user's reads too.
  const logistics = await request.get(`${API_BASE}/activity-records?subsidiaryId=${SUB.logistics}&year=${E2E_YEAR}&limit=100`, { headers: bearer(entry) });
  if (logistics.ok()) {
    const items = ((await logistics.json()) as { items: { createdBy: string }[] }).items;
    expect(items.filter((r) => r.createdBy !== entryId)).toEqual([]);
  }

  // Figures: the admin's Energy breakdown has Natural Gas; this user's has none.
  const summary = async (token: string) =>
    (await (await request.get(`${API_BASE}/emissions/summary?year=${E2E_YEAR}&subsidiaryId=${SUB.energy}`, { headers: bearer(token) })).json()) as {
      byCategory: { category: string; tCo2e: number }[];
      totals: { total: number };
    };
  const whole = await summary(admin);
  expect(whole.byCategory.map((c) => c.category)).toEqual(expect.arrayContaining(['Natural Gas', 'Electricity']));
  const narrowed = await summary(entry);
  expect(narrowed.byCategory.map((c) => c.category)).toContain('Electricity');
  expect(narrowed.byCategory.map((c) => c.category)).not.toContain('Natural Gas');
  expect(narrowed.totals.total).toBeLessThan(whole.totals.total);

  // Writing another category is refused by its own code.
  const write = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(entry),
    data: {
      subsidiaryId: SUB.energy, locationId: null, reportingYear: E2E_YEAR, reportingPeriod: 'quarterly', periodValue: 'Q4',
      category: 'Fuel', activityType: 'diesel', activityValue: 10, activityUnit: 'litres', varianceReason: null, input: null,
    },
  });
  expect(write.status()).toBe(403);
  expect((await write.json()).code).toBe('category_not_granted');

  // The screen: Data Entry offers Electricity alone, says a linked other category
  // is not assigned, and its records table holds no Natural Gas row.
  await login(page, ENTRY_EMAIL);
  await page.goto(`/data-entry?subsidiaryId=${SUB.energy}`);
  const categoryField = page.locator('div.space-y-2', { has: page.getByText(enDataEntry.category, { exact: true }) });
  await categoryField.getByRole('combobox').click();
  await expect(page.getByRole('option')).toHaveText([enCategories.Electricity]);
  await page.keyboard.press('Escape');
  const records = page.getByTestId('previous-submissions');
  await expect(records.getByRole('row').filter({ hasText: enCategories.Electricity }).first()).toBeVisible();
  await expect(records.getByRole('row').filter({ hasText: enCategories['Natural Gas'] })).toHaveCount(0);

  await page.goto(`/data-entry?subsidiaryId=${SUB.energy}&category=Fuel`);
  await expect(page.getByTestId('category-not-assigned')).toContainText(`${enCategories.Fuel} is not assigned to you for`);
  await expect(page.getByRole('button', { name: enDataEntry.saveDraft })).toHaveCount(0);
});

test('an auditor is offered no action: no queue, no submit, no decision, no withdrawal', async ({ page, request }) => {
  const id = await createCommittedRecord(request, await getAccessToken(request, ENTRY_EMAIL), {
    subsidiaryId: SUB.logistics,
    category: 'Water',
    periodValue: 'Q4',
    activityValue: 80,
    activityUnit: 'cubic_metres',
    varianceReason: 'e2e: approval chain lane',
  });
  try {
    const auditor = await getAccessToken(request, AUDITOR_EMAIL);
    // Reads it...
    expect((await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(auditor) })).status()).toBe(200);
    // ...and every write and decision is refused on the role.
    for (const verb of ['review', 'reject', 'approve'] as const) {
      expect((await decide(request, AUDITOR_EMAIL, id, verb)).status(), verb).toBe(403);
    }
    expect((await request.patch(`${API_BASE}/activity-records/${id}`, { headers: bearer(auditor), data: { activityValue: 81 } })).status()).toBe(403);
    expect((await request.post(`${API_BASE}/activity-records/${id}/recall`, { headers: bearer(auditor) })).status()).toBe(403);
    expect((await request.post(`${API_BASE}/activity-records/${id}/void`, {
      headers: bearer(auditor), data: { voidReason: 'An auditor never withdraws a figure.' },
    })).status()).toBe(403);
    expect((await readRecord(request, id)).status).toBe('submitted');

    await login(page, AUDITOR_EMAIL);
    // The queue: the gate card, no table, no decision.
    await page.goto('/review');
    await expect(page.getByText(enReview.gate.title)).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.getByRole('button', { name: enReview.sheet.approve, exact: true })).toHaveCount(0);
    // Data Entry: nothing to send for review.
    await page.goto(`/data-entry?subsidiaryId=${SUB.logistics}`);
    await expect(page.getByTestId('previous-submissions')).toBeVisible();
    await expect(page.getByRole('button', { name: enDataEntry.submit, exact: true })).toHaveCount(0);
    // The users screen: told who manages users.
    await page.goto('/users');
    await expect(page.getByText(enUsers.forbiddenTitle)).toBeVisible();
    await expect(page.getByRole('button', { name: enUsers.invite })).toHaveCount(0);
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});
