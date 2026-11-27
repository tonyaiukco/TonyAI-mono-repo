import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import enFuel from '../apps/web/messages/en/fuelFiles.json';
import enErrors from '../apps/web/messages/en/errors.json';
import {
  ADMIN_EMAIL,
  API_BASE,
  APPROVER_EMAIL,
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
  listFuelUploads,
} from './helpers';

/**
 * inc28-fuel-bulk task 10.1: a masterkey uploads the Petrol Ofisi fixture on
 * /fuel-files, sends its unmatched account to a company, sees the associate's
 * rows excluded and the batches formed, attaches a file to a batch and submits
 * it; the same file again adds nothing.
 *
 * Lane: the fixture's 2025 March rows (monthly), which no other spec writes.
 * Every fuel row, account, batch, record and file the spec makes is removed in
 * `afterAll` (`cleanupFuelData`, the seed's two accounts kept); the fixture
 * release prices the pairs where no TR release exists (CI).
 *
 * Import budget (5 per minute per user, two per upload): the masterkey spends
 * four here, the central reporter its own in `fuel-batch-review.spec.ts`.
 */
test.describe.configure({ mode: 'serial' });

const FILE_NAME = 'petrol-ofisi-satislistesi.xlsx';
const SHARED_INVOICE = 'OZK0000000000001';
const SECOND_INVOICE = 'OZK0000000000002';
/** What the fixture's 23 data rows are (generate.ts): 21 stored, 1 repeated, 1 without an invoice number. */
const ROWS_READ = 23;
const ROWS_STORED = 21;
/** `000456` is not mapped by the seed: its one row waits for an account. */
const UNMATCHED_CODE = '000456';
/** The company the masterkey maps it to. */
const MAPPED_TO = { id: SUB.energy, name: 'TonyAI Energy' };

test.beforeAll(async ({ request }) => {
  await cleanupFuelData(request);
  await seedFuelFactorFixture();
});
test.afterAll(async ({ request }) => {
  await cleanupFuelData(request);
  await cleanupFuelFactorFixture();
});

/** The organisation's counted 2025 total, as the dashboard's summary reads it. */
async function counted2025(request: APIRequestContext, token: string): Promise<number> {
  const res = await request.get(`${API_BASE}/emissions/summary?year=2025`, { headers: bearer(token) });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { totals: { total: number } }).totals.total;
}

/** Read a file on the Upload tab: Petrol Ofisi and On-road are what the page starts on. */
async function readFile(page: Page): Promise<void> {
  await page.getByRole('tab', { name: enFuel.tabs.upload, exact: true }).click();
  await expect(page.locator('#fuel-source')).toHaveText(enFuel.sources.petrol_ofisi);
  await expect(page.locator('#fuel-usage')).toHaveText(enFuel.usages.on_road);
  await page.locator('#fuel-file').setInputFiles(FUEL_FIXTURES.petrolOfisi);
  await page.getByRole('button', { name: enFuel.upload.read }).click();
  await expect(page.getByText(enFuel.upload.previewTitle.replace('{file}', FILE_NAME))).toBeVisible();
}

const accountRow = (page: Page, code: string) => page.locator('table tbody tr', { has: page.getByText(code, { exact: true }) });

async function openFuelFiles(page: Page): Promise<void> {
  await login(page, ADMIN_EMAIL);
  await page.goto('/fuel-files');
  await expect(page.getByRole('heading', { name: enFuel.title })).toBeVisible();
}

const uploadRow = (page: Page) => page.locator('table tbody tr', { hasText: FILE_NAME });

test('a masterkey reads and applies a Petrol Ofisi file: the associate is excluded, the unknown account waits, two batches form', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  await openFuelFiles(page);

  // ── The first read: nothing is stored yet.
  await readFile(page);
  await expect(page.getByText(`${ROWS_READ} rows read · 1 refused · 1 already stored or repeated`)).toBeVisible();
  // The seed's confirmed account forms batches; the associate's is excluded;
  // the account never seen waits for one.
  await expect(accountRow(page, 'PO-0001')).toContainText('TonyAI Logistics');
  await expect(accountRow(page, 'PO-0001')).toContainText(`${enFuel.previewOutcomes.batches}16 rows · 1,837.38 L`);
  await expect(accountRow(page, 'PO-9001')).toContainText(`${enFuel.previewOutcomes.excluded}4 rows · 80 L`);
  await expect(accountRow(page, UNMATCHED_CODE)).toContainText(enFuel.upload.noCompany);
  await expect(accountRow(page, UNMATCHED_CODE)).toContainText(`${enFuel.previewOutcomes.waiting_account}1 row · 19.63 L`);
  // The repeated row and the sale without an invoice number are named.
  await expect(page.getByText(`Row 23: ${enErrors.bulkUploadIssues.fuel_duplicate}`)).toBeVisible();
  await expect(page.getByText(`Row 24: ${enErrors.bulkUploadIssues.fuel_cell_missing}`)).toBeVisible();
  expect(await listFuelBatches(request, token)).toHaveLength(0);
  expect(await listFuelUploads(request, token)).toEqual([]);

  // ── Apply: the rows are stored and PO-0001's two invoices form two batches.
  await page.getByRole('button', { name: enFuel.upload.apply }).click();
  await expect(page.getByText(`${ROWS_STORED} rows stored.`)).toBeVisible();
  await expect(page.getByText('2 batches formed, 0 joined.')).toBeVisible();
  await expect(page.getByText('2 batches formed and 0 open batches joined.')).toBeVisible();
  await expect(page.getByText(enErrors.bulkUploadIssues.fuel_account_unmatched)).toBeVisible();

  // Uploads: the associate's rows are excluded, never batched.
  await page.getByRole('tab', { name: enFuel.tabs.uploads, exact: true }).click();
  await expect(uploadRow(page)).toHaveCount(1);
  await expect(uploadRow(page)).toContainText(`${ROWS_READ} read · 1 refused · 1 duplicates`);
  await expect(uploadRow(page)).toContainText(`${enFuel.rowStates.assigned}16 rows · 1,837.38 L`);
  await expect(uploadRow(page)).toContainText(`${enFuel.rowStates.excluded}4 rows · 80 L`);
  await expect(uploadRow(page)).toContainText(`${enFuel.rowStates.waiting_account}1 row · 19.63 L`);

  // Batches: two, both TonyAI Logistics', one per invoice; none the associate's.
  const batches = await listFuelBatches(request, token);
  expect(batches.map((b) => `${b.invoiceRef}|${b.subsidiaryId}`).sort()).toEqual(
    [`${SHARED_INVOICE}|${SUB.logistics}`, `${SECOND_INVOICE}|${SUB.logistics}`].sort(),
  );
  expect(batches.every((b) => b.status === 'draft' && b.usage === 'on_road' && b.category === 'Mobile Combustion')).toBe(true);
  const shared = batches.find((b) => b.invoiceRef === SHARED_INVOICE)!;
  // The shared invoice's 15 rows of PO-0001 (669.38 L); the period-shift row is the second invoice's.
  expect(shared.rowCount).toBe(15);
  expect(Number(shared.litres)).toBeCloseTo(669.38, 6);
  expect(Number(batches.find((b) => b.invoiceRef === SECOND_INVOICE)!.litres)).toBeCloseTo(1168, 6);

  await page.getByRole('tab', { name: enFuel.tabs.batches, exact: true }).click();
  const rows = page.locator('table tbody tr');
  // This file's two invoices (a developer's own batches may be listed beside them locally).
  await expect(rows.filter({ hasText: new RegExp(`${SHARED_INVOICE}|${SECOND_INVOICE}`) })).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Bosphorus' })).toHaveCount(0);
  await expect(rows.filter({ hasText: SHARED_INVOICE })).toContainText(enFuel.batches.noFiles);

  // Unmatched: `000456` waits there. No rule PROPOSES a company for it, so it
  // offers no Confirm — the masterkey maps it with "Map to a company" instead.
  await page.getByRole('tab', { name: enFuel.tabs.tray, exact: true }).click();
  const tray = accountRow(page, UNMATCHED_CODE);
  await expect(tray).toContainText(enFuel.upload.noCompany);
  await expect(tray).toContainText('1 row · 19.63 L');
  await expect(tray.getByRole('button', { name: enFuel.accounts.confirm })).toHaveCount(0);
  await expect(tray.getByRole('combobox', { name: enFuel.accounts.mapTo })).toBeVisible();
});

// Regression guard (inc28-fuel-bulk): the fuel DTOs take ids of the system's shape (`UUID_SHAPE`),
// so the seed's fixed company ids map an account; `@IsUUID()` had refused every one of them.
test('the masterkey maps the unknown account to a company from the Unmatched tab, and its row forms a batch', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  await openFuelFiles(page);
  await page.getByRole('tab', { name: enFuel.tabs.tray, exact: true }).click();
  const tray = accountRow(page, UNMATCHED_CODE);
  await tray.getByRole('combobox', { name: enFuel.accounts.mapTo }).click();
  await page.getByRole('option', { name: MAPPED_TO.name, exact: true }).click();
  await expect(page.getByText(enFuel.accounts.confirmed.replace('{code}', UNMATCHED_CODE))).toBeVisible();
  await expect(page.getByText(enFuel.tray.noAccounts)).toBeVisible();

  // Its holder forms the released row's batch from Uploads.
  await page.getByRole('tab', { name: enFuel.tabs.uploads, exact: true }).click();
  await uploadRow(page).getByRole('button', { name: enFuel.uploads.form }).click();
  await expect(page.getByText('1 batches formed, 0 joined.')).toBeVisible();
  const mapped = (await listFuelBatches(request, token)).filter((b) => b.subsidiaryId === MAPPED_TO.id);
  expect(mapped.map((b) => b.invoiceRef)).toEqual([SHARED_INVOICE]);
  expect(Number(mapped[0].litres)).toBeCloseTo(19.63, 6);
});

test('a file attached to a batch backs every record of it, and the batch is submitted whole', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const shared = (await listFuelBatches(request, token)).find((b) => b.invoiceRef === SHARED_INVOICE && b.subsidiaryId === SUB.logistics)!;
  expect(shared.status).toBe('draft');
  await openFuelFiles(page);
  await page.getByRole('tab', { name: enFuel.tabs.batches, exact: true }).click();
  await page.locator('table tbody tr').filter({ hasText: SHARED_INVOICE }).filter({ hasText: 'TonyAI Logistics' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText(enFuel.batches.records, { exact: true })).toBeVisible();

  // ── One file for the batch: both its records carry it.
  await sheet.locator('input[type="file"]').setInputFiles(EVIDENCE_FIXTURE);
  await sheet.getByRole('button', { name: enFuel.batches.attach }).click();
  await expect(page.getByText(enFuel.batches.attached)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'sample-invoice.pdf' })).toBeVisible();
  const detail = await getFuelBatch(request, token, shared.id);
  // Diesel and petrol on one invoice: one record per fuel for March.
  expect(detail.records!.map((r) => r.activityType).sort()).toEqual(['on_road_diesel', 'on_road_petrol']);
  expect(detail.records!.every((r) => r.reportingYear === 2025 && r.month === 3)).toBe(true);
  expect(detail.evidence).toHaveLength(1);
  for (const record of detail.records!) {
    const files = await request.get(`${API_BASE}/activity-records/${record.id}/evidence`, { headers: bearer(token) });
    expect(files.status()).toBe(200);
    expect(((await files.json()) as { items: Array<{ id: string }> }).items.map((f) => f.id)).toEqual([detail.evidence![0].id]);
  }

  // ── Submit: the batch and both its records, in one step.
  await sheet.getByRole('button', { name: enFuel.batches.submit, exact: true }).click();
  await expect(page.getByText(enFuel.batches.submitted)).toBeVisible();
  await expect(sheet.getByRole('heading').first()).toContainText(enFuel.batchStatus.submitted);
  const submitted = await getFuelBatch(request, token, shared.id);
  expect(submitted.status).toBe('submitted');
  // A masterkey's own batch is decided by its author (a self-approval).
  expect(submitted.approver).toBe('author');
  expect(submitted.records!.every((r) => r.status === 'submitted')).toBe(true);
});

test('the same file again is all duplicates: no row, batch or record is added and no total changes', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const snapshot = async () => (await listFuelBatches(request, token)).map((b) => `${b.id}|${b.status}|${b.rowCount}|${b.litres}|${b.tCo2e}`).sort();
  const batchesBefore = await snapshot();
  expect(batchesBefore.length).toBeGreaterThan(0);
  const totalBefore = await counted2025(request, token);

  await openFuelFiles(page);
  await readFile(page);
  // The 21 stored rows and the in-file repeat are duplicates; the row without an invoice is refused again.
  await expect(page.getByText(`${ROWS_READ} rows read · 1 refused · ${ROWS_STORED + 1} already stored or repeated`)).toBeVisible();
  await page.getByRole('button', { name: enFuel.upload.apply }).click();
  await expect(page.getByText('0 rows stored.')).toBeVisible();
  // What the page then says about forming is the test below.

  expect(await snapshot()).toEqual(batchesBefore);
  expect(await counted2025(request, token)).toBe(totalBefore);
  const listed = await listFuelUploads<{ createdAt: string; rowsRead: number; rowsDuplicate: number; rowsRefused: number; rows: Record<string, { rows: number }> }>(request, token);
  expect(listed).toHaveLength(2);
  // Newest first: the repeat stored no row.
  expect(listed[0]).toMatchObject({ rowsRead: ROWS_READ, rowsRefused: 1, rowsDuplicate: ROWS_STORED + 1 });
  expect(Object.values(listed[0].rows).reduce((n, c) => n + c.rows, 0)).toBe(0);
});

// Regression guard (inc28-fuel-bulk): an apply that stored no row asks for no forming step
// (the API refuses one from a caller holding no unbatched row) and says there is nothing to form.
test('after an apply that stored nothing, the page reports no batch formed rather than an error', async ({ page }) => {
  await login(page, APPROVER_EMAIL);
  await page.goto('/fuel-files');
  await readFile(page);
  await expect(page.getByText(`${ROWS_READ} rows read · 1 refused · ${ROWS_STORED + 1} already stored or repeated`)).toBeVisible();
  const formCalls: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/form-batches')) formCalls.push(r.url()); });
  await page.getByRole('button', { name: enFuel.upload.apply }).click();
  await expect(page.getByText('0 rows stored.')).toBeVisible();
  // Nothing is processable, so no forming step is asked for (it would be refused): the page says so instead.
  await expect(page.getByText(enFuel.upload.nothingToForm)).toBeVisible();
  expect(formCalls).toEqual([]);
  await expect(page.getByText(enFuel.upload.previewTitle.replace('{file}', FILE_NAME))).toHaveCount(0);
});
