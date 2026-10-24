import { expect, test, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ADMIN_EMAIL, API_BASE, ENTRY_EMAIL, SUB, bearer, getAccessToken, login } from './helpers';

/**
 * LP4-03 PR B: the Reports screen's issued side, end to end — a boundary
 * declared through the API, then captured, checked, issued and downloaded
 * through the UI; and the live tab marked live, with the boundary's coverage.
 *
 * A frozen boundary version, a retained dataset and an issuance can never be
 * deleted (only with their organisation), so this spec owns a year no other
 * spec reads — 2021 — and every assertion holds on a rerun: each run declares
 * a new version (the newest of the last run is confirmed, so a new one may
 * open), captures it, and issues the newest final.
 */

const YEAR = 2021;
const CATEGORIES = ['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'] as const;

/**
 * A confirmed holding version for YEAR: TonyAI Trading, every category excluded
 * with its reason — the final the factor library allows. `reuse` takes a
 * confirmed newest version as it is (only this spec writes YEAR), so a reader
 * test adds no version to a long-lived database.
 */
async function confirmedHoldingVersion(request: APIRequestContext, { reuse = false } = {}): Promise<number> {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const headers = { ...bearer(token), 'Content-Type': 'application/json' };
  const versions = await request.get(`${API_BASE}/inventory-boundaries?reportingYear=${YEAR}`, { headers });
  expect(versions.ok(), await versions.text()).toBe(true);
  const list = (await versions.json()) as Array<{ id: string; version: number; decision: string; frozenAt: string | null }>;
  const newest = list.reduce<(typeof list)[number] | null>((a, v) => (a === null || v.version > a.version ? v : a), null);
  if (reuse && newest?.decision === 'confirmed') return newest.version;
  // An open version a failed run left behind is reused; a frozen one makes way for the next.
  let id = newest !== null && newest.frozenAt === null ? newest.id : null;
  if (id === null) {
    const created = await request.post(`${API_BASE}/inventory-boundaries`, { headers, data: { reportingYear: YEAR } });
    expect(created.ok(), await created.text()).toBe(true);
    id = ((await created.json()) as { id: string }).id;
  }
  const put = await request.put(`${API_BASE}/inventory-boundaries/${id}/subsidiaries/${SUB.trading}`, {
    headers,
    data: {
      firstMonth: 1, lastMonth: 12, sites: [], sources: [],
      attribution: CATEGORIES.map((category) => ({ category, level: 'company', reportingPeriod: 'annual' })),
      applicability: CATEGORIES.map((category) => ({ locationId: null, category, applicability: 'excluded', reason: 'E2E holding company: no operations' })),
    },
  });
  expect(put.ok(), await put.text()).toBe(true);
  const confirmed = await request.post(`${API_BASE}/inventory-boundaries/${id}/confirm`, { headers });
  expect(confirmed.ok(), await confirmed.text()).toBe(true);
  return ((await confirmed.json()) as { version: number }).version;
}

const issuedUrl = `/reports?year=${YEAR}&subsidiaryId=all&scope=all&category=all&tab=issued`;

test('issued reports: capture, check, issue a final and download its PDF, workbook and CSV', async ({ page, request }) => {
  const version = await confirmedHoldingVersion(request);
  await login(page, ADMIN_EMAIL);
  await page.goto(issuedUrl);
  await expect(page.getByRole('tab', { name: 'Issued reports' })).toHaveAttribute('data-state', 'active');
  await expect(page.getByRole('heading', { name: `Issued reports for ${YEAR}` })).toBeVisible();

  // Capture: the year's newest version, as one whole inventory. Counted once
  // the lists have loaded (the capture button renders with them): earlier runs left datasets behind.
  // The new dataset is the newest row, told by its id — the list is capped, so
  // a count stops moving on a long-lived database.
  await expect(page.getByRole('button', { name: 'Capture the inventory' })).toBeEnabled();
  const rows = page.getByTestId('dataset-row');
  const newestBefore = (await rows.count()) > 0 ? await rows.first().getAttribute('data-dataset-id') : null;
  await page.getByRole('button', { name: 'Capture the inventory' }).click();
  await expect(page.getByText('Dataset captured').first()).toBeVisible();
  await expect(rows.first()).toHaveAttribute('data-dataset-id', /.+/);
  expect(await rows.first().getAttribute('data-dataset-id')).not.toBe(newestBefore);
  const dataset = rows.first();
  await expect(dataset).toContainText(`Boundary version ${version} · confirmed`);
  await expect(dataset).toContainText('Whole inventory');

  // Check: the gate's own derivation, nothing written.
  await dataset.getByRole('button', { name: 'Check' }).click();
  await expect(dataset.getByTestId('issuance-preview')).toHaveText('Qualifies as a final report.');

  // Issue: a final, in English.
  await dataset.getByRole('button', { name: 'Issue' }).click();
  const dialog = page.getByRole('dialog', { name: 'Issue a report' });
  await expect(dialog).toBeVisible();
  // The dialog says what it will issue before anything irreversible happens.
  await expect(dialog.getByTestId('issuance-preview')).toHaveAttribute('data-status', 'final');
  await dialog.getByRole('button', { name: 'Issue' }).click();
  await expect(page.getByText('Final report issued').first()).toBeVisible();

  // The newest issuance is first, final and current.
  const issued = page.getByTestId('issuance-row').first();
  await expect(issued).toHaveAttribute('data-status', 'final');
  await expect(issued).toContainText('Current final');
  await expect(issued).toContainText('Executive Summary · English');

  // Its three files: the retained PDF, and the workbook and CSV of its retained dataset — one name.
  const names: string[] = [];
  for (const [button, magic] of [['PDF', '%PDF'], ['Excel', 'PK'], ['CSV', String.fromCharCode(0xfeff) + 'issuance_id,']] as const) {
    const downloadPromise = page.waitForEvent('download');
    await issued.getByRole('button', { name: button, exact: true }).click();
    const download = await downloadPromise;
    names.push(download.suggestedFilename());
    const path = await download.path();
    expect(readFileSync(path!).subarray(0, 32).toString('utf8').startsWith(magic), button).toBe(true);
  }
  expect(names[0]).toMatch(new RegExp(`^tonyai-report-${YEAR}-executive_summary-en-final-\\d{4}-\\d{2}-\\d{2}-[0-9a-f]{8}\\.pdf$`));
  expect(names.map((n) => n.replace(/\.[a-z]+$/, ''))).toEqual(Array(3).fill(names[0].replace(/\.pdf$/, '')));
  expect(names.map((n) => n.split('.').pop())).toEqual(['pdf', 'xlsx', 'csv']);
});

test('the live tab is marked live and says what the boundary covers', async ({ page, request }) => {
  await confirmedHoldingVersion(request, { reuse: true });
  await login(page, ADMIN_EMAIL);
  await page.goto(`/reports?year=${YEAR}&subsidiaryId=all&scope=all&category=all`);
  await expect(page.getByRole('tab', { name: 'Live preview' })).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('live-banner')).toContainText('Live preview — not an issued report.');
  const coverage = page.getByTestId('coverage-card');
  await expect(coverage).toBeVisible();
  // Every category excluded: nothing included, never "complete".
  await expect(coverage).toHaveAttribute('data-coverage', 'nothing_included');
  await expect(coverage).toContainText('every category is excluded with its reason');
  await expect(page.getByTestId('scope3-disclosure')).toContainText('Scope 3 is not covered by this inventory.');
  // The review badge says what it is, beside the note that it certifies nothing.
  await expect(page.getByTestId('status-note')).toContainText('not an inventory certification');
});

test('a Scope 3 selection reads "Not covered", never 0', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto(`/reports?year=${YEAR}&subsidiaryId=all&scope=3&category=all`);
  await expect(page.getByTestId('coverage-card')).toHaveAttribute('data-coverage', 'not_covered');
  // Scope 1, Scope 2, the total and the committed-records tile: a word each, no tile a 0.
  await expect(page.getByText('Not covered', { exact: true })).toHaveCount(4);
  await expect(page.getByText(/^0 tCO₂e$/)).toHaveCount(0);
});

test('the dashboard reads "Not covered" for a Scope 3 selection, and its total is Scope 1 + 2', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto(`/?year=${YEAR}&subsidiaryId=all&scope=3&category=all`);
  await expect(page.getByTestId('kpi-not-covered')).toHaveCount(3);
  // The chart and a subsidiary's drawer say so too — no bar or total of 0 (Codex B9 P2-2).
  await expect(page.getByTestId('chart-not-covered')).toBeVisible();
  await page.getByRole('button', { name: /TonyAI Energy/ }).first().click();
  await expect(page.getByRole('dialog').getByTestId('drawer-not-covered')).toHaveText('Not covered');
  await page.keyboard.press('Escape');
  await page.goto(`/?year=${YEAR}&subsidiaryId=all&scope=all&category=all`);
  await expect(page.getByText('Scope 1 + 2 total').first()).toBeVisible();
  await expect(page.getByTestId('kpi-not-covered')).toHaveCount(0);
  await expect(page.getByTestId('coverage-card')).toBeVisible();
});

test('data_entry reads no issued report', async ({ page }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto(issuedUrl);
  await expect(page.getByTestId('issued-not-for-role')).toHaveText('Your role does not read issued reports.');
  await expect(page.getByRole('button', { name: 'Capture the inventory' })).toHaveCount(0);
});
