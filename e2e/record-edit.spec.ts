import { test, expect, type Page } from '@playwright/test';
import {
  ADMIN_EMAIL,
  API_BASE,
  ENTRY_EMAIL,
  E2E_BULK_CATEGORY,
  E2E_BULK_UNIT,
  E2E_YEAR,
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
  const res = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUBSIDIARY,
      reportingYear: E2E_YEAR,
      reportingPeriod: 'monthly',
      periodValue,
      category: E2E_BULK_CATEGORY,
      activityValue: 3,
      activityUnit: E2E_BULK_UNIT,
    },
  });
  if (!res.ok()) throw new Error(`createWasteDraft failed: ${res.status()} ${await res.text()}`);
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

test('a voided record is copied into a new draft by its author, who submits it', async ({ page, request }) => {
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  const adminToken = await getAccessToken(request, ADMIN_EMAIL);
  const id = await createWasteDraft(request, entryToken, 'September');
  await post(request, entryToken, `/activity-records/${id}/submit`);
  await approveRecord(request, adminToken, id);
  await post(request, adminToken, `/activity-records/${id}/void`, { voidReason: 'e2e: wrong quantity on the waste note' });

  await login(page, ENTRY_EMAIL);
  await openDataEntry(page);
  await listOf(page).getByRole('button', { name: `Copy September ${E2E_YEAR} ${E2E_BULK_CATEGORY} to a new draft` }).click();
  await expect(page.getByText(/A new draft is filled in from the voided record/)).toBeVisible();
  // A NEW record: nothing is being edited.
  await expect(page.getByText(/Editing draft/)).toHaveCount(0);
  await expect(page.getByPlaceholder('e.g. 45000')).toHaveValue('3');

  await page.getByPlaceholder('e.g. 45000').fill('4');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByText('Submitted for review', { exact: true })).toBeVisible();

  const rows = await serviceReadRecords(
    request,
    `subsidiary_id=eq.${SUBSIDIARY}&reporting_year=eq.${E2E_YEAR}&period_value=eq.September&category=eq.${E2E_BULK_CATEGORY}`,
  );
  const fresh = rows.find((r) => r.id !== id);
  expect(rows.find((r) => r.id === id)?.status).toBe('voided');
  expect(fresh).toMatchObject({ status: 'submitted', activity_value: 4 });
});
