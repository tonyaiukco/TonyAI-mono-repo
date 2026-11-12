import { readFileSync } from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';
import {
  API_BASE,
  ENTRY_EMAIL,
  E2E_YEAR,
  EVIDENCE_FIXTURE,
  SUB,
  bearer,
  deleteRecordsAsService,
  getAccessToken,
  login,
  pickByFieldLabel,
  selectSubsidiary,
  serviceReadRecords,
} from './helpers';

/**
 * UAT round 2, BUG-R2-05 (OpenSpec `uat2-data-entry-layout`): the Data Entry
 * screen in QA's order, files chosen before the record exists, and the records
 * table with its filters — through the real UI, API and database.
 *
 * Lane: `SUB.energy` / quarterly `E2E_YEAR` and `E2E_YEAR - 1` / `Water`,
 * whole company. Water is evidence-required and needs no emission factor, so
 * nothing here leans on the factor library. No other spec writes Water on this
 * subsidiary's quarterly space.
 */

const SUBSIDIARY = SUB.energy;
const OPTION = 'TonyAI Energy (TR)';
const OTHER_OPTION = 'TonyAI Logistics (TR)';
const LANE_QUERY =
  `subsidiary_id=eq.${SUBSIDIARY}&reporting_year=in.(${E2E_YEAR},${E2E_YEAR - 1})` +
  `&reporting_period=eq.quarterly&category=eq.Water`;

test.describe.configure({ mode: 'serial' });

async function sweepLane(request: Parameters<typeof serviceReadRecords>[0]) {
  const strays = await serviceReadRecords(request, LANE_QUERY);
  await deleteRecordsAsService(request, strays.map((r) => String(r.id)));
}

test.beforeAll(async ({ request }) => sweepLane(request));
test.afterAll(async ({ request }) => sweepLane(request));

const records = (page: Page) => page.getByTestId('records-table');
const vault = (page: Page) => page.getByTestId('evidence-vault');

async function openDataEntry(page: Page) {
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await selectSubsidiary(page, OPTION);
}

/** A new Water record for one quarter of `E2E_YEAR`, value 12 m³, not saved. */
async function fillWater(page: Page, quarter: string) {
  await pickByFieldLabel(page, 'Category', 'Water');
  await pickByFieldLabel(page, 'Reporting year', String(E2E_YEAR));
  await pickByFieldLabel(page, 'Value', quarter);
  await page.getByPlaceholder('e.g. 45000').fill('12');
}

async function laneRecords(request: Parameters<typeof serviceReadRecords>[0], periodValue: string) {
  return serviceReadRecords(
    request,
    `subsidiary_id=eq.${SUBSIDIARY}&reporting_year=eq.${E2E_YEAR}&reporting_period=eq.quarterly` +
      `&period_value=eq.${periodValue}&category=eq.Water`,
  );
}

async function evidenceCountOf(request: Parameters<typeof serviceReadRecords>[0], id: string): Promise<number> {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const res = await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) });
  expect(res.ok(), `${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { evidenceCount: number }).evidenceCount;
}

test('the sections read in QA order, and the secondary ones start collapsed', async ({ page }) => {
  await openDataEntry(page);

  const top = async (locator: ReturnType<Page['locator']>) => (await locator.boundingBox())!.y;
  const scope = await top(page.getByText('Reporting scope', { exact: true }));
  const activity = await top(page.getByText('Activity data', { exact: true }));
  const evidence = await top(vault(page));
  const context = await top(page.getByTestId('context-section'));
  const submit = await top(page.getByRole('button', { name: 'Submit for review' }));
  const bulk = await top(page.getByTestId('bulk-upload-section'));
  const table = await top(page.getByTestId('previous-submissions'));
  expect([scope, activity, evidence, context, submit, bulk, table]).toEqual(
    [scope, activity, evidence, context, submit, bulk, table].slice().sort((a, b) => a - b),
  );
  expect(new Set([scope, activity, evidence, context, submit, bulk, table]).size).toBe(7);

  // The vault is there before any save, held mode.
  await expect(vault(page)).toHaveAttribute('data-mode', 'held');

  // Both secondary sections are closed, and open from the keyboard.
  const contextToggle = page.getByTestId('context-section').getByRole('button', { name: 'Additional context' });
  const bulkToggle = page.getByTestId('bulk-upload-section').getByRole('button', { name: /^Bulk upload/ });
  await expect(contextToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(bulkToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Recent imports', { exact: true })).toBeHidden();
  await bulkToggle.focus();
  await page.keyboard.press('Enter');
  await expect(bulkToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Recent imports', { exact: true })).toBeVisible();
  await contextToggle.focus();
  await page.keyboard.press('Space');
  await expect(contextToggle).toHaveAttribute('aria-expanded', 'true');
});

test('a refused context number survives closing and reopening its section, note included', async ({ page }) => {
  await openDataEntry(page);
  await pickByFieldLabel(page, 'Category', 'Water');
  const section = page.getByTestId('context-section');
  const toggle = section.getByRole('button', { name: 'Additional context' });
  await toggle.click();
  const field = section.getByPlaceholder('Enter cubic meters').first();
  const note = section.locator('#context-municipal_water_m3-note');
  await field.fill('12abc');
  await field.blur();
  await expect(note).toContainText('Enter a number');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  // Still the text that blocks the save, still saying why.
  await expect(field).toHaveValue('12abc');
  await expect(note).toContainText('Enter a number');
});

test('a file chosen before the first save lets an evidence-required record submit in one click', async ({
  page,
  request,
}) => {
  await openDataEntry(page);
  await fillWater(page, 'Q1');

  await page.getByTestId('evidence-vault-input').setInputFiles(EVIDENCE_FIXTURE);
  await expect(vault(page)).toContainText('sample-invoice.pdf');
  await expect(vault(page)).toContainText('uploaded when you save');
  // Nothing is uploaded, or created, before the save.
  expect(await laneRecords(request, 'Q1')).toHaveLength(0);

  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Submitted for review', { exact: true })).toBeVisible();

  const [row] = await laneRecords(request, 'Q1');
  expect(row?.status).toBe('submitted');
  expect(await evidenceCountOf(request, String(row.id))).toBe(1);

  // The form reset: the vault is back to holding files for a new record.
  await expect(vault(page)).toHaveAttribute('data-mode', 'held');
  await expect(vault(page)).not.toContainText('sample-invoice.pdf');

  // The table row shows the value, the file and the status.
  const tableRow = records(page).getByRole('row').filter({ hasText: `Q1 ${E2E_YEAR}` }).filter({ hasText: 'Water' });
  await expect(tableRow).toContainText('1 file');
  await expect(tableRow).toContainText('Submitted');
  await expect(tableRow).toContainText('12');
});

test('a file chosen and then left behind by a subsidiary switch reaches no record', async ({ page, request }) => {
  await openDataEntry(page);
  await fillWater(page, 'Q2');
  await page.getByTestId('evidence-vault-input').setInputFiles(EVIDENCE_FIXTURE);
  await expect(vault(page)).toContainText('sample-invoice.pdf');

  await selectSubsidiary(page, OTHER_OPTION);
  await expect(vault(page)).not.toContainText('sample-invoice.pdf');
  await selectSubsidiary(page, OPTION);
  await expect(vault(page)).not.toContainText('sample-invoice.pdf');
  expect(await laneRecords(request, 'Q2')).toHaveLength(0);
});

test('a failed upload leaves a saved draft with Retry, and nothing is submitted', async ({ page, request }) => {
  await openDataEntry(page);
  await fillWater(page, 'Q3');
  await page.getByTestId('evidence-vault-input').setInputFiles([
    { name: 'sample-invoice.pdf', mimeType: 'application/pdf', buffer: readFileSync(EVIDENCE_FIXTURE) },
    { name: 'second.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') },
  ]);

  // Storage is down for the first attempt only.
  const failUpload = async (route: Route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'storage down' }) })
      : route.fallback();
  await page.route('**/api/v1/activity-records/*/evidence', failUpload);

  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText(/these files did not upload: sample-invoice\.pdf, second\.pdf/)).toBeVisible();
  const failed = page.getByTestId('evidence-failed-uploads');
  await expect(failed).toContainText('sample-invoice.pdf');
  await expect(failed).toContainText('second.pdf');

  const [draft] = await laneRecords(request, 'Q3');
  expect(draft?.status).toBe('draft');
  expect(await evidenceCountOf(request, String(draft.id))).toBe(0);

  await page.unroute('**/api/v1/activity-records/*/evidence', failUpload);
  // The Retry answers slowly; meanwhile the user removes the other failed
  // file. When the Retry lands, the removed file must not come back.
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const slowUpload = async (route: Route) => {
    if (route.request().method() === 'POST') await slow;
    return route.fallback();
  };
  await page.route('**/api/v1/activity-records/*/evidence', slowUpload);
  await failed.getByRole('button', { name: 'Retry uploading sample-invoice.pdf' }).click();
  await failed.getByRole('button', { name: 'Remove second.pdf from the list' }).click();
  await expect(failed).not.toContainText('second.pdf');
  release();
  await expect(page.getByTestId('evidence-failed-uploads')).toHaveCount(0);
  await page.unroute('**/api/v1/activity-records/*/evidence', slowUpload);
  await expect(vault(page)).toContainText('sample-invoice.pdf');
  expect(await evidenceCountOf(request, String(draft.id))).toBe(1);

  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Submitted for review', { exact: true })).toBeVisible();
  const [after] = await laneRecords(request, 'Q3');
  expect(after?.status).toBe('submitted');
});

test('a save still in flight when another record is opened uploads its file nowhere, and says so', async ({
  page,
  request,
}) => {
  // The record opened mid-save: a draft of the year before, in the same lane.
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const other = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUBSIDIARY,
      reportingYear: E2E_YEAR - 1,
      reportingPeriod: 'quarterly',
      periodValue: 'Q1',
      category: 'Water',
      activityValue: 5,
      activityUnit: 'cubic_metres',
    },
  });
  expect(other.ok(), await other.text()).toBe(true);
  const otherId = ((await other.json()) as { id: string }).id;

  await openDataEntry(page);
  const filters = page.getByTestId('records-filters');
  await filters.getByRole('combobox', { name: 'Reporting year' }).click();
  await page.getByRole('option', { name: 'All years', exact: true }).click();
  await fillWater(page, 'Q2');
  await page.getByTestId('evidence-vault-input').setInputFiles(EVIDENCE_FIXTURE);

  // The create answers slowly, so the user has time to open another record.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/v1/activity-records', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await held;
    return route.fallback();
  });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await records(page).getByRole('button', { name: `Q1 ${E2E_YEAR - 1} Water, Whole subsidiary` }).click();
  await expect(page.getByText(/Editing draft/)).toBeVisible();
  release();

  await expect(page.getByText(/you moved on before these files were uploaded: sample-invoice\.pdf/)).toBeVisible();
  await page.unroute('**/api/v1/activity-records');
  const [saved] = await laneRecords(request, 'Q2');
  expect(saved?.status).toBe('draft');
  expect(await evidenceCountOf(request, String(saved.id))).toBe(0);
  expect(await evidenceCountOf(request, otherId)).toBe(0);
  // The form stays on the record the user opened.
  await expect(page.getByText(`Editing draft ${otherId.slice(0, 8)}`, { exact: false })).toBeVisible();
});

test('the table filters by year (following the form until picked) and by status, on every page', async ({
  page,
  request,
}) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  for (const [year, quarter] of [
    [E2E_YEAR, 'Q4'],
    [E2E_YEAR - 1, 'Q4'],
  ] as const) {
    const res = await request.post(`${API_BASE}/activity-records`, {
      headers: bearer(token),
      data: {
        subsidiaryId: SUBSIDIARY,
        reportingYear: year,
        reportingPeriod: 'quarterly',
        periodValue: quarter,
        category: 'Water',
        activityValue: 7,
        activityUnit: 'cubic_metres',
      },
    });
    expect(res.ok(), await res.text()).toBe(true);
  }

  await openDataEntry(page);
  await pickByFieldLabel(page, 'Category', 'Water');
  await pickByFieldLabel(page, 'Reporting year', String(E2E_YEAR));
  const thisYear = records(page).getByRole('button', { name: `Q4 ${E2E_YEAR} Water, Whole subsidiary` });
  const lastYear = records(page).getByRole('button', { name: `Q4 ${E2E_YEAR - 1} Water, Whole subsidiary` });
  await expect(thisYear).toBeVisible();
  await expect(lastYear).toHaveCount(0);

  // The year follows the form while unpicked.
  await pickByFieldLabel(page, 'Reporting year', String(E2E_YEAR - 1));
  await expect(lastYear).toBeVisible();
  await expect(thisYear).toHaveCount(0);

  // Picked, it stays: All years shows both, whatever the form says.
  const filters = page.getByTestId('records-filters');
  await filters.getByRole('combobox', { name: 'Reporting year' }).click();
  await page.getByRole('option', { name: 'All years', exact: true }).click();
  await pickByFieldLabel(page, 'Reporting year', String(E2E_YEAR));
  await expect(thisYear).toBeVisible();
  await expect(lastYear).toBeVisible();

  // A status filter is sent with every page, Load more included. The first
  // page is made to claim another page, so the next request can be read.
  let sawNextPage = '';
  let firstPage: { items: Record<string, unknown>[]; nextCursor: string | null; limit: number } = {
    items: [],
    nextCursor: null,
    limit: 0,
  };
  // The list only: a glob would also catch `/activity-records/metadata?…`.
  const isList = (url: URL) => url.pathname === '/api/v1/activity-records';
  await page.route(isList, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('cursor') === 'e2e-next') {
      sawNextPage = url.search;
      // One more row, so Load more is seen appending, not only asking.
      const extra = {
        ...firstPage.items[0],
        id: '00000000-0000-4000-8000-0000000e2e02',
        reportingYear: E2E_YEAR,
        periodValue: 'Q3',
        category: 'Water',
        activityType: null,
        locationId: null,
      };
      return route.fulfill({ json: { items: [extra], nextCursor: null, limit: firstPage.limit } });
    }
    const real = await route.fetch();
    firstPage = (await real.json()) as typeof firstPage;
    return route.fulfill({ response: real, json: { ...firstPage, nextCursor: 'e2e-next' } });
  });
  await filters.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Draft', exact: true }).click();
  await expect(thisYear).toBeVisible();
  await page.getByTestId('previous-submissions-load-more').click();
  await expect.poll(() => sawNextPage).toContain('status=draft');
  // Q3 is submitted in this lane, so under Draft only the appended row carries its name.
  await expect(records(page).getByRole('button', { name: `Q3 ${E2E_YEAR} Water, Whole subsidiary` })).toBeVisible();
  await page.unroute(isList);

  // Nothing matches: the table says so, not that there are no records. Water
  // only, since the seed holds approved records of other categories here.
  await filters.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: 'Water', exact: true }).click();
  await filters.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Approved', exact: true }).click();
  await expect(page.getByTestId('records-table-empty')).toHaveText('No record matches these filters.');

  // Another subsidiary and back: the filters start over (A -> B -> A).
  await selectSubsidiary(page, OTHER_OPTION);
  await selectSubsidiary(page, OPTION);
  await expect(filters.getByRole('combobox', { name: 'Status' })).toHaveText('All statuses');
  await expect(filters.getByRole('combobox', { name: 'Category' })).toHaveText('All categories');
  await expect(filters.getByRole('combobox', { name: 'Reporting year' })).toHaveText(String(E2E_YEAR));
});
