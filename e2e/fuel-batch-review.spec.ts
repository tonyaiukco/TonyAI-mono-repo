import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import enFuel from '../apps/web/messages/en/fuelFiles.json';
import {
  API_BASE,
  APPROVER_EMAIL,
  ENTRY_EMAIL,
  EVIDENCE_FIXTURE,
  FUEL_FIXTURES,
  SUB,
  bearer,
  cleanupFuelData,
  cleanupFuelFactorFixture,
  getAccessToken,
  getFuelBatch,
  listFuelBatches,
  login,
  seedFuelFactorFixture,
  recordFuelUpload,
} from './helpers';

/**
 * inc28-fuel-bulk task 10.2: a central reporter's fuel batch through review.
 *
 * `entry@` is a standard user whose main company is TonyAI Energy and who holds
 * a central reporter grant for TonyAI Logistics; the seed maps Petrol Ofisi
 * account `PO-0001` to Logistics, so its uploaded rows form Logistics' batches,
 * authored by the central reporter and decided by Logistics' active
 * super_admin (`approver@`). The batch walks submit → open (review) → return →
 * a changed usage → resubmit → approve, and after each step the company's
 * counted 2025 total (`/emissions/summary`, the dashboard's figures) is stated
 * exactly: +X, −X, +X′ (X′ = the batch's figure after its usage changed), ±0.
 *
 * Arranged through the API (upload, file, submit), acted on in the review
 * queue. Lane: Logistics, March 2025 (the fixture's rows); everything the spec
 * makes is removed in `afterAll`.
 */
test.describe.configure({ mode: 'serial' });

const INVOICE = 'OZK0000000000002'; // PO-0001's period-shift row: one diesel record, 1,168 L.
const LITRES = 1168;
const REASON = 'E2E: the generator fuel was declared as on-road';

test.beforeAll(async ({ request }) => {
  await cleanupFuelData(request);
  await seedFuelFactorFixture();
});
test.afterAll(async ({ request }) => {
  await cleanupFuelData(request);
  await cleanupFuelFactorFixture();
});

/** Logistics' counted 2025 total, as the dashboard reads it (submitted, in review, approved and locked records). */
async function counted(request: APIRequestContext, token: string): Promise<number> {
  const res = await request.get(`${API_BASE}/emissions/summary?year=2025&subsidiaryId=${SUB.logistics}`, { headers: bearer(token) });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { totals: { total: number } }).totals.total;
}

/** Preview, apply (naming the previewed digest) and form batches, as the Upload tab does. */
async function uploadAsCentralReporter(request: APIRequestContext, token: string): Promise<void> {
  const file = { name: basename(FUEL_FIXTURES.petrolOfisi), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: readFileSync(FUEL_FIXTURES.petrolOfisi) };
  const preview = await request.post(`${API_BASE}/fuel-files/preview`, { headers: bearer(token), multipart: { file, source: 'petrol_ofisi', usage: 'on_road' } });
  expect(preview.status()).toBe(200);
  const { fileSha256 } = (await preview.json()) as { fileSha256: string };
  const applied = await request.post(`${API_BASE}/fuel-files`, {
    headers: bearer(token),
    multipart: { file, source: 'petrol_ofisi', usage: 'on_road', fileSha256 },
  });
  expect(applied.status()).toBe(201);
  const { id } = (await applied.json()) as { id: string };
  recordFuelUpload(id);
  for (let step = 0; step < 10; step += 1) {
    const formed = await request.post(`${API_BASE}/fuel-files/${id}/form-batches`, { headers: bearer(token), data: {} });
    expect(formed.status()).toBe(200);
    if (((await formed.json()) as { processableRows: number }).processableRows === 0) return;
  }
  throw new Error('forming did not finish in ten steps');
}

/** The review queue's Records count, under the page's own filters (the batch's records left out). */
async function pendingRecords(request: APIRequestContext, token: string, inBatch: boolean | null): Promise<number> {
  const query = new URLSearchParams({ status: 'submitted,under_review', awaitingMyDecision: 'true' });
  if (inBatch !== null) query.set('inBatch', String(inBatch));
  const res = await request.get(`${API_BASE}/activity-records/metadata?${query}`, { headers: bearer(token) });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { total: number }).total;
}

async function openQueue(page: Page): Promise<void> {
  await page.goto('/review');
  await expect(page.getByTestId('review-tab-batches')).not.toContainText('—');
}

test('a central reporter\'s batch awaits the owning company\'s super_admin, and the counted total follows its steps', async ({ page, request }) => {
  test.setTimeout(180_000);
  const author = await getAccessToken(request, ENTRY_EMAIL);
  const approver = await getAccessToken(request, APPROVER_EMAIL);

  // ── Arrange: the central reporter uploads the file; its batches are Logistics'.
  await uploadAsCentralReporter(request, author);
  const formed = await listFuelBatches(request, author);
  expect(formed.every((b) => b.subsidiaryId === SUB.logistics && b.status === 'draft')).toBe(true);
  const batch = formed.find((b) => b.invoiceRef === INVOICE)!;
  expect(batch).toBeDefined();
  expect(Number(batch.litres)).toBeCloseTo(LITRES, 6);
  const attached = await request.post(`${API_BASE}/evidence`, {
    headers: bearer(author),
    multipart: {
      file: { name: 'sample-invoice.pdf', mimeType: 'application/pdf', buffer: readFileSync(EVIDENCE_FIXTURE) },
      fuelBatchId: batch.id,
    },
  });
  expect(attached.status()).toBe(201);

  const drafted = await getFuelBatch(request, author, batch.id);
  expect(drafted.records!.map((r) => r.activityType)).toEqual(['on_road_diesel']);
  const X = drafted.tCo2e!;
  expect(X).toBeGreaterThan(0);
  const T0 = await counted(request, approver);
  const recordsBefore = await pendingRecords(request, approver, false);

  // ── 1. Submit: expected total T0 + X.
  test.info().annotations.push({ type: 'expected', description: `first submission: ${T0} + ${X} = ${T0 + X}` });
  const submit = await request.post(`${API_BASE}/fuel-batches/${batch.id}/submit`, { headers: bearer(author), data: {} });
  expect(submit.status()).toBe(200);
  const submitted = await getFuelBatch(request, approver, batch.id);
  expect(submitted.status).toBe('submitted');
  // Decided as a central reporter's record of Logistics is: by its super_admin.
  expect(submitted.approver).toBe('super_admin');
  expect(await counted(request, approver)).toBeCloseTo(T0 + X, 6);

  // The queue's two counts: the batch is listed apart from the records, never inside them.
  const awaiting = await listFuelBatches(request, approver, { awaitingMyDecision: 'true' });
  expect(awaiting.map((b) => b.id)).toEqual([batch.id]);
  expect(await pendingRecords(request, approver, false)).toBe(recordsBefore);
  expect(await pendingRecords(request, approver, null)).toBe(recordsBefore + 1);

  await login(page, APPROVER_EMAIL);
  await openQueue(page);
  await expect(page.getByTestId('review-tab-records')).toHaveText(enFuel.review.recordsTab.replace('{count}', String(recordsBefore)));
  await expect(page.getByTestId('review-tab-batches')).toHaveText(enFuel.review.batchesTab.replace('{count}', '1'));

  // ── 2. Opening the batch takes it into review, which closes recall. Total unchanged.
  await page.getByTestId('review-tab-batches').click();
  const row = page.getByTestId('review-batch-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(INVOICE);
  await expect(row).toContainText('TonyAI Logistics');
  await expect(row).toContainText(enFuel.batches.approver.super_admin);
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/fuel-batches/${batch.id}/review`));
  await row.click();
  expect((await started).status()).toBe(200);
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading').first()).toContainText(enFuel.batchStatus.under_review);
  const recall = await request.post(`${API_BASE}/fuel-batches/${batch.id}/recall`, { headers: bearer(author) });
  expect(recall.status()).toBe(409);
  expect(((await recall.json()) as { code: string }).code).toBe('record_changed');
  expect((await getFuelBatch(request, approver, batch.id)).status).toBe('under_review');
  expect(await counted(request, approver)).toBeCloseTo(T0 + X, 6);

  // A record of the batch is never decided on its own.
  const record = submitted.records![0];
  const single = await request.post(`${API_BASE}/activity-records/${record.id}/approve`, {
    headers: bearer(approver),
    data: { seenSubmittedAt: (await getFuelBatch(request, approver, batch.id)).submittedAt },
  });
  expect(single.status()).toBe(409);
  expect(((await single.json()) as { code: string }).code).toBe('record_in_batch');
  expect((await getFuelBatch(request, approver, batch.id)).records![0].status).toBe('under_review');

  // ── 3. Return, with a reason: expected total T0 + X − X = T0.
  test.info().annotations.push({ type: 'expected', description: `return: ${T0 + X} − ${X} = ${T0}` });
  await sheet.getByLabel(enFuel.batches.returnReason).fill(REASON);
  await sheet.getByRole('button', { name: enFuel.batches.return, exact: true }).click();
  await expect(page.getByText(enFuel.batches.returned)).toBeVisible();
  const returned = await getFuelBatch(request, author, batch.id);
  expect(returned.status).toBe('rejected');
  expect(await counted(request, approver)).toBeCloseTo(T0, 6);

  // ── 4. The author changes the usage (on-road → off-road) and submits again:
  // the record is rebuilt as off-road diesel of the same litres, keeps the file,
  // and the total rises by the batch's new figure X′.
  const declared = await request.patch(`${API_BASE}/fuel-batches/${batch.id}/declarations`, { headers: bearer(author), data: { usage: 'off_road' } });
  expect(declared.status()).toBe(200);
  const rebuilt = await getFuelBatch(request, author, batch.id);
  expect(rebuilt.usage).toBe('off_road');
  expect(rebuilt.records!.map((r) => [r.activityType, Number(r.litres)])).toEqual([['off_road_diesel', LITRES]]);
  expect(rebuilt.evidence).toHaveLength(1);
  const X2 = rebuilt.tCo2e!;
  expect(X2).toBeGreaterThan(0);
  expect(await counted(request, approver)).toBeCloseTo(T0, 6);
  test.info().annotations.push({ type: 'expected', description: `resubmission: ${T0} + ${X2} = ${T0 + X2}` });
  const again = await request.post(`${API_BASE}/fuel-batches/${batch.id}/submit`, { headers: bearer(author), data: {} });
  expect(again.status()).toBe(200);
  const resubmitted = await getFuelBatch(request, approver, batch.id);
  expect(resubmitted).toMatchObject({ status: 'submitted', submissionCount: 2 });
  expect(await counted(request, approver)).toBeCloseTo(T0 + X2, 6);

  // The queue marks it revised.
  await openQueue(page);
  await expect(page.getByTestId('review-tab-batches')).toHaveText(enFuel.review.batchesTab.replace('{count}', '1'));
  await page.getByTestId('review-tab-batches').click();
  await expect(row).toContainText(enFuel.batches.revised);
  await expect(row).toContainText(enFuel.usages.off_road);

  // ── 5. Approve: expected total unchanged at T0 + X′.
  test.info().annotations.push({ type: 'expected', description: `approval: ${T0 + X2} (no change)` });
  const reopened = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/fuel-batches/${batch.id}/review`));
  await row.click();
  expect((await reopened).status()).toBe(200);
  await sheet.getByRole('button', { name: enFuel.batches.approve, exact: true }).click();
  await expect(page.getByText(enFuel.batches.approved)).toBeVisible();
  const approved = await getFuelBatch(request, approver, batch.id);
  expect(approved.status).toBe('approved');
  expect(approved.records!.every((r) => r.status === 'approved')).toBe(true);
  expect(await counted(request, approver)).toBeCloseTo(T0 + X2, 6);
  await expect(page.getByTestId('review-tab-batches')).toHaveText(enFuel.review.batchesTab.replace('{count}', '0'));
});
