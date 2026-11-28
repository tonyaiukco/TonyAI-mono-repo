import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import enAssistant from '../apps/web/messages/en/evidenceAssistant.json';
import trAssistant from '../apps/web/messages/tr/evidenceAssistant.json';
import enFuel from '../apps/web/messages/en/fuelFiles.json';
import {
  ADMIN_EMAIL,
  API_BASE,
  APPROVER_EMAIL,
  ENTRY_EMAIL,
  FUEL_FIXTURES,
  SUB,
  bearer,
  cleanupFuelData,
  cleanupFuelFactorFixture,
  getAccessToken,
  listFuelBatches,
  login,
  recordFuelUpload,
  seedFuelFactorFixture,
} from './helpers';

/**
 * inc29-evidence-assistant task 12.1: the evidence assistant in the review
 * queue, on built servers, with the synthetic invoices (K1 = B).
 *
 * `entry@` (a standard user of TonyAI Energy and Logistics' central reporter)
 * uploads the Petrol Ofisi and Shell fixtures, the admin maps their new
 * accounts to TonyAI Energy, and `entry@` attaches:
 * the shared invoice explicitly to each of its two packages; the 23-invoice
 * Duman PDF to both March packages of the Shell account (a split each); a
 * scanned PDF to April's; an invoice that differs to `OZK…0002`'s. Then, in
 * `approver@`'s queue (the super_admin who decides both companies' batches): the shared invoice is consistent with its note, the period-shift pair
 * shows its label, the scan asks for a manual check, a possible difference is
 * approved, the actions never wait for the panel, and the Turkish labels are
 * the documents'. Lane: the fixtures' 2025 rows; everything is removed in
 * `afterAll` (the uploads by their ledger, the mapped accounts as first seen).
 */
test.describe.configure({ mode: 'serial' });

const INVOICES = resolve(__dirname, '../apps/api/test/fixtures/invoices');
const SHELL_FIXTURE = resolve(__dirname, '../apps/api/test/fixtures/fuel/shell-items.xlsx');
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const VARIANCE = 'E2E: synthetic fuel package';

test.beforeAll(async ({ request }) => {
  await cleanupFuelData(request);
  await seedFuelFactorFixture();
});
test.afterAll(async ({ request }) => {
  await cleanupFuelData(request);
  await cleanupFuelFactorFixture();
});

/**
 * Applies a provider file as the Upload tab does, naming its digest — computed
 * here, so the spec spends one of the uploader's five imports a minute per
 * file, not two.
 */
async function upload(request: APIRequestContext, token: string, path: string, source: 'petrol_ofisi' | 'shell'): Promise<string> {
  const buffer = readFileSync(path);
  const file = { name: basename(path), mimeType: XLSX, buffer };
  const fileSha256 = createHash('sha256').update(buffer).digest('hex');
  const applied = await request.post(`${API_BASE}/fuel-files`, { headers: bearer(token), multipart: { file, source, usage: 'on_road', fileSha256 } });
  expect(applied.status()).toBe(201);
  const { id } = (await applied.json()) as { id: string };
  recordFuelUpload(id);
  return id;
}

async function form(request: APIRequestContext, token: string, uploadId: string): Promise<void> {
  for (let step = 0; step < 10; step += 1) {
    const formed = await request.post(`${API_BASE}/fuel-files/${uploadId}/form-batches`, { headers: bearer(token), data: {} });
    expect(formed.status()).toBe(200);
    if (((await formed.json()) as { processableRows: number }).processableRows === 0) return;
  }
  throw new Error('forming did not finish in ten steps');
}

/** Maps an account the upload first saw to TonyAI Energy. */
async function mapToEnergy(request: APIRequestContext, token: string, source: string, code: string): Promise<void> {
  const res = await request.get(`${API_BASE}/fuel-accounts?source=${source}`, { headers: bearer(token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Array<{ id: string; code: string }> | { items: Array<{ id: string; code: string }> };
  const accounts = Array.isArray(body) ? body : body.items;
  const account = accounts.find((a) => a.code === code);
  expect(account, code).toBeDefined();
  const confirmed = await request.post(`${API_BASE}/fuel-accounts/${account!.id}/confirm`, { headers: bearer(token), data: { subsidiaryId: SUB.energy } });
  expect(confirmed.status()).toBe(200);
}

async function attach(request: APIRequestContext, token: string, batchId: string, name: string): Promise<{ split?: { attached: unknown[]; notAttached: unknown[] } }> {
  const res = await request.post(`${API_BASE}/evidence`, {
    headers: bearer(token),
    multipart: { file: { name, mimeType: 'application/pdf', buffer: readFileSync(resolve(INVOICES, name)) }, fuelBatchId: batchId },
  });
  expect(res.status(), name).toBe(201);
  return res.json();
}

async function submit(request: APIRequestContext, token: string, batchId: string): Promise<void> {
  const res = await request.post(`${API_BASE}/fuel-batches/${batchId}/submit`, { headers: bearer(token), data: { varianceReason: VARIANCE } });
  expect(res.status(), batchId).toBe(200);
}

let batches: Record<'shared' | 'sharedEnergy' | 'difference' | 'march1' | 'march2' | 'april', string>;

async function openInQueue(page: Page, batchId: string, invoiceRef: string) {
  await page.goto('/review');
  await expect(page.getByTestId('review-tab-batches')).not.toContainText('—');
  await page.getByTestId('review-tab-batches').click();
  const row = page.getByTestId('review-batch-row').filter({ hasText: invoiceRef });
  const taken = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/fuel-batches/${batchId}/review`));
  await row.first().click();
  await taken;
  return page.getByRole('dialog');
}

test('arrange: two uploads, mapped accounts, the invoices attached and the packages submitted', async ({ request }) => {
  test.setTimeout(180_000);
  const admin = await getAccessToken(request, ADMIN_EMAIL);
  const entry = await getAccessToken(request, ENTRY_EMAIL);
  const po = await upload(request, entry, FUEL_FIXTURES.petrolOfisi, 'petrol_ofisi');
  await mapToEnergy(request, admin, 'petrol_ofisi', '000456');
  await form(request, entry, po);
  const shell = await upload(request, entry, SHELL_FIXTURE, 'shell');
  await mapToEnergy(request, admin, 'shell', '0071234');
  await form(request, entry, shell);
  const all = await listFuelBatches(request, entry);
  const find = (invoiceRef: string, subsidiaryId: string) => {
    const b = all.find((x) => x.invoiceRef === invoiceRef && x.subsidiaryId === subsidiaryId);
    expect(b, `${invoiceRef} ${subsidiaryId}`).toBeDefined();
    return b!.id;
  };
  batches = {
    shared: find('OZK0000000000001', SUB.logistics),
    sharedEnergy: find('OZK0000000000001', SUB.energy),
    difference: find('OZK0000000000002', SUB.logistics),
    march1: find('2025-03-1', SUB.energy),
    march2: find('2025-03-2', SUB.energy),
    april: find('2025-04-1', SUB.energy),
  };
  // The single shared invoice, explicitly to each of its packages.
  expect((await attach(request, entry, batches.shared, 'ozk-shared.pdf')).split).toBeUndefined();
  await attach(request, entry, batches.sharedEnergy, 'ozk-shared.pdf');
  await attach(request, entry, batches.difference, 'ozk-difference.pdf');
  await attach(request, entry, batches.march2, 'duman-23.pdf');
  await attach(request, entry, batches.april, 'no-text.pdf');
  for (const id of [batches.shared, batches.difference, batches.march2, batches.april]) await submit(request, entry, id);
});

test('the Duman PDF attached in the sheet is split, and the summary says so; the Fuel files sheet shows no panel', async ({ page }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto(`/fuel-files?tab=batches&batch=${batches.march1}`);
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText(enFuel.batches.files)).toBeVisible();
  await sheet.locator('input[type="file"]').setInputFiles(resolve(INVOICES, 'duman-23.pdf'));
  await sheet.getByRole('button', { name: enFuel.batches.attach }).click();
  const summary = sheet.getByTestId('evidence-split-summary');
  await expect(summary).toContainText(enAssistant.split.attachedOne);
  await expect(summary).toContainText(enAssistant.split.notAttached);
  await expect(summary.locator('li')).toHaveCount(22);
  // Outside the review queue the sheet has no assistant.
  await expect(sheet.getByTestId('evidence-assistant')).toHaveCount(0);
});

test('in the review queue: the shared invoice is consistent with its note, and the actions never wait for the panel', async ({ page, request }) => {
  await submit(request, await getAccessToken(request, ENTRY_EMAIL), batches.march1);
  await login(page, APPROVER_EMAIL);
  // Hold the assistant's answer: the sheet's actions must not wait for it.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/fuel-batches/*/evidence-assistant', async (route) => {
    await held;
    await route.continue();
  });
  const sheet = await openInQueue(page, batches.shared, 'OZK0000000000001');
  await expect(sheet.getByRole('button', { name: enFuel.batches.approve, exact: true })).toBeVisible();
  await expect(sheet.getByTestId('evidence-assistant')).toContainText(enAssistant.loading);
  release();
  const panel = sheet.getByTestId('evidence-assistant');
  await expect(panel.getByTestId('evidence-assistant-line-diesel')).toContainText('Invoice: 312.8 L diesel (OZK…001, 01–15.03) | Package: 312.8 L');
  await expect(panel.getByTestId('evidence-assistant-line-diesel')).toContainText(enAssistant.states.consistent);
  await expect(panel.getByTestId('evidence-assistant-line-petrol')).toContainText(enAssistant.states.consistent);
  await expect(panel.getByTestId('evidence-assistant-line-petrol')).toContainText('456.21 L petrol');
  await expect(panel).toContainText(enAssistant.sharedNote.replace('{count}', '3'));
  // A reviewer granted both companies reads the other package of the invoice as a sibling.
  await expect(panel).toContainText(enAssistant.siblings);
  await expect(panel).toContainText('ÖRNEK TAŞIMACILIK A.Ş.');
  await page.unroute('**/fuel-batches/*/evidence-assistant');
});

test('the period-shift pair shows its label; a scan asks for a manual check', async ({ page }) => {
  await login(page, APPROVER_EMAIL);
  const march = await openInQueue(page, batches.march1, '2025-03-1');
  await expect(march.getByTestId('evidence-assistant-line-diesel')).toContainText(enAssistant.states.periodShift);
  await expect(march.getByTestId('evidence-assistant-line-diesel')).toContainText('Invoice: 80 L diesel (DAU…005, 01–15.03) | Package: 111.86 L');
  await page.keyboard.press('Escape');
  const april = await openInQueue(page, batches.april, '2025-04-1');
  const unread = april.getByTestId('evidence-assistant-unread');
  await expect(unread).toContainText(enAssistant.states.unread);
  await expect(unread).toContainText(enAssistant.manualCheck);
  await expect(unread).toContainText(enAssistant.unreadReasons.no_text);
});

test('a batch with a possible difference is approved as any other', async ({ page, request }) => {
  await login(page, APPROVER_EMAIL);
  const sheet = await openInQueue(page, batches.difference, 'OZK0000000000002');
  await expect(sheet.getByTestId('evidence-assistant-line-diesel')).toContainText(enAssistant.states.possible_difference);
  await sheet.getByRole('button', { name: enFuel.batches.approve, exact: true }).click();
  await expect(page.getByText(enFuel.batches.approved)).toBeVisible();
  const approver = await getAccessToken(request, APPROVER_EMAIL);
  const res = await request.get(`${API_BASE}/fuel-batches/${batches.difference}`, { headers: bearer(approver) });
  expect(((await res.json()) as { status: string }).status).toBe('approved');
});

test('the labels are the documents’ in Turkish', async ({ page, request }) => {
  const approver = await getAccessToken(request, APPROVER_EMAIL);
  try {
    expect((await request.patch(`${API_BASE}/me/preferences`, { headers: bearer(approver), data: { language: 'tr' } })).status()).toBe(200);
    await login(page, APPROVER_EMAIL);
    const sheet = await openInQueue(page, batches.march2, '2025-03-2');
    const line = sheet.getByTestId('evidence-assistant-line-diesel');
    await expect(line).toContainText('Fatura: 119,22 L motorin (DAU…006, 16–31.03) | Paket: 87,36 L');
    await expect(line).toContainText(trAssistant.states.periodShift);
    await expect(sheet.getByTestId('evidence-assistant')).toContainText(trAssistant.title);
  } finally {
    await request.patch(`${API_BASE}/me/preferences`, { headers: bearer(approver), data: { language: 'en' } });
  }
});
