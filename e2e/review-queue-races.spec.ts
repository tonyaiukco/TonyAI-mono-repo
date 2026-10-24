import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  ADMIN_EMAIL, API_BASE, E2E_YEAR, SUB, bearer, createCommittedRecord, deleteRecordsAsService, getAccessToken, login,
} from './helpers';

/**
 * LP4-05 PR C's review queue under delayed and failing answers (Codex's B9
 * review of #209, P2-1 to P2-3). The queue's records are this spec's own lane —
 * TonyAI Gas, company-level Natural Gas, quarterly, which no other spec writes
 * — and go in `afterAll`; the switch target is TonyAI Mfg. The admin enters
 * them and takes them into review (starting a review has no authorship rule).
 */
const YEAR = E2E_YEAR;
const created: string[] = [];
test.afterAll(async ({ request }) => {
  await deleteRecordsAsService(request, created.splice(0));
});
const APP_ORIGIN = 'http://localhost:3000';
const CORS = { 'access-control-allow-origin': APP_ORIGIN, 'access-control-allow-credentials': 'true' };

/** One page of the queue (not its metadata), for the subsidiary given — or any. */
const isQueuePage = (subsidiaryId?: string) => (url: URL) =>
  url.pathname.endsWith('/api/v1/activity-records') &&
  url.searchParams.get('sort') === 'review_queue' &&
  (subsidiaryId === undefined || url.searchParams.get('subsidiaryId') === subsidiaryId);

async function pending(request: APIRequestContext, periodValue: string): Promise<string> {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await createCommittedRecord(request, token, {
    subsidiaryId: SUB.gas,
    category: 'Natural Gas',
    periodValue,
    reportingYear: YEAR,
    activityValue: 1100,
    activityUnit: 'm3',
  });
  created.push(id);
  return id;
}

async function legalName(request: APIRequestContext, id: string): Promise<string> {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const subs = (await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) })).json()) as { id: string; legalName: string }[];
  return subs.find((s) => s.id === id)!.legalName;
}

async function pickSubsidiary(page: Page, name: string): Promise<void> {
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name, exact: true }).click();
}

test('a failed switch never shows the previous selection’s queue under the new selector (P2-1)', async ({ page, request }) => {
  await pending(request, 'Q1');
  const mfg = await legalName(request, SUB.mfg);
  const gasName = await legalName(request, SUB.gas);
  await login(page, ADMIN_EMAIL);
  await page.goto('/review');
  const rowA = page.locator('table tbody tr').filter({ hasText: `Q1 ${YEAR}` }).filter({ hasText: gasName });
  await expect(rowA).toHaveCount(1);

  await page.route(isQueuePage(SUB.mfg), (route) =>
    route.fulfill({ status: 500, headers: CORS, json: { statusCode: 500, code: 'internal_error', message: 'Simulated outage' } }),
  );
  await pickSubsidiary(page, mfg);

  // The defect: the previous selection's actionable rows under the new selector.
  await expect(rowA).toHaveCount(0);
  await expect(page.getByTestId('review-queue-failed')).toBeVisible();
  await expect(page.getByTestId('review-queue-total')).toHaveText('— awaiting review');
  await expect(page.getByTestId('review-queue-load-more')).toHaveCount(0);
});

test('a decision that settles after a switch refreshes the selection on screen, sheet closed (P2-2)', async ({ page, request }) => {
  const id = await pending(request, 'Q2');
  const mfg = await legalName(request, SUB.mfg);
  const gasName = await legalName(request, SUB.gas);
  await login(page, ADMIN_EMAIL);
  await page.goto('/review');
  const rowA = page.locator('table tbody tr').filter({ hasText: `Q2 ${YEAR}` }).filter({ hasText: gasName });
  await rowA.click();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route((url) => url.pathname.endsWith(`/activity-records/${id}/review`), async (route) => {
    await gate;
    await route.continue();
  });
  const decided = page.waitForResponse((r) => r.url().endsWith(`/activity-records/${id}/review`));
  await page.getByRole('button', { name: 'Start review' }).click();
  // The reviewer moves on before the answer: closes the sheet, picks another subsidiary.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const mfgLoaded = page.waitForResponse((r) => isQueuePage(SUB.mfg)(new URL(r.url())));
  await pickSubsidiary(page, mfg);
  await mfgLoaded;

  // The refresh after the decision must be for the selection on screen — Mfg — not the one the decision started under.
  const refreshed = page.waitForResponse((r) => isQueuePage(SUB.mfg)(new URL(r.url())));
  release();
  expect((await decided).status()).toBe(200);
  await refreshed;
  await expect(rowA).toHaveCount(0);
  await expect(page.getByRole('combobox').first()).toContainText(mfg);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('review evidence starts again from its first page when a cursor is refused (P2-3)', async ({ page, request }) => {
  const id = await pending(request, 'Q3');
  const calls: string[] = [];
  await page.route((url) => url.pathname.endsWith(`/activity-records/${id}/evidence`), async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    calls.push(cursor ?? 'first');
    if (calls.length === 1) {
      // A first page from before a deployment, whose cursor the API now refuses.
      return route.fulfill({
        headers: CORS,
        json: {
          items: [{
            id: '00000000-0000-4000-8000-0000000000f1', subsidiaryId: SUB.gas, fileName: 'stale-page.pdf',
            mimeType: 'application/pdf', sizeBytes: 4, uploadedBy: '00000000-0000-4000-8000-0000000000f2',
            createdAt: new Date().toISOString(),
            linkedRecords: [{ id, category: 'Natural Gas', reportingYear: YEAR, periodValue: 'Q3', locationName: null, status: 'submitted' }],
          }],
          limit: 50,
          nextCursor: 'stale-cursor',
        },
      });
    }
    if (cursor) {
      return route.fulfill({ status: 400, headers: CORS, json: { statusCode: 400, code: 'validation_failed', message: ['cursor is invalid'] } });
    }
    return route.continue();
  });

  const gasName = await legalName(request, SUB.gas);
  await login(page, ADMIN_EMAIL);
  await page.goto('/review');
  await page.locator('table tbody tr').filter({ hasText: `Q3 ${YEAR}` }).filter({ hasText: gasName }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('stale-page.pdf')).toBeVisible();

  await sheet.getByTestId('review-evidence-load-more').click();
  // The chain starts over: the record's real first page replaces the stale one.
  await expect(sheet.getByText('sample-invoice.pdf')).toBeVisible();
  await expect(sheet.getByText('stale-page.pdf')).toHaveCount(0);
  await expect(sheet.getByTestId('review-evidence-load-more')).toHaveCount(0);
  expect(calls).toEqual(['first', 'stale-cursor', 'first']);
});

test('a failed evidence restart shows the error, offers no stale Load more, and Retry recovers it (re-check P3)', async ({ page, request }) => {
  const id = await pending(request, 'Q4');
  const calls: string[] = [];
  await page.route((url) => url.pathname.endsWith(`/activity-records/${id}/evidence`), async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    calls.push(cursor ?? 'first');
    if (calls.length === 1) {
      return route.fulfill({
        headers: CORS,
        json: {
          items: [{
            id: '00000000-0000-4000-8000-0000000000f3', subsidiaryId: SUB.gas, fileName: 'stale-page.pdf',
            mimeType: 'application/pdf', sizeBytes: 4, uploadedBy: '00000000-0000-4000-8000-0000000000f2',
            createdAt: new Date().toISOString(),
            linkedRecords: [{ id, category: 'Natural Gas', reportingYear: YEAR, periodValue: 'Q4', locationName: null, status: 'submitted' }],
          }],
          limit: 50,
          nextCursor: 'stale-cursor',
        },
      });
    }
    if (cursor) {
      return route.fulfill({ status: 400, headers: CORS, json: { statusCode: 400, code: 'validation_failed', message: ['cursor is invalid'] } });
    }
    // The restart itself fails once; Retry then reads the real first page.
    if (calls.length === 3) {
      return route.fulfill({ status: 500, headers: CORS, json: { statusCode: 500, code: 'internal_error', message: 'Simulated outage' } });
    }
    return route.continue();
  });

  const gasName = await legalName(request, SUB.gas);
  await login(page, ADMIN_EMAIL);
  await page.goto('/review');
  await page.locator('table tbody tr').filter({ hasText: `Q4 ${YEAR}` }).filter({ hasText: gasName }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('stale-page.pdf')).toBeVisible();

  await sheet.getByTestId('review-evidence-load-more').click();
  await expect(sheet.getByText(/Could not load the evidence for this record/)).toBeVisible();
  // No Load more is left to resend a cursor the API refused.
  await expect(sheet.getByTestId('review-evidence-load-more')).toHaveCount(0);

  await sheet.getByRole('button', { name: 'Retry' }).click();
  await expect(sheet.getByText('sample-invoice.pdf')).toBeVisible();
  await expect(sheet.getByText(/Could not load the evidence for this record/)).toHaveCount(0);
  expect(calls).toEqual(['first', 'stale-cursor', 'first', 'first']);
});
