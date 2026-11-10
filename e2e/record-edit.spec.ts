import { test, expect, type Page } from '@playwright/test';
import {
  ADMIN_EMAIL,
  API_BASE,
  ENTRY_EMAIL,
  E2E_BULK_CATEGORY,
  E2E_BULK_UNIT,
  E2E_YEAR,
  EVIDENCE_FIXTURE,
  SUB,
  approveRecord,
  attachEvidence,
  bearer,
  deleteRecordsAsService,
  getAccessToken,
  login,
  pickByFieldLabel,
  selectSubsidiary,
  serviceReadRecords,
  switchUser,
} from './helpers';

/**
 * UAT round 2, BUG-R2-03 (OpenSpec `uat2-record-edit`): a record is edited in
 * full, through the real UI, API and database.
 *   - Edit mode re-files the SAME record — category and period included — and
 *     says so before the save; a category change takes the record's file off
 *     only after the user confirms (owner decision D1).
 *   - The author recalls a submitted record, edits it and submits it again.
 *   - A voided record is copied into a new draft by its author (D04's re-entry).
 *
 * Lane: `SUB.logistics`, monthly `E2E_YEAR`, July–December, Waste and Water.
 * Waste needs no evidence and Water no emission factor, so nothing here leans
 * on the factor library. `e2e/analytics.spec.ts` keeps the other half: a record
 * opened WITHOUT Edit still starts a new record when its period moves.
 */

const SUBSIDIARY = SUB.logistics;
const OPTION = 'TonyAI Logistics (TR)';
const OTHER_OPTION = 'TonyAI Energy (TR)';
const MONTHS = ['July', 'August', 'September', 'October', 'November', 'December'];
const LANE_QUERY =
  `subsidiary_id=eq.${SUBSIDIARY}&reporting_year=eq.${E2E_YEAR}` +
  `&reporting_period=eq.monthly&period_value=in.(${MONTHS.join(',')})` +
  `&category=in.(${E2E_BULK_CATEGORY},Water)`;

test.describe.configure({ mode: 'serial' });

async function sweepLane(request: Parameters<typeof serviceReadRecords>[0]) {
  const strays = await serviceReadRecords(request, LANE_QUERY);
  await deleteRecordsAsService(request, strays.map((r) => String(r.id)));
}

test.beforeAll(async ({ request }) => sweepLane(request));
test.afterAll(async ({ request }) => sweepLane(request));

async function createWasteDraft(
  request: Parameters<typeof serviceReadRecords>[0],
  token: string,
  periodValue: string,
): Promise<string> {
  return createDraft(request, token, periodValue, E2E_BULK_CATEGORY, E2E_BULK_UNIT);
}

async function createDraft(
  request: Parameters<typeof serviceReadRecords>[0],
  token: string,
  periodValue: string,
  category: string,
  activityUnit: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUBSIDIARY,
      reportingYear: E2E_YEAR,
      reportingPeriod: 'monthly',
      periodValue,
      category,
      activityValue: 3,
      activityUnit,
    },
  });
  if (!res.ok()) throw new Error(`createDraft failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).id as string;
}

async function post(request: Parameters<typeof serviceReadRecords>[0], token: string, path: string, data?: unknown) {
  const res = await request.post(`${API_BASE}${path}`, { headers: bearer(token), ...(data ? { data } : {}) });
  if (!res.ok()) throw new Error(`POST ${path} failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

const listOf = (page: Page) => page.locator('[data-testid="previous-submissions"]');

async function openDataEntry(page: Page) {
  await page.goto('/data-entry');
  await selectSubsidiary(page, OPTION);
}

test('Edit mode re-files the same record — category and period — after the evidence is confirmed', async ({ page, request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const id = await createWasteDraft(request, token, 'October');
  await attachEvidence(request, token, id);

  await login(page, ENTRY_EMAIL);
  await openDataEntry(page);
  await listOf(page).getByRole('button', { name: `Edit October ${E2E_YEAR} ${E2E_BULK_CATEGORY}` }).click();
  const band = page.getByTestId('edit-mode-band');
  await expect(band).toBeVisible();

  // Cancel puts the form back to the record as stored and leaves Edit mode.
  await pickByFieldLabel(page, 'Value', 'December');
  await expect(band).toContainText('Period: October → December');
  await band.getByRole('button', { name: 'Cancel editing' }).click();
  await expect(band).toHaveCount(0);
  await expect(page.getByText(/Editing draft/)).toBeVisible();
  expect((await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json()).periodValue).toBe('October');

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(band).toBeVisible();
  // Edit again on the record already open in Edit mode: its files are read
  // again, or the band below would list none and Save would never enable.
  await listOf(page).getByRole('button', { name: `Edit October ${E2E_YEAR} ${E2E_BULK_CATEGORY}` }).click();
  await expect(band).toBeVisible();

  await pickByFieldLabel(page, 'Category', 'Water');
  await pickByFieldLabel(page, 'Value', 'November');
  // In Edit mode the form never drops the record (the opened-record guard's toast).
  await expect(page.getByText(/Now entering a new record/)).toHaveCount(0);
  await expect(band).toContainText(`Category: ${E2E_BULK_CATEGORY} → Water`);
  await expect(band).toContainText('Period: October → November');
  await expect(band).toContainText('sample-invoice.pdf');

  // The file goes only once the user says so.
  const save = page.getByRole('button', { name: 'Save draft', exact: true });
  await expect(save).toBeDisabled();
  await band.getByRole('checkbox', { name: 'Remove the 1 file(s) and save' }).check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText('Changes saved to the record.')).toBeVisible();
  await expect(band).toHaveCount(0);

  const after = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
  expect(after).toMatchObject({ id, category: 'Water', periodValue: 'November', status: 'draft', evidenceCount: 0 });
  // The same record, not a second one: nothing is left in the old slot.
  const old = await serviceReadRecords(
    request,
    `subsidiary_id=eq.${SUBSIDIARY}&reporting_year=eq.${E2E_YEAR}&period_value=eq.October&category=eq.${E2E_BULK_CATEGORY}`,
  );
  expect(old).toHaveLength(0);
});

test('a late Cancel of one record never refills the form over the record opened after it (owner review P2)', async ({ page, request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const first = await createWasteDraft(request, token, 'July');
  const second = await createWasteDraft(request, token, 'August');

  await login(page, ENTRY_EMAIL);
  await openDataEntry(page);
  await listOf(page).getByRole('button', { name: `Edit July ${E2E_YEAR} ${E2E_BULK_CATEGORY}` }).click();
  const band = page.getByTestId('edit-mode-band');
  await expect(band).toContainText(first.slice(0, 8));

  // Hold Cancel's read of the first record until the user has moved on.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const readReached = new Promise<void>((resolve) => (reached = resolve));
  await page.route(`**/api/v1/activity-records/${first}`, async (route) => {
    reached();
    await held;
    await route.continue();
  });
  await band.getByRole('button', { name: 'Cancel editing' }).click();
  await readReached;

  await listOf(page).getByRole('button', { name: `Edit August ${E2E_YEAR} ${E2E_BULK_CATEGORY}` }).click();
  await expect(band).toContainText(second.slice(0, 8));
  await page.getByPlaceholder('e.g. 45000').fill('55');

  release();
  await page.waitForResponse((r) => r.url().endsWith(`/activity-records/${first}`));
  // The first record's late answer was dropped: the form still holds the
  // second record and what the user typed.
  await expect(band).toContainText(second.slice(0, 8));
  await expect(page.getByPlaceholder('e.g. 45000')).toHaveValue('55');
  await page.unroute(`**/api/v1/activity-records/${first}`);
});

test('the author recalls a submitted record, edits it and submits it again; a super_admin is offered neither', async ({ page, request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const id = await createWasteDraft(request, token, 'December');
  await post(request, token, `/activity-records/${id}/submit`);

  await login(page, ADMIN_EMAIL);
  await openDataEntry(page);
  await expect(listOf(page).getByRole('button', { name: `Recall December ${E2E_YEAR} ${E2E_BULK_CATEGORY}` })).toHaveCount(0);

  await switchUser(page, ENTRY_EMAIL);
  await openDataEntry(page);
  await listOf(page).getByRole('button', { name: `Recall December ${E2E_YEAR} ${E2E_BULK_CATEGORY}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Recall this submission?');
  await dialog.getByRole('button', { name: 'Recall to draft' }).click();
  await expect(page.getByText('Recalled to draft. Edit it, then submit it again.')).toBeVisible();

  let record = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
  expect(record.status).toBe('draft');
  expect(record.submittedAt).toBeNull();

  await listOf(page).getByRole('button', { name: `Edit December ${E2E_YEAR} ${E2E_BULK_CATEGORY}` }).click();
  await page.getByPlaceholder('e.g. 45000').fill('7');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByText('Submitted for review', { exact: true })).toBeVisible();

  record = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
  expect(record).toMatchObject({ id, status: 'submitted', activityValue: 7 });
});

test('a voided evidence-required record is copied into a new draft, which needs its own file before it is submitted', async ({ page, request }) => {
  // Water: evidence-required (K3) and priced by no factor, so the full D04
  // re-entry runs — void, copy, the evidence gate, a file, submit.
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  const adminToken = await getAccessToken(request, ADMIN_EMAIL);
  const id = await createDraft(request, entryToken, 'September', 'Water', 'cubic_metres');
  await attachEvidence(request, entryToken, id);
  await post(request, entryToken, `/activity-records/${id}/submit`);
  // A decision that names no submission — a review tab from before this
  // release — is told to reload, never applied (owner review P1).
  const bare = await request.post(`${API_BASE}/activity-records/${id}/approve`, { headers: bearer(adminToken) });
  expect(bare.status()).toBe(409);
  expect((await bare.json()).code).toBe('record_changed');
  await approveRecord(request, adminToken, id);
  await post(request, adminToken, `/activity-records/${id}/void`, { voidReason: 'e2e: wrong meter reading' });

  await login(page, ENTRY_EMAIL);
  await openDataEntry(page);
  await listOf(page).getByRole('button', { name: `Copy September ${E2E_YEAR} Water to a new draft` }).click();
  await expect(page.getByText(/A new draft is filled in from the voided record/)).toBeVisible();
  // A NEW record: nothing is being edited, and no file came with the copy.
  await expect(page.getByText(/Editing draft/)).toHaveCount(0);
  await expect(page.getByPlaceholder('e.g. 45000')).toHaveValue('3');
  await page.getByPlaceholder('e.g. 45000').fill('4');

  // Submit saves the draft, and the evidence gate holds it with the vault open.
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  const vaultInput = page.locator('[data-testid="evidence-vault-input"]');
  await expect(vaultInput).toBeAttached();
  await expect(page.getByText('Submitted for review', { exact: true })).toHaveCount(0);
  await vaultInput.setInputFiles(EVIDENCE_FIXTURE);
  await expect(page.getByText('Evidence uploaded')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByText('Submitted for review', { exact: true })).toBeVisible();

  const rows = await serviceReadRecords(
    request,
    `subsidiary_id=eq.${SUBSIDIARY}&reporting_year=eq.${E2E_YEAR}&period_value=eq.September&category=eq.Water`,
  );
  const fresh = rows.find((r) => r.id !== id);
  expect(rows.find((r) => r.id === id)?.status).toBe('voided');
  expect(fresh).toMatchObject({ status: 'submitted', activity_value: 4 });
  const copied = await (await request.get(`${API_BASE}/activity-records/${String(fresh?.id)}`, { headers: bearer(entryToken) })).json();
  expect(copied.evidenceCount).toBe(1);
  // Its author is the user who copied it.
  expect(copied.createdBy).toBe(String(rows.find((r) => r.id === id)?.created_by));
});

test('a second Copy answering after a subsidiary switch never overwrites the switched form (review P2)', async ({ page, request }) => {
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  const adminToken = await getAccessToken(request, ADMIN_EMAIL);
  const voided: string[] = [];
  // Months no other test here writes Waste into.
  for (const month of ['September', 'November']) {
    const id = await createDraft(request, entryToken, month, E2E_BULK_CATEGORY, E2E_BULK_UNIT);
    await post(request, entryToken, `/activity-records/${id}/submit`);
    await approveRecord(request, adminToken, id);
    await post(request, adminToken, `/activity-records/${id}/void`, { voidReason: 'e2e: copy race' });
    voided.push(id);
  }

  // A super_admin: Copy is theirs on any voided record, and they see a second subsidiary.
  await login(page, ADMIN_EMAIL);
  await openDataEntry(page);
  await listOf(page).getByRole('button', { name: `Copy September ${E2E_YEAR} ${E2E_BULK_CATEGORY} to a new draft` }).click();
  await expect(page.getByText(/A new draft is filled in from the voided record/)).toBeVisible();

  // Hold the second Copy's read until the subsidiary has been switched.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const readReached = new Promise<void>((resolve) => (reached = resolve));
  await page.route(`**/api/v1/activity-records/${voided[1]}`, async (route) => {
    reached();
    await held;
    await route.continue();
  });
  await listOf(page).getByRole('button', { name: `Copy November ${E2E_YEAR} ${E2E_BULK_CATEGORY} to a new draft` }).click();
  await readReached;
  await selectSubsidiary(page, OTHER_OPTION);
  await page.getByPlaceholder('e.g. 45000').fill('77');

  release();
  await page.waitForResponse((r) => r.url().endsWith(`/activity-records/${voided[1]}`));
  // The late copy was dropped: the subsidiary and the typed value stand.
  const subsidiaryField = page.locator('div.space-y-2', { has: page.getByText('Subsidiary', { exact: true }) });
  await expect(subsidiaryField.getByRole('combobox')).toContainText(OTHER_OPTION);
  await expect(page.getByPlaceholder('e.g. 45000')).toHaveValue('77');
  await page.unroute(`**/api/v1/activity-records/${voided[1]}`);
});
