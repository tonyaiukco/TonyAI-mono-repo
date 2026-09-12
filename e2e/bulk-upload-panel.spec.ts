import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { BULK_UPLOAD_COLUMNS } from '@tonyai/shared-types';
import {
  ADMIN_EMAIL,
  buildBulkCsv,
  deleteRecordsAsService,
  E2E_BULK_CATEGORY,
  E2E_PERIOD,
  ENTRY_EMAIL,
  getAccessToken,
  login,
  OUT_OF_SCOPE_SUB,
  serviceReadRecords,
  waitOutImportThrottle,
  SUB,
} from './helpers';

/**
 * The half that has never been executed in a browser.
 *
 * Three review passes recorded the same gap: `apps/web/vitest.config.ts`
 * collects only `lib/**`, so the panel's state machine, its drag handlers, its
 * confirm dialog and its double-click window have no coverage in either
 * direction and never will. This is where they run.
 *
 * Lane: `SUB.energy` / quarterly 2026 / Q1 is taken by `data-entry-happy`, so
 * this file uses Q2.
 *
 * The four import tests below deliberately SPLIT ACROSS TWO USERS. Each does a
 * dry run and an apply, the import route allows five a minute per user, and
 * eight in one window is a 429 in whichever test happens to be third — which
 * would then fail while asserting something else entirely.
 */
const LANE_PERIOD = 'Q2';
const laneQuery = `subsidiary_id=eq.${SUB.energy}&reporting_period=eq.${E2E_PERIOD}&period_value=eq.${LANE_PERIOD}&category=eq.${E2E_BULK_CATEGORY}`;

const csv = (activityValue: number) =>
  buildBulkCsv([{ subsidiaryId: SUB.energy, periodValue: LANE_PERIOD, activityValue }]);

async function laneCount(request: Parameters<typeof serviceReadRecords>[0]) {
  return (await serviceReadRecords(request, laneQuery)).length;
}

test.describe.configure({ mode: 'serial' });
/**
 * The import route allows five requests per minute per user, and the bulk group
 * makes far more than two users can spend in one window — so each of these
 * files opens with a fresh one. Counted rather than hoped for: a 429 inside a
 * test that was asserting something else is a failure that blames the wrong
 * code.
 */
test.beforeAll(async () => {
  // The hook's own timeout defaults to the test timeout, which is 60s — one
  // second less than the wait it has to make.
  test.setTimeout(90_000);
  await waitOutImportThrottle();
});


test('the template downloads, and names only the entities this user can reach', async ({
  page,
}) => {
  // The template is how a user learns which entity ids exist, so building it
  // from an unscoped query would hand one tenant another's register — in a
  // file people email around. A magic-byte check proves none of that, which is
  // why this reads the workbook.
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download template' }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe('tonyai-bulk-upload-template.xlsx');
  const path = await download.path();
  expect(path).toBeTruthy();
  const buffer = readFileSync(path!);
  expect(buffer.subarray(0, 2).toString('utf8')).toBe('PK');
  await expect(page.getByText('Template downloaded')).toBeVisible();

  const workbook = await new ExcelJS.Workbook().xlsx.load(
    buffer as unknown as ArrayBuffer,
  );

  // Sheet 1 is the importer's contract: exactly the nine columns, and nothing
  // for anyone to fill in yet.
  const records = workbook.getWorksheet('Records');
  expect(records).toBeTruthy();
  expect(
    (records!.getRow(1).values as unknown[]).slice(1).map(String),
  ).toEqual([...BULK_UPLOAD_COLUMNS]);
  expect(records!.actualRowCount).toBe(1);

  // Sheet 2 is invisible to the importer, which is the only reason the names
  // can be in this file at all.
  const reference = workbook.getWorksheet('Reference');
  expect(reference).toBeTruthy();
  const ids: string[] = [];
  reference!.eachRow((row) => ids.push(String(row.getCell(1).value ?? '')));
  expect(ids).toContain(SUB.energy);
  expect(ids).toContain(SUB.logistics);
  expect(ids, 'the register must be scoped to the caller').not.toContain(
    OUT_OF_SCOPE_SUB,
  );
});

test('the template response is never cached', async ({ request }) => {
  // The body is the caller's own entity register and the response carries no
  // `Vary: Authorization`. Behind a caching intermediary an ETag match could
  // otherwise serve one tenant's register to another. Nothing else tests it.
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const res = await request.get(
    'http://localhost:3001/api/v1/bulk-upload/template',
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(res.ok()).toBe(true);
  expect(res.headers()['cache-control']).toBe('no-store');
});

test('the confirm dialog is the only path to a write, and a double-click writes once', async ({
  page,
  request,
}) => {
  // Two claims in one flow, both uncoverable anywhere else: that picking a
  // file previews without writing, and that the dialog's Import — double
  // clicked, through Radix's 200ms exit animation — issues exactly one apply.
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');

  let posts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/bulk-upload/activity-records')) {
      posts += 1;
    }
  });

  try {
    await page.locator('[data-testid="bulk-upload-input"]').setInputFiles({
      name: 'bulk.csv',
      mimeType: 'text/csv',
      buffer: csv(21),
    });

    // The dry run starts on pick, and says so.
    await expect(page.getByText(/nothing is being written/)).toBeVisible();
    const importButton = page.getByRole('button', { name: /^Import / });
    await expect(importButton).toBeVisible();
    expect(posts).toBe(1);
    expect(await laneCount(request), 'a dry run must write nothing').toBe(0);

    // Opening the dialog and cancelling still writes nothing.
    await importButton.click();
    await expect(page.getByRole('heading', { name: 'Import these rows?' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(await laneCount(request)).toBe(0);

    // Confirm, double-clicked.
    await importButton.click();
    await page.locator('[data-testid="bulk-import-confirm"]').dblclick();
    await expect(page.getByText(/imported as drafts/i)).toBeVisible();

    // Both assertions are needed: a second apply would come back all
    // `duplicate_existing`, so the row count alone would still read 1.
    expect(posts, 'a double-click must issue exactly one apply').toBe(2);
    expect(await laneCount(request)).toBe(1);
  } finally {
    const ids = (await serviceReadRecords(request, laneQuery)).map((r) => String(r.id));
    await deleteRecordsAsService(request, ids);
  }
});

test('a second pick during a dry run is refused, and the verdict names the file it previewed', async ({
  page,
  request,
}) => {
  // Both PR-3b review seats found the same race: two dry runs in flight, the
  // responses landing in either order, the older overwriting the newer report
  // while `file` held the newer file — so Import would post a file the user
  // never previewed.
  //
  // Two guards shipped for it, and this test asserts the one that is actually
  // reachable. `dryRun()` refuses to start while another is in flight, so a
  // second pick makes NO request at all. (The request-sequence ref behind it is
  // belt-and-braces for a path that no longer exists: `busy` used to be cleared
  // out from under a running dry run by the template download's `finally`, and
  // the template now has its own flag.) The first version of this test asserted
  // the superseding behaviour instead, and failed — correctly — because the
  // shipped code prevents it.
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');

  let posts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/bulk-upload/activity-records')) {
      posts += 1;
    }
  });

  // The first response is held so the second pick lands while it is in flight —
  // a race that only sometimes reproduces is a test that only sometimes tests.
  let seen = 0;
  await page.route('**/bulk-upload/activity-records', async (route) => {
    seen += 1;
    if (seen === 1) await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });

  const input = page.locator('[data-testid="bulk-upload-input"]');
  await input.setInputFiles({ name: 'first.csv', mimeType: 'text/csv', buffer: csv(31) });
  await expect(page.getByText(/nothing is being written/)).toBeVisible();
  await input.setInputFiles({ name: 'second.csv', mimeType: 'text/csv', buffer: csv(32) });

  // The filename on the verdict exists precisely so the screen cannot lie about
  // which file it previewed.
  await expect(page.getByText('first.csv')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('second.csv')).toHaveCount(0);
  expect(posts, 'a pick during a dry run must not start a second one').toBe(1);
  expect(await laneCount(request), 'neither dry run may write').toBe(0);
});

test('an all-evidence import explains itself instead of offering a dead button', async ({
  page,
  request,
}) => {
  // The product decision recorded on 2026-09-12: on seeded data every
  // importable category requires an evidence file and an import cannot attach
  // one, so the submit half is correctly unreachable. The panel says why.
  //
  // As admin@ — the second half of this file's throttle budget.
  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');

  const electricity = buildBulkCsv([
    {
      subsidiaryId: SUB.energy,
      periodValue: 'Q3',
      category: 'Electricity',
      activityValue: 145000,
      activityUnit: 'kWh',
    },
  ]);

  try {
    await page.locator('[data-testid="bulk-upload-input"]').setInputFiles({
      name: 'electricity.csv',
      mimeType: 'text/csv',
      buffer: electricity,
    });
    await page.getByRole('button', { name: /^Import / }).click();
    await page.locator('[data-testid="bulk-import-confirm"]').click();
    await expect(page.getByText(/imported as drafts/i)).toBeVisible();

    // The whole sentence, count included, and in the singular because one row
    // was imported: `blockedReason` picks its verb and pronoun from that count,
    // so a looser matcher would pass on copy that says "1 records need".
    await expect(page.locator('[data-testid="bulk-submit-blocked"]')).toContainText(
      'All 1 imported record needs an evidence file before it can be submitted, ' +
        'and an import cannot attach one.',
    );
    await expect(page.locator('[data-testid="bulk-submit-button"]')).toHaveCount(0);
  } finally {
    const ids = (
      await serviceReadRecords(
        request,
        `subsidiary_id=eq.${SUB.energy}&reporting_period=eq.${E2E_PERIOD}&period_value=eq.Q3&category=eq.Electricity`,
      )
    ).map((r) => String(r.id));
    await deleteRecordsAsService(request, ids);
  }
});

test('a non-evidence import offers the submit button, and it moves the records', async ({
  page,
  request,
}) => {
  // The other side of the same decision, reachable only because global setup
  // seeds a fixture factor for a non-evidence category. This is the one flow
  // that exercises the submit button and its own confirm dialog in a browser.
  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');

  try {
    await page.locator('[data-testid="bulk-upload-input"]').setInputFiles({
      name: 'waste.csv',
      mimeType: 'text/csv',
      buffer: csv(7),
    });
    await page.getByRole('button', { name: /^Import / }).click();
    await page.locator('[data-testid="bulk-import-confirm"]').click();
    await expect(page.getByText(/imported as drafts/i)).toBeVisible();

    await page.locator('[data-testid="bulk-submit-button"]').click();
    // The sentence the dialog exists for: there is no author-side un-submit.
    await expect(page.getByText(/Only a reviewer can send them back/)).toBeVisible();
    await page.locator('[data-testid="bulk-submit-confirm"]').click();

    await expect(page.getByText(/now in the review queue/i)).toBeVisible();
    const [row] = await serviceReadRecords(request, laneQuery);
    expect(row.status).toBe('submitted');
  } finally {
    const ids = (await serviceReadRecords(request, laneQuery)).map((r) => String(r.id));
    await deleteRecordsAsService(request, ids);
  }
});
